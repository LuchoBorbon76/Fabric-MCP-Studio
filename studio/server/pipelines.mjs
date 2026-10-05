// End-to-end pipelines used by both the UI (quick actions) and the AI agent (studio_* tools).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, sleep, stableUuid, newId } from './config.mjs';
import * as F from './fabric.mjs';
import { getProject, updateProject, setStep, recordArtifact, logActivity, assertProjectTenant, projectModels, modelContext } from './project.mjs';
import { discoverSqlServer, testSqlServer, readOnlyQuery, withPool } from './sql.mjs';
import { discoverPostgres, testPostgres } from './pg.mjs';
import { sourceType } from './sources.mjs';
import { buildPlan, semanticModelFiles, ontologyFiles, defaultMeasures } from './generators/tmdl.mjs';
import { applyLiveOntology, liveEventsOf, ontologySourceOf } from './generators/ontology-live.mjs';
import { isPlanTable, reapplyPlan } from './planning/index.mjs';
import { RETAIL, ADVENTUREWORKS, presetFor } from './presets.mjs';
import { AWDW, getKit, loadAdventureWorksDW, salesTotalsMatch } from './samples/adventureworks-dw.mjs';
import { resetProfileCache } from './reports/index.mjs';
import { stopSimulator } from './realtime/simulator.mjs';
import { deleteTaskFlow } from './taskflow.mjs';
import * as WTF from './workspace-taskflow.mjs';
import { clearDataPrepFiles } from './dataprep.mjs';
import { standardName, standardize, itemNameFor, purposeOf, parseName, namingOf, setNaming, suggestNaming, pascal } from './naming.mjs';

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
  // Naming guessed for the previous workspace (from its name or a sample) doesn't carry over; a confirmed one does.
  const reset = prev?.id !== ws.id ? { lakehouse: null, sqlDatabase: null, modelSource: null, semanticModel: null, ontology: null, source: null, dataPrep: null, dataPrepItems: [], dataAgent: null, dataAgentProposal: null, taskFlow: null, semanticModels: [], planStore: null, ...(getProject().naming?.inferred ? { naming: null } : {}) } : {};
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
  suggestNaming(RETAIL.naming);
  ctx.step('Create the project lakehouse');
  const lh = await ensureProjectLakehouse(ctx.log, { purpose: RETAIL.naming.lakehouse, legacy: [RETAIL.lakehouseName] });
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

export async function useInPlace({ workspaceId, itemId, itemType, typeId }) {
  await assertProjectTenant();
  requireWorkspace();
  const ep = await endpointFor(workspaceId, itemId, itemType);
  updateProject({ scenario: 'byod', source: { kind: 'fabric', type: typeId || itemType, itemType, itemName: ep.itemName, label: `${ITEM_LABEL[itemType] || itemType} · ${ep.itemName}`, method: 'in-place', itemId, workspaceId } });
  setModelSource({ itemType, itemId, itemName: ep.itemName, workspaceId, server: ep.server, endpointId: ep.endpointId, database: ep.database }, `Using ${ep.itemName} in place`);
  return getProject().modelSource;
}

export async function runShortcuts(ctx, { sourceWorkspaceId, sourceItemId, sourceItemType, tables = [], typeId }) {
  requireWorkspace();
  const ws = getProject().workspace;
  ctx.step('Prepare the project lakehouse');
  const lh = await ensureProjectLakehouse(ctx.log, { purpose: 'Raw', reuseAny: true });
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
  const src = await F.getItem(sourceWorkspaceId, sourceItemId);
  updateProject({ scenario: 'byod', source: { kind: 'fabric', type: typeId || sourceItemType, itemType: sourceItemType, itemName: src.displayName, label: `${ITEM_LABEL[sourceItemType] || sourceItemType} · ${src.displayName} (shortcuts)`, method: 'shortcut', itemId: sourceItemId, workspaceId: sourceWorkspaceId, tables: tables.map((t) => t.name) } });
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
  d.source = ms;
  discoveryCache = { key, at: Date.now(), data: d };
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
  return readOnlyQuery({ server: ms.server, database: ms.database }, query);
}

// ---------------- semantic model ----------------

export async function runSemanticModel(ctx, { name, include, names, relationships, measures, descriptions, useDefaults = true, proposalId } = {}) {
  const ws = requireWorkspace();
  const p = getProject();
  const preset = presetFor(p);
  ctx.step('Read the source schema');
  const schema = await describeModelSource({ refresh: true });
  // The plan values are added as the model's Plan table, not as a regular table.
  schema.tables = schema.tables.filter((t) => !isPlanTable(t) || include?.includes(`${t.schema}.${t.name}`));
  if (relationships?.length) schema.relationships = relationships;
  const plan = buildPlan(schema, { include: include?.length ? include : preset?.include, names: { ...(preset?.names || {}), ...(names || {}) }, descriptions: descriptions || preset?.descriptions });
  if (!plan.tables.length) throw new Error('No tables found in the data source.');
  ctx.log(`${plan.tables.length} tables, ${plan.relationships.length} relationships`);
  ctx.progress(25);

  const m = modelMeasures(plan, preset, measures, useDefaults);
  const dateTable = preset?.dateTable && plan.tables.some((t) => t.name === preset.dateTable.table) ? preset.dateTable : null;
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
  ctx.log(`${Object.keys(files).length} definition parts · ${m.length} measures`);
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
    semanticModel: { id: item.id, name: modelName, workspaceId: ws.id, workspaceName: ws.name, origin: 'studio', storageMode: 'DirectLake', tables: plan.tables.length, measures: m.length, relationships: plan.relationships.length, sourceItemId: p.modelSource.itemId },
    ...(proposalId && proposal?.id === proposalId ? { modelProposal: { ...proposal, appliedAt: new Date().toISOString(), semanticModelId: item.id } } : {}),
  });
  const others = (getProject().semanticModels || []).filter((x) => x.id !== item.id);
  if (isNew && others.length) ctx.log(`${modelName} is now the active model; ${others.length === 1 ? `${others[0].name} stays` : `the other ${others.length} models stay`} in the project (switch on the Semantic model page)`);
  setStep('model', 'done', modelName);
  return { id: item.id, name: modelName, tables: plan.tables.map((t) => t.name), measures: m.map((x) => x.name), relationships: plan.relationships.length };
}

/**
 * The semantic model's name: without a name the active model keeps its name (when the studio built it); a new one
 * follows the naming standard. Names of the other models the studio built are accepted as they are (updating them).
 */
export function modelNameFor(p, preset, name) {
  const ours = (p.semanticModels || []).filter((x) => x.origin !== 'existing').map((x) => x.name);
  const current = p.semanticModel?.origin !== 'existing' ? p.semanticModel?.name : undefined;
  return F.itemName('SemanticModel', itemNameFor('SemanticModel', { name, current, known: ours, purpose: preset?.naming?.model || purposeOf(p.modelSource?.itemName, p.modelSource?.itemType) || 'Main' }));
}

/**
 * Measures for a model: sample presets keep their glossary measures and add or replace Copilot's by name;
 * other sources use Copilot's measures, or starter measures when there are none. Measures on excluded tables are dropped.
 */
function modelMeasures(plan, preset, measures, useDefaults = true) {
  let m;
  if (preset?.measures?.length) {
    const given = measures || [];
    const names = new Set(given.map((x) => x.name.toLowerCase()));
    m = [...preset.measures.filter((x) => !names.has(x.name.toLowerCase())), ...given];
  } else m = measures?.length ? measures : useDefaults ? defaultMeasures(plan) : [];
  return m.filter((x) => plan.tables.some((t) => t.name === x.table));
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
  const warnings = [
    ...(include || []).filter((k) => !known.has(k)).map((k) => `Table ${k} doesn't exist in the data source and was left out.`),
    ...given.filter((x) => !plan.tables.some((t) => t.name === x.table)).map((x) => `Measure ${x.name} uses table "${x.table}", which isn't one of the model's business table names, and was left out.`),
    ...(relationships?.length && plan.relationships.length < relationships.length ? [`${relationships.length - plan.relationships.length} relationship(s) use tables or columns that aren't in the model and were left out.`] : []),
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

export async function runOntology(ctx, { name, include, entityNames, rules, descriptions } = {}) {
  const ws = requireWorkspace();
  const p = getProject();
  const preset = presetFor(p);
  ctx.step('Read the source schema');
  const schema = await describeModelSource();
  const exclude = new Set((preset?.ontology?.exclude || []).map((x) => x.toLowerCase()));
  const inc = include?.length ? include : preset?.ontology?.include || schema.tables.filter((t) => !exclude.has(t.name.toLowerCase()) && !isPlanTable(t)).map((t) => `${t.schema}.${t.name}`);
  const plan = buildPlan(schema, { include: inc, names: preset?.names, descriptions: preset?.descriptions });
  const ontName = F.itemName('Ontology', itemNameFor('Ontology', { name, current: p.ontology?.name, purpose: preset?.naming?.model || purposeOf(p.semanticModel?.name, 'SemanticModel') || purposeOf(p.modelSource.itemName, p.modelSource.itemType) }), 'Ontology');
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
  updateProject({ ontology: { id: item.id, name: ontName, sourceItemId: p.modelSource.itemId, entities: Object.values(out.entities), rules: out.rules, ruleDetails: ruleSet.filter((r) => out.rules.includes(r.name)).map((r) => ({ name: r.name, statement: r.statement })), relationships: out.relationships.map((r) => r.label) } });
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

/** What "Clean up resources" deletes, in delete order: only items the studio created or mirrored. */
function teardownItems(p) {
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
  return list.filter(([, , it]) => it?.id && !seen.has(it.id) && seen.add(it.id)).map(([type, label, it]) => ({ type, label, id: it.id, name: it.name || it.displayName || it.id }));
}

/** Shown before "Clean up resources" runs, so the user confirms exactly what is deleted. */
export function teardownPlan({ deleteWorkspace = false } = {}) {
  const p = getProject();
  if (!p.workspace) return { workspace: null, deleteWorkspace: false, items: [] };
  const workspace = { id: p.workspace.id, name: p.workspace.name, created: Boolean(p.workspace.created) };
  const items = teardownItems(p).map((i) => ({ ...i, recoverable: RECOVERABLE.has(i.type) }));
  const tf = p.taskFlow?.id ? p.taskFlow : null;
  return {
    workspace,
    deleteWorkspace: Boolean(deleteWorkspace && workspace.created),
    items,
    taskFlow: p.realtime?.medallion?.taskFlow ? { name: p.realtime.medallion.taskFlow.name } : null,
    // A task flow the studio created is deleted; in one that was already in the workspace only the studio's items are
    // taken off its tasks.
    taskFlows: [p.realtime?.medallion?.taskFlow, tf?.mode !== 'existing' ? tf : null].filter((x) => x?.id).map((x) => ({ name: x.name })),
    taskFlowUnassign: tf?.mode === 'existing' ? { name: tf.name } : null,
    keptModels: projectModels(p).filter((m) => m.origin === 'existing').map((m) => ({ name: m.name })),
    ontologyCompanions: Boolean(p.ontology?.id),
    liveEvents: Boolean(p.realtime),
  };
}

export async function runTeardown(ctx, { deleteWorkspace = false } = {}) {
  const p = getProject();
  discoveryCache = { key: null, at: 0, data: null };
  resetProfileCache();
  // A lakehouse the studio doesn't delete (for example one used in place in another workspace) keeps no shortcut to
  // the planning warehouse that goes now – in both clean-up paths.
  const pt = p.planning?.target?.kind === 'Lakehouse' ? p.planning.target : p.planStore?.shortcut ? p.planStore : null;
  if (p.workspace && pt?.shortcut && pt.lakehouse && pt.lakehouse.id !== p.lakehouse?.id) {
    try { await F.fabric('DELETE', `/workspaces/${pt.lakehouse.workspaceId}/items/${pt.lakehouse.id}/shortcuts/${pt.shortcut.path}/${pt.shortcut.name}`); ctx.log(`Deleted the plan shortcut in ${pt.lakehouse.name}`); } catch (e) { if (e.status !== 404) ctx.log(`Could not delete the plan shortcut in ${pt.lakehouse.name}: ${e.message}`); }
  }
  if (deleteWorkspace && p.workspace?.created) {
    stopSimulator('clean up');
    ctx.step(`Delete workspace ${p.workspace.name}`);
    await F.deleteWorkspace(p.workspace.id);
    // Everything lived in that workspace; keep only the glossary for the next project.
    updateProject({ workspace: null, lakehouse: null, sqlDatabase: null, source: null, modelSource: null, modelProposal: null, reportProposal: null, dataAgentProposal: null, dataAgent: null, semanticModel: null, ontology: null, reports: [], orgApp: null, teamsAgent: null, scenario: null, realtime: null, planning: null, taskFlow: null, semanticModels: [], planStore: null, dataPrep: null, dataPrepItems: [], tenant: null, steps: {} });
    clearDataPrepFiles();
  } else if (p.workspace) {
    ctx.step('Delete items created by the studio');
    stopSimulator('clean up');
    const tf = p.realtime?.medallion?.taskFlow;
    if (tf?.id) {
      try { ctx.log((await deleteTaskFlow(p.workspace.id, tf.id)) ? `Deleted task flow "${tf.name}"` : `Task flow "${tf.name}" was already deleted`); } catch (e) { ctx.log(`Could not delete task flow "${tf.name}": ${e.message}`); }
    }
    const mf = p.taskFlow;
    if (mf?.id) {
      try { ctx.log(await WTF.teardownTaskFlow()); } catch (e) { ctx.log(`Could not ${mf.mode === 'existing' ? 'take the studio\'s items off' : 'delete'} task flow "${mf.name}": ${e.message}`); }
    }
    for (const it of teardownItems(p)) {
      if (it.type === 'MirroredDatabase') { try { await F.stopMirroring(p.workspace.id, it.id); } catch { /* already stopped */ } }
      try { await F.deleteItem(p.workspace.id, it.id); ctx.log(`Deleted ${it.name} (${it.label.replace(/ \(.*\)$/, '')})`); } catch (e) { ctx.log(e.status === 404 ? `${it.name} was already deleted` : `Could not delete ${it.name}: ${e.message}`); }
      if (it.type === 'Ontology') await deleteOntologyCompanions(p.workspace.id, it.id, ctx.log);
    }
    // The project starts empty again: the workspace itself stays in Fabric, but the studio no longer points to it.
    updateProject({ workspace: null, lakehouse: null, sqlDatabase: null, source: null, modelSource: null, modelProposal: null, reportProposal: null, dataAgentProposal: null, dataAgent: null, semanticModel: null, ontology: null, reports: [], orgApp: null, teamsAgent: null, scenario: null, realtime: null, planning: null, taskFlow: null, semanticModels: [], planStore: null, dataPrep: null, dataPrepItems: [], tenant: null, steps: {} });
    clearDataPrepFiles();
    ctx.log(`The project is empty again – ${p.workspace.name} stays in Fabric; choose a workspace to start a new one`);
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
