// Plan storage: writes plan rows next to the model's data so the Direct Lake model can read them – a "planning" schema
// in a Fabric SQL database (replicated to OneLake) or a Fabric warehouse, written over TDS with the user's Entra token.
import * as F from '../fabric.mjs';
import { withPool } from '../sql.mjs';
import { sleep } from '../config.mjs';

export const PLAN_SCHEMA = 'planning';
export const PLAN_TABLE = 'PlanValues';
const q = (n) => `[${String(n).replace(/]/g, ']]')}]`;
const FIXED = ['Scenario', 'PlanYear', 'MonthNumber', 'PeriodStart', 'Amount', 'ClosedPeriod', 'UpdatedAt'];

/** Where plan rows go for the project's data source (or why they can't be written). */
export async function planTarget(p) {
  const ms = p.modelSource;
  if (!ms) throw new Error('Load data first.');
  if (ms.itemType === 'SQLDatabase') {
    const db = await F.getSqlDatabase(ms.workspaceId || p.workspace.id, ms.itemId);
    const props = db.properties || {};
    if (!props.serverFqdn || !props.databaseName) throw new Error('The SQL database has no connection details yet. Try again in a minute.');
    return { kind: 'SQLDatabase', label: `${ms.itemName} (Fabric SQL database)`, write: { server: props.serverFqdn, database: props.databaseName }, read: { server: ms.server, database: ms.database, endpointId: ms.endpointId }, workspaceId: ms.workspaceId || p.workspace.id, text: 'nvarchar(400)', replicated: true };
  }
  if (ms.itemType === 'Warehouse') {
    return { kind: 'Warehouse', label: `${ms.itemName} (warehouse)`, write: { server: ms.server, database: ms.database }, read: { server: ms.server, database: ms.database }, workspaceId: ms.workspaceId || p.workspace.id, text: 'varchar(400)', replicated: false };
  }
  const what = { Lakehouse: 'a lakehouse', MirroredDatabase: 'a mirrored database' }[ms.itemType] || `a ${ms.itemType}`;
  throw new Error(`Your semantic model reads ${what}, which the studio can't write plan values to yet. Plans are stored next to your data in a Fabric SQL database or a warehouse – load your data into one of those (for example the AdventureWorks sample), then plan.`);
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
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (let i = 0; Date.now() < deadline; i++) {
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    if (i % 3 === 0 && target.read.endpointId) await F.refreshSqlEndpoint(target.workspaceId, target.read.endpointId);
    try {
      const r = await withPool({ server: target.read.server, database: target.read.database }, (pool) => pool.request().query(`SELECT COUNT_BIG(*) AS n, CAST(SUM(Amount) AS float) AS s FROM ${q(PLAN_SCHEMA)}.${q(PLAN_TABLE)} WHERE PlanYear = ${Number(planYear)}`));
      const { n, s } = r.recordset[0];
      if (Number(n) === rows && Math.abs(Number(s) - total) < 1) return;
      const msg = `OneLake replica: ${Number(n)} of ${rows} plan rows`;
      if (msg !== last) { ctx.log(msg); last = msg; }
    } catch (e) {
      if (!/Invalid object|does not exist/i.test(e.message)) ctx.log(`Waiting for the SQL analytics endpoint: ${e.message.split('\n')[0]}`);
      else if (last !== 'pending') { ctx.log('Waiting for the plan table to reach OneLake (usually 1–2 minutes)'); last = 'pending'; }
    }
    await sleep(10000);
  }
  throw new Error('The plan values are in the SQL database but haven\'t reached OneLake yet. Run the plan again in a few minutes – it continues where it stopped.');
}

/** Drop the plan table (when the plan is removed with its data). */
export async function dropPlanTable(target) {
  await withPool(target.write, (pool) => pool.request().query(`IF OBJECT_ID('${PLAN_SCHEMA}.${PLAN_TABLE}') IS NOT NULL DROP TABLE ${q(PLAN_SCHEMA)}.${q(PLAN_TABLE)}`));
}

/** True for tables the studio writes plans to (left out of models and ontologies built from the source). */
export const isPlanTable = (t) => String(t?.schema || '').toLowerCase() === PLAN_SCHEMA && String(t?.name || t?.table || '').toLowerCase() === PLAN_TABLE.toLowerCase();
