// Real-time intelligence for the project: an Eventhouse table fed by an Eventstream (custom endpoint), a live event
// simulator shaped like the project's data, and a generated Real-Time Dashboard.
import * as F from '../fabric.mjs';
import { getProject, updateProject, setStep, recordArtifact, logActivity, fabricUrl } from '../project.mjs';
import { sleep } from '../config.mjs';
import { currentProfile } from '../reports/index.mjs';
import { kusto, assertReadOnlyKql, kqlName } from './kusto.mjs';
import { loadScenario, scenarioKind, scenarioSummary, tableCommand } from './scenarios.mjs';
import { buildDashboard, tileQueries } from './dashboard.mjs';
import * as SIM from './simulator.mjs';
import { applyLiveOntology, liveEventsOf, ontologySourceOf } from '../generators/ontology-live.mjs';
import { ALERT_CHANNELS, alertEntities, alertQuery, cleanRecipients } from './alerts.mjs';
import * as MED from './medallion.mjs';
import { querysetDefinition, silverTabs, goldTabs, goldModelFiles } from './medallion-items.mjs';
import * as TF from '../taskflow.mjs';
import { getToken } from '../auth.mjs';
import { dax, useSingleSignOn } from '../powerbi.mjs';
import { stableUuid } from '../config.mjs';
import { itemNameFor, standardName, purposeOf, numberedName, scopedPurpose } from '../naming.mjs';

export const dashboardUrl = (ws, id) => `https://app.fabric.microsoft.com/groups/${ws}/kustodashboards/${id}`;
export const activatorUrl = (ws, id) => `https://app.fabric.microsoft.com/groups/${ws}/reflexes/${id}`;
export const taskFlowUrl = (ws) => `https://app.fabric.microsoft.com/groups/${ws}/list?experience=fabric-developer`;

function requireWorkspace() {
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  return p;
}

function requireRealtime() {
  const p = requireWorkspace();
  if (!p.realtime?.eventstream) throw new Error('Set up live data first (Real-time › Set up live data).');
  return p;
}

const rtRef = (p) => ({ workspaceId: p.workspace.id, ...p.realtime });
const kq = (rt) => ({ cluster: rt.eventhouse.queryUri, database: rt.database.name });
/** The table or view consumers read: the deduplicated Silver view once the medallion layers exist. */
export const cleanSource = (rt) => rt?.medallion?.names?.clean || rt?.table;

/** What the UI and Copilot need: setup, scenario summary, dashboard and simulator state (no secrets). */
export function realtimeState() {
  const p = getProject();
  const rt = p.realtime || null;
  const med = rt?.medallion || null;
  return {
    available: Boolean(p.workspace && scenarioKind(p)),
    scenarioKind: scenarioKind(p),
    setup: rt,
    ontology: p.ontology ? { id: p.ontology.id, name: p.ontology.name, entities: p.ontology.entities || [] } : null,
    links: rt ? {
      eventhouse: fabricUrl('Eventhouse', p.workspace.id, rt.eventhouse.id),
      database: fabricUrl('KQLDatabase', p.workspace.id, rt.database.id),
      eventstream: fabricUrl('Eventstream', p.workspace.id, rt.eventstream.id),
      dashboard: rt.dashboard ? dashboardUrl(p.workspace.id, rt.dashboard.id) : null,
      ontology: p.ontology ? fabricUrl('Ontology', p.workspace.id, p.ontology.id) : null,
      activator: rt.alerts ? activatorUrl(p.workspace.id, rt.alerts.id) : null,
      silverQueryset: med?.items?.silverQueryset ? fabricUrl('KQLQueryset', p.workspace.id, med.items.silverQueryset.id) : null,
      goldQueryset: med?.items?.goldQueryset ? fabricUrl('KQLQueryset', p.workspace.id, med.items.goldQueryset.id) : null,
      goldModel: med?.items?.goldModel ? fabricUrl('SemanticModel', p.workspace.id, med.items.goldModel.id) : null,
      silverLakehouse: med?.items?.silverLakehouse ? fabricUrl('Lakehouse', p.workspace.id, med.items.silverLakehouse.id) : null,
      taskFlow: med?.taskFlow ? taskFlowUrl(p.workspace.id) : null,
    } : null,
    medallionDefaults: { ...MED.DEFAULT_OPTIONS, choices: MED.RETENTION_CHOICES },
    simulator: SIM.simulatorStatus(),
    limits: SIM.LIMITS,
  };
}

// Reference data is read once per project/source for 30 minutes: starting and restarting events stays quick.
let scenarioCache = { key: null, at: 0, scenario: null };

async function scenarioFor(p, { fresh = false } = {}) {
  const kind = scenarioKind(p);
  const key = [kind, p.modelSource?.itemId, p.semanticModel?.id, p.workspace?.id].join('|');
  if (!fresh && scenarioCache.key === key && Date.now() - scenarioCache.at < 30 * 60 * 1000) return scenarioCache.scenario;
  const scenario = await loadScenario(p, kind === 'generic' ? { profile: await currentProfile() } : {});
  scenarioCache = { key, at: Date.now(), scenario };
  return scenario;
}

function realtimeQuality(scenario) {
  const errors = [];
  const warnings = [];
  let score = 100;
  const roles = new Set((scenario.columns || []).map((c) => c.role).filter(Boolean));
  if (!scenario.table) errors.push('No Eventhouse table name was generated.');
  if (!scenario.columns?.length) errors.push('No event columns were generated.');
  if (!roles.has('time')) errors.push('The live event schema has no time column.');
  if (!roles.has('order') && !roles.has('itemKey') && !roles.has('partyKey')) warnings.push('The event schema has no obvious business key (order, item or party).');
  if (!roles.has('amount')) warnings.push('The event schema has no amount column, so dashboard KPIs will focus on counts.');
  if (!roles.has('rule')) warnings.push('No rule-break column was generated; Activator alerts will be limited.');
  if (!Object.values(scenario.references || {}).some((n) => Number(n) > 0)) warnings.push('No reference data was loaded; simulated events may be generic.');
  if (!scenario.rules?.length) warnings.push('No business-rule scenarios were generated for live events.');
  score -= errors.length * 40;
  score -= warnings.length * 8;
  score = Math.max(0, Math.min(100, score));
  const status = errors.length ? 'not-ready' : score >= 80 ? 'ready' : 'needs-review';
  return { status, score, errors, warnings: warnings.slice(0, 10), summary: status === 'ready' ? `Ready (${score}/100)` : status === 'needs-review' ? `Needs review (${score}/100)` : `Not ready (${score}/100)` };
}

function medallionQuality(model, summary) {
  const errors = [];
  const warnings = [];
  let score = 100;
  if (!model?.checks?.length) errors.push('No Silver validation checks were generated.');
  if (!model?.gold?.length) errors.push('No Gold aggregate views were generated.');
  if (!summary?.names?.silver || !summary?.names?.clean) errors.push('Silver table/view names are missing.');
  if (!model?.extras?.some((x) => x.role === 'hash')) warnings.push('No event hash column was generated; duplicate detection may be weaker.');
  if (!model?.gold?.some((g) => /minute|hour|day/i.test(g.name))) warnings.push('No time-bucket Gold view was generated; dashboard trend tiles may be limited.');
  score -= errors.length * 40;
  score -= warnings.length * 8;
  score = Math.max(0, Math.min(100, score));
  const status = errors.length ? 'not-ready' : score >= 80 ? 'ready' : 'needs-review';
  return { status, score, errors, warnings: warnings.slice(0, 10), summary: status === 'ready' ? `Ready (${score}/100)` : status === 'needs-review' ? `Needs review (${score}/100)` : `Not ready (${score}/100)` };
}

/** Create (or reuse) the Eventhouse, the events table and the Eventstream that feeds it. */
export async function runRealtimeSetup(ctx, { name } = {}) {
  const p = requireWorkspace();
  const ws = p.workspace;
  ctx.step('Read your data to shape the live events');
  const scenario = await scenarioFor(p, { fresh: true });
  ctx.log(`${scenario.label}: ${scenario.description}`);
  ctx.log(`Reference data: ${Object.entries(scenario.references).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  const quality = realtimeQuality(scenario);
  ctx.step(`Real-time quality gate: ${quality.summary}`);
  if (quality.errors.length) throw new Error(`Real-time setup is not ready: ${quality.errors.join(' ')}`);
  ctx.log(`Quality gate: ${quality.summary}`);
  for (const w of quality.warnings) ctx.log(`Quality warning: ${w}`);
  ctx.progress(15);

  const prevRt = p.realtime;
  const ehName = F.itemName('Eventhouse', itemNameFor('Eventhouse', { name, current: prevRt?.eventhouse?.name, purpose: scopedPurpose('Live') }), 'Live');
  ctx.step(`Create the Eventhouse "${ehName}"`);
  let eh = (await F.listItems(ws.id, 'Eventhouse')).find((i) => i.displayName.toLowerCase() === ehName.toLowerCase());
  if (eh) ctx.log('Using the existing Eventhouse');
  else {
    eh = await F.fabric('POST', `/workspaces/${ws.id}/eventhouses`, { displayName: ehName, description: `Live events from Fabric MCP Studio (${scenario.label}).` }, { signal: ctx.signal });
    if (!eh?.id) eh = await F.findItem(ws.id, 'Eventhouse', ehName);
    recordArtifact({ type: 'Eventhouse', id: eh.id, name: ehName, workspaceId: ws.id });
  }
  let props = null;
  for (let i = 0; i < 40; i++) {
    props = (await F.fabric('GET', `/workspaces/${ws.id}/eventhouses/${eh.id}`)).properties;
    if (props?.queryServiceUri && props.databasesItemIds?.length) break;
    await sleep(3000);
  }
  if (!props?.databasesItemIds?.length) throw new Error('The Eventhouse has no KQL database yet. Try again in a minute.');
  const dbs = await F.listItems(ws.id, 'KQLDatabase');
  const db = dbs.find((d) => props.databasesItemIds.includes(d.id) && d.displayName.toLowerCase() === ehName.toLowerCase()) || dbs.find((d) => props.databasesItemIds.includes(d.id));
  ctx.log(`KQL database ${db.displayName} · ${props.queryServiceUri}`);
  ctx.progress(35);

  ctx.step(`Create the ${scenario.table} table`);
  const cluster = props.queryServiceUri;
  const existing = await kusto(cluster, db.displayName, `.show tables | where TableName == "${scenario.table}" | project TableName`, { mgmt: true, signal: ctx.signal });
  if (existing.length) {
    const cols = await kusto(cluster, db.displayName, `${kqlName(scenario.table)} | getschema | project ColumnName, ColumnType`, { signal: ctx.signal });
    const have = new Map(cols.map((c) => [c.ColumnName, c.ColumnType]));
    const conflict = scenario.columns.filter((c) => have.has(c.name) && !sameType(have.get(c.name), c.type));
    if (conflict.length) throw new Error(`The table ${scenario.table} already exists with different column types (${conflict.map((c) => c.name).join(', ')}). Use another Eventhouse name.`);
  }
  await kusto(cluster, db.displayName, tableCommand(scenario), { mgmt: true, signal: ctx.signal });
  await kusto(cluster, db.displayName, `.alter table ${kqlName(scenario.table)} policy streamingingestion enable`, { mgmt: true, signal: ctx.signal }).catch((e) => ctx.log(`Streaming ingestion not enabled: ${e.message}`));
  await kusto(cluster, db.displayName, `.alter table ${kqlName(scenario.table)} docstring "${scenario.description.replace(/"/g, "'")}"`, { mgmt: true, signal: ctx.signal }).catch(() => {});
  ctx.log(`${scenario.columns.length} columns: ${scenario.columns.map((c) => c.name).join(', ')}`);
  ctx.progress(50);

  // The Eventstream that already feeds this Eventhouse keeps its name.
  const esName = F.itemName('Eventstream', prevRt?.eventhouse?.id === eh.id && prevRt.eventstream?.name ? prevRt.eventstream.name : standardName('Eventstream', purposeOf(ehName, 'Eventhouse')), 'Stream');
  ctx.step(`Create the Eventstream "${esName}"`);
  const streamName = `${esName}-stream`;
  const ser = { type: 'Json', properties: { encoding: 'UTF8' } };
  const topology = {
    sources: [{ name: 'StudioLiveEvents', type: 'CustomEndpoint', properties: {} }],
    destinations: [{
      name: 'StudioEventhouse', type: 'Eventhouse',
      properties: { dataIngestionMode: 'ProcessedIngestion', workspaceId: ws.id, itemId: db.id, databaseName: db.displayName, tableName: scenario.table, inputSerialization: ser },
      inputNodes: [{ name: streamName }],
    }],
    streams: [{ name: streamName, type: 'DefaultStream', properties: {}, inputNodes: [{ name: 'StudioLiveEvents' }] }],
    operators: [],
    compatibilityLevel: '1.0',
  };
  const definition = F.toParts({ 'eventstream.json': topology, 'eventstreamProperties.json': { retentionTimeInDays: 1, eventThroughputLevel: 'Low' } });
  let es = await F.findItem(ws.id, 'Eventstream', esName);
  if (es) {
    const topo = await F.fabric('GET', `/workspaces/${ws.id}/eventstreams/${es.id}/topology`);
    const dest = topo?.destinations?.find((d) => d.type === 'Eventhouse');
    const ok = topo?.sources?.some((s) => s.type === 'CustomEndpoint') && dest?.properties?.itemId === db.id && dest?.properties?.tableName === scenario.table;
    if (ok) ctx.log('Using the existing Eventstream');
    else {
      await F.updateDefinition(ws.id, es.id, definition);
      ctx.log('Updated the existing Eventstream');
    }
  } else {
    es = await F.createItem(ws.id, { name: esName, type: 'Eventstream', description: `Custom endpoint for live events → ${ehName}.${scenario.table}`, definition });
    recordArtifact({ type: 'Eventstream', id: es.id, name: esName, workspaceId: ws.id });
  }
  SIM.forgetEndpoint();
  ctx.progress(70);

  ctx.step('Wait for the Eventstream to start');
  let status = '';
  for (let i = 0; i < 60; i++) {
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    const topo = await F.fabric('GET', `/workspaces/${ws.id}/eventstreams/${es.id}/topology`).catch(() => null);
    const nodes = [...(topo?.sources || []), ...(topo?.destinations || [])];
    status = nodes.map((n) => `${n.name} ${n.status}`).join(' · ');
    const failed = nodes.find((n) => /fail|error|warning/i.test(n.status || ''));
    if (failed) throw new Error(`Eventstream ${failed.name} is ${failed.status}${failed.error ? `: ${JSON.stringify(failed.error)}` : ''}`);
    if (nodes.length && nodes.every((n) => n.status === 'Running')) break;
    if (i % 5 === 0) ctx.log(status || 'Starting…');
    await sleep(5000);
  }
  ctx.log(status);
  ctx.progress(90);

  const prev = getProject().realtime;
  const same = prev?.eventhouse?.id === eh.id && prev?.table === scenario.table;
  const realtime = {
    scenario: scenarioSummary(scenario),
    eventhouse: { id: eh.id, name: ehName, queryUri: cluster },
    database: { id: db.id, name: db.displayName },
    table: scenario.table,
    eventstream: { id: es.id, name: esName },
    dashboard: same ? prev.dashboard || null : null,
    ontology: same ? prev.ontology || null : null,
    alerts: same ? prev.alerts || null : null,
    medallion: same ? prev.medallion || null : null,
    medallionRemoval: same ? prev.medallionRemoval || null : null,
    quality,
    createdAt: prev?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  updateProject({ realtime });
  setStep('realtime', 'done', `${ehName}.${scenario.table}`);
  return { eventhouse: ehName, table: scenario.table, eventstream: esName, scenario: scenario.label };
}

function sameType(kqlType, ours) {
  const norm = (t) => String(t).toLowerCase().replace(/^system\./, '').replace('int32', 'int').replace('int64', 'long').replace('double', 'real').replace('datetime', 'datetime');
  return norm(kqlType) === norm(ours);
}

/** Start streaming live events (reference data is loaded fresh from the source). */
export async function startLiveEvents(opts = {}) {
  const p = requireRealtime();
  const scenario = await scenarioFor(p);
  if (scenario.table !== p.realtime.table) throw new Error(`Your data now needs the ${scenario.table} table. Run "Set up live data" again.`);
  let backfillMinutes = Number(opts.backfillMinutes);
  if (opts.backfillMinutes === undefined || opts.backfillMinutes === 'auto') {
    const n = await kusto(p.realtime.eventhouse.queryUri, p.realtime.database.name, `${kqlName(p.realtime.table)} | where EventTime > ago(1h) | count`).catch(() => [{ Count: 1 }]);
    backfillMinutes = Number(n[0]?.Count) ? 0 : 60;
  }
  return SIM.startSimulator(rtRef(p), scenario, { ...opts, backfillMinutes, dataIssuePct: opts.dataIssuePct ?? (p.realtime.medallion ? 1 : 0) });
}

export const stopLiveEvents = () => SIM.stopSimulator('stopped by user');
export const updateLiveEvents = (o) => SIM.updateSimulator(o);

/** Read-only KQL against the live table's database. */
export async function liveQuery(csl, { maxRows = 200 } = {}) {
  const p = requireRealtime();
  const text = assertReadOnlyKql(csl);
  const rows = await kusto(p.realtime.eventhouse.queryUri, p.realtime.database.name, `set truncationmaxrecords=${maxRows + 1};\n${text}`);
  return { columns: rows.length ? Object.keys(rows[0]) : [], rows: rows.slice(0, maxRows), rowCount: rows.length, truncated: rows.length > maxRows };
}

/** Headline numbers for the last N minutes (UI KPIs and Copilot). */
export async function liveSummary({ minutes = 15 } = {}) {
  const p = requireRealtime();
  const s = p.realtime.scenario;
  const R = Object.fromEntries(s.columns.filter((c) => c.role).map((c) => [c.role, c.name]));
  const amount = R.amount ? kqlName(R.amount) : null;
  const rule = R.rule ? kqlName(R.rule) : null;
  const t = kqlName(R.time || 'EventTime');
  const csl = `${kqlName(s.table)}
| summarize Total = count(), LastEvent = max(${t}), LastIngested = max(ingestion_time())
| extend k = 1
| join kind=leftouter (${kqlName(s.table)} | where ${t} > ago(${minutes}m) | summarize Events = count()${amount ? `, Amount = round(sum(${amount}), 2)` : ''}${rule ? `, RuleBreaks = countif(isnotempty(${rule}))` : ''}${R.order && s.unit === 'sales line' ? `, Orders = dcount(${kqlName(R.order)})` : ''} | extend k = 1) on k
| project-away k, k1`;
  const [row] = await kusto(p.realtime.eventhouse.queryUri, p.realtime.database.name, csl);
  return { minutes, amountLabel: s.columns.find((c) => c.role === 'amount')?.label || 'Amount', ...(row || {}) };
}

/** Build (or update) the Real-Time Dashboard. Every tile query is checked against the Eventhouse first. */
export async function runRealtimeDashboard(ctx, { name, refreshSeconds = 30 } = {}) {
  const p = requireRealtime();
  const rt = p.realtime;
  const ws = p.workspace;
  const title = F.itemName('KQLDashboard', itemNameFor('KQLDashboard', { name, current: rt.dashboard?.name, purpose: scopedPurpose('Live') }));
  ctx.step('Design the dashboard');
  const dash = buildDashboard({ title, source: { clusterUri: rt.eventhouse.queryUri, databaseId: rt.database.id, databaseName: rt.database.name, workspaceId: ws.id }, scenario: rt.scenario, refreshSeconds, medallion: rt.medallion || null });
  ctx.log(`${dash.pages.length} pages · ${dash.tiles.length} tiles · auto refresh every ${refreshSeconds} seconds${rt.medallion ? ` · reads Silver ${rt.medallion.names.clean} and Gold views` : ''}`);
  ctx.progress(20);

  ctx.step('Check every tile against the Eventhouse');
  const failures = [];
  for (const t of tileQueries(dash)) {
    try { await kusto(rt.eventhouse.queryUri, rt.database.name, t.kql, { signal: ctx.signal }); } catch (e) { failures.push(`${t.title}: ${e.message}`); }
  }
  if (failures.length) throw new Error(`Some tiles don't run: ${failures.join(' | ')}`);
  ctx.log('All tile queries run');
  ctx.progress(50);

  ctx.step(`Deploy "${title}"`);
  const definition = F.toParts({ 'RealTimeDashboard.json': dash });
  let item = rt.dashboard?.id ? await F.getItem(ws.id, rt.dashboard.id).catch(() => null) : null;
  item ||= await F.findItem(ws.id, 'KQLDashboard', title);
  if (item) {
    await F.updateDefinition(ws.id, item.id, definition);
    ctx.log('Updated the existing dashboard');
  } else {
    item = await F.createItem(ws.id, { name: title, type: 'KQLDashboard', description: `Real-Time Dashboard over ${rt.database.name}.${rt.table}, generated by Fabric MCP Studio.`, definition });
    recordArtifact({ type: 'KQLDashboard', id: item.id, name: title, workspaceId: ws.id, url: dashboardUrl(ws.id, item.id) });
  }
  const dashboard = { id: item.id, name: title, url: dashboardUrl(ws.id, item.id), pages: dash.pages.map((x) => x.name), tiles: dash.tiles.length, refreshSeconds, builtAt: new Date().toISOString() };
  updateProject({ realtime: { ...getProject().realtime, dashboard } });
  logActivity('realtime.dashboard', `Real-Time Dashboard "${title}" deployed`, {});
  await syncTaskFlow(ctx);
  return dashboard;
}

/** Connection details for the customer's own apps. The key is returned only when `withKey` (UI only, never Copilot). */
export async function endpointInfo({ withKey = false } = {}) {
  const p = requireRealtime();
  const c = await SIM.endpoint(rtRef(p));
  return {
    namespace: c.ns, eventHub: c.hub, sourceName: c.sourceName, keyName: c.keyName, table: p.realtime.table,
    columns: p.realtime.scenario.columns.map((x) => ({ name: x.name, type: x.type })),
    ...(withKey ? { connectionString: c.connectionString } : {}),
  };
}

// ---------------- live ontology ----------------

async function readOntology(p) {
  const def = await F.getDefinition(p.workspace.id, p.ontology.id);
  const files = Object.fromEntries((def?.parts || []).map((x) => [x.path, Buffer.from(x.payload, 'base64').toString('utf8')]));
  if (!Object.keys(files).some((k) => /^entities\/.+\.tmdl$/.test(k))) throw new Error(`${p.ontology.name} has no TMDL entity types. Create it again in the Ontology tab.`);
  return files;
}

/**
 * Bind the live events table to the ontology: every entity type whose key is a column of the events gets time-series
 * properties (amount, quantity, discount, margin, rule broken…) and a link to the Real-Time Dashboard. `unlink` removes them.
 */
export async function runLiveOntology(ctx, { unlink = false } = {}) {
  const p = requireRealtime();
  if (!p.ontology?.id) throw new Error('Create the ontology first (Ontology tab).');
  const ws = p.workspace;
  ctx.step(`Read the ontology "${p.ontology.name}"`);
  const files = await readOntology(p);
  ctx.progress(25);

  ctx.step(unlink ? 'Remove the live properties' : `Bind ${p.realtime.database.name}.${cleanSource(p.realtime)} to the entity types`);
  const out = applyLiveOntology(files, { events: liveEventsOf(p), link: !unlink, source: ontologySourceOf(p), dashboard: p.realtime.dashboard, workspaceId: ws.id });
  if (!unlink && !out.linked.length) {
    const keys = p.realtime.scenario.columns.filter((c) => /key$|id$/i.test(c.name)).map((c) => c.name);
    throw new Error(`No entity type's key matches a column of ${p.realtime.table}${keys.length ? ` (${keys.join(', ')})` : ''}. Live properties need events that carry the entity key.`);
  }
  for (const l of out.linked) ctx.log(`${l.entity}: ${l.properties.length} live properties (${l.properties.join(', ')}) · ${p.realtime.table}.${l.eventColumn} → ${l.keyColumn}`);
  if (out.removed.length) ctx.log(`Replaced ${out.removed.length} earlier live binding${out.removed.length === 1 ? '' : 's'}`);
  if (out.annotated) ctx.log(`${out.annotated} tables tagged with their source item so Fabric can preview instances`);
  if (!unlink && p.realtime.dashboard) ctx.log(`Linked "${p.realtime.dashboard.name}" from each of these entity types`);
  ctx.progress(55);

  ctx.step(`Update "${p.ontology.name}"`);
  await F.updateDefinition(ws.id, p.ontology.id, F.toParts(Object.fromEntries(Object.entries(out.files).filter(([k]) => k !== '.platform'))));
  const ontology = unlink ? null : {
    id: p.ontology.id, name: p.ontology.name, linkedAt: new Date().toISOString(), dashboardLinked: Boolean(p.realtime.dashboard),
    entities: out.linked.map((l) => ({ entity: l.entity, key: l.keyColumn, eventColumn: l.eventColumn, properties: l.properties })),
  };
  updateProject({ realtime: { ...getProject().realtime, ontology } });
  logActivity('realtime.ontology', unlink ? `Removed the live properties from "${p.ontology.name}"` : `Live events bound to ${out.linked.map((l) => l.entity).join(', ')} in "${p.ontology.name}"`, {});
  await syncTaskFlow(ctx);
  return unlink ? { ontology: p.ontology.name, removed: out.removed.length } : { ontology: p.ontology.name, entities: ontology.entities, url: fabricUrl('Ontology', ws.id, p.ontology.id) };
}

// ---------------- Activator alerts ----------------

/** Create or update an Activator that sends a Teams message or email for every live business-rule break. */
export async function runRealtimeAlerts(ctx, { channel = 'teams', recipients, rules: ruleIds, minAmount = 0, name } = {}) {
  const p = requireRealtime();
  const rt = p.realtime;
  const ws = p.workspace;
  if (!ALERT_CHANNELS.includes(channel)) throw new Error(`Channel must be one of: ${ALERT_CHANNELS.join(', ')}.`);
  const to = cleanRecipients(recipients);
  const rules = Array.isArray(ruleIds) && ruleIds.length ? rt.scenario.rules.filter((r) => ruleIds.includes(r.id) || ruleIds.includes(r.label)) : rt.scenario.rules;
  if (!rules.length) throw new Error(`Pick at least one business rule (${rt.scenario.rules.map((r) => r.label).join(', ')}).`);
  const min = Math.max(0, Number(minAmount) || 0);

  ctx.step('Check the alert query against the Eventhouse');
  const source = cleanSource(rt);
  const ruleCol = rt.scenario.columns.find((c) => c.role === 'rule')?.name || 'RuleBreak';
  const probe = alertQuery(rt.scenario, { minAmount: min, source }).replace(/^declare query_parameters\(.*\);/, 'let startTime = ago(60m); let endTime = now();');
  const counts = await kusto(rt.eventhouse.queryUri, rt.database.name, `${probe}\n| summarize Breaks = count() by ${kqlName(ruleCol)}`, { signal: ctx.signal });
  ctx.log(counts.length ? `Last hour: ${counts.map((c) => `${c.Breaks} × ${c[ruleCol]}`).join(', ')}` : 'No rule breaks in the last hour yet – alerts start with the next ones');
  if (rt.medallion) ctx.log(`Reads ${source} (Silver: checked and deduplicated), so a duplicate event never sends a second message`);
  ctx.progress(30);

  let itemName = F.itemName('Reflex', itemNameFor('Reflex', { name, current: rt.alerts?.name, purpose: scopedPurpose('RuleBreaks') }), 'Alerts');
  ctx.step(`${rt.alerts ? 'Update' : 'Create'} the Activator "${itemName}"`);
  const entities = alertEntities({ workspaceId: ws.id, database: rt.database, scenario: rt.scenario, rules, channel, recipients: to, minAmount: min, source });
  const definition = F.toParts({ 'ReflexEntities.json': entities });
  let item = rt.alerts?.id ? await F.getItem(ws.id, rt.alerts.id).catch(() => null) : null;
  item ||= await F.findItem(ws.id, 'Reflex', itemName);
  if (item) {
    await F.updateDefinition(ws.id, item.id, definition);
    ctx.log('Updated the existing Activator');
  } else {
    const create = (n) => F.createItem(ws.id, { name: n, type: 'Reflex', description: `Alerts on live business-rule breaks in ${rt.database.name}.${rt.table}, generated by Fabric MCP Studio.`, definition });
    // A just-deleted item keeps its name reserved for a few minutes: fall back to a numbered name.
    for (let i = 1; !item; i++) {
      const n = i === 1 ? itemName : F.itemName('Reflex', numberedName(itemName, i), 'Alerts');
      try {
        item = await create(n);
        itemName = n;
      } catch (e) {
        if (i >= 5 || !/not available yet|NotAvailableYet|already in use/i.test(e.message)) throw e;
        ctx.log(`The name ${n} is still reserved by a deleted item – trying another`);
      }
    }
    recordArtifact({ type: 'Reflex', id: item.id, name: itemName, workspaceId: ws.id, url: activatorUrl(ws.id, item.id) });
  }
  ctx.log(`${rules.length} rule${rules.length === 1 ? '' : 's'} running: ${rules.map((r) => r.label).join(', ')} · ${channel === 'email' ? 'email' : 'Teams message'} to ${to.length} recipient${to.length === 1 ? '' : 's'}${min ? ` · ${rt.scenario.columns.find((c) => c.role === 'amount')?.label || 'amount'} ≥ ${min}` : ''} · checked every minute`);
  ctx.progress(90);

  const now = new Date().toISOString();
  const alerts = { id: item.id, name: itemName, url: activatorUrl(ws.id, item.id), channel, recipients: to, rules: rules.map((r) => r.label), ruleIds: rules.map((r) => r.id), minAmount: min, source, intervalSeconds: 60, createdAt: rt.alerts?.createdAt || now, updatedAt: now };
  updateProject({ realtime: { ...getProject().realtime, alerts } });
  logActivity('realtime.alerts', `Activator "${itemName}": ${rules.length} rule alert${rules.length === 1 ? '' : 's'} by ${channel === 'email' ? 'email' : 'Teams'}`, {});
  await syncTaskFlow(ctx);
  return { ...alerts, recipients: to.length };
}

/** Delete the Real-Time Dashboard (the live data stays). Links to it in the live ontology are taken out first. */
export async function removeDashboard() {
  const p = requireRealtime();
  const d = p.realtime.dashboard;
  if (p.realtime.ontology?.dashboardLinked && p.ontology?.id) await runLiveOntology(QUIET, { unlink: true }).catch(() => {});
  if (d?.id) await F.deleteItem(p.workspace.id, d.id).catch((e) => { if (e.status !== 404 && !/not\s*found/i.test(e.message)) throw e; });
  updateProject({ realtime: { ...getProject().realtime, dashboard: null } });
  if (d) logActivity('realtime.dashboard', `Real-Time Dashboard "${d.name}" removed`, {});
  await syncTaskFlow(QUIET);
  return { ok: true };
}

/** Stop the alerts (deletes the Activator unless `keepItem`). */
export async function removeAlerts({ keepItem = false } = {}) {
  const p = requireRealtime();
  const a = p.realtime.alerts;
  if (a?.id && !keepItem) await F.deleteItem(p.workspace.id, a.id).catch((e) => { if (!/not\s*found|404/i.test(e.message)) throw e; });
  updateProject({ realtime: { ...getProject().realtime, alerts: null } });
  if (a) logActivity('realtime.alerts', `Activator "${a.name}" removed`, {});
  await syncTaskFlow(QUIET);
  return { ok: true };
}

/** Forget the real-time setup (optionally deleting the Fabric items). */
export async function removeRealtime({ deleteItems = false } = {}) {
  const p = getProject();
  SIM.stopSimulator('removed');
  SIM.forgetEndpoint();
  const rt = p.realtime;
  if (rt && deleteItems && p.workspace) {
    // The ontology would point at a deleted table: take the live properties off first.
    if (rt.ontology && p.ontology?.id) await runLiveOntology(QUIET, { unlink: true }).catch(() => {});
    if (rt.medallion?.taskFlow?.id) await TF.deleteTaskFlow(p.workspace.id, rt.medallion.taskFlow.id).catch(() => {});
    const med = rt.medallion?.items || {};
    for (const id of [rt.alerts?.id, rt.dashboard?.id, med.goldModel?.id, med.goldQueryset?.id, med.silverLakehouse?.id, med.silverQueryset?.id, rt.eventstream?.id, rt.eventhouse?.id].filter(Boolean)) await F.deleteItem(p.workspace.id, id).catch(() => {});
  }
  updateProject({ realtime: null });
  return { ok: true };
}

// ---------------- medallion layers ----------------

const QUIET = { step() {}, log() {}, progress() {}, signal: undefined };

/** A job context that reports a nested job's steps as log lines of the parent, within a progress range. */
function nested(ctx, from, to) {
  return { signal: ctx.signal, step: (s) => ctx.log(`· ${s}`), log: (l) => ctx.log(`  ${l}`), progress: (p) => ctx.progress(from + ((to - from) * Math.min(100, p)) / 100) };
}

async function upsertItem(ctx, ws, { type, name, description, definition }) {
  let item = await F.findItem(ws.id, type, name);
  if (item) { await F.updateDefinition(ws.id, item.id, definition); ctx.log(`Updated ${name}`); return { item, created: false }; }
  item = await F.createItem(ws.id, { name, type, description, definition });
  recordArtifact({ type, id: item.id, name, workspaceId: ws.id });
  ctx.log(`Created ${name}`);
  return { item, created: true };
}

/** The Fabric items of each layer, as task flow tasks (Microsoft's "Event medallion" flow, one item per task). */
function medallionFlow(p) {
  const rt = p.realtime;
  const med = rt.medallion;
  const N = med.names;
  const items = med.items || {};
  const o = med.options;
  const tasks = [
    { key: 'ingest', name: 'Live events ingest', type: 'get data', x: 0, y: 80, items: [{ type: 'Eventstream', id: rt.eventstream.id }],
      description: `Live ${rt.scenario.unit}s from the studio simulator or your own apps arrive through the custom endpoint of ${rt.eventstream.name}.` },
    { key: 'bronze', name: 'Bronze layer', type: 'store data', x: 360, y: 80, items: [{ type: 'Eventhouse', id: rt.eventhouse.id }],
      description: `Raw events land in ${rt.database.name}.${N.bronze} exactly as they arrive${o.bronzeDays ? `, kept ${o.bronzeDays} days for replay` : ''}. The Silver and Gold tables and views live in the same KQL database (folders Bronze, Silver, Gold).` },
    { key: 'toSilver', name: 'Bronze to Silver', type: 'prepare data', x: 720, y: 80, items: [{ type: 'KQLQueryset', id: items.silverQueryset?.id }],
      description: `Update policies check every new event (${med.checks.map((c) => c.reason.toLowerCase()).join('; ')}), enrich it and send failures to ${N.quarantine} with the reason.` },
    { key: 'silver', name: 'Silver layer', type: 'store data', x: 1080, y: 80, items: [{ type: 'Lakehouse', id: items.silverLakehouse?.id }],
      description: `${N.silver}: checked and enriched events; ${N.clean} removes duplicates as they arrive (materialized view)${items.silverLakehouse ? `; ${items.silverLakehouse.name} exposes Silver in OneLake as Delta` : ''}. Kept ${o.silverDays} days.` },
    { key: 'toGold', name: 'Silver to Gold', type: 'prepare data', x: 1440, y: 80, items: [{ type: 'KQLQueryset', id: items.goldQueryset?.id }],
      description: `Materialized views aggregate Silver continuously, late events included: ${med.gold.map((g) => g.label.toLowerCase()).join(', ')}.` },
    { key: 'gold', name: 'Gold layer', type: 'store data', x: 1800, y: 80, items: [{ type: 'SemanticModel', id: items.goldModel?.id }],
      description: `${med.gold.map((g) => g.name).join(', ')} (kept ${o.goldDays} days), published as the ${items.goldModel?.name || 'Gold'} semantic model for Power BI and Copilot.` },
    { key: 'visualize', name: 'Realtime visualize', type: 'visualize', x: 2160, y: 80, items: [{ type: 'KQLDashboard', id: rt.dashboard?.id }],
      description: 'Real-Time Dashboard over the deduplicated Silver events and the Gold views, refreshed automatically.' },
    { key: 'activate', name: 'Realtime activation', type: 'track data', x: 1440, y: 300, items: [{ type: 'Reflex', id: rt.alerts?.id }],
      description: 'Activator checks the Silver events every minute and sends a Teams message or email for each business-rule break.' },
    { key: 'context', name: 'Business context', type: 'analyze and train data', x: 1800, y: 300, items: [{ type: 'Ontology', id: rt.ontology ? p.ontology?.id : null }],
      description: 'The ontology gives each product, customer and region its live Silver events as time-series properties, for agents and people.' },
  ];
  const edges = [['ingest', 'bronze'], ['bronze', 'toSilver'], ['toSilver', 'silver'], ['silver', 'toGold'], ['toGold', 'gold'], ['gold', 'visualize'], ['silver', 'activate'], ['silver', 'context']];
  return {
    name: rt.medallion?.taskFlow?.name || standardName('TaskFlow', scopedPurpose('EventMedallion', p), p),
    description: `Bronze, Silver and Gold layers for ${rt.scenario.label}, built by Fabric MCP Studio on Microsoft's Real-Time Intelligence medallion pattern: events are checked, deduplicated and aggregated as they arrive, with no schedules.`,
    tasks, edges,
  };
}

/** Create or update the workspace task flow so it matches the medallion's items (quietly skipped without one). */
export async function syncTaskFlow(ctx = QUIET) {
  const p = getProject();
  const rt = p.realtime;
  if (!p.workspace || !rt?.medallion) return null;
  try {
    const flow = await TF.buildTaskFlow(medallionFlow(p), { idOf: (...k) => stableUuid('taskflow', p.workspace.id, rt.eventhouse.id, ...k), workspaceId: p.workspace.id });
    const saved = await TF.saveTaskFlow(p.workspace.id, flow, { id: rt.medallion.taskFlow?.id });
    const assigned = flow.tasks.reduce((a, t) => a + t.items.filter((i) => i.artifactObjectId).length, 0);
    const taskFlow = { id: saved.id, name: flow.name, tasks: flow.tasks.length, items: assigned, url: taskFlowUrl(p.workspace.id), syncedAt: new Date().toISOString() };
    updateProject({ realtime: { ...getProject().realtime, medallion: { ...getProject().realtime.medallion, taskFlow, taskFlowError: null } } });
    ctx.log(`Task flow "${flow.name}" ${saved.created ? 'created' : 'updated'} in the workspace: ${flow.tasks.length} tasks, ${assigned} items assigned`);
    return taskFlow;
  } catch (e) {
    updateProject({ realtime: { ...getProject().realtime, medallion: { ...getProject().realtime.medallion, taskFlowError: e.message } } });
    ctx.log(`The workspace task flow wasn't updated: ${e.message}`);
    return null;
  }
}

/**
 * Apply the medallion template to the live events: Bronze/Silver/Gold layers in the Eventhouse, one Fabric item per
 * layer (querysets and a Gold semantic model), the workspace task flow, and the dashboard, alerts and live ontology
 * moved to the clean data. Safe to run again: what already matches is kept.
 */
export async function runMedallion(ctx, opts = {}) {
  const p = requireRealtime();
  const ws = p.workspace;
  const rt = p.realtime;
  const model = MED.medallionModel(rt.scenario, MED.medallionOptions(opts, rt.medallion?.options));
  const summary = MED.modelSummary(model);
  const quality = medallionQuality(model, summary);
  ctx.step(`Medallion quality gate: ${quality.summary}`);
  if (quality.errors.length) throw new Error(`Medallion design is not ready: ${quality.errors.join(' ')}`);
  ctx.log(`Quality gate: ${quality.summary}`);
  for (const w of quality.warnings) ctx.log(`Quality warning: ${w}`);
  const out = await MED.applyMedallion(kq(rt), model, ctx);
  const prevItems = rt.medallion?.items || {};
  updateProject({ realtime: { ...getProject().realtime, medallionRemoval: null, medallion: {
    ...summary, quality, items: prevItems, taskFlow: rt.medallion?.taskFlow || null, counts: out.counts, oneLake: out.oneLake,
    bronzePolicies: rt.medallion?.bronzePolicies ?? rt.medallionRemoval?.bronzePolicies ?? out.bronzePolicies, appliedAt: rt.medallion?.appliedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  } } });

  // One Fabric item per layer step, so the task flow can show each layer.
  ctx.step('Create the layer items: Bronze → Silver and Silver → Gold querysets');
  const qs = async (key, purpose, tabs, description) => {
    // Items made by an earlier run keep their names, so they are updated rather than duplicated.
    const name = F.itemName('KQLQueryset', prevItems[`${key}Queryset`]?.name || standardName('KQLQueryset', scopedPurpose(purpose)));
    const def = querysetDefinition({ key: `${rt.database.id}/${key}`, cluster: rt.eventhouse.queryUri, database: rt.database.name, tabs });
    const { item } = await upsertItem(ctx, ws, { type: 'KQLQueryset', name, description, definition: F.toParts({ 'RealTimeQueryset.json': def }) });
    return { id: item.id, name, tabs: tabs.map((t) => t.title) };
  };
  const silverQueryset = await qs('silver', 'BronzeToSilver', silverTabs(summary), `Medallion: how ${rt.table} events are checked, enriched, quarantined and deduplicated into Silver. Generated by Fabric MCP Studio.`);
  const goldQueryset = await qs('gold', 'SilverToGold', goldTabs(summary), `Medallion: the Gold materialized views over ${summary.names.clean}. Generated by Fabric MCP Studio.`);
  // Recorded as soon as they exist, so a later failure still lets "Remove" and "Clean up" find them.
  const saveItems = (extra) => updateProject({ realtime: { ...getProject().realtime, medallion: { ...getProject().realtime.medallion, items: { ...(getProject().realtime.medallion.items || {}), ...extra } } } });
  saveItems({ silverQueryset, goldQueryset });
  ctx.progress(58);

  ctx.step('Publish the Gold layer as a semantic model (DirectQuery, single sign-on)');
  const schemas = {};
  for (const g of model.gold) schemas[g.name] = (await kusto(rt.eventhouse.queryUri, rt.database.name, `${kqlName(g.name)} | getschema | project name = ColumnName, type = ColumnType`, { signal: ctx.signal }));
  const goldName = F.itemName('SemanticModel', prevItems.goldModel?.name || standardName('SemanticModel', scopedPurpose('LiveGold')));
  const gm = goldModelFiles({ name: goldName, cluster: rt.eventhouse.queryUri, database: rt.database.name, med: summary, schemas, scenario: rt.scenario });
  const { item: goldItem } = await upsertItem(ctx, ws, { type: 'SemanticModel', name: goldName, description: `Gold layer of the live ${rt.scenario.label}: DirectQuery over ${model.gold.map((g) => g.name).join(', ')}. Generated by Fabric MCP Studio.`, definition: F.toParts(gm.files) });
  ctx.log(`${gm.tables.length} tables (${gm.tables.map((t) => t.name).join(', ')}) · ${gm.measures.length} measures`);
  const goldModel = { id: goldItem.id, name: goldName, tables: gm.tables, measures: gm.measures, sso: false, check: null };
  saveItems({ goldModel });
  try {
    const sso = await useSingleSignOn(ws.id, goldItem.id, () => getToken(`${rt.eventhouse.queryUri.replace(/\/+$/, '')}/.default`));
    goldModel.sso = sso.done.length > 0 && !sso.failed.length;
    if (goldModel.sso) ctx.log('Report viewers query the Eventhouse with their own identity (single sign-on)');
    else ctx.log(`Single sign-on not set up${sso.failed[0] ? `: ${sso.failed[0].error}` : ''}. In Fabric, open the model's settings › Data source credentials and sign in with OAuth2.`);
  } catch (e) { ctx.log(`Single sign-on not set up: ${e.message}. In Fabric, open the model's settings › Data source credentials and sign in with OAuth2.`); }
  if (gm.eventsMeasure) {
    try {
      const [row] = await dax(ws.id, goldItem.id, `EVALUATE ROW ( "Events", [${gm.eventsMeasure.replace(/]/g, ']]')}] )`);
      goldModel.check = { ok: true, events: Number(row?.Events) || 0 };
      ctx.log(`Checked: the Gold model answers – ${goldModel.check.events.toLocaleString('en-US')} events`);
    } catch (e) {
      goldModel.check = { ok: false, error: e.message };
      ctx.log(`The Gold model doesn't answer yet: ${e.message.split('\n')[0].slice(0, 200)}`);
    }
  }
  ctx.progress(70);
  saveItems({ goldModel });

  // Consumers read the clean data from now on.
  const now = getProject().realtime;
  if (now.dashboard) {
    ctx.step('Point the Real-Time Dashboard at the Silver and Gold layers');
    await runRealtimeDashboard(nested(ctx, 70, 78), { name: now.dashboard.name, refreshSeconds: now.dashboard.refreshSeconds });
  }
  if (now.alerts) {
    ctx.step('Point the Activator alerts at the Silver layer');
    const a = now.alerts;
    await runRealtimeAlerts(nested(ctx, 78, 84), { channel: a.channel, recipients: a.recipients, rules: a.ruleIds || a.rules, minAmount: a.minAmount, name: a.name });
  }
  if (now.ontology && getProject().ontology?.id) {
    ctx.step('Point the live ontology at the Silver layer');
    await runLiveOntology(nested(ctx, 84, 90), {});
  }
  ctx.progress(90);

  // Silver as Delta in OneLake, in a lakehouse of its own (Spark, SQL endpoint, Direct Lake) – the Silver task's item.
  if (out.oneLake.enabled) {
    ctx.step('Silver in OneLake: a lakehouse with a shortcut to the Silver Delta table');
    const lhName = F.itemName('Lakehouse', prevItems.silverLakehouse?.name || standardName('Lakehouse', scopedPurpose('Silver')));
    const lh = await F.ensureLakehouse(ws.id, lhName, `Silver layer of the live ${rt.scenario.label}: a OneLake shortcut to ${rt.database.name}.${summary.names.silver} (Delta). Generated by Fabric MCP Studio.`);
    if (lh.created) recordArtifact({ type: 'Lakehouse', id: lh.id, name: lhName, workspaceId: ws.id });
    ctx.log(`${lh.created ? 'Created' : 'Using'} lakehouse ${lhName}`);
    let ready = false;
    for (let i = 0; i < 48 && !ready; i++) {
      if (ctx.signal?.aborted) throw new Error('Cancelled');
      ready = await F.oneLakePathExists(ws.id, rt.database.id, `Tables/${summary.names.silver}/_delta_log`).catch(() => false);
      if (!ready) { if (i % 6 === 0) ctx.log('Waiting for OneLake to publish the Silver Delta table (a few minutes the first time)…'); await sleep(5000); }
    }
    let shortcut = null;
    if (ready) {
      try {
        await F.createShortcut(ws.id, lh.id, { path: 'Tables', name: summary.names.silver, target: { oneLake: { workspaceId: ws.id, itemId: rt.database.id, path: `Tables/${summary.names.silver}` } } });
        shortcut = summary.names.silver;
        ctx.log(`Shortcut Tables/${shortcut} → ${rt.database.name}.${summary.names.silver} (before deduplication: use ${summary.extras.find((e) => e.role === 'hash')?.name} to drop repeats)`);
      } catch (e) { ctx.log(`Shortcut not created: ${e.message}`); }
    } else ctx.log('OneLake is still publishing the Silver table – select "Update layers" in a few minutes to add the shortcut');
    saveItems({ silverLakehouse: { id: lh.id, name: lhName, shortcut } });
  }
  ctx.progress(95);

  ctx.step('Show the layers as a task flow in the workspace');
  const taskFlow = await syncTaskFlow(ctx);
  setStep('medallion', 'done', `${summary.names.silver} · ${model.gold.length} Gold views`);
  logActivity('realtime.medallion', `Medallion layers on ${rt.table}: Silver ${summary.names.silver}, ${model.gold.length} Gold views${taskFlow ? `, task flow "${taskFlow.name}"` : ''}`, {});
  const final = getProject().realtime.medallion;
  return { names: summary.names, gold: model.gold.map((g) => g.name), counts: out.counts, oneLake: out.oneLake.enabled, items: final.items, taskFlow: final.taskFlow, taskFlowError: final.taskFlowError || null };
}

/** Remove the medallion layers, their items and the task flow; the dashboard, alerts and ontology go back to Bronze. */
export async function removeMedallion(ctx = QUIET, { deleteItems = true } = {}) {
  const p = requireRealtime();
  const rt = p.realtime;
  // A removal that stopped half way (e.g. a timeout while dropping) is kept so it can be finished.
  const pending = rt.medallionRemoval || null;
  const med = rt.medallion || pending;
  if (!med) return { ok: true };
  if (rt.medallion) {
    ctx.step('Remove the task flow and the layer items');
    if (med.taskFlow?.id) await TF.deleteTaskFlow(p.workspace.id, med.taskFlow.id).then((x) => ctx.log(x ? `Deleted task flow "${med.taskFlow.name}"` : 'The task flow was already gone')).catch((e) => ctx.log(`Task flow not deleted: ${e.message}`));
    if (deleteItems) {
      for (const it of [med.items?.goldModel, med.items?.goldQueryset, med.items?.silverLakehouse, med.items?.silverQueryset].filter((x) => x?.id)) {
        await F.deleteItem(p.workspace.id, it.id).then(() => ctx.log(`Deleted ${it.name}`)).catch((e) => ctx.log(/404|not\s*found/i.test(e.message) ? `${it.name} was already deleted` : `Could not delete ${it.name}: ${e.message}`));
      }
    }
    ctx.progress(20);
    // Consumers go back to the Bronze table before its Silver and Gold views disappear.
    updateProject({ realtime: { ...getProject().realtime, medallion: null, medallionRemoval: { names: med.names, gold: med.gold, bronzePolicies: med.bronzePolicies } } });
    const now = getProject().realtime;
    if (now.dashboard) { ctx.step('Point the dashboard back at the Bronze table'); await runRealtimeDashboard(nested(ctx, 20, 40), { name: now.dashboard.name, refreshSeconds: now.dashboard.refreshSeconds }); }
    if (now.alerts) { ctx.step('Point the alerts back at the Bronze table'); const a = now.alerts; await runRealtimeAlerts(nested(ctx, 40, 55), { channel: a.channel, recipients: a.recipients, rules: a.ruleIds || a.rules, minAmount: a.minAmount, name: a.name }); }
    if (now.ontology && getProject().ontology?.id) { ctx.step('Point the live ontology back at the Bronze table'); await runLiveOntology(nested(ctx, 55, 70), {}); }
  } else ctx.log('Finishing a removal that stopped half way');
  ctx.step('Drop the Silver and Gold layers');
  await MED.dropMedallion(kq(rt), med.names, { gold: med.gold, bronzePolicies: med.bronzePolicies }, ctx);
  updateProject({ realtime: { ...getProject().realtime, medallionRemoval: null } });
  setStep('medallion', 'todo', '');
  logActivity('realtime.medallion', `Medallion layers removed from ${rt.table}`, {});
  return { ok: true };
}

/** Rows per layer, data quality and view health. */
export async function medallionHealth({ minutes = 15 } = {}) {
  const p = requireRealtime();
  const med = p.realtime.medallion;
  if (!med) return { applied: false };
  return { applied: true, ...(await MED.layerHealth(kq(p.realtime), med, { minutes })) };
}

/** What applying the template would create for the current live events (nothing changes in Fabric). */
export function medallionPreview(opts = {}) {
  const p = requireRealtime();
  const m = MED.medallionModel(p.realtime.scenario, MED.medallionOptions(opts, p.realtime.medallion?.options));
  return { ...MED.modelSummary(m), functions: m.functions.map((f) => ({ name: f.name, doc: f.doc, body: f.body })) };
}
