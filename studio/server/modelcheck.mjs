// Model check: find why a semantic model can't answer (keys that repeat on the "one" side of a relationship, empty
// keys) by reading the tables it is built on, and fix exact duplicate rows in a Fabric warehouse – with a backup table,
// in one transaction, then reframe the model. Works for any model the user can read; the model itself isn't changed.
import { decodeText } from './reports/zip.mjs';
import * as F from './fabric.mjs';
import { dax, refreshDataset } from './powerbi.mjs';
import { withPool } from './sql.mjs';
import { getProject, logActivity, assertProjectTenant, projectModels, modelWorkspaceId } from './project.mjs';
import { resetProfileCache } from './reports/index.mjs';
import { sleep, isNetworkError } from './config.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (s) => `[${String(s).replace(/]/g, ']]')}]`;
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const ITEM_LABEL = { Lakehouse: 'lakehouse', Warehouse: 'warehouse', SQLEndpoint: 'SQL analytics endpoint', MirroredDatabase: 'mirrored database', SQLDatabase: 'SQL database' };

/** The model the check is for: one of the project's models (the active one by default). */
function modelFor(id) {
  const p = getProject();
  const m = id ? projectModels(p).find((x) => x.id === id) : p.semanticModel;
  if (!m) throw fail(id ? 'That semantic model isn\'t in the project.' : 'There is no semantic model yet.', 404);
  return { p, m, ws: modelWorkspaceId(p, m) };
}

// ---------------- where the model's tables come from ----------------

/** TMDL values: a quoted name or a plain one. */
const unq = (s) => String(s ?? '').trim().replace(/^'(.*)'$/s, '$1').replace(/''/g, "'");

/**
 * Read the model definition (TMDL) for each table's source (schema and table in the source item) and each column's
 * source column, plus the source connection: Sql.Database(server, database) or a OneLake path to the item.
 */
function parseTmdl(parts) {
  const text = (p) => decodeText(Buffer.from(p.payload, 'base64')).replace(/\r\n/g, '\n');
  const exprs = {};
  const tables = {};
  for (const part of parts) {
    if (/definition\/expressions\.tmdl$/i.test(part.path)) {
      const t = text(part);
      for (const m of t.matchAll(/^expression\s+('?[^=\n]+?'?)\s*=\s*([\s\S]*?)(?=^expression\s|$(?![\s\S]))/gm)) exprs[unq(m[1])] = m[2];
    }
    const tm = part.path.match(/definition\/tables\/(.+)\.tmdl$/i);
    if (!tm) continue;
    const t = text(part);
    const name = unq(t.match(/^table\s+(.+)$/m)?.[1] || tm[1]);
    const cols = {};
    for (const m of t.matchAll(/^\tcolumn\s+(.+?)\s*$([\s\S]*?)(?=^\t(?:column|measure|partition|hierarchy|annotation|calculationGroup)\b|(?![\s\S]))/gm)) {
      const src = m[2].match(/^\t\tsourceColumn:\s*(.+)$/m);
      const type = m[2].match(/^\t\tdataType:\s*(\w+)/m)?.[1] || '';
      if (src) cols[unq(m[1].split('=')[0])] = { source: unq(src[1]), text: /^string$/i.test(type) };
    }
    const part0 = t.match(/^\tpartition\s+[\s\S]*?(?=^\t(?!\t)|(?![\s\S]))/m)?.[0] || '';
    const mode = part0.match(/^\t\tmode:\s*(\w+)/m)?.[1] || null;
    tables[name] = {
      mode,
      entity: unq(part0.match(/^\t\t\tentityName:\s*(.+)$/m)?.[1] || ''),
      schema: unq(part0.match(/^\t\t\tschemaName:\s*(.+)$/m)?.[1] || ''),
      expression: unq(part0.match(/^\t\t\texpressionSource:\s*(.+)$/m)?.[1] || ''),
      columns: cols,
    };
  }
  return { exprs, tables };
}

function encodeText(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

// Reading a definition takes Fabric about 20 seconds; fixing data doesn't change it, so it is kept for a while.
const defCache = new Map();
async function modelDefinition(ws, id) {
  const hit = defCache.get(id);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.def;
  const def = parseTmdl((await F.getDefinition(ws, id))?.parts || []);
  defCache.set(id, { at: Date.now(), def });
  return def;
}

function tableNameOfTmdl(text, fallback = '') {
  return unq(String(text || '').replace(/\r\n/g, '\n').match(/^table\s+(.+)$/m)?.[1] || fallback);
}

function hideColumnsInTableTmdl(text, columns) {
  const want = new Set([...columns].map((x) => String(x).toLowerCase()));
  if (!want.size) return { text, hidden: [], already: [] };
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const hidden = [];
  const already = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\tcolumn\s+(.+?)\s*$/);
    if (!m) continue;
    const col = unq(m[1].split('=')[0]);
    if (!want.has(col.toLowerCase())) continue;
    let end = i + 1;
    while (end < lines.length && !/^\t(?:column|measure|partition|hierarchy|annotation|calculationGroup)\b/.test(lines[end])) end++;
    if (lines.slice(i + 1, end).some((l) => /^\t\tisHidden\b/.test(l))) { already.push(col); continue; }
    let insertAt = i + 1;
    for (let j = i + 1; j < end; j++) if (/^\t\tdataType:/.test(lines[j])) { insertAt = j + 1; break; }
    lines.splice(insertAt, 0, '\t\tisHidden');
    hidden.push(col);
    i = insertAt;
  }
  return { text: lines.join('\n'), hidden, already };
}

/** The item behind an expression: Sql.Database("server", "database") or a OneLake URL with workspace and item ids. */
function sourceOfExpression(expr) {
  const s = String(expr || '');
  const sql = s.match(/Sql\.Database\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"/i);
  if (sql) return { server: sql[1], database: sql[2] };
  const lake = s.match(/onelake\.dfs\.fabric\.microsoft\.com\/([0-9a-f-]{36})\/([0-9a-f-]{36})/i);
  if (lake) return { workspaceId: lake[1], itemId: lake[2] };
  return null;
}

/** The Fabric item behind a source (to know whether it can be changed with T-SQL). */
async function itemFor(src, modelWs) {
  const tryGet = async (ws, id) => { try { return await F.getItem(ws, id); } catch { return null; } };
  const id = src.itemId || (GUID.test(src.database || '') ? src.database : null);
  if (id) {
    const it = await tryGet(src.workspaceId || modelWs, id);
    if (it) return { ...it, workspaceId: it.workspaceId || src.workspaceId || modelWs };
  }
  // A database name: find the item with that name in the model's workspace.
  if (src.database) {
    const items = await F.listItems(modelWs).catch(() => []);
    const hit = items.find((i) => ['Warehouse', 'Lakehouse', 'SQLEndpoint', 'MirroredDatabase', 'SQLDatabase'].includes(i.type) && i.displayName.toLowerCase() === src.database.toLowerCase());
    if (hit) return { ...hit, workspaceId: modelWs };
  }
  return null;
}

/** The SQL connection for a source: the server in the expression, or the item's SQL analytics endpoint. */
async function connectionFor(src, item) {
  if (src.server) return { server: src.server, database: src.database };
  if (item) {
    const ep = await F.waitSqlEndpoint(item.workspaceId, item.id, item.type, { timeoutMs: 60000 });
    return { server: ep.server, database: ep.database };
  }
  return null;
}

/**
 * The Fabric items a semantic model reads (lakehouse, warehouse, mirrored or SQL database), from its definition. A
 * lakehouse's SQL analytics endpoint stands for the lakehouse. Reading the definition needs write access to the model.
 */
export async function modelSourceItems(ws, id) {
  const def = await modelDefinition(ws, id);
  const used = [...new Set(Object.values(def.tables).map((t) => t.expression).filter((n) => n && def.exprs[n]))];
  const out = new Map();
  for (const name of used.length ? used : Object.keys(def.exprs)) {
    const src = sourceOfExpression(def.exprs[name]);
    if (!src) continue;
    let it = await itemFor(src, ws);
    if (it?.type === 'SQLEndpoint') {
      const lake = (await F.listItems(it.workspaceId).catch(() => [])).find((i) => i.type === 'Lakehouse' && i.displayName === it.displayName);
      if (lake) it = { ...lake, workspaceId: it.workspaceId };
    }
    if (it && !out.has(it.id)) out.set(it.id, { id: it.id, type: it.type, name: it.displayName, workspaceId: it.workspaceId });
  }
  return [...out.values()];
}

// ---------------- the check ----------------

const count = (v) => Number(v ?? 0);

/** Check every relationship of a model: is the key on the "one" side unique in the data the model reads? */
export async function checkModel({ id, fresh = false } = {}) {
  await assertProjectTenant();
  const { m, ws } = modelFor(id);
  if (fresh) defCache.delete(m.id);
  const rels = await dax(ws, m.id, 'EVALUATE SELECTCOLUMNS(INFO.VIEW.RELATIONSHIPS(), "From", [FromTable], "FromColumn", [FromColumn], "To", [ToTable], "ToColumn", [ToColumn], "Active", [IsActive], "FromCard", [FromCardinality], "ToCard", [ToCardinality])')
    .catch((e) => { throw new Error(`The model's relationships couldn't be read (${e.message.split('\n')[0].slice(0, 200)}). Check that its capacity is running and that you have Build permission.`); });
  // The key that must be unique: the "One" side of a relationship.
  const keys = [];
  for (const r of rels) {
    if (r.ToCard === 'One') keys.push({ table: r.To, column: r.ToColumn, rel: `${r.From}[${r.FromColumn}] → ${r.To}[${r.ToColumn}]`, active: r.Active !== false });
    if (r.FromCard === 'One' && r.ToCard === 'One') keys.push({ table: r.From, column: r.FromColumn, rel: `${r.To}[${r.ToColumn}] → ${r.From}[${r.FromColumn}]`, active: r.Active !== false });
  }
  const result = { model: { id: m.id, name: m.name, workspaceId: ws, origin: m.origin || 'studio' }, relationships: rels.length, keys: [], sources: [], problems: 0, fixable: 0, unchecked: 0, notes: [] };
  if (!keys.length) { result.notes.push('The model has no relationships with a "one" side, so there is nothing to check.'); return result; }

  let def;
  try { def = await modelDefinition(ws, m.id); } catch (e) {
    const why = e.message.split('\n')[0].slice(0, 200);
    result.notes.push(isNetworkError(e)
      ? `The model's definition couldn't be read: ${why} Select Check again.`
      : [401, 403].includes(e.status)
        ? `The model's definition couldn't be read (${why}), so its tables can't be traced to the data. Reading it needs Contributor or higher in ${m.workspaceName || 'its workspace'} (or Write permission on the model).`
        : `The model's definition couldn't be read (${why}), so its tables can't be traced to the data. Select Check again; if it keeps failing, check that the model still exists in ${m.workspaceName || 'its workspace'}.`);
    return result;
  }
  // One connection per data source for the whole check (opening one takes several seconds).
  const conns = new Map();
  const pools = [];
  const sourceFor = (exprName) => {
    if (!conns.has(exprName)) conns.set(exprName, openSource(exprName));
    return conns.get(exprName);
  };
  const openSource = async (exprName) => {
    const src = sourceOfExpression(def.exprs[exprName]);
    let out = null;
    if (src) {
      const item = await itemFor(src, ws);
      const conn = await connectionFor(src, item).catch(() => null);
      if (conn) {
        let release;
        const ready = new Promise((resolveReady, rejectReady) => {
          const held = withPool(conn, (pool) => { resolveReady(pool); return new Promise((r) => { release = r; }); });
          held.catch(rejectReady);
          pools.push({ held, release: () => release?.() });
        });
        out = { conn, item, src, pool: await ready.catch(() => null) };
        if (!out.pool) out = null;
      }
    }
    return out;
  };

  // Tables are checked in parallel (the connection runs up to 4 queries at a time); the list keeps the model's order.
  const checkKey = async (k, row) => {
    const t = def.tables[k.table];
    if (!t || !t.entity) { row.status = 'unknown'; row.reason = t ? `${k.table} isn't read from a table (calculated or import query), so it can't be checked here.` : `${k.table} wasn't found in the model definition.`; return; }
    const s = await sourceFor(t.expression);
    if (!s) { row.status = 'unknown'; row.reason = `The source of ${k.table} couldn't be reached.`; return; }
    const schema = t.schema || 'dbo';
    const colDef = t.columns[k.column] || { source: k.column, text: false };
    Object.assign(row, {
      schema, entity: t.entity, sourceColumn: colDef.source, sourceTable: `${schema}.${t.entity}`,
      source: { server: s.conn.server, database: s.conn.database, itemId: s.item?.id || null, itemName: s.item?.displayName || s.conn.database, itemType: s.item?.type || null, workspaceId: s.item?.workspaceId || null },
    });
    row.fixKey = `${row.source.itemId || `${s.conn.server}/${s.conn.database}`}:${row.sourceTable}`.toLowerCase();
    const T = `${q(schema)}.${q(t.entity)}`;
    const C = q(colDef.source);
    // The model compares text without regard to letter case ("ab-1" and "AB-1" are one key), so text keys are
    // counted the same way.
    const K = colDef.text ? `UPPER(${C})` : C;
    // Only SELECTs the studio writes itself, with quoted names.
    const sel = async (text) => (await s.pool.request().query(text)).recordset || [];
    try {
      const st = (await sel(`SELECT COUNT_BIG(*) AS r, COUNT_BIG(DISTINCT ${K}) AS k, SUM(CASE WHEN ${C} IS NULL THEN 1 ELSE 0 END) AS e FROM ${T}`))[0];
      row.rows = count(st.r);
      row.keys = count(st.k);
      row.emptyKeys = count(st.e);
      if (row.rows - row.emptyKeys > row.keys) {
        const d = (await sel(`SELECT COUNT_BIG(*) AS dk, SUM(c) AS dr FROM (SELECT ${K} AS v, COUNT_BIG(*) AS c FROM ${T} WHERE ${C} IS NOT NULL GROUP BY ${K} HAVING COUNT_BIG(*) > 1) x`))[0];
        row.duplicateKeys = count(d.dk);
        row.extraRows = count(d.dr) - count(d.dk);
        row.sample = (await sel(`SELECT TOP 5 MIN(${C}) AS v, COUNT_BIG(*) AS c FROM ${T} WHERE ${C} IS NOT NULL GROUP BY ${K} HAVING COUNT_BIG(*) > 1 ORDER BY COUNT_BIG(*) DESC`)).map((x) => ({ value: x.v, rows: count(x.c) }));
        // Exact copies: every repeated key's rows are identical byte for byte (text compared with its letter case
        // and trailing spaces), so removing the copies changes no number.
        try {
          const cols = (await s.pool.request().input('s', schema).input('t', t.entity)
            .query('SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t ORDER BY ORDINAL_POSITION')).recordset || [];
          const exact = cols.map((x, i) => `${/char|text/i.test(x.type) ? `HASHBYTES('SHA2_256', ${q(x.name)})` : q(x.name)} AS c${i}`).join(', ');
          if (!exact) throw new Error('no columns');
          const n = async (text) => count((await sel(text))[0].n);
          row.distinctRows = await n(`SELECT COUNT_BIG(*) AS n FROM (SELECT DISTINCT * FROM ${T}) x`);
          // Byte-exact distinct rows: with a key, and in the whole table.
          const strict = await n(`SELECT COUNT_BIG(*) AS n FROM (SELECT DISTINCT ${exact} FROM ${T} WHERE ${C} IS NOT NULL) x`);
          const strictAll = await n(`SELECT COUNT_BIG(*) AS n FROM (SELECT DISTINCT ${exact} FROM ${T}) x`);
          // Keys as written (letter case kept); the model sees row.keys of them.
          const sensitive = colDef.text ? await n(`SELECT COUNT_BIG(DISTINCT ${C}) AS n FROM ${T}`) : row.keys;
          row.caseKeys = Math.max(0, sensitive - row.keys);
          row.copyRows = Math.max(0, row.rows - row.emptyKeys - strict);
          row.exactCopies = strict === row.keys;
          // The fix rebuilds the whole table with DISTINCT *: only when that keeps every row that isn't an exact copy.
          row.safeDistinct = strictAll === row.distinctRows;
          if (!row.exactCopies && strict === sensitive) row.caseOnly = true;
        } catch { row.exactCopies = null; }
        row.status = 'duplicates';
      }
      if (row.emptyKeys > 1 && row.status === 'ok') row.status = 'warn';
    } catch (e) { row.status = 'unknown'; row.reason = `Couldn't read ${row.sourceTable}: ${e.message.split('\n')[0].slice(0, 200)}`; return; }
    if (row.status === 'duplicates') {
      const type = s.item?.type;
      const nf = (x) => Number(x).toLocaleString('en-US');
      if (row.exactCopies && row.safeDistinct && type === 'Warehouse') row.fix = 'dedupe';
      row.reason = row.exactCopies
        ? `${nf(row.duplicateKeys)} ${k.column} values have ${nf(row.extraRows)} extra rows that are exact copies – removing them changes no number.`
        : row.caseOnly
          ? `${nf(row.caseKeys)} ${k.column} value${row.caseKeys === 1 ? ' is' : 's are'} written with different letter case (for example "ab" and "AB"); the model treats them as the same key. Make the spelling consistent in the source${row.copyRows ? `, and remove the ${nf(row.copyRows)} extra rows that are exact copies` : ''}.`
          : `${nf(row.duplicateKeys)} ${k.column} values repeat with different values in other columns, so the right row has to be chosen in the source.`;
      if (row.exactCopies && type === 'Warehouse' && !row.safeDistinct) {
        row.reason += ' Rows with an empty key differ only by letter case or trailing spaces, so the studio won\'t rebuild the table – remove the copies where the data is loaded.';
      }
      if (row.exactCopies && type !== 'Warehouse') {
        row.reason += type ? ` The ${ITEM_LABEL[type] || type} ${s.item.displayName} can't be changed with T-SQL from the studio – remove the copies where the data is loaded (notebook, pipeline or the source database).` : '';
      }
    }
    if (row.status === 'warn') row.reason = `${row.emptyKeys.toLocaleString('en-US')} rows have an empty ${k.column}; the model treats them as one blank key.`;
  };
  try {
    const rows = keys.map((k) => ({ ...k, sourceTable: null, source: null, rows: null, keys: null, duplicateKeys: 0, extraRows: 0, emptyKeys: 0, exactCopies: null, status: 'ok', fix: null, reason: null, sample: [], modelRows: null, stale: false }));
    result.keys.push(...rows);
    await Promise.all(keys.map((k, i) => checkKey(k, rows[i])));
  } finally {
    for (const x of pools) x.release();
    await Promise.allSettled(pools.map((x) => x.held));
  }
  // What the model holds: after the data changed (rows removed in the warehouse) it keeps the old rows until it is
  // reloaded – the data then looks fine while every query still fails. Only a warehouse count is current at once; a
  // lakehouse or mirrored database is counted through its SQL endpoint, which can lag behind what the model reads.
  const tables = [...new Set(result.keys.filter((r) => r.rows !== null && r.status !== 'unknown').map((r) => r.table))];
  const held = await modelRowCounts(ws, m.id, tables).catch(() => null);
  if (held) {
    for (const r of result.keys) {
      if (held[r.table] === undefined || r.rows === null) continue;
      r.modelRows = held[r.table];
      r.stale = r.modelRows !== r.rows && r.source?.itemType === 'Warehouse';
    }
    result.stale = new Set(result.keys.filter((r) => r.stale).map((r) => r.table)).size;
  } else result.stale = 0;
  // The same table (in the same source) can be the "one" side of several relationships: fix it once.
  const fixTables = new Set();
  const seenSources = new Map();
  for (const r of result.keys) {
    if (r.status === 'duplicates') result.problems += 1;
    if (r.status === 'unknown') result.unchecked += 1;
    if (r.source) seenSources.set(`${r.source.server}|${r.source.database}`.toLowerCase(), r.source);
    if (r.fix && !fixTables.has(r.fixKey)) { fixTables.add(r.fixKey); result.fixable += 1; } else if (r.fix) r.fix = 'same-table';
  }
  result.sources = [...seenSources.values()];
  return result;
}

/** One line for the job log and Copilot: what the check found. */
export function checkSummary(r) {
  if (!r) return 'The model couldn\'t be checked again.';
  if (r.problems) return `${r.problems} relationship${r.problems === 1 ? '' : 's'} still ha${r.problems === 1 ? 's' : 've'} repeated keys`;
  if (r.stale) return `The data is fine, but the model still holds older rows in ${r.stale} table${r.stale === 1 ? '' : 's'} – reload it`;
  if (!r.keys.length || r.unchecked) return `${r.unchecked || 'The'} relationship${r.unchecked === 1 ? '' : 's'} couldn't be checked${r.notes.length ? ` – ${r.notes.join(' ')}` : ''}`;
  return 'Every relationship key is unique now';
}

// ---------------- what the model holds, and reloading it ----------------

/** Rows of each checked model table in its data: { modelTable: rows } (warehouse tables – their count is current). */
function expectedRows(check) {
  const out = {};
  for (const r of check.keys) if (r.rows !== null && r.status !== 'unknown' && r.source?.itemType === 'Warehouse') out[r.table] = r.rows;
  return out;
}

/** Rows the model holds in each table (one DAX query). Works while relationships are broken. */
async function modelRowCounts(ws, id, tables) {
  if (!tables.length) return {};
  const cols = tables.map((t, i) => `"c${i}", COUNTROWS('${String(t).replace(/'/g, "''")}')`).join(', ');
  const row = (await dax(ws, id, `EVALUATE ROW(${cols})`))?.[0] || {};
  const pick = (i) => row[`c${i}`] ?? row[`[c${i}]`];
  return Object.fromEntries(tables.map((t, i) => [t, pick(i) === undefined || pick(i) === null ? undefined : count(pick(i))]));
}

/**
 * Reload (reframe or refresh) a model until it holds the rows its tables have in the data. A change in a warehouse
 * takes a little while to reach OneLake, where a Direct Lake model reads it: a reload right after the change can still
 * see the old rows. expected: { modelTable: rows }. Returns true when the model is current (or can't be compared).
 */
async function reloadUntilCurrent(ctx, { workspaceId, id, name }, expected, { firstWaitMs = 0, attempts = 5 } = {}) {
  const tables = Object.keys(expected);
  const nf = (x) => Number(x).toLocaleString('en-US');
  if (firstWaitMs) await sleep(firstWaitMs);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    const r = await refreshDataset(workspaceId, id, { signal: ctx.signal, timeoutMs: 6 * 60 * 1000 });
    if (r.status !== 'Completed') { ctx.log(`Model refresh: ${r.status}${r.error ? ` – ${String(r.error).slice(0, 300)}` : ''}`); return false; }
    const held = await modelRowCounts(workspaceId, id, tables).catch(() => null);
    if (!held) { ctx.log(`${name} reloaded`); return true; }
    const behind = tables.filter((t) => held[t] !== undefined && held[t] !== expected[t]);
    if (!behind.length) { ctx.log(`${name} reloaded and holds the current data`); return true; }
    const what = behind.map((t) => `${t}: ${nf(held[t])} rows (the data has ${nf(expected[t])})`).join(', ');
    if (attempt === attempts) { ctx.log(`${name} still holds older rows – ${what}. Wait a few minutes, then select "Reload the model" in the check.`); return false; }
    ctx.log(`${name} still holds older rows – ${what}. The change hasn't reached OneLake yet; reloading again in 20 seconds (attempt ${attempt + 1} of ${attempts}).`);
    await sleep(20000);
  }
  return false;
}

/** Job: reload a model whose data changed (for example after duplicates were removed) and check it again. */
export async function runReloadModel(ctx, { id } = {}) {
  ctx.step('Check the tables the model is built on');
  const check = await checkModel({ id });
  ctx.progress(30);
  ctx.step(`Reload ${check.model.name}`);
  const current = await reloadUntilCurrent(ctx, { workspaceId: check.model.workspaceId, id: check.model.id, name: check.model.name }, expectedRows(check));
  resetProfileCache();
  ctx.progress(85);
  ctx.step('Check again');
  const after = await checkModel({ id: check.model.id }).catch(() => null);
  ctx.log(checkSummary(after));
  logActivity('model.reload', `Reloaded ${check.model.name}${current ? '' : ' (it still holds older rows)'}`, { semanticModelId: check.model.id });
  return { reloaded: current, stale: after?.stale ?? null, remaining: after?.problems ?? null };
}

/** Job: hide all columns used by model relationships (both keys and foreign keys), keeping relationships intact. */
export async function runHideRelationshipKeys(ctx, { id } = {}) {
  ctx.step('Read the model relationships');
  await assertProjectTenant();
  const { m, ws } = modelFor(id);
  if (m.origin === 'existing') throw fail('This is an existing semantic model the studio did not create. The studio will not change it.');
  const rels = await dax(ws, m.id, 'EVALUATE SELECTCOLUMNS(INFO.VIEW.RELATIONSHIPS(), "FromTable", [FromTable], "FromColumn", [FromColumn], "ToTable", [ToTable], "ToColumn", [ToColumn], "Active", [IsActive])');
  const colsByTable = new Map();
  for (const r of rels || []) {
    for (const [table, column] of [[r.FromTable, r.FromColumn], [r.ToTable, r.ToColumn]]) {
      if (!table || !column) continue;
      const key = String(table).toLowerCase();
      if (!colsByTable.has(key)) colsByTable.set(key, { table: String(table), columns: new Set() });
      colsByTable.get(key).columns.add(String(column));
    }
  }
  if (!colsByTable.size) throw fail(`${m.name} has no relationships, so there are no relationship key columns to hide.`);
  ctx.progress(20);

  ctx.step('Read the model definition');
  const definition = await F.getDefinition(ws, m.id, 'TMDL');
  const parts = (definition?.parts || []).map((p) => ({ ...p }));
  let changed = 0;
  let already = 0;
  const details = [];
  for (const p of parts) {
    const file = String(p.path || '');
    if (!/^definition\/tables\/.+\.tmdl$/i.test(file) || !p.payload) continue;
    const text = decodeText(Buffer.from(p.payload, 'base64'));
    const table = tableNameOfTmdl(text, file.replace(/^definition\/tables\/|\.tmdl$/gi, ''));
    const spec = colsByTable.get(table.toLowerCase());
    if (!spec) continue;
    const next = hideColumnsInTableTmdl(text, spec.columns);
    if (next.hidden.length) {
      p.payload = encodeText(next.text);
      p.payloadType = 'InlineBase64';
      changed += next.hidden.length;
      details.push(`${table}: ${next.hidden.join(', ')}`);
    }
    already += next.already.length;
  }
  if (!changed) {
    ctx.log(already ? `All ${already} relationship key column${already === 1 ? '' : 's'} were already hidden.` : 'No matching relationship columns were found in the TMDL definition.');
    return { changed: 0, already };
  }
  ctx.progress(55);

  ctx.step(`Update ${m.name}`);
  await F.updateDefinition(ws, m.id, { ...definition, parts });
  defCache.delete(m.id);
  resetProfileCache();
  for (const d of details) ctx.log(`Hidden ${d}`);
  logActivity('model.hide-keys', `Hid ${changed} relationship key column${changed === 1 ? '' : 's'} in ${m.name}`, { semanticModelId: m.id });
  return { changed, already, tables: details.length };
}

// ---------------- the fix ----------------

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

/**
 * Remove exact duplicate rows from warehouse tables a model reads, keeping a backup copy of each table, one
 * transaction per warehouse (all or nothing there). Then reframe or refresh the model and check again. Only tables the
 * check found with exact copies in a Fabric warehouse are changed, each in the warehouse the model reads it from.
 * tables: fixKey values from the check (or schema.table names).
 */
export async function runFixDuplicates(ctx, { id, tables } = {}) {
  ctx.step('Check the tables the model is built on');
  const check = await checkModel({ id, fresh: true });
  const want = new Set((tables || []).map((t) => String(t).toLowerCase()));
  const fixes = check.keys.filter((k) => k.fix === 'dedupe' && (!want.size || want.has(k.fixKey) || want.has(k.sourceTable.toLowerCase())));
  if (!fixes.length) {
    const left = check.keys.filter((k) => k.status === 'duplicates');
    throw new Error(left.length ? `Nothing the studio can fix here: ${left.map((k) => k.reason).join(' ')}` : 'No duplicate keys found – the model\'s relationships are fine.');
  }
  // One transaction per warehouse.
  const groups = new Map();
  for (const f of fixes) {
    const g = `${f.source.server}|${f.source.database}`.toLowerCase();
    if (!groups.has(g)) groups.set(g, { source: f.source, fixes: [] });
    groups.get(g).fixes.push(f);
  }
  ctx.log(`${check.model.name}: fixing ${fixes.map((f) => `${f.sourceTable} in ${f.source.itemName}`).join(', ')}`);
  ctx.progress(20);

  const at = stamp();
  const done = [];
  ctx.step(`Remove exact duplicate rows (backup first, one transaction per warehouse)`);
  for (const { source, fixes: list } of groups.values()) {
    try {
      await withPool({ server: source.server, database: source.database }, async (pool) => {
        const tx = pool.transaction();
        await tx.begin();
        const here = [];
        try {
          for (const f of list) {
            const backup = `${f.entity}_backup_${at}`.slice(0, 120);
            const work = `${f.entity}_dedup_${at}`.slice(0, 120);
            const S = q(f.schema);
            const run = (sqlText) => tx.request().query(sqlText);
            await run(`CREATE TABLE ${S}.${q(backup)} AS SELECT * FROM ${S}.${q(f.entity)}`);
            await run(`CREATE TABLE ${S}.${q(work)} AS SELECT DISTINCT * FROM ${S}.${q(f.entity)}`);
            const kept = count((await run(`SELECT COUNT_BIG(*) AS n FROM ${S}.${q(work)}`)).recordset[0].n);
            if (kept !== f.distinctRows) throw new Error(`${f.sourceTable}: expected ${f.distinctRows} distinct rows, found ${kept} – the table changed while it was being fixed.`);
            await run(`TRUNCATE TABLE ${S}.${q(f.entity)}`);
            await run(`INSERT INTO ${S}.${q(f.entity)} SELECT * FROM ${S}.${q(work)}`);
            await run(`DROP TABLE ${S}.${q(work)}`);
            here.push({ fixKey: f.fixKey, table: f.sourceTable, modelTable: f.table, warehouse: source.itemName, before: f.rows, after: kept, removed: f.rows - kept, backup: `${f.schema}.${backup}` });
          }
          await tx.commit();
        } catch (e) {
          await tx.rollback().catch(() => {});
          throw e;
        }
        for (const d of here) {
          done.push(d);
          ctx.log(`${d.table} in ${d.warehouse}: ${d.before.toLocaleString('en-US')} → ${d.after.toLocaleString('en-US')} rows (${d.removed.toLocaleString('en-US')} copies removed) · backup ${d.backup}`);
        }
      });
    } catch (e) {
      const msg = `Nothing was changed in ${source.itemName} (the transaction was rolled back): ${e.message.split('\n')[0]}`;
      if (!done.length) throw new Error(msg);
      ctx.log(msg);
    }
  }
  ctx.progress(65);
  logActivity('model.fix', `Removed exact duplicate rows from ${done.map((d) => `${d.table} (${d.warehouse})`).join(', ')} for ${check.model.name} (backups kept)`, { semanticModelId: check.model.id });

  ctx.step(`Reload ${check.model.name}`);
  // The model must read the fixed tables: until it reloads after the change has reached OneLake, it keeps the copies.
  // Every model table that reads a fixed warehouse table counts – also a second one on the same table (a role-playing
  // dimension, marked 'same-table' in the check), which would otherwise look behind for ever.
  const expected = expectedRows(check);
  const fixed = new Map(done.map((d) => [d.fixKey, d]));
  const tried = new Set(fixes.map((f) => f.fixKey));
  for (const r of check.keys) {
    if (!r.fixKey || !tried.has(r.fixKey)) continue;
    const d = fixed.get(r.fixKey);
    if (d) expected[r.table] = d.after;
    else delete expected[r.table];
  }
  try {
    await reloadUntilCurrent(ctx, { workspaceId: check.model.workspaceId, id: check.model.id, name: check.model.name }, expected, { firstWaitMs: 10000 });
  } catch (e) { ctx.log(`The model couldn't be reloaded (${e.message.split('\n')[0].slice(0, 200)}) – select "Reload the model" in the check, or refresh it in Fabric.`); }
  resetProfileCache();
  ctx.progress(85);

  ctx.step('Check again');
  const after = await checkModel({ id: check.model.id }).catch(() => null);
  ctx.log(checkSummary(after));
  ctx.log('The backup tables stay in the warehouse until you drop them (DROP TABLE …) once the numbers look right.');
  return { fixed: done, remaining: after?.problems ?? null, stale: after?.stale ?? null, unchecked: after?.unchecked ?? null };
}
/** Plain-language hint for an error a model query returned (used by the UI and Copilot). */
export function explainModelError(message) {
  const m = String(message || '').replace(/<\/?oii>/g, '');
  const dup = m.match(/Column '([^']+)' in Table '([^']+)' contains a duplicate value '([^']*)'/i);
  if (dup) return { kind: 'duplicates', table: dup[2], column: dup[1], value: dup[3], text: `${dup[2]}[${dup[1]}] has repeated values (for example ${dup[3]}), but it is the "one" side of a relationship, so every query that uses the relationship fails. Check the model to see which tables are affected and fix them.` };
  return null;
}
