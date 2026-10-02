// Schema discovery for PostgreSQL (Azure Database for PostgreSQL flexible server or self-managed).
import pg from 'pg';
import { getToken } from './auth.mjs';
import { inferRelationships } from './sql.mjs';

const PG_ENTRA_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

async function withClient(conn, fn) {
  const auth = conn.auth || {};
  let password = auth.password;
  let user = auth.username;
  if (!auth.type || auth.type === 'Entra' || auth.type === 'OAuth2') {
    password = await getToken(PG_ENTRA_SCOPE);
    user = auth.username || conn.entraUser;
  }
  const client = new pg.Client({
    host: conn.server, port: Number(conn.port) || 5432, database: conn.database,
    user, password, ssl: conn.ssl === false ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000, statement_timeout: 120000,
  });
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => {}); }
}

export async function testPostgres(conn) {
  return withClient(conn, async (c) => {
    const v = await c.query('SELECT version() AS v, current_database() AS db');
    const n = await c.query("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')");
    return { ok: true, version: v.rows[0].v.split(',')[0], database: v.rows[0].db, tables: n.rows[0].n };
  });
}

export async function discoverPostgres(conn) {
  return withClient(conn, async (c) => {
    const cols = (await c.query(`
      SELECT c.table_schema AS schema, c.table_name AS table, c.column_name AS column, c.data_type AS type,
             c.is_nullable = 'YES' AS nullable, c.ordinal_position AS ordinal, c.numeric_precision AS precision, c.numeric_scale AS scale,
             EXISTS (SELECT 1 FROM information_schema.table_constraints tc
                     JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
                     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND k.column_name = c.column_name) AS "isPk"
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position`)).rows;
    const fks = (await c.query(`
      SELECT kcu.table_schema AS "fromSchema", kcu.table_name AS "fromTable", kcu.column_name AS "fromColumn",
             ccu.table_schema AS "toSchema", ccu.table_name AS "toTable", ccu.column_name AS "toColumn", tc.constraint_name AS name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'`)).rows;
    const counts = new Map((await c.query(`
      SELECT n.nspname AS schema, c.relname AS table, GREATEST(c.reltuples, 0)::bigint AS rows
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r'`)).rows.map((r) => [`${r.schema}.${r.table}`, Number(r.rows)]));
    const map = new Map();
    for (const r of cols) {
      const key = `${r.schema}.${r.table}`;
      if (!map.has(key)) map.set(key, { schema: r.schema, name: r.table, columns: [], rows: counts.get(key) ?? null });
      map.get(key).columns.push({ name: r.column, type: r.type, nullable: r.nullable, isPk: r.isPk, precision: r.precision, scale: r.scale });
    }
    const tables = [...map.values()];
    const relationships = fks.length
      ? fks.map((f) => ({ from: { schema: f.fromSchema, table: f.fromTable, column: f.fromColumn }, to: { schema: f.toSchema, table: f.toTable, column: f.toColumn }, source: 'foreign key', name: f.name }))
      : inferRelationships(tables);
    const version = (await c.query('SELECT version() AS v')).rows[0].v.split(',')[0];
    return { engine: 'PostgreSQL', version, tables, relationships };
  });
}
