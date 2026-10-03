// End-to-end pipelines used by both the UI (quick actions) and the AI agent (studio_* tools).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, sleep, stableUuid, newId } from './config.mjs';
import * as F from './fabric.mjs';
import { getProject, updateProject, setStep, recordArtifact, logActivity, assertProjectTenant } from './project.mjs';
import { discoverSqlServer, testSqlServer, readOnlyQuery, withPool } from './sql.mjs';
import { discoverPostgres, testPostgres } from './pg.mjs';
import { sourceType } from './sources.mjs';
import { buildPlan, semanticModelFiles, ontologyFiles, defaultMeasures } from './generators/tmdl.mjs';
import { RETAIL, ADVENTUREWORKS, presetFor } from './presets.mjs';
import { AWDW, getKit, loadAdventureWorksDW, salesTotalsMatch } from './samples/adventureworks-dw.mjs';
import { resetProfileCache } from './reports/index.mjs';

const safeName = (s, fallback = 'Item') => (String(s || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_') || fallback).slice(0, 120);

// ---------------- workspace ----------------

export async function selectWorkspace({ workspaceId, name, capacityId, description }, log = () => {}) {
  await assertProjectTenant();
  let ws;
  let created = false;
  if (workspaceId) {
    ws = await F.getWorkspace(workspaceId);
  } else {
    if (!name) throw new Error('Workspace name is required.');
    ws = await F.findWorkspace(name);
    if (!ws) {
      if (!capacityId) throw new Error('Choose a Fabric capacity for the new workspace.');
      log(`Creating workspace "${name}"…`);
      ws = await F.createWorkspace({ name, capacityId, description: description || 'Created by Fabric MCP Studio.' });
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
  const reset = prev?.id !== ws.id ? { lakehouse: null, modelSource: null, semanticModel: null, ontology: null, source: null } : {};
  updateProject({ workspace, ...reset });
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

async function ensureProjectLakehouse(name, log) {
  const ws = requireWorkspace();
  const p = getProject();
  if (p.lakehouse?.id && (!name || p.lakehouse.name === name)) return p.lakehouse;
  const lhName = safeName(name || 'StudioLakehouse');
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
  ctx.step('Create the project lakehouse');
  const lh = await ensureProjectLakehouse(RETAIL.lakehouseName, ctx.log);
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
  const conn = await F.createCloudConnection({
    name: name || `${st.name} - ${server}/${database}`.slice(0, 200),
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
  if (!connectionId) throw new Error('A Fabric connection is required. Create one in the Data tab or pick an existing connection.');
  const mirrorType = (st.mirrorTypeByVersion && st.mirrorTypeByVersion[sqlVersionMajor]) || st.mirrorType;
  const itemName = safeName(name || `Mirror_${database}`);

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
  const lh = await ensureProjectLakehouse(getProject().lakehouse?.name || 'StudioLakehouse', ctx.log);
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
  if (!ms) throw new Error('No data source yet. Load sample data or connect your data first (Data tab).');
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
  if (relationships?.length) schema.relationships = relationships;
  const plan = buildPlan(schema, { include: include?.length ? include : preset?.include, names: { ...(preset?.names || {}), ...(names || {}) }, descriptions: descriptions || preset?.descriptions });
  if (!plan.tables.length) throw new Error('No tables found in the data source.');
  ctx.log(`${plan.tables.length} tables, ${plan.relationships.length} relationships`);
  ctx.progress(25);

  const m = modelMeasures(plan, preset, measures, useDefaults);
  const dateTable = preset?.dateTable && plan.tables.some((t) => t.name === preset.dateTable.table) ? preset.dateTable : null;
  const modelName = name || p.semanticModel?.name || preset?.semanticModelName || `${p.modelSource.itemName} Model`;

  ctx.step('Generate the Direct Lake model (TMDL)');
  const files = semanticModelFiles({ name: modelName, src: { server: p.modelSource.server, endpointId: p.modelSource.endpointId, itemName: p.modelSource.itemName }, plan, measures: m, dateTable });
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
  updateProject({
    semanticModel: { id: item.id, name: modelName, tables: plan.tables.length, measures: m.length, relationships: plan.relationships.length },
    ...(proposalId && proposal?.id === proposalId ? { modelProposal: { ...proposal, appliedAt: new Date().toISOString(), semanticModelId: item.id } } : {}),
  });
  setStep('model', 'done', modelName);
  return { id: item.id, name: modelName, tables: plan.tables.map((t) => t.name), measures: m.map((x) => x.name), relationships: plan.relationships.length };
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
  if (!p.modelSource) throw new Error('No data source yet. Load sample data or connect data first (Data tab).');
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
  const modelName = name || p.semanticModel?.name || preset?.semanticModelName || `${p.modelSource.itemName} Model`;
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
    updatesExisting: p.semanticModel?.name === modelName,
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
  const inc = include?.length ? include : preset?.ontology?.include || schema.tables.filter((t) => !exclude.has(t.name.toLowerCase())).map((t) => `${t.schema}.${t.name}`);
  const plan = buildPlan(schema, { include: inc, names: preset?.names, descriptions: preset?.descriptions });
  const ontName = F.itemName('Ontology', name || p.ontology?.name || preset?.ontologyName || `${p.modelSource.itemName}_Ontology`, 'Ontology');
  const presetRules = preset?.ontology?.rules || [];
  const ruleSet = rules?.length
    ? rules.map((r) => {
      const pr = presetRules.find((x) => x.name === r.name);
      return pr && !r.entities?.length ? { ...pr, ...r, entities: pr.entities, relationships: pr.relationships } : r;
    })
    : presetRules;
  ctx.progress(25);

  ctx.step('Generate the ontology (entities, relationships, rules)');
  const out = ontologyFiles({ name: ontName, src: { server: p.modelSource.server, endpointId: p.modelSource.endpointId }, plan, rules: ruleSet, entityNames: entityNames || preset?.ontology?.entityNames || {}, descriptions: descriptions || {} });
  ctx.log(`${Object.keys(out.entities).length} entities · ${out.relationships.length} relationships · ${out.rules.length} rules`);
  ctx.progress(45);

  ctx.step(`Deploy ontology "${ontName}"`);
  const definition = F.toParts(out.files);
  let item = await F.findItem(ws.id, 'Ontology', ontName);
  if (item) await F.updateDefinition(ws.id, item.id, definition);
  else {
    item = await F.createItem(ws.id, { name: ontName, type: 'Ontology', description: 'Business ontology generated by Fabric MCP Studio.', definition });
    recordArtifact({ type: 'Ontology', id: item.id, name: ontName, workspaceId: ws.id });
  }
  updateProject({ ontology: { id: item.id, name: ontName, entities: Object.values(out.entities), rules: out.rules, relationships: out.relationships.map((r) => r.label) } });
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
  ctx.step('Get the AdventureWorksDW install kit from Microsoft');
  const kit = await getKit(ctx.log, { signal: ctx.signal });
  ctx.progress(6);

  ctx.step(`Create the Fabric SQL database ${AWDW.databaseName}`);
  let db = await F.findItem(ws.id, 'SQLDatabase', AWDW.databaseName);
  if (!db) {
    db = await F.createSqlDatabase(ws.id, { name: AWDW.databaseName, description: 'AdventureWorksDW2022 sample created by Fabric MCP Studio.' });
    recordArtifact({ type: 'SQLDatabase', id: db.id, name: AWDW.databaseName, workspaceId: ws.id });
    ctx.log(`Created ${AWDW.databaseName}`);
  } else ctx.log(`Reusing ${AWDW.databaseName}`);
  const props = (await F.getSqlDatabase(ws.id, db.id))?.properties || {};
  if (!props.serverFqdn || !props.databaseName) throw new Error('The SQL database has no connection details yet. Try again in a minute.');
  updateProject({ sqlDatabase: { id: db.id, name: AWDW.databaseName, server: props.serverFqdn, database: props.databaseName } });
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
  setModelSource({ itemType: 'SQLDatabase', itemId: db.id, itemName: AWDW.databaseName, workspaceId: ws.id, server: ep.server, endpointId: ep.endpointId, database: ep.database }, 'AdventureWorksDW2022 loaded');
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

export async function runTeardown(ctx, { deleteWorkspace = false } = {}) {
  const p = getProject();
  if (deleteWorkspace && p.workspace?.created) {
    ctx.step(`Delete workspace ${p.workspace.name}`);
    await F.deleteWorkspace(p.workspace.id);
    // Everything lived in that workspace; keep only the glossary for the next project.
    updateProject({ workspace: null, lakehouse: null, sqlDatabase: null, source: null, modelSource: null, modelProposal: null, semanticModel: null, ontology: null, reports: [], teamsAgent: null, scenario: null, tenant: null, steps: {} });
  } else if (p.workspace) {
    ctx.step('Delete items created by the studio');
    for (const it of [...(p.reports || []), p.ontology, p.semanticModel].filter(Boolean)) {
      try { await F.deleteItem(p.workspace.id, it.id); ctx.log(`Deleted ${it.name}`); } catch (e) { ctx.log(`Could not delete ${it.name}: ${e.message}`); }
    }
    if (p.ontology?.id) {
      // An ontology provisions companion items named <ontology>_eh_<id> / <ontology>_graph_<id>.
      const suffix = p.ontology.id.replace(/-/g, '').toLowerCase();
      const order = { GraphModel: 0, KQLDatabase: 1, Eventhouse: 2 };
      try {
        const companions = (await F.listItems(p.workspace.id)).filter((i) => i.displayName.toLowerCase().endsWith(suffix) && i.type in order).sort((a, b) => order[a.type] - order[b.type]);
        for (const i of companions) {
          try { await F.deleteItem(p.workspace.id, i.id); ctx.log(`Deleted ${i.type} ${i.displayName}`); } catch (e) { if (e.status !== 404) ctx.log(`Could not delete ${i.displayName}: ${e.message}`); }
        }
      } catch (e) { ctx.log(`Could not list ontology companion items: ${e.message}`); }
    }
    if (p.source?.method === 'mirror' && p.modelSource?.itemId) {
      try { await F.stopMirroring(p.workspace.id, p.modelSource.itemId); } catch { /* ignore */ }
      try { await F.deleteItem(p.workspace.id, p.modelSource.itemId); ctx.log(`Deleted ${p.modelSource.itemName}`); } catch (e) { ctx.log(e.message); }
    }
    if (p.lakehouse?.id) {
      try { await F.deleteItem(p.workspace.id, p.lakehouse.id); ctx.log(`Deleted ${p.lakehouse.name}`); } catch (e) { ctx.log(e.message); }
    }
    if (p.sqlDatabase?.id) {
      try { await F.deleteItem(p.workspace.id, p.sqlDatabase.id); ctx.log(`Deleted SQL database ${p.sqlDatabase.name}`); } catch (e) { ctx.log(e.message); }
    }
    const keep = p.steps?.workspace;
    updateProject({ lakehouse: null, sqlDatabase: null, source: null, modelSource: null, modelProposal: null, semanticModel: null, ontology: null, reports: [], teamsAgent: null, scenario: null, steps: keep ? { workspace: keep } : {} });
  }
  return { ok: true };
}

export const ids = { stableUuid };
