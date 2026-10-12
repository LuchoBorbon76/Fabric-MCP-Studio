// End-to-end pipelines used by both the UI (quick actions) and the AI agent (studio_* tools).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, sleep, stableUuid, newId } from './config.mjs';
import * as F from './fabric.mjs';
import { getProject, updateProject, setStep, recordArtifact, logActivity, assertProjectTenant, projectModels, modelContext, sourceKeyOf, activateSource, contextViews, sourceContexts, blankSourcesPatch, dropEmptySource, isNoSource, otherSourcesUsing } from './project.mjs';
import { listJobs } from './jobs.mjs';
import { discoverSqlServer, testSqlServer, readOnlyQuery, withPool } from './sql.mjs';
import { discoverPostgres, testPostgres } from './pg.mjs';
import { sourceType } from './sources.mjs';
import { buildPlan, semanticModelFiles, ontologyFiles, defaultMeasures, quoteName } from './generators/tmdl.mjs';
import { applyLiveOntology, liveEventsOf, ontologySourceOf } from './generators/ontology-live.mjs';
import { isPlanTable, reapplyPlan } from './planning/index.mjs';
import { RETAIL, ADVENTUREWORKS, presetFor } from './presets.mjs';
import { AWDW, getKit, loadAdventureWorksDW, salesTotalsMatch } from './samples/adventureworks-dw.mjs';
import { resetProfileCache } from './reports/index.mjs';
import { stopSimulator, forgetEndpoint } from './realtime/simulator.mjs';
import { deleteTaskFlow } from './taskflow.mjs';
import * as WTF from './workspace-taskflow.mjs';
import { clearDataPrepFiles } from './dataprep.mjs';
import { standardName, standardize, itemNameFor, purposeOf, parseName, namingOf, setNaming, suggestNaming, pascal, scopedPurpose, freeAcrossSources } from './naming.mjs';

// ---------------- workspace ----------------

export async function selectWorkspace({ workspaceId, name, capacityId, description, domain, environment, intent }, log = () => {}) {
  await assertProjectTenant();
  if (domain || environment || intent) setNaming({ domain, environment, intent });
  let ws;
  let created = false;
  if (workspaceId) {
    ws = await F.getWorkspace(workspaceId);
  } else {
    if (!name) throw new Error('Workspace name is required.');
    // An existing workspace is used as it is; a new one follows the naming standard.
    const wsName = standardize('Workspace', name, 'Analytics');
    ws = await F.findWorkspace(name) || (wsName !== name ? await F.findWorkspace(wsName) : null);
    if (!ws) {
      if (!capacityId) throw new Error('Choose a Fabric capacity for the new workspace.');
      log(`Creating workspace "${wsName}"…`);
      ws = await F.createWorkspace({ name: wsName, capacityId, description: description || `${namingOf().intent} workspace created by Fabric MCP Studio.` });
      created = true;
    }
  }
  if (!ws.capacityId && capacityId) {
    log('Assigning the workspace to the selected capacity…');
    await F.assignCapacity(ws.id, capacityId);
    ws = await F.getWorkspace(ws.id);
  }
  if (!ws.capacityId) throw new Error('This workspace is not on a Fabric capacity. Pick a capacity so the studio can create Fabric items.');
  const prev = getProject().workspace;
  const workspace = { id: ws.id, name: ws.displayName, capacityId: ws.capacityId, created: created || (prev?.id === ws.id && prev.created) };
  // Another workspace starts everything over: data sources, models, reports, live data, plans, the task flow and the
  // naming (unless it was chosen with this workspace). The items stay in the old workspace in Fabric.
  let reset = {};
  if (prev && prev.id !== ws.id) {
    leaveSource('workspace changed');
    clearDataPrepFiles();
    reset = { ...blankSourcesPatch(), steps: {}, ...(domain || environment || intent || created ? {} : { naming: null }) };
    logActivity('workspace.reset', `Started over in ${ws.displayName}: everything the studio built in ${prev.name} stays there`, { from: prev.id, to: ws.id });
  } else if (!prev && getProject().naming?.inferred) reset = { naming: null };
  updateProject({ workspace, ...reset });
  // A workspace that already follows the standard tells the domain and environment until the user chooses.
  const parsed = parseName(ws.displayName);
  if (parsed?.code === 'WS') suggestNaming({ domain: parsed.domain, environment: parsed.environment });
  setStep('workspace', 'done', workspace.name);
  if (created) recordArtifact({ type: 'Workspace', id: ws.id, name: ws.displayName, workspaceId: ws.id });
  logActivity('workspace.select', `Using workspace ${ws.displayName}`, { workspaceId: ws.id, created });
  return workspace;
}

function requireWorkspace() {
  const ws = getProject().workspace;
  if (!ws) throw new Error('Select or create a workspace first (Workspace tab).');
  return ws;
}

// ---------------- data sources: each one keeps its own items ----------------

// Jobs that don't write to the project's data source (finding what is built on a model only adopts a source when the
// project has none, and checks that again right before it does).
const SOURCE_NEUTRAL_JOBS = new Set(['github-login', 'model-links']);

/** Another job still writing to the current data source would land in the wrong one after a switch. */
function assertNoOtherJobs(selfId) {
  const busy = listJobs().filter((j) => j.status === 'running' && j.id !== selfId && !SOURCE_NEUTRAL_JOBS.has(j.kind));
  if (busy.length) throw Object.assign(new Error(`"${busy[0].title}" is still running on the current data source. Wait for it to finish (or cancel it), then switch data sources.`), { status: 409 });
}

/** What leaving a data source (or the workspace) stops: the event simulator and what was read from the old data. */
function leaveSource(reason) {
  stopSimulator(reason);
  forgetEndpoint();
  discoveryCache = { key: null, at: 0, data: null };
  resetProfileCache();
}

/**
 * Before a data source is loaded: make it the active one. Items built from it before come back; a source used for the
 * first time starts with none (the map greys out what it doesn't have yet), and the previous source keeps its items.
 */
function beginSource(draft, ctx) {
  const p = getProject();
  const key = sourceKeyOf(draft);
  if (!key || key === p.sourceKey) return null;
  assertNoOtherJobs(ctx?.jobId);
  const before = p.source?.label || null;
  const r = activateSource(key, { label: draft.label });
  if (r.adopted) return r;
  leaveSource('data source switched');
  const say = r.restored
    ? `Switched to ${draft.label}: the items built from it before are back`
    : `${draft.label} is a new data source in this workspace and gets its own items${before ? `; ${before} keeps everything built from it (switch back from Data source on the map)` : ''}`;
  ctx?.log?.(say);
  logActivity('source.switch', say, { key, from: r.previous || null });
  return r;
}

/** The data sources used in the workspace and what was built from each. */
export function sourcesState() {
  const p = getProject();
  return { active: p.sourceKey || null, sources: sourceContexts(p) };
}

const DATA_ITEM_TYPES = ['Lakehouse', 'Warehouse', 'MirroredDatabase', 'SQLDatabase'];
// Items Fabric makes for itself (dataflow staging, and system databases such as the one behind a Fabric plan).
const SYSTEM_ITEM = /^(DataflowsStaging|StagingLakehouseForDataflows|StagingWarehouseForDataflows|__)/i;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every item in a workspace that can be a data source (lakehouses, warehouses, mirrored and SQL databases) – the project
 * workspace unless another one is chosen – each with the project's data sources that read it and what was built from
 * them. Sources whose data was in the workspace but isn't any more are listed too, and the project workspace also lists
 * the sources without data (not connected yet, items kept without a data source). byWorkspace: how many of the project's
 * sources read data in each workspace, so the other workspaces that hold some can be shown.
 */
export async function workspaceDataSources({ workspaceId } = {}) {
  await assertProjectTenant();
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  if (workspaceId && !GUID.test(workspaceId)) throw Object.assign(new Error('That isn\'t a workspace ID.'), { status: 400 });
  const home = p.workspace.id;
  const isHome = !workspaceId || workspaceId.toLowerCase() === home.toLowerCase();
  const ws = isHome ? home : workspaceId;
  const wsName = isHome ? p.workspace.name : (await F.getWorkspace(ws)).displayName;
  const wsOf = (c) => String(c.data?.workspaceId || home).toLowerCase();
  const items = (await F.listItems(ws)).filter((i) => DATA_ITEM_TYPES.includes(i.type) && !SYSTEM_ITEM.test(i.displayName || ''));
  // Items the studio made to serve a source (the plan values warehouse, the live Silver layer) aren't data sources.
  const helpers = new Set();
  for (const v of contextViews(p).map((x) => x.view)) {
    for (const w of [v.planning?.target?.warehouse, v.planStore?.warehouse]) if (w?.id) helpers.add(w.id);
    const silver = v.realtime?.medallion?.items?.silverLakehouse;
    if (silver?.id) helpers.add(silver.id);
  }
  const contexts = sourceContexts(p);
  const byItem = new Map();
  for (const c of contexts) {
    if (!c.data?.itemId || wsOf(c) !== ws.toLowerCase()) continue;
    if (!byItem.has(c.data.itemId)) byItem.set(c.data.itemId, []);
    byItem.get(c.data.itemId).push(c);
  }
  const rows = items.filter((i) => !helpers.has(i.id)).map((i) => ({ itemId: i.id, itemType: i.type, name: i.displayName, workspaceId: ws, sources: byItem.get(i.id) || [] }));
  const listed = new Set(rows.flatMap((r) => r.sources.map((c) => c.key)));
  // Items with something built first, then the rest by name.
  rows.sort((a, b) => Number(b.sources.some((c) => c.active)) - Number(a.sources.some((c) => c.active)) || b.sources.length - a.sources.length || a.name.localeCompare(b.name));
  // A source whose data was in this workspace but isn't any more (deleted in Fabric, or by a clean up) is marked.
  // Sources reading data in another workspace are shown with that workspace.
  const here = new Set(items.map((i) => i.id));
  const others = contexts.filter((c) => !listed.has(c.key) && (c.data?.itemId ? wsOf(c) === ws.toLowerCase() : isHome))
    .map((c) => (c.data?.itemId && !here.has(c.data.itemId) ? { ...c, missing: true } : c));
  const byWorkspace = new Map();
  for (const c of contexts) {
    if (!c.data?.itemId) continue;
    const e = byWorkspace.get(wsOf(c)) || { workspaceId: c.data.workspaceId || home, name: null, reachable: true, active: false, sources: [] };
    e.sources.push(c);
    e.active ||= c.active;
    byWorkspace.set(wsOf(c), e);
  }
  // The other workspaces by name; one that is gone (deleted, or access removed) keeps its sources reachable here.
  await Promise.all([...byWorkspace.values()].map(async (e) => {
    const id = e.workspaceId.toLowerCase();
    if (id === home.toLowerCase()) e.name = p.workspace.name;
    else if (id === ws.toLowerCase()) e.name = wsName;
    else {
      try { e.name = (await F.getWorkspace(e.workspaceId)).displayName; }
      catch (err) { if ([403, 404].includes(err.status)) e.reachable = false; }
    }
  }));
  const lost = isHome ? [...byWorkspace.values()].filter((e) => !e.reachable).flatMap((e) => e.sources.map((c) => ({ ...c, lost: true }))) : [];
  return {
    workspace: { id: ws, name: wsName, project: isHome }, projectWorkspace: { id: home, name: p.workspace.name },
    active: p.sourceKey || null, items: rows, others: [...others, ...lost],
    byWorkspace: [...byWorkspace.values()].filter((e) => e.reachable).map(({ reachable, ...e }) => e),
  };
}

/** Work on another data source of the workspace (nothing changes in Fabric). One switch at a time. */
let switching = Promise.resolve();
export function switchSource(key) {
  const run = switching.then(() => doSwitchSource(key));
  switching = run.catch(() => {});
  return run;
}

async function doSwitchSource(key) {
  await assertProjectTenant();
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  if (!key || key === p.sourceKey) return sourcesState();
  const entry = (p.sources || []).find((e) => e.key === key && e.state);
  if (!entry) throw Object.assign(new Error('That data source isn\'t one of this workspace\'s. Connect it on the Data page.'), { status: 404 });
  assertNoOtherJobs();
  const r = activateSource(key);
  leaveSource('data source switched');
  // A source restored from an older project knows its item but not its SQL endpoint yet: look it up once.
  const ms = getProject().modelSource;
  if (ms?.itemId && !ms.server && ms.itemType) {
    try {
      const ep = await endpointFor(ms.workspaceId || p.workspace.id, ms.itemId, ms.itemType);
      const fixed = { ...ms, itemName: ep.itemName || ms.itemName, server: ep.server, endpointId: ep.endpointId, database: ep.database };
      // Written to this source even if another one became active in the meantime (a job started from Copilot).
      const cur = getProject();
      if (cur.sourceKey === key) updateProject({ modelSource: fixed });
      else updateProject({ sources: (cur.sources || []).map((e) => (e.key === key && e.state ? { ...e, state: { ...e.state, modelSource: fixed } } : e)) });
    } catch (e) {
      logActivity('source.endpoint', `The SQL endpoint of ${ms.itemName} couldn't be read (${e.message.split('\n')[0].slice(0, 160)}) – its existing items work; reconnect it on the Data page to build new ones`, { key });
    }
  }
  const now = getProject();
  logActivity('source.switch', `Working on ${now.source?.label || entry.label || 'another data source'}${r.previous && !isNoSource(r.previous) ? ' (the previous data source keeps its items)' : ''}`, { key, from: r.previous || null });
  return sourcesState();
}

/**
 * The project lakehouse for a purpose (named by the naming standard). The current one is reused when it was made for
 * the same purpose (whatever domain and environment it was named with), and a lakehouse with one of the names older
 * versions of the studio used (legacy) is reused instead of creating a new one next to it.
 */
async function ensureProjectLakehouse(log, { purpose = 'Raw', legacy = [], reuseAny = false } = {}) {
  const ws = requireWorkspace();
  const p = getProject();
  const std = standardName('Lakehouse', purpose);
  const samePurpose = (n) => { const x = parseName(n); return x?.code === 'LH' && x.purpose.toLowerCase() === pascal(purpose).toLowerCase(); };
  if (p.lakehouse?.id && (reuseAny || samePurpose(p.lakehouse.name) || [std, ...legacy].some((n) => n.toLowerCase() === p.lakehouse.name.toLowerCase()))) return p.lakehouse;
  let lhName = F.itemName('Lakehouse', std, 'Lakehouse');
  if (!await F.findItem(ws.id, 'Lakehouse', lhName)) {
    for (const n of legacy) {
      const found = await F.findItem(ws.id, 'Lakehouse', n);
      if (found) { lhName = found.displayName; break; }
    }
  }
  log(`Preparing lakehouse ${lhName}…`);
  const lh = await F.ensureLakehouse(ws.id, lhName, 'Project lakehouse created by Fabric MCP Studio.');
  if (lh.created) recordArtifact({ type: 'Lakehouse', id: lh.id, name: lhName, workspaceId: ws.id });
  log('Waiting for the SQL analytics endpoint…');
  const ep = await F.waitSqlEndpoint(ws.id, lh.id, 'Lakehouse');
  const lakehouse = { id: lh.id, name: lhName, sqlEndpointId: ep.endpointId, sqlEndpointServer: ep.server };
  updateProject({ lakehouse });
  return lakehouse;
}

function setModelSource(ms, label) {
  discoveryCache = { key: null, at: 0, data: null };
  // A suggested design is tied to the old schema.
  updateProject({ modelSource: ms, modelProposal: null });
  setStep('data', 'done', label);
}

// ---------------- sample data ----------------

export async function runSampleRetail(ctx) {
  const ws = requireWorkspace();
  const draft = { kind: 'sample', id: 'retail', label: 'Contoso Retail (sample)', method: 'files' };
  beginSource(draft, ctx);
  suggestNaming(RETAIL.naming);
  ctx.step('Create the project lakehouse');
  // The retail source's own lakehouse is reused whatever it was named with (the purpose gets the source's name only
  // while the workspace has other sources).
  const lh = await ensureProjectLakehouse(ctx.log, { purpose: scopedPurpose(RETAIL.naming.lakehouse, getProject(), draft), legacy: [RETAIL.lakehouseName], reuseAny: true });
  ctx.progress(20);

  const folder = join(REPO_ROOT, 'data', 'retail', 'parquet');
  if (!existsSync(folder)) throw new Error(`Sample files not found in ${folder}. Run: python scripts/generate-sample-data.py`);
  const files = readdirSync(folder).filter((f) => f.endsWith('.parquet')).sort();
  ctx.step(`Upload ${files.length} files to OneLake`);
  for (const [i, f] of files.entries()) {
    await F.uploadOneLake(ws.id, lh.id, `Files/raw/retail/${f}`, readFileSync(join(folder, f)), { signal: ctx.signal });
    ctx.log(`Uploaded ${f}`);
    ctx.progress(20 + (i + 1) * (25 / files.length));
  }

  ctx.step('Load Delta tables');
  for (const [i, f] of files.entries()) {
    const table = basename(f, extname(f));
    await F.loadTable(ws.id, lh.id, table, `Files/raw/retail/${f}`, 'Parquet', { signal: ctx.signal });
    ctx.log(`Loaded table ${table}`);
    ctx.progress(45 + (i + 1) * (35 / files.length));
  }

  ctx.step('Refresh the SQL analytics endpoint');
  await F.refreshSqlEndpoint(ws.id, lh.sqlEndpointId);
  ctx.progress(90);

  const glossaryPath = join(REPO_ROOT, RETAIL.glossaryFile);
  updateProject({
    scenario: 'sample',
    source: { kind: 'sample', id: 'retail', label: 'Contoso Retail (sample)', method: 'files', tables: files.map((f) => basename(f, '.parquet')) },
    glossary: existsSync(glossaryPath) ? readFileSync(glossaryPath, 'utf8') : getProject().glossary,
  });
  setModelSource({ itemType: 'Lakehouse', itemId: lh.id, itemName: lh.name, workspaceId: ws.id, server: lh.sqlEndpointServer, endpointId: lh.sqlEndpointId, database: lh.name }, 'Contoso Retail sample loaded');
  return { lakehouse: lh, tables: files.length };
}

// ---------------- customer sources ----------------

export async function testSource({ typeId, server, database, port, auth }) {
  const st = sourceType(typeId);
  if (!st) throw new Error(`Unknown source type ${typeId}`);
  if (st.engine === 'postgres') return testPostgres({ server, database, port, auth });
  return testSqlServer({ server, database, port, auth, trustServerCertificate: typeId === 'sql-server' });
}

export async function discoverSource({ typeId, server, database, port, auth }) {
  const st = sourceType(typeId);
  if (st.engine === 'postgres') return discoverPostgres({ server, database, port, auth });
  return discoverSqlServer({ server, database, port, auth, trustServerCertificate: typeId === 'sql-server' });
}

export async function createConnection({ typeId, server, database, port, credential, name }) {
  const st = sourceType(typeId);
  const host = st.engine === 'postgres' && port && String(port) !== '5432' ? `${server}:${port}` : server;
  // Connections are shared across the tenant, so the purpose names the database and its server.
  const purpose = `${pascal(database)}${pascal(String(server).split('.')[0])}`;
  const conn = await F.createCloudConnection({
    name: itemNameFor('Connection', { name, purpose }).slice(0, 200),
    connectionType: st.connectionType,
    server: host,
    database,
    credential,
  });
  logActivity('connection.create', `Created Fabric connection ${conn.displayName}`, { connectionId: conn.id });
  return { id: conn.id, name: conn.displayName };
}

/** Mirror a database into Fabric. Credentials never reach this function: it takes a Fabric connection ID. */
export async function runMirror(ctx, { typeId, connectionId, connectionName, server, port, database, tables = [], name, sqlVersionMajor, sourceLabel }) {
  const ws = requireWorkspace();
  const st = sourceType(typeId);
  if (!st?.mirrorType) throw new Error(`${typeId} can't be mirrored.`);
  if (!connectionId) throw new Error('A Fabric connection is required. Create one in the Data page or pick an existing connection.');
  beginSource({ kind: 'database', type: typeId, method: 'mirror', connectionId, server: server || null, port: port || null, database, label: sourceLabel || `${st.name} · ${database}` }, ctx);
  const mirrorType = (st.mirrorTypeByVersion && st.mirrorTypeByVersion[sqlVersionMajor]) || st.mirrorType;
  const itemName = F.itemName('MirroredDatabase', itemNameFor('MirroredDatabase', { name, current: getProject().source?.method === 'mirror' && getProject().source?.database === database ? getProject().modelSource?.itemName : undefined, purpose: pascal(database) }), 'Mirror');

  ctx.step(`Create mirrored database ${itemName}`);
  let item = await F.findItem(ws.id, 'MirroredDatabase', itemName);
  if (!item) {
    item = await F.createMirroredDatabase(ws.id, { name: itemName, sourceType: mirrorType, connectionId, database: st.engine === 'postgres' ? database : undefined, tables });
    recordArtifact({ type: 'MirroredDatabase', id: item.id, name: itemName, workspaceId: ws.id });
    ctx.log(`Created ${itemName} (${mirrorType})`);
  } else ctx.log(`Reusing existing ${itemName}`);
  ctx.progress(20);

  ctx.step('Start mirroring');
  try { await F.startMirroring(ws.id, item.id); } catch (e) { if (!/already|running/i.test(e.message)) throw e; }
  ctx.progress(30);

  ctx.step('Replicate tables (initial snapshot)');
  const deadline = Date.now() + 20 * 60 * 1000;
  let last = [];
  while (Date.now() < deadline) {
    if (ctx.signal.aborted) throw new Error('Cancelled');
    await sleep(15000);
    let status = {};
    try { status = await F.mirroringStatus(ws.id, item.id); } catch { status = {}; }
    try { last = await F.tablesMirroringStatus(ws.id, item.id); } catch { last = []; }
    ctx.data({ kind: 'mirroring', status: status.status, tables: last });
    const done = last.filter((t) => t.status === 'Replicating' && (t.metrics?.processedRows ?? 0) >= 0 && t.metrics?.lastSyncDateTime);
    const failed = last.filter((t) => /fail|error/i.test(t.status || ''));
    ctx.log(`Mirroring ${status.status || '…'} · ${done.length}/${last.length || '?'} tables synced${failed.length ? ` · ${failed.length} failed` : ''}`);
    ctx.progress(30 + (last.length ? (done.length / last.length) * 50 : 5));
    if (failed.length && failed.length === last.length) throw new Error(`Mirroring failed: ${failed[0].errorMessage || failed[0].status}. Check the prerequisites for ${st.name}.`);
    if (last.length && done.length + failed.length === last.length) break;
  }

  ctx.step('Wait for the SQL analytics endpoint');
  const ep = await F.waitSqlEndpoint(ws.id, item.id, 'MirroredDatabase', { signal: ctx.signal });
  await F.refreshSqlEndpoint(ws.id, ep.endpointId);
  ctx.progress(95);

  updateProject({ scenario: 'byod', source: { kind: 'database', type: typeId, label: sourceLabel || `${st.name} · ${database}`, method: 'mirror', connectionId, connectionName: connectionName || null, server: server || null, port: port || null, database, itemId: item.id, tables: last.map((t) => `${t.sourceSchemaName}.${t.sourceTableName}`) } });
  setModelSource({ itemType: 'MirroredDatabase', itemId: item.id, itemName, workspaceId: ws.id, server: ep.server, endpointId: ep.endpointId, database: itemName }, `${st.name} mirrored`);
  return { mirroredDatabaseId: item.id, tables: last.length };
}

export async function listSourceItems(workspaceId, itemType) {
  const items = await F.listItems(workspaceId, itemType);
  return items.map((i) => ({ id: i.id, name: i.displayName, type: i.type, workspaceId }));
}

async function endpointFor(workspaceId, itemId, itemType) {
  const ep = await F.waitSqlEndpoint(workspaceId, itemId, itemType, { timeoutMs: 60000 });
  const item = await F.getItem(workspaceId, itemId);
  return { ...ep, itemName: item.displayName };
}

export async function listTablesOfItem({ workspaceId, itemId, itemType }) {
  const ep = await endpointFor(workspaceId, itemId, itemType);
  const d = await discoverSqlServer({ server: ep.server, database: ep.database }, { fabricEndpoint: true });
  return { endpoint: ep, tables: d.tables.map((t) => ({ schema: t.schema, name: t.name, rows: t.rows, columns: t.columns.length })) };
}

const ITEM_LABEL = { Lakehouse: 'Lakehouse', Warehouse: 'Warehouse', MirroredDatabase: 'Mirrored database', SQLDatabase: 'SQL database' };

export async function useInPlace({ workspaceId, itemId, itemType, typeId }, ctx, { onlyIf } = {}) {
  await assertProjectTenant();
  requireWorkspace();
  const ep = await endpointFor(workspaceId, itemId, itemType);
  const source = { kind: 'fabric', type: typeId || itemType, itemType, itemName: ep.itemName, label: `${ITEM_LABEL[itemType] || itemType} · ${ep.itemName}`, method: 'in-place', itemId, workspaceId };
  // Checked again after the wait for the SQL endpoint: the project may have changed in the meantime.
  if (onlyIf && !onlyIf()) return null;
  beginSource(source, ctx);
  updateProject({ scenario: 'byod', source });
  setModelSource({ itemType, itemId, itemName: ep.itemName, workspaceId, server: ep.server, endpointId: ep.endpointId, database: ep.database }, `Using ${ep.itemName} in place`);
  return getProject().modelSource;
}

/**
 * A project without data takes the item an existing semantic model reads, in place (nothing is copied), so the map shows
 * where the model's numbers come from. Returns null when the project already has data, or the item already has its own
 * items in the workspace (switching would put the model away).
 */
export async function adoptModelSource({ workspaceId, itemId, itemType, modelId }, ctx) {
  const key = sourceKeyOf({ kind: 'fabric', method: 'in-place', itemId, workspaceId });
  const wsId = getProject().workspace?.id;
  const free = () => {
    const p = getProject();
    return Boolean(p.workspace) && p.workspace.id === wsId && !p.sourceKey && !p.modelSource && (!modelId || p.semanticModel?.id === modelId)
      && DATA_ITEM_TYPES.includes(itemType) && !(p.sources || []).some((e) => e.key === key && e.state);
  };
  if (!free()) return null;
  return useInPlace({ workspaceId, itemId, itemType }, ctx, { onlyIf: free });
}

export async function runShortcuts(ctx, { sourceWorkspaceId, sourceItemId, sourceItemType, tables = [], typeId }) {
  requireWorkspace();
  const src = await F.getItem(sourceWorkspaceId, sourceItemId);
  const source = { kind: 'fabric', type: typeId || sourceItemType, itemType: sourceItemType, itemName: src.displayName, label: `${ITEM_LABEL[sourceItemType] || sourceItemType} · ${src.displayName} (shortcuts)`, method: 'shortcut', itemId: sourceItemId, workspaceId: sourceWorkspaceId, tables: tables.map((t) => t.name) };
  beginSource(source, ctx);
  const ws = getProject().workspace;
  ctx.step('Prepare the project lakehouse');
  const lh = await ensureProjectLakehouse(ctx.log, { purpose: scopedPurpose('Raw', getProject(), source), reuseAny: true });
  ctx.progress(25);
  ctx.step(`Create ${tables.length} OneLake shortcuts`);
  for (const [i, t] of tables.entries()) {
    const schema = t.schema || 'dbo';
    const targetPath = sourceItemType === 'Lakehouse' && schema === 'dbo' && !t.schemaEnabled ? `Tables/${t.name}` : `Tables/${schema}/${t.name}`;
    await F.createShortcut(ws.id, lh.id, { path: 'Tables', name: t.name, target: { oneLake: { workspaceId: sourceWorkspaceId, itemId: sourceItemId, path: targetPath } } });
    ctx.log(`Shortcut ${t.name} → ${targetPath}`);
    ctx.progress(25 + ((i + 1) / tables.length) * 55);
  }
  ctx.step('Refresh the SQL analytics endpoint');
  await sleep(5000);
  await F.refreshSqlEndpoint(ws.id, lh.sqlEndpointId);
  updateProject({ scenario: 'byod', source });
  setModelSource({ itemType: 'Lakehouse', itemId: lh.id, itemName: lh.name, workspaceId: ws.id, server: lh.sqlEndpointServer, endpointId: lh.sqlEndpointId, database: lh.name }, `${tables.length} tables shortcut into ${lh.name}`);
  return { lakehouseId: lh.id, shortcuts: tables.length };
}

// ---------------- model source discovery ----------------

let discoveryCache = { key: null, at: 0, data: null };

export async function describeModelSource({ refresh = false } = {}) {
  await assertProjectTenant();
  const ms = getProject().modelSource;
  if (!ms) throw new Error('No data source yet. Load sample data or connect your data first (Data page).');
  const key = `${ms.server}|${ms.endpointId}|${ms.database}`;
  if (!refresh && discoveryCache.key === key && Date.now() - discoveryCache.at < 5 * 60 * 1000) return discoveryCache.data;
  const d = await discoverSqlServer({ server: ms.server, database: ms.database }, { fabricEndpoint: true });
  const preset = presetFor(getProject());
  if (preset?.relationships) d.relationships = preset.relationships;
  else applyDataPrepHints(d, dataPrepHints(getProject()));
  d.source = ms;
  discoveryCache = { key, at: Date.now(), data: d };
  return d;
}

/**
 * What the data prep notebook found, when the data source is the curated lakehouse one of its runs wrote (in any data
 * source of the workspace): table roles and keys, relationships found from the values, KPIs with DAX, and its own
 * output tables (KPIs, DataQuality). null otherwise.
 */
export function dataPrepHints(p = getProject()) {
  const id = p.modelSource?.itemId;
  if (!id) return null;
  for (const { view } of contextViews(p)) {
    const dp = view.dataPrep;
    const s = dp?.lastRun?.status === 'Completed' ? dp.lastRun.summary : null;
    if (s && dp.target?.id === id) return { notebook: dp.notebook?.name || 'data prep notebook', at: dp.lastRun.endedAt || null, tables: s.tables || [], relationships: s.relationships || [], kpis: s.kpis || [], outputs: s.outputs || [] };
  }
  return null;
}

/** Use the notebook's findings in a discovered schema (keys, relationships, KPIs; its log tables are marked). */
export function applyDataPrepHints(d, h) {
  if (!h) return d;
  const find = (name) => d.tables.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
  const outputs = new Set((h.outputs?.length ? h.outputs : ['KPIs', 'DataQuality']).map((x) => String(x).toLowerCase()));
  for (const t of d.tables) if (outputs.has(t.name.toLowerCase()) || /^(curated_)?(kpis|dataquality)$/i.test(t.name)) t.notebookOutput = true;
  for (const x of h.tables) {
    const t = find(x.table);
    const c = x.key && t?.columns.find((col) => col.name.toLowerCase() === String(x.key).toLowerCase());
    if (c) c.isKey = true;
    if (t && x.role) t.role = x.role;
  }
  const rels = [];
  for (const r of h.relationships) {
    const from = find(r.from);
    const to = find(r.to);
    if (!from || !to) continue;
    rels.push({ from: { schema: from.schema, table: from.name, column: r.column }, to: { schema: to.schema, table: to.name, column: r.key }, source: 'data prep notebook' });
  }
  if (rels.length) d.relationships = rels;
  d.kpis = h.kpis;
  d.dataPrep = { notebook: h.notebook, at: h.at };
  return d;
}

/** Live replication status when the current data source is a mirrored database (mirrored by the studio or used in place). */
export async function currentMirroringStatus() {
  await assertProjectTenant();
  const ms = getProject().modelSource;
  if (ms?.itemType !== 'MirroredDatabase') return { kind: 'mirroring', status: null, tables: [] };
  const [status, tables] = await Promise.all([
    F.mirroringStatus(ms.workspaceId, ms.itemId).catch(() => ({})),
    F.tablesMirroringStatus(ms.workspaceId, ms.itemId).catch(() => []),
  ]);
  return { kind: 'mirroring', status: status?.status || null, tables: tables || [] };
}

export async function queryModelSource(query) {
  await assertProjectTenant();
  const ms = getProject().modelSource;
  if (!ms) throw new Error('No data source yet.');
  try {
    return await readOnlyQuery({ server: ms.server, database: ms.database }, query);
  } catch (e) {
    if (/aggregate function.*aggregate or a subquery/i.test(e.message || '')) {
      throw new Error(`${e.message} For relationship checks, do not put EXISTS/NOT EXISTS subqueries inside SUM/COUNT expressions. Use studio_profile_relationships, or rewrite the SQL with LEFT JOIN/CTEs and aggregate over joined columns.`);
    }
    throw e;
  }
}

const qSql = (s) => `[${String(s).replace(/]/g, ']]')}]`;
const tableKey = (t) => `${t.schema}.${t.name}`.toLowerCase();
const tableRef = (t) => `${qSql(t.schema)}.${qSql(t.name)}`;

function resolveSourceTable(schema, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  return schema.tables.find((t) => `${t.schema}.${t.name}`.toLowerCase() === want || t.name.toLowerCase() === want) || null;
}

function relationshipCandidates(schema, include) {
  const includeKeys = new Set(include.map(tableKey));
  return (schema.relationships || []).filter((r) => {
    const from = resolveSourceTable(schema, `${r.from.schema}.${r.from.table}`);
    const to = resolveSourceTable(schema, `${r.to.schema}.${r.to.table}`);
    if (!from || !to) return false;
    return !includeKeys.size || (includeKeys.has(tableKey(from)) && includeKeys.has(tableKey(to)));
  }).slice(0, 30);
}

/** SQL Server-safe relationship profiling for star-schema design. */
export async function profileRelationships({ tables = [], relationships = [] } = {}) {
  await assertProjectTenant();
  const ms = getProject().modelSource;
  if (!ms) throw new Error('No data source yet.');
  const schema = await describeModelSource();
  const include = (tables || []).map((x) => resolveSourceTable(schema, x)).filter(Boolean);
  const missingTables = (tables || []).filter((x) => !resolveSourceTable(schema, x));
  if ((tables || []).length && !include.length) {
    return { ok: true, relationships: [], missingTables, note: 'None of the requested tables were found. Call studio_describe_data and use exact schema.table names.' };
  }
  const rels = relationships?.length
    ? relationships.map((r) => {
      const fromParts = String(r.from || '').split('.');
      const toParts = String(r.to || '').split('.');
      const fromColumn = r.fromColumn || fromParts.pop();
      const toColumn = r.toColumn || toParts.pop();
      const fromTable = r.fromTable || fromParts.join('.');
      const toTable = r.toTable || toParts.join('.');
      const from = resolveSourceTable(schema, fromTable);
      const to = resolveSourceTable(schema, toTable);
      return from && to && fromColumn && toColumn ? { from: { ...from, column: fromColumn }, to: { ...to, column: toColumn }, source: 'requested' } : null;
    }).filter(Boolean)
    : relationshipCandidates(schema, include);
  if (!rels.length) return { ok: true, relationships: [], missingTables, note: 'No declared or inferred relationships were found for the selected tables. Use studio_describe_data to inspect candidate key columns.' };

  return withPool({ server: ms.server, database: ms.database }, async (pool) => {
    const out = [];
    for (const r of rels.slice(0, 20)) {
      const from = resolveSourceTable(schema, `${r.from.schema}.${r.from.table}`);
      const to = resolveSourceTable(schema, `${r.to.schema}.${r.to.table}`);
      if (!from || !to) continue;
      const fc = qSql(r.from.column);
      const tc = qSql(r.to.column);
      const sql = `
SELECT
  (SELECT COUNT_BIG(*) FROM ${tableRef(from)}) AS [FromRows],
  (SELECT COUNT_BIG(*) FROM ${tableRef(from)} WHERE ${fc} IS NULL) AS [FromNullKeys],
  (SELECT COUNT_BIG(DISTINCT ${fc}) FROM ${tableRef(from)} WHERE ${fc} IS NOT NULL) AS [DistinctFromKeys],
  (SELECT COUNT_BIG(*) FROM ${tableRef(to)}) AS [ToRows],
  (SELECT COUNT_BIG(*) FROM ${tableRef(to)} WHERE ${tc} IS NULL) AS [ToNullKeys],
  (SELECT COUNT_BIG(DISTINCT ${tc}) FROM ${tableRef(to)} WHERE ${tc} IS NOT NULL) AS [DistinctToKeys],
  (SELECT COUNT_BIG(*) FROM ${tableRef(from)} f JOIN (SELECT DISTINCT ${tc} AS [k] FROM ${tableRef(to)} WHERE ${tc} IS NOT NULL) d ON f.${fc} = d.[k] WHERE f.${fc} IS NOT NULL) AS [MatchedFromRows],
  (SELECT COUNT_BIG(*) FROM ${tableRef(from)} f LEFT JOIN (SELECT DISTINCT ${tc} AS [k] FROM ${tableRef(to)} WHERE ${tc} IS NOT NULL) d ON f.${fc} = d.[k] WHERE f.${fc} IS NOT NULL AND d.[k] IS NULL) AS [UnmatchedFromRows]`;
      try {
        const row = (await pool.request().query(sql)).recordset?.[0] || {};
        const fromRows = Number(row.FromRows) || 0;
        const unmatched = Number(row.UnmatchedFromRows) || 0;
        out.push({
          from: `${from.schema}.${from.name}.${r.from.column}`,
          to: `${to.schema}.${to.name}.${r.to.column}`,
          source: r.source || 'inferred',
          fromRows,
          fromNullKeys: Number(row.FromNullKeys) || 0,
          distinctFromKeys: Number(row.DistinctFromKeys) || 0,
          toRows: Number(row.ToRows) || 0,
          toNullKeys: Number(row.ToNullKeys) || 0,
          distinctToKeys: Number(row.DistinctToKeys) || 0,
          matchedFromRows: Number(row.MatchedFromRows) || 0,
          unmatchedFromRows: unmatched,
          matchRate: fromRows ? Number(((fromRows - unmatched) / fromRows).toFixed(4)) : null,
        });
      } catch (e) {
        out.push({ from: `${from.schema}.${from.name}.${r.from.column}`, to: `${to.schema}.${to.name}.${r.to.column}`, source: r.source || 'inferred', error: e.message });
      }
    }
    return { ok: true, relationships: out, missingTables, note: 'Counts are computed with JOIN/CTE-safe SQL; no aggregate expression contains a subquery.' };
  });
}

// ---------------- semantic model ----------------

export async function runSemanticModel(ctx, { name, include, names, relationships, measures, descriptions, useDefaults = true, proposalId } = {}) {
  const ws = requireWorkspace();
  const p = getProject();
  const preset = presetFor(p);
  ctx.step('Read the source schema');
  const schema = await describeModelSource({ refresh: true });
  // The plan values are added as the model's Plan table, not as a regular table; the data prep notebook's own output
  // tables (KPIs, DataQuality) are its log, not data – unless asked for by name.
  schema.tables = schema.tables.filter((t) => (!isPlanTable(t) && !t.notebookOutput) || include?.includes(`${t.schema}.${t.name}`) || include?.includes(t.name));
  if (relationships?.length) schema.relationships = relationships;
  // Curated tables already have business names: keep them, so the notebook's KPI DAX matches the model.
  const keepNames = schema.dataPrep ? Object.fromEntries(schema.tables.map((t) => [`${t.schema}.${t.name}`, t.name])) : {};
  const plan = buildPlan(schema, { include: include?.length ? include : preset?.include, names: { ...keepNames, ...(preset?.names || {}), ...(names || {}) }, descriptions: descriptions || preset?.descriptions });
  if (!plan.tables.length) throw new Error('No tables found in the data source.');
  ctx.log(`${plan.tables.length} tables, ${plan.relationships.length} relationships${schema.dataPrep ? ` (keys and relationships from ${schema.dataPrep.notebook})` : ''}`);
  ctx.progress(25);

  const kpis = !preset?.measures?.length && !measures?.length && schema.kpis?.length ? kpiMeasures(plan, schema.kpis) : [];
  const m = kpis.length ? sanitizeMeasures(plan, kpis) : modelMeasures(plan, preset, measures, useDefaults);
  if (kpis.length) ctx.log(`${kpis.length} measures from the notebook's KPIs`);
  if (m.warnings?.length) for (const w of m.warnings) ctx.log(w);
  const dateTable = preset?.dateTable && plan.tables.some((t) => t.name === preset.dateTable.table) ? preset.dateTable : preset ? null : findDateTable(plan);
  const quality = semanticModelQuality(plan, m, { dateTable, measureWarnings: m.warnings });
  ctx.step(`Semantic model quality gate: ${quality.summary}`);
  if (quality.errors.length) throw new Error(`Semantic model is not ready: ${quality.errors.join(' ')}`);
  ctx.log(`Quality gate: ${quality.summary}`);
  for (const w of quality.warnings.slice(0, 6)) ctx.log(`Quality warning: ${w}`);
  ctx.progress(32);
  const modelName = modelNameFor(p, preset, name);
  // A model the user added to the project (not built by the studio) is never overwritten by a generated one.
  const theirs = (p.semanticModels || []).find((x) => x.origin === 'existing' && (x.workspaceId || ws.id) === ws.id && x.name.toLowerCase() === modelName.toLowerCase());
  if (theirs) throw new Error(`"${theirs.name}" is an existing semantic model you added to the project, so the studio won't replace it. Choose another name for the new model.`);
  const planModel = p.planning?.spec ? (p.semanticModels || []).find((x) => x.id === p.planning.semanticModelId) || p.semanticModel : null;

  ctx.step('Generate the Direct Lake model (TMDL)');
  let files = semanticModelFiles({ name: modelName, src: { server: p.modelSource.server, endpointId: p.modelSource.endpointId, itemName: p.modelSource.itemName }, plan, measures: m, dateTable });
  if (planModel?.name === modelName) {
    files = reapplyPlan(files, p);
    ctx.log(`Plan ${p.planning.planYear} kept (Plan table with budget and forecast measures)`);
  }
  ctx.log(`${Object.keys(files).length} definition parts · ${m.length} measures · quality ${quality.score}/100`);
  ctx.progress(45);

  ctx.step(`Deploy semantic model "${modelName}"`);
  const definition = F.toParts(files);
  let item = await F.findItem(ws.id, 'SemanticModel', modelName);
  if (item) {
    await F.updateDefinition(ws.id, item.id, definition);
    ctx.log('Updated existing model definition');
  } else {
    item = await F.createItem(ws.id, { name: modelName, type: 'SemanticModel', description: 'Direct Lake model generated by Fabric MCP Studio.', definition });
    recordArtifact({ type: 'SemanticModel', id: item.id, name: modelName, workspaceId: ws.id });
  }
  ctx.progress(90);
  resetProfileCache();
  const proposal = getProject().modelProposal;
  const isNew = !(p.semanticModels || []).some((x) => x.id === item.id);
  updateProject({
    // sourceItemId: the item the model reads (so the item can't be removed while the model uses it). The model becomes
    // the active one; a model built before stays in the project with its own reports and data agent.
    semanticModel: { id: item.id, name: modelName, workspaceId: ws.id, workspaceName: ws.name, origin: 'studio', storageMode: 'DirectLake', tables: plan.tables.length, measures: m.length, relationships: plan.relationships.length, quality, sourceItemId: p.modelSource.itemId },
    ...(proposalId && proposal?.id === proposalId ? { modelProposal: { ...proposal, appliedAt: new Date().toISOString(), semanticModelId: item.id } } : {}),
  });
  const others = (getProject().semanticModels || []).filter((x) => x.id !== item.id);
  if (isNew && others.length) ctx.log(`${modelName} is now the active model; ${others.length === 1 ? `${others[0].name} stays` : `the other ${others.length} models stay`} in the project (switch on the Semantic model page)`);
  setStep('model', 'done', modelName);
  return { id: item.id, name: modelName, tables: plan.tables.map((t) => t.name), measures: m.map((x) => x.name), relationships: plan.relationships.length, quality };
}

/**
 * Measures from the data prep notebook's KPIs (their DAX uses the curated table names; renamed tables are followed).
 * KPIs on tables that aren't in the model are left out.
 */
export function kpiMeasures(plan, kpis) {
  const display = new Map(plan.tables.map((t) => [t.source.toLowerCase(), t.name]));
  const rename = (expr) => String(expr).replace(/'((?:[^']|'')+)'\s*\[/g, (all, n) => { const to = display.get(n.replace(/''/g, "'").toLowerCase()); return to ? `${quoteName(to)}[` : all; });
  const seen = new Set();
  const out = [];
  for (const k of kpis) {
    const table = display.get(String(k.table).toLowerCase());
    if (!table || !k.dax || !k.measure || seen.has(k.measure.toLowerCase())) continue;
    seen.add(k.measure.toLowerCase());
    out.push({ table, name: k.measure, expression: rename(k.dax), formatString: k.format || '#,0', displayFolder: 'KPIs', description: k.description || `KPI from the data prep notebook (${k.measure}).` });
  }
  // Every KPI must resolve: a measure that refers to another one left out would break the model.
  const names = new Set(out.map((x) => x.name.toLowerCase()));
  return sanitizeMeasures(plan, out.filter((x) => [...x.expression.matchAll(/(?<!['\w\]])\[([^\]]+)\]/g)].every((r) => names.has(r[1].toLowerCase()) || plan.tables.some((t) => t.columns.some((c) => c.name.toLowerCase() === r[1].toLowerCase())))));
}

/** The model's date table: a dimension keyed on a date column that other tables relate to (Date, Dates, Calendar…). */
export function findDateTable(plan) {
  const related = new Set(plan.relationships.map((r) => r.to));
  const candidates = plan.tables.filter((t) => related.has(t) && t.columns.some((c) => c.isKey && c.dataType === 'dateTime'));
  const t = candidates.find((x) => /^(dim\s?)?(dates?|calendar|time)$/i.test(x.name)) || candidates[0];
  if (!t) return null;
  return { table: t.name, column: t.columns.find((c) => c.isKey && c.dataType === 'dateTime').name };
}

/**
 * The semantic model's name: without a name the active model keeps its name (when the studio built it); a new one
 * follows the naming standard. Names of the other models the studio built are accepted as they are (updating them).
 */
export function modelNameFor(p, preset, name) {
  const ours = (p.semanticModels || []).filter((x) => x.origin !== 'existing').map((x) => x.name);
  const current = p.semanticModel?.origin !== 'existing' ? p.semanticModel?.name : undefined;
  const picked = F.itemName('SemanticModel', itemNameFor('SemanticModel', { name, current, known: ours, purpose: preset?.naming?.model || purposeOf(p.modelSource?.itemName, p.modelSource?.itemType) || 'Main' }));
  // A model another data source of the workspace built is never updated from this one.
  return ours.some((n) => n.toLowerCase() === picked.toLowerCase()) ? picked : freeAcrossSources('SemanticModel', picked, p);
}

/**
 * Measures for a model: sample presets keep their glossary measures and add or replace Copilot's by name;
 * other sources use Copilot's measures, or starter measures when there are none. Measures on excluded tables are dropped.
 */
const measureRef = (name) => `[${String(name).replace(/]/g, ']]')}]`;
function safeMeasureName(base, used, columnNames) {
  const raw = String(base || 'Measure').trim() || 'Measure';
  const candidates = columnNames.has(raw.toLowerCase())
    ? [/^(count|number of|total|sum|average|avg|distinct)/i.test(raw) ? `${raw} Measure` : `Total ${raw}`, `${raw} Measure`, `${raw} Value`]
    : [raw];
  for (const c of candidates) if (!used.has(c.toLowerCase()) && !columnNames.has(c.toLowerCase())) return c;
  let i = 2;
  while (used.has(`${raw} ${i}`.toLowerCase()) || columnNames.has(`${raw} ${i}`.toLowerCase())) i++;
  return `${raw} ${i}`;
}

function rewriteMeasureRefs(expression, renames) {
  return String(expression || '').replace(/(?<!['\w\]])\[([^\]]+)\]/g, (all, n) => {
    const key = n.replace(/]]/g, ']').toLowerCase();
    return renames.has(key) ? measureRef(renames.get(key)) : all;
  });
}

function sanitizeMeasures(plan, measures) {
  const byTable = new Map(plan.tables.map((t) => [t.name, t]));
  const columns = new Map(plan.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name.toLowerCase()))]));
  const used = new Set();
  const renames = new Map();
  const warnings = [];
  const out = [];
  for (const x of measures.filter((m) => byTable.has(m.table))) {
    const colNames = columns.get(x.table) || new Set();
    const columnCollision = colNames.has(String(x.name).toLowerCase());
    const name = safeMeasureName(x.name, used, colNames);
    used.add(name.toLowerCase());
    if (name !== x.name) {
      // Only rewrite [Measure] references for the common Fabric-blocking case: a measure name collides with a column.
      // Duplicate suggested measures are renamed too, but their references would be ambiguous, so leave them alone.
      if (columnCollision) renames.set(String(x.name).toLowerCase(), name);
      warnings.push(`Measure "${x.name}" in ${x.table} renamed to "${name}" because a column or another measure already uses that name.`);
    }
    out.push({ ...x, name });
  }
  if (renames.size) for (const m of out) m.expression = rewriteMeasureRefs(m.expression, renames);
  out.warnings = warnings;
  return out;
}

const WEAK_DIM = /(key|id|guid|code|phone|email|address|url|image|description|flag|status|number|row)/i;
function semanticModelQuality(plan, measures, { dateTable = null, measureWarnings = [] } = {}) {
  const errors = [];
  const warnings = [...(measureWarnings || [])];
  let score = 100;
  const byTable = new Map(plan.tables.map((t) => [t.name, t]));
  const measureNames = new Set();
  const columnsByTable = new Map(plan.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name.toLowerCase()))]));
  if (!plan.tables.length) errors.push('No tables are included.');
  if (!measures.length) errors.push('No measures are included. Add at least one business measure before deploying.');
  if (plan.tables.length > 1 && !plan.relationships.length) errors.push('Multiple tables are included but there are no relationships.');

  for (const m of measures) {
    const tbl = byTable.get(m.table);
    if (!tbl) errors.push(`Measure "${m.name}" uses table "${m.table}", which is not in the model.`);
    const key = String(m.name || '').toLowerCase();
    if (measureNames.has(key)) errors.push(`Measure "${m.name}" is duplicated.`);
    measureNames.add(key);
    if (columnsByTable.get(m.table)?.has(key)) errors.push(`Measure "${m.name}" collides with a column in ${m.table}.`);
  }
  const unresolved = [];
  for (const m of measures) {
    for (const ref of String(m.expression || '').matchAll(/(?<!['\w\]])\[([^\]]+)\]/g)) {
      const name = ref[1].replace(/]]/g, ']');
      if (!measureNames.has(name.toLowerCase())) unresolved.push(`${m.name} → [${name}]`);
    }
  }
  if (unresolved.length) warnings.push(`Some measure references do not match another measure by name (${unresolved.slice(0, 6).join(', ')}).`);

  const factTables = new Set(plan.relationships.map((r) => r.from.name));
  const dimTables = new Set(plan.relationships.map((r) => r.to.name));
  if (!factTables.size && plan.tables.length > 1) warnings.push('No fact table was detected from relationships.');
  if (!dimTables.size && plan.tables.length > 1) warnings.push('No dimension tables were detected from relationships.');
  const hasDateColumn = plan.tables.some((t) => t.columns.some((c) => c.dataType === 'dateTime' && /date|start|time/i.test(c.name)));
  if (!dateTable && !hasDateColumn) warnings.push('No date table was detected; reports will have limited time trends.');
  else if (!dateTable && hasDateColumn) warnings.push('No dedicated date table was detected; reports will use fact date columns for trends.');
  const categories = plan.tables.flatMap((t) => t.columns.map((c) => ({ t, c })))
    .filter(({ t, c }) => c.dataType === 'string' && !c.isKey && t.name !== dateTable?.table && !WEAK_DIM.test(c.name) && (t.role !== 'fact' || /category|segment|region|country|territory|channel|type|group/i.test(c.name)));
  if (!categories.length) warnings.push('No strong breakdown dimension was detected; reports may focus on KPIs instead of segment analysis.');
  const businessMeasures = measures.filter((m) => !/countrows|row count/i.test(m.expression || m.name));
  if (businessMeasures.length < 3) warnings.push('Fewer than three business measures are included; reports may look sparse.');

  score -= errors.length * 35;
  score -= warnings.length * 8;
  score = Math.max(0, Math.min(100, score));
  const status = errors.length ? 'not-ready' : score >= 80 ? 'ready' : score >= 55 ? 'needs-review' : 'not-ready';
  return {
    status, score, errors, warnings: warnings.slice(0, 12),
    summary: status === 'ready' ? `Ready (${score}/100)` : status === 'needs-review' ? `Needs review (${score}/100)` : `Not ready (${score}/100)`,
  };
}

export function modelMeasures(plan, preset, measures, useDefaults = true) {
  let m;
  if (preset?.measures?.length) {
    const given = measures || [];
    const names = new Set(given.map((x) => x.name.toLowerCase()));
    m = [...preset.measures.filter((x) => !names.has(x.name.toLowerCase())), ...given];
  } else m = measures?.length ? measures : useDefaults ? defaultMeasures(plan) : [];
  return sanitizeMeasures(plan, m);
}

// ---------------- Copilot suggestions ----------------

/** Keep Copilot's suggested semantic model design, checked against the schema, so the user can review and apply it. Nothing changes in Fabric. */
export async function proposeSemanticModel({ name, include, names, relationships, measures, summary }, { chatId = null } = {}) {
  await assertProjectTenant();
  const p = getProject();
  if (!p.modelSource) throw new Error('No data source yet. Load sample data or connect data first (Data page).');
  const preset = presetFor(p);
  const schema = await describeModelSource();
  const known = new Set(schema.tables.flatMap((t) => [`${t.schema}.${t.name}`, t.name]));
  const plan = buildPlan({ ...schema, relationships: relationships?.length ? relationships : schema.relationships }, { include: include?.length ? include : preset?.include, names: { ...(preset?.names || {}), ...(names || {}) } });
  if (!plan.tables.length) throw new Error('None of the suggested tables exist in the data source. Call studio_describe_data and use schema.table names.');
  const given = (measures || []).filter((x) => x?.table && x?.name && x?.expression);
  const effective = modelMeasures(plan, preset, given);
  const propDateTable = preset?.dateTable && plan.tables.some((t) => t.name === preset.dateTable.table) ? preset.dateTable : preset ? null : findDateTable(plan);
  const quality = semanticModelQuality(plan, effective, { dateTable: propDateTable, measureWarnings: effective.warnings });
  const warnings = [
    ...(include || []).filter((k) => !known.has(k)).map((k) => `Table ${k} doesn't exist in the data source and was left out.`),
    ...given.filter((x) => !plan.tables.some((t) => t.name === x.table)).map((x) => `Measure ${x.name} uses table "${x.table}", which isn't one of the model's business table names, and was left out.`),
    ...(relationships?.length && plan.relationships.length < relationships.length ? [`${relationships.length - plan.relationships.length} relationship(s) use tables or columns that aren't in the model and were left out.`] : []),
    ...(effective.warnings || []),
    ...quality.warnings,
    ...quality.errors,
  ];
  const modelName = modelNameFor(p, preset, name);
  // Snowflaked dimensions (Product → Subcategory) are on the "from" side too; only tables nothing points to are facts.
  const role = (t) => (plan.relationships.some((r) => r.to === t) ? 'dimension' : plan.relationships.some((r) => r.from === t) ? 'fact' : 'table');
  const text = String(summary || '').trim();
  const proposal = {
    id: newId(), kind: 'semantic-model', chatId, createdAt: new Date().toISOString(), summary: text.length > 1200 ? `${text.slice(0, 1200).replace(/\s+\S*$/, '')}…` : text,
    name: modelName,
    include: plan.tables.map((t) => t.key),
    names: names || {},
    relationships: relationships?.length ? relationships : null,
    measures: given,
    quality,
    updatesExisting: (p.semanticModels || []).some((x) => x.origin !== 'existing' && x.name.toLowerCase() === modelName.toLowerCase()),
    preview: {
      tables: plan.tables.map((t) => ({ key: t.key, name: t.name, role: role(t) })),
      relationships: plan.relationships.map((r) => ({ from: `${r.from.name}[${r.fromColumn}]`, to: `${r.to.name}[${r.toColumn}]`, active: r.active })),
      measures: effective.map((x) => ({ table: x.table, name: x.name, expression: x.expression, suggested: given.includes(x) })),
    },
    warnings,
  };
  updateProject({ modelProposal: proposal });
  logActivity('copilot.proposal', `Copilot suggested semantic model "${modelName}" (${plan.tables.length} tables, ${plan.relationships.length} relationships, ${effective.length} measures)`, { chatId });
  return proposal;
}

// ---------------- ontology ----------------

function ontologyQuality(out, plan, rules = []) {
  const errors = [];
  const warnings = [];
  let score = 100;
  const entityCount = Object.keys(out.entities || {}).length;
  if (!entityCount) errors.push('No entities were generated.');
  if (plan.tables.length > 1 && !out.relationships.length) warnings.push('No entity relationships were generated; ontology answers will have little navigation context.');
  if (!out.rules.length) warnings.push('No business rules were generated; governance dashboards will be limited.');
  const noKey = plan.tables.filter((t) => !t.columns.some((c) => c.isKey)).map((t) => t.name);
  if (noKey.length) warnings.push(`${noKey.slice(0, 5).join(', ')} ${noKey.length === 1 ? 'has' : 'have'} no key column, so instance linking may be weaker.`);
  const normEntity = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const one = (s) => String(s || '').replace(/ies$/i, 'y').replace(/(ss)es$/i, '$1').replace(/([^s])s$/i, '$1');
  const knownEntities = new Set();
  for (const t of plan.tables) {
    const e = out.entities?.[t.key];
    for (const n of [e, t.name, t.source, one(t.name), one(t.source), t.key.split('.').pop()]) if (n) knownEntities.add(normEntity(n));
  }
  const brokenRules = (rules || []).filter((r) => r.entities?.length && r.entities.some((e) => !knownEntities.has(normEntity(e.entity || e))));
  if (brokenRules.length) warnings.push(`${brokenRules.length} rule${brokenRules.length === 1 ? '' : 's'} reference entities that were not generated.`);
  score -= errors.length * 40;
  score -= warnings.length * 10;
  score = Math.max(0, Math.min(100, score));
  const status = errors.length ? 'not-ready' : score >= 80 ? 'ready' : 'needs-review';
  return { status, score, errors, warnings: warnings.slice(0, 10), summary: status === 'ready' ? `Ready (${score}/100)` : status === 'needs-review' ? `Needs review (${score}/100)` : `Not ready (${score}/100)` };
}

export async function runOntology(ctx, { name, include, entityNames, rules, descriptions } = {}) {
  const ws = requireWorkspace();
  const p = getProject();
  const preset = presetFor(p);
  ctx.step('Read the source schema');
  const schema = await describeModelSource();
  const exclude = new Set((preset?.ontology?.exclude || []).map((x) => x.toLowerCase()));
  const inc = include?.length ? include : preset?.ontology?.include || schema.tables.filter((t) => !exclude.has(t.name.toLowerCase()) && !isPlanTable(t)).map((t) => `${t.schema}.${t.name}`);
  const plan = buildPlan(schema, { include: inc, names: preset?.names, descriptions: preset?.descriptions });
  const picked = F.itemName('Ontology', itemNameFor('Ontology', { name, current: p.ontology?.name, purpose: preset?.naming?.model || purposeOf(p.semanticModel?.name, 'SemanticModel') || purposeOf(p.modelSource.itemName, p.modelSource.itemType) }), 'Ontology');
  // An ontology another data source of the workspace built is never updated from this one.
  const ontName = p.ontology?.name && picked.toLowerCase() === p.ontology.name.toLowerCase() ? picked : freeAcrossSources('Ontology', picked, p);
  const presetRules = preset?.ontology?.rules || [];
  const ruleSet = rules?.length
    ? rules.map((r) => {
      const pr = presetRules.find((x) => x.name === r.name);
      return pr && !r.entities?.length ? { ...pr, ...r, entities: pr.entities, relationships: pr.relationships } : r;
    })
    : presetRules;
  ctx.progress(25);

  ctx.step('Generate the ontology (entities, relationships, rules)');
  const out = ontologyFiles({ name: ontName, src: { server: p.modelSource.server, endpointId: p.modelSource.endpointId, item: ontologySourceOf(p) }, plan, rules: ruleSet, entityNames: entityNames || preset?.ontology?.entityNames || {}, descriptions: descriptions || {} });
  ctx.log(`${Object.keys(out.entities).length} entities · ${out.relationships.length} relationships · ${out.rules.length} rules`);
  const quality = ontologyQuality(out, plan, ruleSet);
  ctx.step(`Ontology quality gate: ${quality.summary}`);
  if (quality.errors.length) throw new Error(`Ontology is not ready: ${quality.errors.join(' ')}`);
  ctx.log(`Quality gate: ${quality.summary}`);
  for (const w of quality.warnings) ctx.log(`Quality warning: ${w}`);
  // Keep the live time-series properties when the ontology was connected to the live events before.
  let files = out.files;
  const events = p.realtime?.ontology ? liveEventsOf(p) : null;
  if (events) {
    const live = applyLiveOntology(files, { events, dashboard: p.realtime.dashboard, workspaceId: ws.id });
    files = live.files;
    if (live.linked.length) ctx.log(`Live events kept on ${live.linked.map((l) => l.entity).join(', ')}`);
  }
  ctx.progress(45);

  ctx.step(`Deploy ontology "${ontName}"`);
  const definition = F.toParts(files);
  let item = await F.findItem(ws.id, 'Ontology', ontName);
  if (item) await F.updateDefinition(ws.id, item.id, definition);
  else {
    item = await F.createItem(ws.id, { name: ontName, type: 'Ontology', description: 'Business ontology generated by Fabric MCP Studio.', definition });
    recordArtifact({ type: 'Ontology', id: item.id, name: ontName, workspaceId: ws.id });
  }
  updateProject({ ontology: { id: item.id, name: ontName, sourceItemId: p.modelSource.itemId, entities: Object.values(out.entities), rules: out.rules, ruleDetails: ruleSet.filter((r) => out.rules.includes(r.name)).map((r) => ({ name: r.name, statement: r.statement })), relationships: out.relationships.map((r) => r.label), quality } });
  setStep('ontology', 'done', ontName);
  return { id: item.id, name: ontName, entities: Object.values(out.entities), rules: out.rules };
}

export function ontologyPreview({ include, rules } = {}) {
  return (async () => {
    const p = getProject();
    const preset = presetFor(p);
    const schema = await describeModelSource();
    const exclude = new Set((preset?.ontology?.exclude || []).map((x) => x.toLowerCase()));
    const inc = include?.length ? include : preset?.ontology?.include || schema.tables.filter((t) => !exclude.has(t.name.toLowerCase())).map((t) => `${t.schema}.${t.name}`);
    const plan = buildPlan(schema, { include: inc, names: preset?.names });
    const out = ontologyFiles({ name: 'preview', src: { server: 's', endpointId: 'e' }, plan, rules: rules || preset?.ontology?.rules || [], entityNames: preset?.ontology?.entityNames || {} });
    return {
      entities: plan.tables.map((t) => ({ name: out.entities[t.key], table: `${t.schema}.${t.source}`, properties: t.columns.length, key: t.columns.find((c) => c.isKey)?.name || null })),
      relationships: out.relationships,
      rules: (rules || preset?.ontology?.rules || []).map((r) => ({ name: r.name, statement: r.statement })),
    };
  })();
}

// ---------------- Teams agent (Microsoft 365 Copilot) ----------------

export function runTeamsAgent(ctx, { includeOntology = false, publish = false, dryRun = false } = {}) {
  if (process.platform !== 'win32') throw new Error('The Teams agent installer is a PowerShell script. Run scripts/install-teams-agent.ps1 with PowerShell 7 on macOS/Linux.');
  const script = join(REPO_ROOT, 'scripts', 'install-teams-agent.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (dryRun) args.push('-DryRun');
  if (includeOntology) {
    const p = getProject();
    if (!p.ontology?.id) throw new Error('Deploy the ontology first, or install without it.');
    args.push('-IncludeOntology', '-OntologyWorkspaceId', p.workspace.id, '-OntologyItemId', p.ontology.id);
  }
  if (publish) args.push('-Publish');
  ctx.step(dryRun ? 'Validate the agent package (dry run)' : 'Install the Contoso Retail Analyst agent');
  return new Promise((resolveP, reject) => {
    const child = spawn('powershell.exe', args, { cwd: REPO_ROOT, windowsHide: true });
    const onData = (b) => String(b).split(/\r?\n/).filter((l) => l.trim() && !/DeprecationWarning|trace-deprecation/.test(l)).forEach((l) => ctx.log(l));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    ctx.signal.addEventListener('abort', () => child.kill());
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        if (!dryRun) { updateProject({ teamsAgent: { installedAt: new Date().toISOString(), includeOntology, published: publish } }); setStep('share', 'done', 'Teams agent installed'); }
        resolveP({ ok: true });
      } else reject(new Error(`Installer exited with code ${code}. See the log above.`));
    });
  });
}

// ---------------- AdventureWorksDW2022 sample (Fabric SQL database) ----------------

export async function runSampleAdventureWorks(ctx) {
  const ws = requireWorkspace();
  beginSource({ kind: 'sample', id: 'adventureworks-dw', label: 'AdventureWorksDW2022 (Fabric SQL database)', method: 'sql-database' }, ctx);
  suggestNaming(ADVENTUREWORKS.naming);
  ctx.step('Get the AdventureWorksDW install kit from Microsoft');
  const kit = await getKit(ctx.log, { signal: ctx.signal });
  ctx.progress(6);

  // The project's database (or one an older version of the studio created) is reused; a new one follows the standard.
  const prevDb = getProject().sqlDatabase;
  const dbName = F.itemName('SQLDatabase', prevDb?.name || standardName('SQLDatabase', ADVENTUREWORKS.naming.database));
  ctx.step(`Create the Fabric SQL database ${dbName}`);
  let db = (prevDb?.id && await F.getItem(ws.id, prevDb.id).catch(() => null)) || await F.findItem(ws.id, 'SQLDatabase', dbName) || await F.findItem(ws.id, 'SQLDatabase', AWDW.databaseName);
  if (!db) {
    db = await F.createSqlDatabase(ws.id, { name: dbName, description: 'AdventureWorksDW2022 sample created by Fabric MCP Studio.' });
    recordArtifact({ type: 'SQLDatabase', id: db.id, name: dbName, workspaceId: ws.id });
    ctx.log(`Created ${dbName}`);
  } else ctx.log(`Reusing ${db.displayName || dbName}`);
  const usedName = db.displayName || dbName;
  const props = (await F.getSqlDatabase(ws.id, db.id))?.properties || {};
  if (!props.serverFqdn || !props.databaseName) throw new Error('The SQL database has no connection details yet. Try again in a minute.');
  updateProject({ sqlDatabase: { id: db.id, name: usedName, server: props.serverFqdn, database: props.databaseName } });
  ctx.progress(12);

  ctx.step('Create the tables and load the data');
  const load = await withPool({ server: props.serverFqdn, database: props.databaseName }, (pool) => loadAdventureWorksDW(pool, kit, ctx, { from: 12, to: 70 }));
  const expected = Object.fromEntries(load.plan.data.map((d) => [d.table, load.counts[d.table]]));
  const rows = Object.values(expected).reduce((a, b) => a + (b || 0), 0);
  logActivity('sample.adventureworks', `Loaded AdventureWorksDW2022 into Fabric SQL database (${Object.keys(expected).length} tables, ${rows.toLocaleString('en-US')} rows)`, { sqlDatabaseId: db.id });

  ctx.step('Wait for the OneLake replica (SQL analytics endpoint)');
  const ep = await F.waitSqlEndpoint(ws.id, db.id, 'SQLDatabase', { signal: ctx.signal });
  await waitForReplica(ctx, ws.id, ep, expected, { from: 70, to: 97, verify: salesTotalsMatch });

  const glossaryPath = join(REPO_ROOT, ADVENTUREWORKS.glossaryFile);
  updateProject({
    scenario: 'sample',
    source: { kind: 'sample', id: 'adventureworks-dw', label: 'AdventureWorksDW2022 (Fabric SQL database)', method: 'sql-database', itemId: db.id, tables: Object.keys(expected) },
    glossary: existsSync(glossaryPath) ? readFileSync(glossaryPath, 'utf8') : getProject().glossary,
  });
  setModelSource({ itemType: 'SQLDatabase', itemId: db.id, itemName: usedName, workspaceId: ws.id, server: ep.server, endpointId: ep.endpointId, database: ep.database }, 'AdventureWorksDW2022 loaded');
  return { sqlDatabaseId: db.id, tables: Object.keys(expected).length, rows, reused: load.reused };
}

/** Fabric replicates SQL database tables to OneLake automatically; wait until every table matches the source. */
async function waitForReplica(ctx, workspaceId, ep, expected, { from, to, verify = null, timeoutMs = 25 * 60 * 1000 }) {
  const want = Object.entries(expected);
  const synced = new Set();
  const deadline = Date.now() + timeoutMs;
  let lastMsg = '';
  let verified = !verify;
  for (let i = 0; Date.now() < deadline; i++) {
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    if (i % 4 === 0) await F.refreshSqlEndpoint(workspaceId, ep.endpointId);
    try {
      await withPool({ server: ep.server, database: ep.database }, async (pool) => {
        const present = new Set((await pool.request().query("SELECT name FROM sys.tables WHERE SCHEMA_NAME(schema_id) = 'dbo'")).recordset.map((r) => r.name));
        for (const [t, n] of want) {
          if (synced.has(t) || !present.has(t)) continue;
          const c = Number((await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM dbo.[${t}]`)).recordset[0].n);
          if (c === n) synced.add(t);
        }
        if (synced.size === want.length && !verified) verified = await verify(pool);
      });
    } catch (e) {
      if (!/Invalid object|does not exist|Login failed|not found/i.test(e.message)) ctx.log(`Waiting for the SQL analytics endpoint: ${e.message.split('\n')[0]}`);
    }
    const msg = `OneLake replica: ${synced.size}/${want.length} tables in sync${synced.size === want.length && !verified ? ' · waiting for the latest values' : ''}`;
    if (msg !== lastMsg) { ctx.log(msg); lastMsg = msg; }
    ctx.progress(from + (to - from) * (synced.size / want.length) * (verified ? 1 : 0.97));
    if (synced.size === want.length && verified) return;
    await sleep(15000);
  }
  const missing = want.filter(([t]) => !synced.has(t)).map(([t]) => t);
  throw new Error(`OneLake replication didn't finish in time (${missing.length} tables pending: ${missing.slice(0, 5).join(', ')}). The data is in the SQL database; run the sample again in a few minutes to continue.`);
}

// ---------------- teardown ----------------

// Item types Fabric moves to the workspace recycle bin when item recovery is on (the default); the rest are deleted
// for good.
const RECOVERABLE = new Set(['Lakehouse', 'SQLDatabase', 'MirroredDatabase', 'Warehouse', 'Ontology', 'KQLDashboard', 'Eventstream']);
const displayName = (x, fallback = 'item') => x?.name || x?.displayName || x?.itemName || x?.id || fallback;

/** What "Clean up resources" deletes, in delete order: only items the studio created or mirrored – for every data source of the workspace. */
function teardownItems(p) {
  const out = [];
  const seen = new Set();
  const views = contextViews(p);
  for (const v of views) {
    for (const it of contextTeardownItems(v.view)) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(views.length > 1 ? { ...it, source: v.view.source?.label || v.label || null } : it);
    }
  }
  return out;
}

/** The items one data source's work created, in delete order. */
function contextTeardownItems(p) {
  const med = p.realtime?.medallion?.items || {};
  // Every model's data agent and org app (the active model's are live, the others' are kept with their model). Models
  // the user added to the project (origin 'existing') are theirs and stay.
  const contexts = projectModels(p).map((m) => modelContext(p, m.id));
  if (!p.semanticModel) contexts.push({ dataAgent: p.dataAgent, orgApp: p.orgApp });
  const studioModels = projectModels(p).filter((m) => m.origin !== 'existing' && (m.workspaceId || p.workspace?.id) === p.workspace?.id);
  const list = [
    ...contexts.map((c) => ['OrgApp', 'Org app', c.orgApp]),
    ...contexts.map((c) => ['DataAgent', 'Fabric data agent', c.dataAgent]),
    ...(p.reports || []).map((r) => ['Report', 'Report', r]),
    ['Plan', 'Fabric plan', p.planning?.planItem],
    ['Warehouse', 'Planning warehouse (plan values)', [p.planning?.target?.warehouse, p.planStore?.warehouse].find((w) => w?.created) || null],
    ['Reflex', 'Activator alerts', p.realtime?.alerts],
    ['KQLDashboard', 'Real-Time Dashboard', p.realtime?.dashboard],
    ['SemanticModel', 'Gold semantic model (medallion)', med.goldModel],
    ['KQLQueryset', 'Silver to Gold queryset (medallion)', med.goldQueryset],
    ['Lakehouse', 'Silver lakehouse (medallion, shortcut only)', med.silverLakehouse],
    ['KQLQueryset', 'Bronze to Silver queryset (medallion)', med.silverQueryset],
    ['Eventstream', 'Eventstream', p.realtime?.eventstream],
    ['Eventhouse', 'Eventhouse (all live events and medallion layers)', p.realtime?.eventhouse],
    ['Ontology', 'Ontology', p.ontology],
    ...studioModels.map((m) => ['SemanticModel', 'Semantic model', m]),
    ...(p.dataPrepItems || []).filter((i) => i.id !== p.lakehouse?.id).map((i) => [i.type, i.type === 'Notebook' ? 'Data prep notebook' : 'Curated lakehouse (data prep notebook)', i]),
    ['MirroredDatabase', 'Mirrored database (replication stops)', p.source?.method === 'mirror' && p.modelSource?.itemId ? { id: p.modelSource.itemId, name: p.modelSource.itemName } : null],
    ['Lakehouse', 'Lakehouse', p.lakehouse],
    ['SQLDatabase', 'SQL database', p.sqlDatabase],
  ];
  const seen = new Set();
  return list.filter(([, , it]) => it?.id && !seen.has(it.id) && seen.add(it.id)).map(([type, label, it]) => ({ type, label, id: it.id, name: displayName(it) }));
}

/** Shown before "Clean up resources" runs, so the user confirms exactly what is deleted. */
export function teardownPlan({ deleteWorkspace = false } = {}) {
  const p = getProject();
  if (!p.workspace) return { workspace: null, deleteWorkspace: false, items: [] };
  const workspace = { id: p.workspace.id, name: p.workspace.name, created: Boolean(p.workspace.created) };
  const items = teardownItems(p).map((i) => ({ ...i, recoverable: RECOVERABLE.has(i.type) }));
  const tf = p.taskFlow?.id ? p.taskFlow : null;
  const views = contextViews(p).map((v) => v.view);
  return {
    workspace,
    deleteWorkspace: Boolean(deleteWorkspace && workspace.created),
    items,
    sources: views.length,
    taskFlow: p.realtime?.medallion?.taskFlow ? { name: p.realtime.medallion.taskFlow.name } : null,
    // A task flow the studio created is deleted; in one that was already in the workspace only the studio's items are
    // taken off its tasks.
    taskFlows: [...views.map((v) => v.realtime?.medallion?.taskFlow), tf?.mode !== 'existing' ? tf : null].filter((x) => x?.id).map((x) => ({ name: x.name })),
    taskFlowUnassign: tf?.mode === 'existing' ? { name: tf.name } : null,
    keptModels: views.flatMap((v) => projectModels(v)).filter((m) => m.origin === 'existing').map((m) => ({ name: m.name })),
    ontologyCompanions: views.some((v) => v.ontology?.id),
    liveEvents: views.some((v) => v.realtime),
  };
}

export async function runTeardown(ctx, { deleteWorkspace = false } = {}) {
  const p = getProject();
  const workspace = p.workspace ? { ...p.workspace } : null;
  const workspaceName = workspace?.name || 'the workspace';
  const views = contextViews(p).map((v) => v.view);
  discoveryCache = { key: null, at: 0, data: null };
  resetProfileCache();
  // A lakehouse the studio doesn't delete (for example one used in place in another workspace) keeps no shortcut to
  // the planning warehouse that goes now – in both clean-up paths, for every data source.
  for (const v of views) {
    const pt = v.planning?.target?.kind === 'Lakehouse' ? v.planning.target : v.planStore?.shortcut ? v.planStore : null;
    if (workspace && pt?.shortcut && pt.lakehouse && pt.lakehouse.id !== v.lakehouse?.id) {
      const lhName = displayName(pt.lakehouse, 'lakehouse');
      try { await F.fabric('DELETE', `/workspaces/${pt.lakehouse.workspaceId}/items/${pt.lakehouse.id}/shortcuts/${pt.shortcut.path}/${pt.shortcut.name}`); ctx.log(`Deleted the plan shortcut in ${lhName}`); } catch (e) { if (e.status !== 404) ctx.log(`Could not delete the plan shortcut in ${lhName}: ${e.message}`); }
    }
  }
  // The project starts empty again; only the glossary is kept for the next project.
  const empty = { workspace: null, ...blankSourcesPatch(), glossary: p.glossary || '', tenant: null, steps: {} };
  if (deleteWorkspace && workspace?.created) {
    stopSimulator('clean up');
    ctx.step(`Delete workspace ${workspaceName}`);
    await F.deleteWorkspace(workspace.id);
    updateProject(empty);
    clearDataPrepFiles();
  } else if (workspace) {
    ctx.step('Delete items created by the studio');
    stopSimulator('clean up');
    for (const v of views) {
      const tf = v.realtime?.medallion?.taskFlow;
      if (tf?.id) {
        const tfName = displayName(tf, 'task flow');
        try { ctx.log((await deleteTaskFlow(workspace.id, tf.id)) ? `Deleted task flow "${tfName}"` : `Task flow "${tfName}" was already deleted`); } catch (e) { ctx.log(`Could not delete task flow "${tfName}": ${e.message}`); }
      }
    }
    const mf = p.taskFlow;
    if (mf?.id) {
      const mfName = displayName(mf, 'task flow');
      try { ctx.log(await WTF.teardownTaskFlow()); } catch (e) { ctx.log(`Could not ${mf.mode === 'existing' ? 'take the studio\'s items off' : 'delete'} task flow "${mfName}": ${e.message}`); }
    }
    for (const it of teardownItems(p)) {
      if (it.type === 'MirroredDatabase') { try { await F.stopMirroring(workspace.id, it.id); } catch { /* already stopped */ } }
      try { await F.deleteItem(workspace.id, it.id); ctx.log(`Deleted ${it.name} (${it.label.replace(/ \(.*\)$/, '')})`); } catch (e) { ctx.log(e.status === 404 ? `${it.name} was already deleted` : `Could not delete ${it.name}: ${e.message}`); }
      if (it.type === 'Ontology') await deleteOntologyCompanions(workspace.id, it.id, ctx.log);
    }
    // The project starts empty again: the workspace itself stays in Fabric, but the studio no longer points to it.
    updateProject(empty);
    clearDataPrepFiles();
    ctx.log(`The project is empty again – ${workspaceName} stays in Fabric; choose a workspace to start a new one`);
  }
  return { ok: true };
}

export const ids = { stableUuid };

/** An ontology provisions companion items named <ontology>_graph_<id> and <ontology>_eh_<id>: delete them too. */
export async function deleteOntologyCompanions(workspaceId, ontologyId, log = () => {}) {
  const suffix = ontologyId.replace(/-/g, '').toLowerCase();
  const order = { GraphModel: 0, KQLDatabase: 1, Eventhouse: 2 };
  try {
    const companions = (await F.listItems(workspaceId)).filter((i) => i.displayName.toLowerCase().endsWith(suffix) && i.type in order).sort((a, b) => order[a.type] - order[b.type]);
    for (const i of companions) {
      try { await F.deleteItem(workspaceId, i.id); log(`Deleted ${i.type} ${i.displayName}`); } catch (e) { if (e.status !== 404) log(`Could not delete ${i.displayName}: ${e.message}`); }
    }
  } catch (e) { log(`Could not list ontology companion items: ${e.message}`); }
}

/**
 * The studio-created items that hold the data source: the mirrored database, or the project lakehouse or SQL database
 * when the model reads it. A lakehouse, warehouse or database of the customer's (used in place) isn't one of them.
 */
export function dataSourceItems(p = getProject()) {
  const ms = p.modelSource;
  if (!ms) return [];
  const out = [];
  if (p.source?.method === 'mirror' && ms.itemId) out.push({ type: 'MirroredDatabase', id: ms.itemId, name: ms.itemName, workspaceId: ms.workspaceId || p.workspace?.id });
  if (p.lakehouse?.id && p.lakehouse.id === ms.itemId) out.push({ type: 'Lakehouse', id: p.lakehouse.id, name: p.lakehouse.name, workspaceId: p.workspace?.id });
  if (p.sqlDatabase?.id && p.sqlDatabase.id === ms.itemId) out.push({ type: 'SQLDatabase', id: p.sqlDatabase.id, name: p.sqlDatabase.name, workspaceId: p.workspace?.id });
  return out;
}

/** Disconnect the data source and delete the items the studio created for it; the customer's own items stay. */
export async function removeDataSource(ctx) {
  const p = getProject();
  for (const it of dataSourceItems(p)) {
    // Another data source of the workspace reads it (for example the same lakehouse used in place): it stays.
    const users = otherSourcesUsing(it.id, p);
    if (users.length) { ctx.log(`${it.name} stays – ${users.map((u) => u.label).join(', ')} use${users.length === 1 ? 's' : ''} it`); continue; }
    if (it.type === 'MirroredDatabase') { try { await F.stopMirroring(it.workspaceId, it.id); } catch { /* already stopped */ } }
    try { await F.deleteItem(it.workspaceId, it.id); ctx.log(`Deleted ${it.name}`); } catch (e) { if (e.status !== 404) throw e; ctx.log(`${it.name} was already deleted`); }
  }
  discoveryCache = { key: null, at: 0, data: null };
  const left = getProject();
  updateProject({
    source: null, modelSource: null, scenario: null, modelProposal: null,
    ...(left.lakehouse?.id === p.modelSource?.itemId ? { lakehouse: null } : {}),
    ...(left.sqlDatabase?.id === p.modelSource?.itemId ? { sqlDatabase: null } : {}),
  });
  setStep('data', 'todo', '');
  ctx.log(p.source?.label ? `Disconnected ${p.source.label}` : 'Disconnected the data source');
  // Nothing left that was built from it: it leaves the workspace's list of data sources.
  dropEmptySource();
}

/** Uninstall the Microsoft 365 / Teams agent with the installer script (-Uninstall). */
export function uninstallTeamsAgent(ctx) {
  if (process.platform !== 'win32') throw new Error('The Teams agent installer is a PowerShell script. Run scripts/install-teams-agent.ps1 -Uninstall with PowerShell 7 on macOS/Linux.');
  const script = join(REPO_ROOT, 'scripts', 'install-teams-agent.ps1');
  ctx.log('Uninstalling the agent from Microsoft 365 (installer -Uninstall)');
  return new Promise((resolveP, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Uninstall'], { cwd: REPO_ROOT, windowsHide: true });
    const onData = (b) => String(b).split(/\r?\n/).filter((l) => l.trim() && !/DeprecationWarning|trace-deprecation/.test(l)).forEach((l) => ctx.log(l));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    ctx.signal?.addEventListener('abort', () => child.kill());
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) { reject(new Error(`The uninstaller exited with code ${code}. See the log above.`)); return; }
      updateProject({ teamsAgent: null });
      setStep('share', 'todo', '');
      resolveP({ ok: true });
    });
  });
}
