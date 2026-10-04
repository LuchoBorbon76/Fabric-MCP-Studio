// Medallion architecture for the live events – Microsoft's pattern for Real-Time Intelligence, applied to the
// project's existing Eventhouse table (https://learn.microsoft.com/fabric/real-time-intelligence/architecture-medallion):
//   Bronze  the table the Eventstream already lands raw events in, kept as they arrive for replay
//   Silver  update policies check and enrich every new Bronze event into <table>_Silver; events that fail a check go
//           to <table>_Quarantine with the reason; a take_any(*) materialized view removes duplicates
//   Gold    materialized views over the deduplicated Silver data: per-minute and daily totals and the latest event
//           per customer (or item) – always fresh, cheap to query
// Each layer has its own retention and caching. Everything is generated from the scenario's column roles, so the
// same template fits the samples and any semantic model.
import { kusto, kustoOperation, kqlName, kqlString, sameKqlType } from './kusto.mjs';

// Kusto folders, so the database explorer shows the layers.
export const FOLDERS = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold' };
const HOT_DAYS = { bronze: 3, silver: 30, gold: 90 };
export const DEFAULT_OPTIONS = { bronzeDays: 30, silverDays: 90, goldDays: 730, oneLake: true };
export const RETENTION_CHOICES = { bronze: [0, 7, 30, 90, 365], silver: [30, 90, 365], gold: [365, 730, 1825] };

const days = (v, min, max, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== null && v !== '' ? Math.min(max, Math.max(min, n)) : d;
};

/** Options for the layers (bronzeDays 0 keeps the Bronze table's retention as it is). */
export function medallionOptions(o = {}, prev = null) {
  const base = { ...DEFAULT_OPTIONS, ...(prev || {}) };
  return {
    bronzeDays: Number(o.bronzeDays ?? base.bronzeDays) === 0 ? 0 : days(o.bronzeDays ?? base.bronzeDays, 1, 3650, DEFAULT_OPTIONS.bronzeDays),
    silverDays: days(o.silverDays ?? base.silverDays, 1, 3650, DEFAULT_OPTIONS.silverDays),
    goldDays: days(o.goldDays ?? base.goldDays, 1, 36500, DEFAULT_OPTIONS.goldDays),
    oneLake: o.oneLake === undefined ? base.oneLake !== false : Boolean(o.oneLake),
  };
}

export function layerNames(table) {
  return {
    bronze: table, silver: `${table}_Silver`, quarantine: `${table}_Quarantine`, clean: `${table}_Silver_Dedup`,
    toSilver: `${table}_ToSilver`, toQuarantine: `${table}_ToQuarantine`,
    perMinute: `${table}_Gold_PerMinute`, daily: `${table}_Gold_Daily`, latest: `${table}_Gold_Latest`,
  };
}

const present = (c) => (c.type === 'string' ? `isnotempty(${kqlName(c.name)})` : `isnotnull(${kqlName(c.name)})`);
const lower = (c, fallback) => String(c?.label || fallback).toLowerCase();

/** Data-quality checks for Silver, from the column roles. Each `ok` is a null-safe boolean KQL expression. */
function qualityChecks(R) {
  const n = (c) => kqlName(c.name);
  const out = [];
  if (R.time) out.push({ id: 'time', column: R.time.name, reason: `Missing or future ${lower(R.time, 'time')}`, ok: `isnotnull(${n(R.time)}) and ${n(R.time)} <= now() + 15m` });
  if (R.order) out.push({ id: 'order', column: R.order.name, reason: `Missing ${lower(R.order, 'order')}`, ok: present(R.order) });
  if (R.itemKey) out.push({ id: 'itemKey', column: R.itemKey.name, reason: `Missing ${lower(R.itemKey, 'item key')}`, ok: present(R.itemKey) });
  if (R.qty) out.push({ id: 'qty', column: R.qty.name, reason: `${R.qty.label || 'Quantity'} not above zero`, ok: `isnotnull(${n(R.qty)}) and ${n(R.qty)} > 0` });
  if (R.price) out.push({ id: 'price', column: R.price.name, reason: `Missing or negative ${lower(R.price, 'price')}`, ok: `isnotnull(${n(R.price)}) and ${n(R.price)} >= 0` });
  if (R.discount) out.push({ id: 'discount', column: R.discount.name, reason: `${R.discount.label || 'Discount'} outside 0-100%`, ok: `isnull(${n(R.discount)}) or (${n(R.discount)} >= 0 and ${n(R.discount)} < 1)` });
  if (R.amount) out.push({ id: 'amount', column: R.amount.name, reason: `Missing or negative ${lower(R.amount, 'amount')}`, ok: `isnotnull(${n(R.amount)}) and ${n(R.amount)} >= 0` });
  return out;
}

/**
 * Everything the template creates, as data and KQL: names, checks, Silver/Quarantine schemas and queries, the
 * deduplication view and the Gold views. Pure – no Eventhouse calls – so it can be shown and tested before applying.
 * scenario: { table, label, unit, columns: [{ name, type, role, label }] } (the project's scenario summary).
 */
export function medallionModel(scenario, options = DEFAULT_OPTIONS) {
  const o = medallionOptions(options);
  const N = layerNames(scenario.table);
  const cols = scenario.columns;
  const R = Object.fromEntries(cols.filter((c) => c.role).map((c) => [c.role, c]));
  const q = (c) => kqlName(c.name);
  const T = R.time || cols.find((c) => c.type === 'datetime');
  if (!T) throw new Error(`${scenario.table} has no event time column.`);

  const used = new Set(cols.map((c) => c.name.toLowerCase()));
  const fresh = (name) => { let x = name; for (let i = 2; used.has(x.toLowerCase()); i++) x = `${name}${i}`; used.add(x.toLowerCase()); return x; };
  const checks = qualityChecks(R);
  const reasonExpr = checks.length ? `case(${checks.map((c) => `not(${c.ok}), ${kqlString(c.reason)}`).join(', ')}, "")` : '""';

  const extras = [
    { name: fresh('EventHash'), type: 'string', role: 'hash', label: 'Event hash (deduplication key)', expr: `hash_sha256(strcat_delim("|", ${cols.map((c) => `tostring(${q(c)})`).join(', ')}))` },
    { name: fresh('EventDate'), type: 'datetime', role: 'date', label: 'Event date', expr: `startofday(${q(T)})` },
    ...(R.rule ? [{ name: fresh('IsRuleBreak'), type: 'bool', role: 'isRule', label: 'Breaks a business rule', expr: `isnotempty(${q(R.rule)})` }] : []),
    ...(R.margin && R.amount ? [{ name: fresh('MarginPct'), type: 'real', role: 'marginPct', label: 'Margin (%)', expr: `iff(${q(R.amount)} == 0, real(null), round(100.0 * ${q(R.margin)} / ${q(R.amount)}, 2))` }] : []),
  ];
  const X = Object.fromEntries(extras.map((e) => [e.role, e]));
  const reasonCol = fresh('Reason');
  const quarantinedAt = fresh('QuarantinedAt');
  const base = cols.map(q).join(', ');

  const silverQuery = (source) => [
    source,
    `| extend _Reason = ${reasonExpr}`,
    '| where isempty(_Reason)',
    `| extend ${extras.map((e) => `${kqlName(e.name)} = ${e.expr}`).join(', ')}`,
    `| project ${base}, ${extras.map((e) => kqlName(e.name)).join(', ')}`,
  ].join('\n');
  const quarantineQuery = (source) => [
    source,
    `| extend ${kqlName(reasonCol)} = ${reasonExpr}`,
    `| where isnotempty(${kqlName(reasonCol)})`,
    `| extend ${kqlName(quarantinedAt)} = now()`,
    `| project ${base}, ${kqlName(reasonCol)}, ${kqlName(quarantinedAt)}`,
  ].join('\n');

  // Gold: additive measures only, so totals can be rolled up over any time range and dimension.
  const gUsed = new Set();
  const gName = (name) => { let x = name; for (let i = 2; gUsed.has(x.toLowerCase()); i++) x = `${name}${i}`; gUsed.add(x.toLowerCase()); return x; };
  const dimsOf = (roles) => roles.map((r) => R[r]).filter(Boolean).filter((c, i, a) => a.indexOf(c) === i);
  const measures = () => [
    `${kqlName(gName('Events'))} = count()`,
    ...['amount', 'cost', 'margin', 'qty'].filter((r) => R[r]).map((r) => `${kqlName(gName(R[r].name))} = sum(${q(R[r])})`),
    ...(X.isRule ? [`${kqlName(gName('RuleBreaks'))} = countif(${kqlName(X.isRule.name)})`] : []),
  ];
  const gold = [];
  const perMinuteDims = dimsOf(['channel', 'group', 'region']);
  gUsed.clear(); [T, ...perMinuteDims].forEach((c) => gUsed.add(c.name.toLowerCase()));
  gold.push({
    kind: 'perMinute', name: N.perMinute, label: 'Per minute', grain: '1 minute', by: [T.name, ...perMinuteDims.map((c) => c.name)],
    doc: `Gold layer: totals per minute${perMinuteDims.length ? ` by ${perMinuteDims.map((c) => lower(c, c.name)).join(', ')}` : ''} from ${N.clean}.`,
    query: `${kqlName(N.clean)}\n| summarize ${measures().join(', ')}\n    by ${q(T)} = bin(${q(T)}, 1m)${perMinuteDims.map((c) => `, ${q(c)}`).join('')}`,
  });
  const dailyDims = dimsOf(['channel', 'group', 'subgroup', 'item', 'region']);
  gUsed.clear(); [X.date, ...dailyDims].forEach((c) => gUsed.add(c.name.toLowerCase()));
  gold.push({
    kind: 'daily', name: N.daily, label: 'Daily', grain: '1 day', by: [X.date.name, ...dailyDims.map((c) => c.name)],
    doc: `Gold layer: daily totals${dailyDims.length ? ` by ${dailyDims.map((c) => lower(c, c.name)).join(', ')}` : ''} from ${N.clean}.`,
    query: `${kqlName(N.clean)}\n| summarize ${measures().join(', ')}\n    by ${kqlName(X.date.name)}${dailyDims.map((c) => `, ${q(c)}`).join('')}`,
  });
  const latestKey = R.party || R.item || R.region || R.order;
  gold.push({
    kind: 'latest', name: N.latest, label: `Latest per ${lower(latestKey, latestKey.name)}`, grain: 'latest event', by: [latestKey.name],
    doc: `Gold layer: the latest event per ${lower(latestKey, latestKey.name)} from ${N.clean}.`,
    query: `${kqlName(N.clean)}\n| summarize arg_max(${q(T)}, *) by ${q(latestKey)}`,
  });

  const clean = {
    kind: 'dedup', name: N.clean, source: N.silver, onView: false, lookback: '6h',
    doc: `Silver layer: ${N.silver} without duplicates (one row per ${X.hash.name}).`,
    query: `${kqlName(N.silver)}\n| summarize take_any(*) by ${kqlName(X.hash.name)}`,
  };
  gold.forEach((g) => Object.assign(g, { source: N.clean, onView: true, layer: 'gold' }));

  return {
    options: o, names: N, table: scenario.table, label: scenario.label, timeColumn: T.name,
    checks: checks.map(({ id, column, reason, ok }) => ({ id, column, reason, kql: ok })),
    extras: extras.map(({ name, type, role, label }) => ({ name, type, role, label })),
    reasonColumn: reasonCol, quarantinedAtColumn: quarantinedAt, latestKey: latestKey.name,
    silverSchema: [...cols.map((c) => ({ name: c.name, type: c.type })), ...extras.map((e) => ({ name: e.name, type: e.type }))],
    quarantineSchema: [...cols.map((c) => ({ name: c.name, type: c.type })), { name: reasonCol, type: 'string' }, { name: quarantinedAt, type: 'datetime' }],
    silverQuery, quarantineQuery, clean, gold,
    functions: [
      { name: N.toSilver, doc: `Silver layer: checks and enriches new ${N.bronze} events (update policy of ${N.silver}).`, body: silverQuery(kqlName(N.bronze)) },
      { name: N.toQuarantine, doc: `Silver layer: new ${N.bronze} events that fail a data-quality check, with the reason (update policy of ${N.quarantine}).`, body: quarantineQuery(kqlName(N.bronze)) },
    ],
  };
}

/** The same model without the query builders (what the project file, the UI and Copilot see). */
export function modelSummary(m) {
  return {
    options: m.options, names: m.names, table: m.table, timeColumn: m.timeColumn, checks: m.checks, extras: m.extras,
    reasonColumn: m.reasonColumn, quarantinedAtColumn: m.quarantinedAtColumn, latestKey: m.latestKey,
    clean: { name: m.clean.name, doc: m.clean.doc, query: m.clean.query },
    gold: m.gold.map(({ kind, name, label, grain, by, doc, query }) => ({ kind, name, label, grain, by, doc, query })),
  };
}

const policyJson = (source, query) => `@'${JSON.stringify([{ IsEnabled: true, Source: source, Query: query, IsTransactional: false, PropagateIngestionProperties: false }])}'`;
const norm = (s) => String(s || '').replace(/\s+/g, '');
const hot = (layer, d) => Math.max(1, Math.min(HOT_DAYS[layer], d));

/**
 * Create or update the layers in the Eventhouse. Idempotent: what already matches is kept; a Silver table or view
 * whose shape changed is rebuilt from Bronze. Returns { counts, oneLake, bronzePolicies, rebuilt }.
 */
export async function applyMedallion({ cluster, database }, model, ctx) {
  const signal = ctx.signal;
  const run = (csl) => kusto(cluster, database, csl, { mgmt: true, signal });
  const query = (csl) => kusto(cluster, database, csl, { signal });
  const N = model.names;
  const o = model.options;

  const tables = new Set((await run('.show tables | project TableName')).map((r) => r.TableName));
  if (!tables.has(N.bronze)) throw new Error(`The Bronze table ${N.bronze} doesn't exist. Run "Set up live data" again.`);
  const views = new Map((await run('.show materialized-views | project Name, Query, SourceTable, IsEnabled')).map((v) => [v.Name, v]));
  const dropView = async (name) => { if (views.has(name)) { await run(`.drop materialized-view ${kqlName(name)} ifexists`); views.delete(name); ctx.log(`Dropped ${name} to rebuild it`); } };
  const dropViews = async () => { for (const g of model.gold) await dropView(g.name); await dropView(N.clean); };

  // ---- Bronze ----
  ctx.step(`Bronze: ${N.bronze} keeps the raw events as they arrive`);
  const policyOf = async (kind) => { const [r] = await run(`.show table ${kqlName(N.bronze)} policy ${kind}`); return r?.Policy && r.Policy !== 'null' ? r.Policy : null; };
  const bronzePolicies = { retention: await policyOf('retention'), caching: await policyOf('caching') };
  if (o.bronzeDays) {
    await run(`.alter-merge table ${kqlName(N.bronze)} policy retention softdelete = ${o.bronzeDays}d`);
    await run(`.alter table ${kqlName(N.bronze)} policy caching hot = ${hot('bronze', o.bronzeDays)}d`);
    ctx.log(`Retention ${o.bronzeDays} days for replay · hot cache ${hot('bronze', o.bronzeDays)} days`);
  } else ctx.log('Retention left as it is');
  await run(`.alter table ${kqlName(N.bronze)} folder ${kqlString(FOLDERS.bronze)}`).catch(() => {});
  ctx.progress(8);

  // ---- Silver: functions, tables, update policies ----
  ctx.step(`Silver: check and enrich every new event (${model.checks.length} checks)`);
  for (const f of model.functions) {
    await run(`.create-or-alter function with (folder = ${kqlString(FOLDERS.silver)}, docstring = ${kqlString(f.doc)}) ${kqlName(f.name)}() {\n${f.body}\n}`);
  }
  for (const c of model.checks) ctx.log(`Check: ${c.reason} (${c.kql})`);
  const ensureTable = async (name, schema, doc) => {
    if (tables.has(name)) {
      const have = await query(`${kqlName(name)} | getschema | project ColumnName, ColumnType`);
      const same = have.length === schema.length && schema.every((c, i) => have[i]?.ColumnName === c.name && sameKqlType(have[i].ColumnType, c.type));
      if (same) {
        const [{ n }] = await query(`${kqlName(name)} | count | project n = Count`);
        return { created: Number(n) === 0, reused: true };
      }
      ctx.log(`${name} has a different shape – rebuilding it from ${N.bronze}`);
      if (name === N.silver) await dropViews();
      await run(`.drop table ${kqlName(name)} ifexists`);
    }
    await run(`.create-merge table ${kqlName(name)} (${schema.map((c) => `${kqlName(c.name)}: ${c.type}`).join(', ')}) with (folder = ${kqlString(FOLDERS.silver)}, docstring = ${kqlString(doc)})`);
    return { created: true, reused: false };
  };
  const silver = await ensureTable(N.silver, model.silverSchema, `Silver layer: checked and enriched ${model.label || N.bronze} from ${N.bronze}.`);
  const quarantine = await ensureTable(N.quarantine, model.quarantineSchema, `Silver layer: ${N.bronze} events that failed a data-quality check, with the reason.`);
  await run(`.alter table ${kqlName(N.silver)} policy update ${policyJson(N.bronze, `${N.toSilver}()`)}`);
  await run(`.alter table ${kqlName(N.quarantine)} policy update ${policyJson(N.bronze, `${N.toQuarantine}()`)}`);
  ctx.log(`Update policies: ${N.bronze} → ${N.silver} and ${N.quarantine}, applied to every new event`);
  ctx.progress(18);

  // Events already in Bronze: process them once. The cut-off is taken after the policies are on, so nothing is
  // missed; the few events processed twice share their hash and the deduplication view removes them.
  if (silver.created || quarantine.created) {
    ctx.step(`Silver: process the events already in ${N.bronze}`);
    const [{ Now: cutoff }] = await query('print Now = now()');
    const src = `${kqlName(N.bronze)}\n| where ingestion_time() <= datetime(${cutoff}) and ingestion_time() > ago(${o.silverDays}d)`;
    const fill = [[silver, N.silver, model.silverQuery], [quarantine, N.quarantine, model.quarantineQuery]];
    for (const [state, name, build] of fill) {
      if (!state.created) continue;
      await kustoOperation(cluster, database, `.set-or-append async ${kqlName(name)} <|\n${build(src)}`, { signal, label: `Filling ${name}`, onWait: (s) => ctx.log(`Still filling ${name} (${s}s)…`) });
    }
  }
  const count = async (name) => Number((await query(`${kqlName(name)} | count`))[0]?.Count || 0);
  const silverRows = await count(N.silver);
  const quarantineRows = await count(N.quarantine);
  ctx.log(`${silverRows.toLocaleString('en-US')} events in ${N.silver} · ${quarantineRows.toLocaleString('en-US')} in ${N.quarantine}`);
  ctx.progress(28);

  // ---- Silver dedup + Gold views ----
  const desired = [model.clean, ...model.gold];
  const stale = desired.filter((v) => views.has(v.name) && (norm(views.get(v.name).Query) !== norm(v.query) || views.get(v.name).IsEnabled === false));
  if (stale.some((v) => v.name === N.clean)) await dropViews();
  else for (const v of stale) await dropView(v.name);
  const create = async (v) => {
    if (views.has(v.name)) { ctx.log(`${v.name} is up to date`); return; }
    const props = [`backfill=true`, `folder=${kqlString(v.layer === 'gold' ? FOLDERS.gold : FOLDERS.silver)}`, `docString=${kqlString(v.doc)}`, ...(v.lookback ? [`lookback=${v.lookback}`] : [])].join(', ');
    await kustoOperation(cluster, database, `.create async ifnotexists materialized-view with (${props}) ${kqlName(v.name)} on ${v.onView ? 'materialized-view' : 'table'} ${kqlName(v.source)}\n{\n${v.query}\n}`,
      { signal, label: `Creating ${v.name}`, onWait: (s) => ctx.log(`Still building ${v.name} (${s}s)…`) });
    views.set(v.name, { Name: v.name, Query: v.query, IsEnabled: true });
    ctx.log(`Created ${v.name}`);
  };
  ctx.step(`Silver: remove duplicates (${N.clean})`);
  await create(model.clean);
  ctx.progress(36);
  ctx.step(`Gold: ${model.gold.map((g) => g.label.toLowerCase()).join(', ')}`);
  for (const g of model.gold) await create(g);
  ctx.progress(44);

  // ---- retention and caching per layer, OneLake availability for Silver ----
  ctx.step('Set retention and caching per layer');
  for (const t of [N.silver, N.quarantine]) {
    await run(`.alter-merge table ${kqlName(t)} policy retention softdelete = ${o.silverDays}d`);
    await run(`.alter table ${kqlName(t)} policy caching hot = ${hot('silver', o.silverDays)}d`);
  }
  for (const [v, layer, d] of [[N.clean, 'silver', o.silverDays], ...model.gold.map((g) => [g.name, 'gold', o.goldDays])]) {
    await run(`.alter-merge materialized-view ${kqlName(v)} policy retention softdelete = ${d}d`);
    await run(`.alter materialized-view ${kqlName(v)} policy caching hot = ${hot(layer, d)}d`);
  }
  ctx.log(`Silver ${o.silverDays} days (hot ${hot('silver', o.silverDays)}) · Gold ${o.goldDays} days (hot ${hot('gold', o.goldDays)})`);
  const oneLake = { enabled: false, error: null };
  try {
    await run(`.alter-merge table ${kqlName(N.silver)} policy mirroring dataformat=parquet with (IsEnabled=${o.oneLake}, TargetLatencyInMinutes=5)`);
    oneLake.enabled = o.oneLake;
    if (o.oneLake) ctx.log(`OneLake availability on for ${N.silver}: Delta tables for lakehouses, notebooks and Power BI`);
  } catch (e) {
    oneLake.error = e.message;
    if (o.oneLake) ctx.log(`OneLake availability not turned on: ${e.message}`);
  }
  ctx.progress(50);

  ctx.step('Check every layer');
  const counts = { bronze: await count(N.bronze), silver: silverRows, quarantine: quarantineRows, clean: await count(N.clean) };
  for (const g of model.gold) counts[g.kind] = await count(g.name);
  ctx.log(`Bronze ${counts.bronze.toLocaleString('en-US')} · Silver ${counts.clean.toLocaleString('en-US')} unique (${(counts.silver - counts.clean).toLocaleString('en-US')} duplicates removed) · quarantine ${counts.quarantine.toLocaleString('en-US')} · Gold ${model.gold.map((g) => `${counts[g.kind].toLocaleString('en-US')} ${g.label.toLowerCase()}`).join(', ')}`);
  return { counts, oneLake, bronzePolicies, rebuilt: silver.created && silver.reused };
}

/** Remove the layers: views, Silver and quarantine tables, functions; Bronze gets its earlier policies back. */
export async function dropMedallion({ cluster, database }, names, { gold = [], bronzePolicies = null } = {}, ctx) {
  // Drops can take a while (OneLake copies are cleaned up too): a long timeout, and "already gone" counts as done.
  const run = (csl) => kusto(cluster, database, csl, { mgmt: true, signal: ctx.signal, timeoutMs: 5 * 60 * 1000 });
  const drop = (csl) => run(csl).catch((e) => { if (!/not found|does not exist/i.test(e.message)) throw e; });
  const N = names;
  const goldNames = gold.length ? gold.map((g) => g.name) : [N.perMinute, N.daily, N.latest];
  for (const v of [...goldNames, N.clean]) await drop(`.drop materialized-view ${kqlName(v)} ifexists`);
  ctx.log(`Dropped ${goldNames.length + 1} materialized views`);
  for (const t of [N.silver, N.quarantine]) {
    await run(`.alter-merge table ${kqlName(t)} policy mirroring dataformat=parquet with (IsEnabled=false)`).catch(() => {});
    await drop(`.drop table ${kqlName(t)} ifexists`);
  }
  ctx.log(`Dropped ${N.silver} and ${N.quarantine} (and their update policies)`);
  for (const f of [N.toSilver, N.toQuarantine]) await drop(`.drop function ${kqlName(f)} ifexists`);
  const restore = async (kind, policy) => {
    if (!policy) { await run(`.delete table ${kqlName(N.bronze)} policy ${kind}`).catch(() => {}); return; }
    if (kind === 'retention') { await run(`.alter table ${kqlName(N.bronze)} policy retention @'${JSON.stringify(JSON.parse(policy)).replace(/'/g, "''")}'`); return; }
    const span = String(JSON.parse(policy)?.DataHotSpan?.Value || JSON.parse(policy)?.DataHotSpan || '');
    const m = span.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
    if (m) await run(`.alter table ${kqlName(N.bronze)} policy caching hot = ${Math.max(1, Number(m[1] || 0) + Math.round(Number(m[2]) / 24))}d`);
  };
  await restore('retention', bronzePolicies?.retention).catch((e) => ctx.log(`Bronze retention not restored: ${e.message}`));
  await restore('caching', bronzePolicies?.caching).catch((e) => ctx.log(`Bronze caching not restored: ${e.message}`));
  await run(`.alter table ${kqlName(N.bronze)} folder ""`).catch(() => {});
  ctx.log(`${N.bronze} keeps its events and gets its earlier retention back`);
}

/** Rows per layer, recent flow, data-quality reasons and view health – for the UI and Copilot. */
export async function layerHealth({ cluster, database }, med, { minutes = 15 } = {}) {
  const N = med.names;
  const q = (csl) => kusto(cluster, database, csl);
  const tbl = (name, layer) => `(${kqlName(name)} | summarize Total = count(), Recent = countif(ingestion_time() > ago(${minutes}m)), LastIngested = max(ingestion_time()) | extend Layer = ${kqlString(layer)})`;
  const view = (name, layer) => `(${kqlName(name)} | summarize Total = count() | extend Layer = ${kqlString(layer)})`;
  const out = { minutes, layers: {}, reasons: [], views: [], freshnessSeconds: null, errors: [] };
  try {
    const rows = await q(`union ${[tbl(N.bronze, 'bronze'), tbl(N.silver, 'silver'), tbl(N.quarantine, 'quarantine'), view(N.clean, 'clean'), ...(med.gold || []).map((g) => view(g.name, g.kind))].join(', ')}`);
    for (const r of rows) out.layers[r.Layer] = { total: Number(r.Total) || 0, recent: r.Recent === null || r.Recent === undefined ? null : Number(r.Recent), lastIngested: r.LastIngested || null };
  } catch (e) { out.errors.push(e.message); }
  try {
    // Freshness: how old the newest checked event in Silver is (stays right when history is backfilled).
    const [r] = await q(`${kqlName(N.silver)} | where ingestion_time() > ago(${minutes}m) | summarize s = datetime_diff('second', now(), max(${kqlName(med.timeColumn)}))`);
    out.freshnessSeconds = r?.s === null || r?.s === undefined || r?.s === '' ? null : Math.max(0, Number(r.s));
  } catch (e) { out.errors.push(e.message); }
  try {
    out.reasons = (await q(`${kqlName(N.quarantine)} | summarize Rows = count() by Reason = ${kqlName(med.reasonColumn)} | top 8 by Rows desc`)).map((r) => ({ reason: r.Reason, rows: Number(r.Rows) || 0 }));
  } catch (e) { out.errors.push(e.message); }
  try {
    const names = [N.clean, ...(med.gold || []).map((g) => g.name)];
    out.views = (await kusto(cluster, database, `.show materialized-views | where Name in (${names.map(kqlString).join(', ')}) | project Name, IsEnabled, IsHealthy, MaterializedTo, LastRun, LastRunResult`, { mgmt: true }))
      .map((v) => ({ name: v.Name, enabled: v.IsEnabled !== false, healthy: v.IsHealthy !== false, materializedTo: v.MaterializedTo || null, lastRun: v.LastRun || null, lastRunResult: v.LastRunResult || null }));
  } catch (e) { out.errors.push(e.message); }
  const L = out.layers;
  if (L.silver && L.clean) out.duplicatesRemoved = Math.max(0, L.silver.total - L.clean.total);
  return out;
}
