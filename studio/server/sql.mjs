// Schema discovery for SQL Server family sources and Fabric SQL analytics endpoints (TDS via mssql/tedious).
import sql from 'mssql';
import { getToken, SCOPES } from './auth.mjs';

function poolConfig({ server, database, port, auth = {}, encrypt = true, trustServerCertificate = false, timeoutMs = 30000 }) {
  const cfg = {
    server: server.replace(/^tcp:/i, '').split(',')[0],
    port: Number(port) || Number(server.split(',')[1]) || 1433,
    database,
    options: { encrypt, trustServerCertificate, enableArithAbort: true },
    connectionTimeout: timeoutMs,
    requestTimeout: 300000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 10000 },
  };
  if (auth.type === 'Basic' || auth.type === 'sql') {
    cfg.user = auth.username; cfg.password = auth.password;
  } else if (auth.type === 'ServicePrincipal') {
    cfg.authentication = { type: 'azure-active-directory-service-principal-secret', options: { clientId: auth.clientId, clientSecret: auth.clientSecret, tenantId: auth.tenantId } };
  } else if (auth.type === 'Windows') {
    cfg.authentication = { type: 'ntlm', options: { userName: auth.username, password: auth.password, domain: auth.domain || '' } };
  } else {
    cfg.authentication = { type: 'azure-active-directory-access-token', options: { token: auth.token } };
  }
  return cfg;
}

export async function withPool(conn, fn) {
  const auth = { ...(conn.auth || {}) };
  if (!auth.type || auth.type === 'Entra' || auth.type === 'OAuth2') auth.token = await getToken(SCOPES.sql);
  let pool;
  // Azure SQL and Fabric SQL redirect to a worker node; that connection occasionally resets and succeeds on retry.
  for (let attempt = 1; ; attempt++) {
    pool = new sql.ConnectionPool(poolConfig({ ...conn, auth }));
    try { await pool.connect(); break; } catch (e) {
      await pool.close().catch(() => {});
      if (attempt >= 4 || !/ECONNRESET|ETIMEOUT|ESOCKET|ECONNREFUSED|Failed to connect/i.test(`${e.code || ''} ${e.message}`)) throw e;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  try { return await fn(pool); } finally { await pool.close().catch(() => {}); }
}

const SCHEMA_QUERY = `
SELECT s.name AS [schema], t.name AS [table], c.name AS [column], ty.name AS [type],
       c.max_length AS maxLength, c.precision, c.scale, c.is_nullable AS nullable, c.column_id AS ordinal,
       CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS isPk
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN (
  SELECT ic.object_id, ic.column_id FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  WHERE i.is_primary_key = 1
) pk ON pk.object_id = t.object_id AND pk.column_id = c.column_id
WHERE t.is_ms_shipped = 0 AND s.name NOT IN ('sys','INFORMATION_SCHEMA','queryinsights')
ORDER BY s.name, t.name, c.column_id;`;

const FK_QUERY = `
SELECT sp.name AS fromSchema, tp.name AS fromTable, cp.name AS fromColumn,
       sr.name AS toSchema, tr.name AS toTable, cr.name AS toColumn, fk.name AS name
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id JOIN sys.schemas sp ON sp.schema_id = tp.schema_id
JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id JOIN sys.schemas sr ON sr.schema_id = tr.schema_id
JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id;`;

const ROWCOUNT_QUERY = `
SELECT s.name AS [schema], t.name AS [table], SUM(p.rows) AS [rows]
FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
WHERE t.is_ms_shipped = 0 GROUP BY s.name, t.name;`;

/**
 * Discover tables, columns, keys and relationships.
 * @param conn { server, database, port?, auth?: { type: 'Entra'|'Basic'|'ServicePrincipal'|'Windows', ... } }
 * @param opts { fabricEndpoint?: boolean, exactCounts?: boolean }
 */
export async function discoverSqlServer(conn, { fabricEndpoint = false, exactCounts = false } = {}) {
  return withPool(conn, async (pool) => {
    const version = (await pool.request().query('SELECT @@VERSION AS v')).recordset[0]?.v?.split('\n')[0] || '';
    const cols = (await pool.request().query(SCHEMA_QUERY)).recordset;
    let fks = [];
    try { fks = (await pool.request().query(FK_QUERY)).recordset; } catch { fks = []; }
    const tables = groupColumns(cols);
    const counts = new Map();
    if (!fabricEndpoint) {
      try {
        for (const r of (await pool.request().query(ROWCOUNT_QUERY)).recordset) counts.set(`${r.schema}.${r.table}`, Number(r.rows));
      } catch { /* permissions */ }
    }
    if (fabricEndpoint || exactCounts) {
      const targets = tables.slice(0, 60);
      for (let i = 0; i < targets.length; i += 6) {
        await Promise.all(targets.slice(i, i + 6).map(async (t) => {
          try {
            const r = await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM ${q(t.schema)}.${q(t.name)}`);
            counts.set(`${t.schema}.${t.name}`, Number(r.recordset[0].n));
          } catch { /* skip */ }
        }));
      }
    }
    for (const t of tables) t.rows = counts.has(`${t.schema}.${t.name}`) ? counts.get(`${t.schema}.${t.name}`) : null;
    const relationships = fks.length
      ? fks.map((f) => ({ from: { schema: f.fromSchema, table: f.fromTable, column: f.fromColumn }, to: { schema: f.toSchema, table: f.toTable, column: f.toColumn }, source: 'foreign key', name: f.name }))
      : inferRelationships(tables);
    return { engine: fabricEndpoint ? 'Fabric SQL analytics endpoint' : 'SQL Server', version, tables, relationships };
  });
}

/** Run a read-only query against the model source (used by the agent for profiling). */
export async function readOnlyQuery(conn, query, { maxRows = 200 } = {}) {
  const statements = prepareReadOnlyStatements(query);
  return withPool(conn, async (pool) => {
    const resultSets = [];
    for (const text of statements) {
      const r = await pool.request().query(text);
      const rows = r.recordset || [];
      resultSets.push({ columns: rows.length ? Object.keys(rows[0]) : [], rows: rows.slice(0, maxRows), rowCount: rows.length, truncated: rows.length > maxRows });
    }
    if (resultSets.length === 1) return resultSets[0];
    return { columns: resultSets[0]?.columns || [], rows: resultSets[0]?.rows || [], rowCount: resultSets.reduce((a, r) => a + r.rowCount, 0), truncated: resultSets.some((r) => r.truncated), resultSets };
  });
}

const RESERVED_ALIASES = new Set(['rowcount', 'count', 'key', 'value', 'group', 'order', 'user', 'date', 'time', 'type', 'table', 'schema']);
const quoteAlias = (a) => `[${String(a).replace(/]/g, ']]')}]`;

export function prepareReadOnlyStatements(query) {
  const raw = stripSqlFence(String(query || '').trim());
  const statements = splitSqlStatements(raw).map((s) => normalizeSelect(s.trim())).filter((s) => stripSqlLiterals(s).trim());
  if (!statements.length) throw new Error('Enter a read-only SELECT query.');
  if (statements.length > 10) throw new Error('Run at most 10 read-only SELECT statements at a time.');
  for (const text of statements) {
    const safe = stripSqlLiterals(text);
    if (!/^(select|with)\b/i.test(safe) || /\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|into)\b/i.test(safe)) {
      throw new Error('Only read-only SELECT (or WITH … SELECT) statements are allowed.');
    }
  }
  return statements;
}

function stripSqlFence(text) {
  const m = text.match(/^```(?:sql|tsql|t-sql)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return (m ? m[1] : text).trim().replace(/;+\s*$/, '');
}

function splitSqlStatements(text) {
  const out = [];
  let cur = '';
  let quote = null;
  let bracket = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      cur += ch;
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      cur += ch;
      if (ch === '*' && next === '/') { cur += next; i++; blockComment = false; }
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote && next === quote) { cur += next; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (bracket) {
      cur += ch;
      if (ch === ']' && next === ']') { cur += next; i++; continue; }
      if (ch === ']') bracket = false;
      continue;
    }
    if (ch === '-' && next === '-') { cur += ch + next; i++; lineComment = true; continue; }
    if (ch === '/' && next === '*') { cur += ch + next; i++; blockComment = true; continue; }
    if (ch === "'" || ch === '"') { cur += ch; quote = ch; continue; }
    if (ch === '[') { cur += ch; bracket = true; continue; }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function stripSqlLiterals(text) {
  let out = '';
  let quote = null;
  let bracket = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      out += ch === '\n' ? '\n' : ' ';
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      out += /\s/.test(ch) ? ch : ' ';
      if (ch === '*' && next === '/') { out += ' '; i++; blockComment = false; }
      continue;
    }
    if (quote) {
      out += /\s/.test(ch) ? ch : ' ';
      if (ch === quote && next === quote) { out += ' '; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (bracket) {
      out += /\s/.test(ch) ? ch : ' ';
      if (ch === ']' && next === ']') { out += ' '; i++; continue; }
      if (ch === ']') bracket = false;
      continue;
    }
    if (ch === '-' && next === '-') { out += '  '; i++; lineComment = true; continue; }
    if (ch === '/' && next === '*') { out += '  '; i++; blockComment = true; continue; }
    if (ch === "'" || ch === '"') { out += ' '; quote = ch; continue; }
    if (ch === '[') { out += ' '; bracket = true; continue; }
    out += ch;
  }
  return out.trim();
}

function normalizeSelect(text) {
  // AI-generated profiling SQL often uses aliases such as "AS RowCount" or "COUNT_BIG(*) RowCount".
  // Some SQL endpoints treat these as keywords. Quote just the alias, never identifiers or expressions.
  return text
    .replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi, (all, a) => (RESERVED_ALIASES.has(a.toLowerCase()) ? `AS ${quoteAlias(a)}` : all))
    .replace(/(\)|\]|\*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?=,|\s+FROM\b|\s+UNION\b|\s+ORDER\b|\s+GROUP\b|\s+HAVING\b|$)/gi,
      (all, exprEnd, a) => (RESERVED_ALIASES.has(a.toLowerCase()) ? `${exprEnd} AS ${quoteAlias(a)}` : all));
}

export async function testSqlServer(conn) {
  return withPool(conn, async (pool) => {
    const r = await pool.request().query("SELECT @@VERSION AS v, DB_NAME() AS db, (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0) AS tables");
    const row = r.recordset[0];
    return { ok: true, version: row.v.split('\n')[0], database: row.db, tables: row.tables };
  });
}

function q(name) { return `[${String(name).replace(/]/g, ']]')}]`; }

export function groupColumns(cols) {
  const map = new Map();
  for (const c of cols) {
    const key = `${c.schema}.${c.table}`;
    if (!map.has(key)) map.set(key, { schema: c.schema, name: c.table, columns: [] });
    map.get(key).columns.push({
      name: c.column, type: c.type, nullable: Boolean(c.nullable), isPk: Boolean(c.isPk),
      precision: c.precision, scale: c.scale, maxLength: c.maxLength,
    });
  }
  return [...map.values()];
}

const singular = (s) => s.replace(/ies$/i, 'y').replace(/(ss)es$/i, '$1').replace(/([^s])s$/i, '$1');
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Infer table keys and many-to-one relationships from naming conventions (used when no FKs exist). */
export function inferRelationships(tables) {
  const keyOf = new Map();
  for (const t of tables) {
    const pk = t.columns.filter((c) => c.isPk);
    if (pk.length === 1) { keyOf.set(t, pk[0].name); continue; }
    const base = norm(singular(t.name.replace(/^(dim|fact|fct|tbl)_?/i, '')));
    const cand = t.columns.find((c) => [`${base}id`, `${base}key`, `${base}code`].includes(norm(c.name)))
      || t.columns.find((c) => ['id', 'key'].includes(norm(c.name)));
    if (cand) keyOf.set(t, cand.name);
  }
  const rels = [];
  for (const dim of tables) {
    const key = keyOf.get(dim);
    if (!key) continue;
    const keyNorm = norm(key);
    const dimBase = norm(singular(dim.name.replace(/^(dim|fact|fct|tbl)_?/i, '')));
    const wanted = keyNorm === 'id' || keyNorm === 'key' ? [`${dimBase}id`, `${dimBase}key`] : [keyNorm];
    for (const fact of tables) {
      if (fact === dim) continue;
      const col = fact.columns.find((c) => wanted.includes(norm(c.name)));
      if (!col) continue;
      if (keyOf.get(fact) && norm(keyOf.get(fact)) === norm(col.name)) continue;
      rels.push({
        from: { schema: fact.schema, table: fact.name, column: col.name },
        to: { schema: dim.schema, table: dim.name, column: key },
        source: 'inferred from names',
      });
    }
  }
  for (const t of tables) for (const c of t.columns) if (keyOf.get(t) === c.name) c.isKey = true;
  return rels;
}
