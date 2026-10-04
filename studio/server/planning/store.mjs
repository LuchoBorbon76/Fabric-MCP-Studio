// Plan storage: writes plan rows next to the model's data so the Direct Lake model can read them – a "planning" schema
// in a Fabric SQL database (replicated to OneLake) or a Fabric warehouse, written over TDS with the user's Entra token.
// A lakehouse's SQL analytics endpoint is read-only, so for a lakehouse the rows go to a planning warehouse in the
// project workspace and a OneLake shortcut in the lakehouse (Tables/PlanValues) lets the model read them in place.
import * as F from '../fabric.mjs';
import { withPool } from '../sql.mjs';
import { sleep } from '../config.mjs';
import { recordArtifact, updateProject, getProject } from '../project.mjs';
import { standardName } from '../naming.mjs';

export const PLAN_SCHEMA = 'planning';
export const PLAN_TABLE = 'PlanValues';
const q = (n) => `[${String(n).replace(/]/g, ']]')}]`;
const FIXED = ['Scenario', 'PlanYear', 'MonthNumber', 'PeriodStart', 'Amount', 'ClosedPeriod', 'UpdatedAt'];

/** Why plan values can't be stored for a data source (null when they can). Shown on the Planning page and to Copilot. */
export function planStoreProblem(ms) {
  if (!ms) return 'Connect a data source and create the semantic model first.';
  if (['SQLDatabase', 'Warehouse', 'Lakehouse'].includes(ms.itemType)) return null;
  if (ms.itemType === 'MirroredDatabase') {
    return `Your semantic model reads ${ms.itemName}, a mirrored database. A mirrored database is a read-only copy that only Fabric mirroring writes to, and a Direct Lake model reads every table from that one item – so the budget and forecast rows have nowhere to go. To plan, bring the mirrored tables into a lakehouse with OneLake shortcuts (Data page › Existing Fabric data › pick ${ms.itemName} › Create shortcuts), rebuild the semantic model on that lakehouse, and plan again.`;
  }
  return `Your semantic model reads a ${ms.itemType}, where the studio can't store plan values. Plans work on a lakehouse, a warehouse or a Fabric SQL database.`;
}

/** Where plan rows go for the project's data source (or why they can't be written). */
export async function planTarget(p) {
  const ms = p.modelSource;
  const problem = planStoreProblem(ms);
  if (problem) throw new Error(problem);
  const source = { schema: PLAN_SCHEMA, table: PLAN_TABLE };
  if (ms.itemType === 'SQLDatabase') {
    const db = await F.getSqlDatabase(ms.workspaceId || p.workspace.id, ms.itemId);
    const props = db.properties || {};
    if (!props.serverFqdn || !props.databaseName) throw new Error('The SQL database has no connection details yet. Try again in a minute.');
    return { kind: 'SQLDatabase', label: `${ms.itemName} (Fabric SQL database)`, write: { server: props.serverFqdn, database: props.databaseName }, read: { server: ms.server, database: ms.database, endpointId: ms.endpointId }, workspaceId: ms.workspaceId || p.workspace.id, text: 'nvarchar(400)', replicated: true, source };
  }
  if (ms.itemType === 'Warehouse') {
    return { kind: 'Warehouse', label: `${ms.itemName} (warehouse)`, write: { server: ms.server, database: ms.database }, read: { server: ms.server, database: ms.database }, workspaceId: ms.workspaceId || p.workspace.id, text: 'varchar(400)', replicated: false, source };
  }
  // Lakehouse: the rows live in a planning warehouse; the lakehouse gets a shortcut to them.
  const lakehouse = { workspaceId: ms.workspaceId || p.workspace.id, id: ms.itemId, name: ms.itemName };
  let schema = null;
  try { schema = (await F.getLakehouse(lakehouse.workspaceId, lakehouse.id))?.properties?.defaultSchema || null; } catch { schema = null; }
  // The warehouse and shortcut are remembered as soon as they exist (planStore), so a run that stops halfway is continued
  // and clean up still finds them.
  const prev = p.planning?.target?.kind === 'Lakehouse' ? p.planning.target : null;
  const stored = p.planStore?.warehouse && p.planStore.workspaceId === p.workspace.id ? p.planStore.warehouse : null;
  return {
    kind: 'Lakehouse',
    label: `${ms.itemName} (lakehouse) through the planning warehouse`,
    lakehouse, schema,
    warehouse: prev?.warehouse || stored || null,
    shortcut: { path: schema ? `Tables/${schema}` : 'Tables', name: PLAN_TABLE },
    read: { server: ms.server, database: ms.database, endpointId: ms.endpointId },
    workspaceId: p.workspace.id,
    text: 'varchar(400)', replicated: true,
    source: { schema: schema || 'dbo', table: PLAN_TABLE },
  };
}

/** For a lakehouse: create (or find) the planning warehouse in the project workspace and connect to it. */
export async function preparePlanStore(ctx, target) {
  if (target.kind !== 'Lakehouse') return target;
  const ws = target.workspaceId;
  let wh = target.warehouse?.id ? await F.getItem(ws, target.warehouse.id).catch(() => null) : null;
  const name = wh?.displayName || target.warehouse?.name || standardName('Warehouse', 'Planning');
  wh ||= await F.findItem(ws, 'Warehouse', name);
  let created = false;
  if (!wh) {
    ctx.log(`A lakehouse's SQL endpoint is read-only, so the plan values go to a warehouse: creating ${name}`);
    wh = await F.createItem(ws, { name, type: 'Warehouse', description: 'Budget and forecast values written by Fabric MCP Studio; the lakehouse reads them through a OneLake shortcut.' });
    if (!wh?.id) throw new Error('Fabric did not return the planning warehouse.');
    recordArtifact({ type: 'Warehouse', id: wh.id, name, workspaceId: ws, note: 'Plan values (planning)' });
    created = true;
    updateProject({ planStore: { workspaceId: ws, warehouse: { id: wh.id, name, created: true } } });
  } else ctx.log(`Plan values go to the warehouse ${name}`);
  const ep = await F.waitSqlEndpoint(ws, wh.id, 'Warehouse', { signal: ctx.signal });
  target.warehouse = { id: wh.id, name, created: created || Boolean(target.warehouse?.created) };
  target.write = { server: ep.server, database: ep.database };
  target.label = `${name} (warehouse), read by ${target.lakehouse.name} through a shortcut`;
  return target;
}

/** For a lakehouse: the shortcut Tables/PlanValues → the warehouse's planning.PlanValues Delta table. */
export async function linkPlanTable(ctx, target) {
  if (target.kind !== 'Lakehouse') return;
  const path = `Tables/${PLAN_SCHEMA}/${PLAN_TABLE}`;
  // The warehouse publishes the table to OneLake as Delta shortly after it is written.
  for (let i = 0; i < 36; i++) {
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    if (await F.oneLakePathExists(target.workspaceId, target.warehouse.id, `${path}/_delta_log`).catch(() => false)) break;
    if (i === 0) ctx.log('Waiting for the warehouse to publish the plan table to OneLake…');
    if (i === 35) throw new Error('The plan values are in the warehouse but it hasn\'t published them to OneLake yet. Run the plan again in a few minutes – it continues where it stopped.');
    await sleep(5000);
  }
  await F.createShortcut(target.lakehouse.workspaceId, target.lakehouse.id, { path: target.shortcut.path, name: target.shortcut.name, target: { oneLake: { workspaceId: target.workspaceId, itemId: target.warehouse.id, path } } });
  updateProject({ planStore: { ...(getProject().planStore || {}), workspaceId: target.workspaceId, warehouse: target.warehouse, lakehouse: target.lakehouse, shortcut: target.shortcut } });
  ctx.log(`Shortcut ${target.shortcut.path}/${PLAN_TABLE} in ${target.lakehouse.name} → ${target.warehouse.name}.${PLAN_SCHEMA}.${PLAN_TABLE}`);
  if (target.read.endpointId) await F.refreshSqlEndpoint(target.lakehouse.workspaceId, target.read.endpointId);
}

/** SQL column definitions for the plan table. columns: [{ name, sql }] for the date key and dimension keys. */
function ddl(target, keyCols) {
  const text = target.text.replace('400', '20');
  const cols = [
    `Scenario ${text} NOT NULL`, 'PlanYear int NOT NULL', 'MonthNumber int NOT NULL', 'PeriodStart date NOT NULL',
    ...keyCols.map((c) => `${q(c.name)} ${c.sql === 'nvarchar(400)' ? target.text : c.sql} NOT NULL`),
    'Amount decimal(19,4) NOT NULL', 'ClosedPeriod bit NOT NULL', 'UpdatedAt datetime2(0) NOT NULL',
  ];
  // Fabric SQL database only replicates tables with a primary key to OneLake.
  const pk = target.kind === 'SQLDatabase' ? `, CONSTRAINT PK_${PLAN_TABLE} PRIMARY KEY (Scenario, PlanYear, MonthNumber, ${keyCols.map((c) => q(c.name)).join(', ')})` : '';
  return `CREATE TABLE ${q(PLAN_SCHEMA)}.${q(PLAN_TABLE)} (${cols.join(', ')}${pk})`;
}

const lit = (v, sqlType) => {
  if (v === null || v === undefined) return 'NULL';
  if (/int|float|decimal/.test(sqlType)) { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`); return String(n); }
  if (sqlType === 'bit') return v ? '1' : '0';
  if (sqlType === 'date') return `'${String(v).slice(0, 10).replace(/'/g, '')}'`;
  return `N'${String(v).replace(/'/g, "''")}'`;
};

/**
 * Replace the plan year's rows. rows: [{ scenario, month, keys, v, closed }]; monthKeys: Map(month -> { key, date }).
 * keyCols: [{ name, sql }] – the date key first, then one per dimension (same order as row.keys).
 */
export async function writePlanRows(ctx, target, { planYear, rows, monthKeys, keyCols }) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const colNames = [...FIXED.slice(0, 4), ...keyCols.map((c) => c.name), ...FIXED.slice(4)];
  await withPool(target.write, async (pool) => {
    await pool.request().query(`IF SCHEMA_ID('${PLAN_SCHEMA}') IS NULL EXEC('CREATE SCHEMA ${q(PLAN_SCHEMA)}')`);
    const have = (await pool.request().query(`SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID('${PLAN_SCHEMA}.${PLAN_TABLE}')`)).recordset.map((r) => r.name);
    const same = have.length && colNames.length === have.length && colNames.every((n) => have.includes(n));
    if (have.length && !same) {
      ctx.log(`The plan table had other columns (${have.filter((n) => !FIXED.includes(n)).join(', ')}); recreating it for the new dimensions`);
      await pool.request().query(`DROP TABLE ${q(PLAN_SCHEMA)}.${q(PLAN_TABLE)}`);
    }
    if (!same) await pool.request().query(ddl(target, keyCols));
    await pool.request().query(`DELETE FROM ${q(PLAN_SCHEMA)}.${q(PLAN_TABLE)} WHERE PlanYear = ${Number(planYear)}`);
    const types = ['nvarchar', 'int', 'int', 'date', ...keyCols.map((c) => c.sql), 'decimal', 'bit', 'datetime2'];
    for (let i = 0; i < rows.length; i += 200) {
      if (ctx.signal?.aborted) throw new Error('Cancelled');
      const values = rows.slice(i, i + 200).map((r) => {
        const mk = monthKeys.get(r.month);
        const vals = [r.scenario, planYear, r.month, mk.date, mk.key, ...r.keys, r.v, r.closed, now];
        return `(${vals.map((v, j) => (types[j] === 'datetime2' ? `'${v}'` : lit(v, types[j]))).join(', ')})`;
      });
      await pool.request().query(`INSERT INTO ${q(PLAN_SCHEMA)}.${q(PLAN_TABLE)} (${colNames.map(q).join(', ')}) VALUES ${values.join(', ')}`);
    }
  });
  return { table: `${PLAN_SCHEMA}.${PLAN_TABLE}`, rows: rows.length };
}

/** Wait until the SQL analytics endpoint (what Direct Lake reads) shows the plan year's rows. */
export async function waitForPlanRows(ctx, target, { planYear, rows, total, timeoutMs = 12 * 60 * 1000 }) {
  if (!target.replicated) return;
  const src = target.source || { schema: PLAN_SCHEMA, table: PLAN_TABLE };
  const endpointWs = target.lakehouse?.workspaceId || target.workspaceId;
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (let i = 0; Date.now() < deadline; i++) {
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    if (i % 3 === 0 && target.read.endpointId) await F.refreshSqlEndpoint(endpointWs, target.read.endpointId);
    try {
      const r = await withPool({ server: target.read.server, database: target.read.database }, (pool) => pool.request().query(`SELECT COUNT_BIG(*) AS n, CAST(SUM(Amount) AS float) AS s FROM ${q(src.schema)}.${q(src.table)} WHERE PlanYear = ${Number(planYear)}`));
      const { n, s } = r.recordset[0];
      if (Number(n) === rows && Math.abs(Number(s) - total) < 1) return;
      const msg = `${target.kind === 'Lakehouse' ? 'Lakehouse SQL endpoint' : 'OneLake replica'}: ${Number(n)} of ${rows} plan rows`;
      if (msg !== last) { ctx.log(msg); last = msg; }
    } catch (e) {
      if (!/Invalid object|does not exist/i.test(e.message)) ctx.log(`Waiting for the SQL analytics endpoint: ${e.message.split('\n')[0]}`);
      else if (last !== 'pending') { ctx.log('Waiting for the plan table to reach the SQL analytics endpoint (usually 1–2 minutes)'); last = 'pending'; }
    }
    await sleep(10000);
  }
  throw new Error(`The plan values are in ${target.kind === 'Lakehouse' ? 'the planning warehouse' : 'the SQL database'} but the SQL analytics endpoint doesn't show them yet. Run the plan again in a few minutes – it continues where it stopped.`);
}

/**
 * Remove the stored plan values (when the plan is removed with its data). For a lakehouse: the shortcut, and the
 * planning warehouse when the studio created it (it holds nothing else); otherwise the plan table.
 */
export async function dropPlanTable(target) {
  if (target.kind === 'Lakehouse') {
    const lh = target.lakehouse;
    await F.fabric('DELETE', `/workspaces/${lh.workspaceId}/items/${lh.id}/shortcuts/${target.shortcut.path}/${target.shortcut.name}`).catch((e) => { if (e.status !== 404) throw e; });
    if (!target.warehouse?.id) return;
    if (target.warehouse.created) { await F.deleteItem(target.workspaceId, target.warehouse.id).catch((e) => { if (e.status !== 404) throw e; }); return; }
    // A warehouse the studio didn't create: only drop the plan table, and never create a warehouse to do it.
    const wh = await F.getItem(target.workspaceId, target.warehouse.id).catch(() => null);
    if (!wh) return;
    const ep = await F.waitSqlEndpoint(target.workspaceId, wh.id, 'Warehouse');
    target.write = { server: ep.server, database: ep.database };
  }
  await withPool(target.write, (pool) => pool.request().query(`IF OBJECT_ID('${PLAN_SCHEMA}.${PLAN_TABLE}') IS NOT NULL DROP TABLE ${q(PLAN_SCHEMA)}.${q(PLAN_TABLE)}`));
}

/** True for tables the studio writes plans to (left out of models and ontologies built from the source): planning.PlanValues, or the PlanValues shortcut in a lakehouse. */
export const isPlanTable = (t) => ['planning', 'dbo', ''].includes(String(t?.schema || '').toLowerCase()) && String(t?.name || t?.table || '').toLowerCase() === PLAN_TABLE.toLowerCase();
