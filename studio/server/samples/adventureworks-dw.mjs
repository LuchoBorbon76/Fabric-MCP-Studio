// AdventureWorksDW2022 sample for Fabric SQL database.
// Uses Microsoft's official AdventureWorksDW install kit (T-SQL script + bcp data files) from
// github.com/microsoft/sql-server-samples, adapted for Fabric: no CREATE DATABASE or full-text, and data is
// bulk-loaded over TDS with the user's Microsoft Entra token instead of BULK INSERT from a local disk.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sql from 'mssql';
import { DATA_DIR, sleep } from '../config.mjs';
import { unzip } from '../unzip.mjs';

export const AWDW = {
  databaseName: 'AdventureWorksDW2022',
  kitUrl: 'https://github.com/microsoft/sql-server-samples/releases/download/adventureworks/AdventureWorksDW-data-warehouse-install-script.zip',
  // Install-kit utility objects that aren't part of the warehouse (DDL log, SSMS diagrams, build stamp).
  skipTables: new Set(['DatabaseLog', 'sysdiagrams', 'AdventureWorksDWBuildVersion']),
  // Known row counts and sales totals, used to verify the load and the OneLake replica.
  expectedRows: { FactInternetSales: 60398, FactResellerSales: 60855, DimCustomer: 18484, DimProduct: 606, DimDate: 3652 },
  expectedSalesAmount: { FactInternetSales: '29358677.2207', FactResellerSales: '80450596.9823' },
};

/** SUM(SalesAmount) as exact text, for the tables in AWDW.expectedSalesAmount (works on the database and its replica). */
export async function salesTotals(pool) {
  const out = {};
  for (const t of Object.keys(AWDW.expectedSalesAmount)) {
    try {
      const r = await pool.request().query(`SELECT CAST(SUM(CAST(SalesAmount AS decimal(19,4))) AS varchar(40)) AS s FROM dbo.[${t}]`);
      out[t] = r.recordset[0].s;
    } catch { out[t] = null; }
  }
  return out;
}

const totalsMatch = (totals) => Object.entries(AWDW.expectedSalesAmount).every(([t, v]) => totals[t] === v);

/** True when the published sales totals match (on the SQL database or its OneLake replica). */
export async function salesTotalsMatch(pool) {
  return totalsMatch(await salesTotals(pool));
}

const CACHE = join(DATA_DIR, 'cache', 'AdventureWorksDW-install-script.zip');

/** Download (once) and unpack Microsoft's AdventureWorksDW install kit. */
export async function getKit(log = () => {}, { signal } = {}) {
  let buf;
  if (existsSync(CACHE)) {
    log('Using the cached AdventureWorksDW install kit');
    buf = readFileSync(CACHE);
  } else {
    log(`Downloading ${AWDW.kitUrl}`);
    const res = await fetch(AWDW.kitUrl, { redirect: 'follow', signal });
    if (!res.ok) throw new Error(`Could not download the AdventureWorksDW install kit (HTTP ${res.status}). The studio needs internet access to github.com.`);
    buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(join(DATA_DIR, 'cache'), { recursive: true });
    writeFileSync(CACHE, buf);
    log(`Downloaded ${(buf.length / 1048576).toFixed(1)} MB`);
  }
  return unzip(buf);
}

// ---------------- install script ----------------

const COL_RX = /^\s*\[(\w+)\]\s*\[(\w+)\]\s*(?:\(\s*(max|\d+)\s*(?:,\s*(\d+))?\s*\))?/i;
const strip = (b) => b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '').replace(/^\s*PRINT\b.*$/gim, '').trim();
const tableOf = (b) => (b.match(/(?:TABLE|ON)\s+\[dbo\]\.\[(\w+)\]/i) || [])[1];

/** Split the kit's script into the parts the studio runs, in order. */
export function parseKit(files) {
  const scriptBuf = files.get('instawdbdw.sql');
  if (!scriptBuf) throw new Error('instawdbdw.sql was not found in the AdventureWorksDW install kit.');
  const script = scriptBuf.toString('utf8').replace(/^\uFEFF/, '');
  const plan = { functions: [], tables: [], primaryKeys: [], uniques: [], foreignKeys: [], views: [], data: [] };

  for (const raw of script.split(/^\s*GO\s*$/im)) {
    const b = strip(raw);
    if (!b) continue;
    if (/^CREATE\s+FUNCTION\b/i.test(b)) { plan.functions.push(b); continue; }
    if (/^CREATE\s+VIEW\b/i.test(b)) { plan.views.push(b); continue; }
    if (/^CREATE\s+TABLE\b/i.test(b)) {
      const name = tableOf(b);
      if (!name || AWDW.skipTables.has(name)) continue;
      const columns = [];
      for (const line of b.split('\n').slice(1)) {
        const m = line.match(COL_RX);
        if (m) columns.push({ name: m[1], type: m[2].toLowerCase(), length: m[3], scale: m[4], nullable: !/\bNOT\s+NULL\b/i.test(line) });
      }
      // Keys come from the data files, so identity is dropped (bulk load can't keep identity values).
      const ddl = b.replace(/\s+IDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, '').replace(/\s+ON\s+\[PRIMARY\]/gi, '').replace(/\s+TEXTIMAGE_ON\s+\[PRIMARY\]/gi, '');
      plan.tables.push({ name, ddl, columns });
      continue;
    }
    if (/\bBULK\s+INSERT\b/i.test(b)) {
      for (const m of b.matchAll(/BULK\s+INSERT\s*\[dbo\]\.\[(\w+)\]\s*FROM\s*'\$\(SqlSamplesSourceDataPath\)([\w.]+)'/gi)) {
        if (!AWDW.skipTables.has(m[1])) plan.data.push({ table: m[1], file: m[2] });
      }
      continue;
    }
    const target = tableOf(b);
    if (target && AWDW.skipTables.has(target)) continue;
    if (/^ALTER\s+TABLE\b[\s\S]*\bPRIMARY\s+KEY\b/i.test(b)) plan.primaryKeys.push(b);
    else if (/^CREATE\s+UNIQUE\b/i.test(b) || /^ALTER\s+TABLE\b[\s\S]*\bUNIQUE\b/i.test(b)) plan.uniques.push(b);
    else if (/^ALTER\s+TABLE\b[\s\S]*\bFOREIGN\s+KEY\b/i.test(b)) plan.foreignKeys.push(b);
    // Everything else (CREATE DATABASE, USE, full-text, DDL trigger, extended properties) doesn't apply to Fabric.
  }
  if (!plan.tables.length || !plan.data.length) throw new Error('The AdventureWorksDW install kit has an unexpected format.');
  plan.order = loadOrder(plan);
  return plan;
}

/** Dimensions before the facts that reference them, so foreign keys are checked during the load. */
function loadOrder(plan) {
  const deps = new Map(plan.tables.map((t) => [t.name, new Set()]));
  for (const fk of plan.foreignKeys) {
    for (const stmt of fk.split(/(?=ALTER\s+TABLE)/i)) {
      const from = tableOf(stmt);
      for (const m of stmt.matchAll(/REFERENCES\s+\[dbo\]\.\[(\w+)\]/gi)) if (from && m[1] !== from && deps.has(from)) deps.get(from).add(m[1]);
    }
  }
  const out = [];
  const seen = new Set();
  const visit = (n) => { if (seen.has(n)) return; seen.add(n); for (const d of deps.get(n) || []) visit(d); out.push(n); };
  for (const d of plan.data) visit(d.table);
  return out.filter((n) => plan.data.some((d) => d.table === n));
}

// ---------------- data files (bcp character format) ----------------

function sqlType(c) {
  const len = c.length === 'max' ? sql.MAX : Number(c.length) || undefined;
  switch (c.type) {
    case 'int': return sql.Int;
    case 'smallint': return sql.SmallInt;
    case 'tinyint': return sql.TinyInt;
    case 'bigint': return sql.BigInt;
    case 'bit': return sql.Bit;
    case 'money': return sql.Decimal(19, 4); // tedious encodes money as Math.floor(value*10000) and loses 0.0001s
    case 'smallmoney': return sql.Decimal(10, 4);
    case 'float': return sql.Float;
    case 'real': return sql.Real;
    case 'decimal': case 'numeric': return sql.Decimal(Number(c.length) || 18, Number(c.scale) || 0);
    case 'date': return sql.Date;
    case 'datetime': return sql.DateTime;
    case 'datetime2': return sql.DateTime2;
    case 'smalldatetime': return sql.SmallDateTime;
    case 'nchar': return sql.NChar(len);
    case 'char': return sql.Char(len);
    case 'varchar': return sql.VarChar(len);
    case 'sysname': return sql.NVarChar(128);
    case 'varbinary': case 'binary': return sql.VarBinary(len || sql.MAX);
    default: return sql.NVarChar(len || sql.MAX);
  }
}

function convert(value, c) {
  if (value === '') return null; // empty field = NULL
  if (value === '\0') return ''; // a single NUL = empty string
  switch (c.type) {
    case 'int': case 'smallint': case 'tinyint': case 'money': case 'smallmoney': case 'float': case 'real': case 'decimal': case 'numeric': {
      const n = Number(value);
      if (Number.isNaN(n)) throw new Error(`"${value}" is not a number`);
      return n;
    }
    case 'bigint': return value;
    case 'bit': return value === '1' || /^true$/i.test(value);
    case 'date': case 'datetime': case 'datetime2': case 'smalldatetime': {
      const iso = value.includes('T') ? value : value.includes(' ') ? value.replace(' ', 'T') : `${value}T00:00:00`;
      const d = new Date(`${iso}Z`);
      if (Number.isNaN(d.getTime())) throw new Error(`"${value}" is not a date`);
      return d;
    }
    case 'varbinary': case 'binary': return Buffer.from(value.replace(/^0x/i, ''), 'hex');
    default: return value;
  }
}

function* rowsOf(buf, columns, table) {
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  let start = 0;
  let line = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const raw = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    line++;
    if (!raw) continue;
    const fields = raw.split('|');
    if (fields.length !== columns.length) throw new Error(`${table}: line ${line} has ${fields.length} fields, expected ${columns.length}.`);
    try { yield fields.map((v, i) => convert(v, columns[i])); } catch (e) { throw new Error(`${table}: line ${line}: ${e.message}`); }
  }
}

// ---------------- load ----------------

const q = (n) => `[${n.replace(/]/g, ']]')}]`;

async function exec(pool, text, log, { optional = false, what = '' } = {}) {
  try { await pool.request().batch(text); return true; } catch (e) {
    if (!optional) throw new Error(`${what || 'SQL'} failed: ${e.message}`);
    log(`Skipped ${what}: ${e.message.split('\n')[0]}`);
    return false;
  }
}

/** Remove the kit's objects so a partial load can be repeated cleanly. */
async function resetSchema(pool, plan) {
  const names = plan.tables.map((t) => `'${t.name}'`).join(',');
  await pool.request().batch(`
DECLARE @s nvarchar(max) = N'';
SELECT @s += N'DROP VIEW ' + QUOTENAME(SCHEMA_NAME(schema_id)) + N'.' + QUOTENAME(name) + N';' FROM sys.views WHERE name IN ('vDMPrep','vTimeSeries','vTargetMail','vAssocSeqOrders','vAssocSeqLineItems');
SELECT @s += N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + N'.' + QUOTENAME(OBJECT_NAME(parent_object_id)) + N' DROP CONSTRAINT ' + QUOTENAME(name) + N';' FROM sys.foreign_keys WHERE OBJECT_NAME(parent_object_id) IN (${names});
SELECT @s += N'DROP TABLE dbo.' + QUOTENAME(name) + N';' FROM sys.tables WHERE schema_id = 1 AND name IN (${names});
SELECT @s += N'DROP FUNCTION dbo.' + QUOTENAME(name) + N';' FROM sys.objects WHERE type IN ('FN','IF','TF') AND name IN ('udfBuildISO8601Date','udfMinimumDate','udfTwoDigitZeroFill');
EXEC sp_executesql @s;`);
}

/** Current row counts for the given tables (null when a table doesn't exist). */
export async function tableCounts(pool, names) {
  const r = await pool.request().query('SELECT t.name, SUM(p.rows) AS n FROM sys.tables t JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1) WHERE t.schema_id = 1 GROUP BY t.name');
  const m = new Map(r.recordset.map((x) => [x.name, Number(x.n)]));
  return Object.fromEntries(names.map((n) => [n, m.has(n) ? m.get(n) : null]));
}

/**
 * Create the AdventureWorksDW schema in the connected database and load the data.
 * ctx: { log, progress(pct), signal }. Progress is reported between `from` and `to`.
 */
export async function loadAdventureWorksDW(pool, kitFiles, ctx, { from = 0, to = 100 } = {}) {
  const plan = parseKit(kitFiles);
  const log = ctx.log;
  const pct = (f) => ctx.progress(from + (to - from) * f);

  const existing = await tableCounts(pool, plan.tables.map((t) => t.name));
  const complete = Object.entries(AWDW.expectedRows).every(([t, n]) => existing[t] === n) && plan.data.every((d) => existing[d.table] !== null);
  if (complete && totalsMatch(await salesTotals(pool))) {
    log('AdventureWorksDW2022 is already loaded – keeping the existing data');
    return { plan, counts: existing, reused: true };
  }
  if (Object.values(existing).some((v) => v !== null)) {
    log('Removing a previous, incomplete load');
    await resetSchema(pool, plan);
  }

  for (const f of plan.functions) await exec(pool, f, log, { optional: true, what: 'function' });
  for (const t of plan.tables) await exec(pool, t.ddl, log, { what: `CREATE TABLE ${t.name}` });
  for (const pk of plan.primaryKeys) await exec(pool, pk, log, { what: 'primary key' });
  for (const u of plan.uniques) await exec(pool, u, log, { optional: true, what: 'unique index' });
  for (const fk of plan.foreignKeys) await exec(pool, fk, log, { optional: true, what: 'foreign key' });
  log(`Created ${plan.tables.length} tables with primary keys, unique indexes and foreign keys`);
  pct(0.08);

  const sizes = Object.fromEntries(plan.data.map((d) => [d.table, kitFiles.get(d.file)?.length || 0]));
  const total = Object.values(sizes).reduce((a, b) => a + b, 0) || 1;
  let done = 0;
  const counts = {};
  for (const name of plan.order) {
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    const d = plan.data.find((x) => x.table === name);
    const buf = kitFiles.get(d.file);
    if (!buf) throw new Error(`${d.file} is missing from the install kit.`);
    const def = plan.tables.find((t) => t.name === name);
    let n = 0;
    let batch = null;
    const flush = async () => {
      if (!batch?.rows.length) return;
      // Fabric starts replicating new tables to OneLake right away; that can briefly conflict with a bulk insert.
      // Each batch is one atomic INSERT BULK, so retrying it is safe.
      for (let attempt = 1; ; attempt++) {
        try { await pool.request().bulk(batch, { checkConstraints: true, lockTable: true }); break; } catch (e) {
          if (attempt >= 8 || !/schema change|deadlock|timeout|try again|transient/i.test(e.message)) throw e;
          log(`${name}: ${e.message.split('\n')[0]} – retrying (${attempt}/7)`);
          await sleep(2000 * attempt);
        }
      }
      n += batch.rows.length;
      batch = null;
    };
    for (const row of rowsOf(buf, def.columns, name)) {
      if (!batch) {
        batch = new sql.Table(`dbo.${q(name)}`);
        for (const c of def.columns) batch.columns.add(c.name, sqlType(c), { nullable: c.nullable });
      }
      batch.rows.add(...row);
      if (batch.rows.length >= 25000) await flush();
    }
    await flush();
    counts[name] = n;
    done += sizes[name];
    log(`Loaded ${name} · ${n.toLocaleString('en-US')} rows`);
    pct(0.08 + 0.84 * (done / total));
  }

  for (const v of plan.views) await exec(pool, v, log, { optional: true, what: 'view' });
  for (const [t, n] of Object.entries(AWDW.expectedRows)) {
    if (counts[t] !== n) throw new Error(`${t} loaded ${counts[t]} rows, expected ${n}.`);
  }
  const totals = await salesTotals(pool);
  if (!totalsMatch(totals)) throw new Error(`Sales totals don't match the published sample (${JSON.stringify(totals)}).`);
  log(`Verified row counts and sales totals (internet ${totals.FactInternetSales}, reseller ${totals.FactResellerSales})`);
  pct(1);
  return { plan, counts, reused: false };
}
