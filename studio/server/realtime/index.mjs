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

export const dashboardUrl = (ws, id) => `https://app.fabric.microsoft.com/groups/${ws}/kustodashboards/${id}`;
export const activatorUrl = (ws, id) => `https://app.fabric.microsoft.com/groups/${ws}/reflexes/${id}`;

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

/** What the UI and Copilot need: setup, scenario summary, dashboard and simulator state (no secrets). */
export function realtimeState() {
  const p = getProject();
  const rt = p.realtime || null;
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
    } : null,
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

/** Create (or reuse) the Eventhouse, the events table and the Eventstream that feeds it. */
export async function runRealtimeSetup(ctx, { name } = {}) {
  const p = requireWorkspace();
  const ws = p.workspace;
  ctx.step('Read your data to shape the live events');
  const scenario = await scenarioFor(p, { fresh: true });
  ctx.log(`${scenario.label}: ${scenario.description}`);
  ctx.log(`Reference data: ${Object.entries(scenario.references).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  ctx.progress(15);

  const base = name || `${(p.semanticModel?.name || p.name || 'Studio').replace(/\s+(semantic model|model)$/i, '')} Live`;
  const ehName = F.itemName('Eventhouse', base, 'Live');
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

  const esName = F.itemName('Eventstream', `${ehName}_Stream`, 'Stream');
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
  return SIM.startSimulator(rtRef(p), scenario, { ...opts, backfillMinutes });
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
  const title = F.itemName('KQLDashboard', name || `${rt.scenario.label} – live`);
  ctx.step('Design the dashboard');
  const dash = buildDashboard({ title, source: { clusterUri: rt.eventhouse.queryUri, databaseId: rt.database.id, databaseName: rt.database.name, workspaceId: ws.id }, scenario: rt.scenario, refreshSeconds });
  ctx.log(`${dash.pages.length} pages · ${dash.tiles.length} tiles · auto refresh every ${refreshSeconds} seconds`);
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

  ctx.step(unlink ? 'Remove the live properties' : `Bind ${p.realtime.database.name}.${p.realtime.table} to the entity types`);
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
  const ruleCol = rt.scenario.columns.find((c) => c.role === 'rule')?.name || 'RuleBreak';
  const probe = alertQuery(rt.scenario, { minAmount: min }).replace(/^declare query_parameters\(.*\);/, 'let startTime = ago(60m); let endTime = now();');
  const counts = await kusto(rt.eventhouse.queryUri, rt.database.name, `${probe}\n| summarize Breaks = count() by ${kqlName(ruleCol)}`, { signal: ctx.signal });
  ctx.log(counts.length ? `Last hour: ${counts.map((c) => `${c.Breaks} × ${c[ruleCol]}`).join(', ')}` : 'No rule breaks in the last hour yet – alerts start with the next ones');
  ctx.progress(30);

  let itemName = F.itemName('Reflex', name || rt.alerts?.name || `${rt.eventhouse.name}_Alerts`, 'Alerts');
  ctx.step(`${rt.alerts ? 'Update' : 'Create'} the Activator "${itemName}"`);
  const entities = alertEntities({ workspaceId: ws.id, database: rt.database, scenario: rt.scenario, rules, channel, recipients: to, minAmount: min });
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
      const n = i === 1 ? itemName : F.itemName('Reflex', `${itemName}_${i}`, 'Alerts');
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
  const alerts = { id: item.id, name: itemName, url: activatorUrl(ws.id, item.id), channel, recipients: to, rules: rules.map((r) => r.label), minAmount: min, intervalSeconds: 60, createdAt: rt.alerts?.createdAt || now, updatedAt: now };
  updateProject({ realtime: { ...getProject().realtime, alerts } });
  logActivity('realtime.alerts', `Activator "${itemName}": ${rules.length} rule alert${rules.length === 1 ? '' : 's'} by ${channel === 'email' ? 'email' : 'Teams'}`, {});
  return { ...alerts, recipients: to.length };
}

/** Stop the alerts (deletes the Activator unless `keepItem`). */
export async function removeAlerts({ keepItem = false } = {}) {
  const p = requireRealtime();
  const a = p.realtime.alerts;
  if (a?.id && !keepItem) await F.deleteItem(p.workspace.id, a.id).catch((e) => { if (!/not\s*found|404/i.test(e.message)) throw e; });
  updateProject({ realtime: { ...getProject().realtime, alerts: null } });
  if (a) logActivity('realtime.alerts', `Activator "${a.name}" removed`, {});
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
    if (rt.ontology && p.ontology?.id) {
      const quiet = { step() {}, log() {}, progress() {} };
      await runLiveOntology(quiet, { unlink: true }).catch(() => {});
    }
    for (const id of [rt.alerts?.id, rt.dashboard?.id, rt.eventstream?.id, rt.eventhouse?.id].filter(Boolean)) await F.deleteItem(p.workspace.id, id).catch(() => {});
  }
  updateProject({ realtime: null });
  return { ok: true };
}
