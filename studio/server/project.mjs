// Project state: what the customer selected and what the studio created. Persisted locally.
import { join } from 'node:path';
import { DATA_DIR, REPO_ROOT, readJson, writeJson, newId } from './config.mjs';
import { emit } from './events.mjs';
import { currentIdentity, whoAmI } from './auth.mjs';

const PROJECT_FILE = join(DATA_DIR, 'project.json');
const ACTIVITY_FILE = join(DATA_DIR, 'activity.json');
// Keep the repo's scripts (deploy-ontology.ps1, install-teams-agent.ps1, setup.ps1) in sync.
const DEMO_STATE_FILE = join(REPO_ROOT, 'config', 'demo.state.json');

const EMPTY = {
  id: null,
  name: 'My Fabric MCP project',
  createdAt: null,
  tenant: null,                   // { id, domain } – the Microsoft Entra tenant the project's workspace lives in
  naming: null,                   // Naming standard [Domain]_[Object]_[Purpose]_[Environment]: { domain, environment, intent, inferred } (naming.mjs)
  scenario: null,                 // sample | byod
  workspace: null,                // { id, name, capacityId, created }
  lakehouse: null,                // { id, name, sqlEndpointId, sqlEndpointServer }
  sqlDatabase: null,              // { id, name, server, database } – Fabric SQL database created by the studio (AdventureWorksDW2022 sample)
  source: null,                   // { kind, type, label, method, itemId, tables[] } + mirror: connectionId, connectionName, server, port, database; fabric: itemType, itemName, workspaceId
  modelSource: null,              // { itemType, itemId, itemName, workspaceId, server, endpointId, database, schema, tables[] }
  modelProposal: null,            // Copilot's suggested semantic model design, applied from the chat or the Semantic model tab
  reportProposal: null,           // Copilot's suggested report (name, theme, pages), applied from the chat or the Reports & apps tab
  dataAgentProposal: null,        // Copilot's suggested Fabric data agent (name, instructions), applied from the chat or the Ask & share tab
  dataAgent: null,                // Fabric data agent on the semantic model: { id, name, workspaceId, semanticModel, instructions, published }
  semanticModel: null,            // The active semantic model (one of semanticModels): { id, name, workspaceId, workspaceName, origin, tables, measures, relationships, sourceItemId, storageMode }
  semanticModels: [],             // Every semantic model in the project – built by the studio (origin 'studio') or an existing one added to it ('existing'). Inactive ones keep their own data agent, org app and suggestions in `context`.
  ontology: null,                 // { id, name }
  reports: [],                    // Power BI reports built by the studio: [{ id, name, theme, pages[], url, builtAt, preview }]
  orgApp: null,                   // Org app bundling the reports: { id, name, theme, reports[], url, builtAt }
  realtime: null,                 // Live data: { scenario, eventhouse, database, table, eventstream, dashboard } (no endpoint keys)
  planning: null,                 // Budget and forecast: { measure, dims, planYear, spec, totals, planItem } (Plan table in the model)
  taskFlow: null,                 // Workspace task flow the studio keeps in sync (workspace-taskflow.mjs): { mode, template, id, name, overrides, assigned, itemIds, syncedAt }
  planStore: null,                // For a lakehouse: the planning warehouse and the PlanValues shortcut, kept as soon as they exist
  dataPrep: null,                 // Data prep notebook for a lakehouse source: { source, target, notebook, lastRun }
  dataPrepItems: [],              // Every notebook and curated lakehouse the data prep job created: [{ type, id, name, workspaceId }]
  glossary: '',
  teamsAgent: null,
  steps: {},                      // stepId -> { status, at, note }
};

let project = null;
let activity = null;

export function getProject() {
  if (!project) project = migrate({ ...structuredClone(EMPTY), ...readJson(PROJECT_FILE, {}) });
  return project;
}

/** Projects saved by older versions: one semantic model, and the Medallion task flow under its own key. */
function migrate(p) {
  if (!Array.isArray(p.semanticModels)) p.semanticModels = [];
  if (p.semanticModel?.id) {
    p.semanticModel = { origin: 'studio', ...p.semanticModel, workspaceId: p.semanticModel.workspaceId || p.workspace?.id || null };
    if (!p.semanticModels.some((m) => m.id === p.semanticModel.id)) p.semanticModels.unshift({ ...p.semanticModel, workspaceName: p.semanticModel.workspaceName || p.workspace?.name || null, addedAt: p.createdAt || null });
  }
  if (p.medallionFlow?.id && !p.taskFlow) p.taskFlow = { mode: 'template', template: 'medallion', ...p.medallionFlow };
  delete p.medallionFlow;
  // The plan belongs to the model its Plan table was added to.
  if (p.planning && !p.planning.semanticModelId && p.semanticModel?.id) p.planning = { ...p.planning, semanticModelId: p.semanticModel.id };
  return p;
}

// ---- semantic models: the project can hold several; one is active at a time ----

// Things that belong to one semantic model: when another model becomes active they are kept with the model they were
// built for and come back when it is active again.
export const MODEL_CONTEXT_KEYS = ['dataAgent', 'dataAgentProposal', 'reportProposal', 'orgApp'];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plain = (m) => { if (!m) return m; const { context, ...rest } = m; return rest; };

/** The semantic models in the project, the active one first. */
export function projectModels(p = getProject()) {
  const list = p.semanticModels || [];
  return [...list.filter((m) => m.id === p.semanticModel?.id), ...list.filter((m) => m.id !== p.semanticModel?.id)];
}

/** The workspace a semantic model lives in (an existing model can be in another workspace than the project's). */
export const modelWorkspaceId = (p = getProject(), sm = p.semanticModel) => sm?.workspaceId || p.workspace?.id || null;

/** Data agent, org app and suggestions of a model: live values for the active model, the kept ones for the others. */
export function modelContext(p, modelId) {
  if (modelId && modelId === p.semanticModel?.id) return Object.fromEntries(MODEL_CONTEXT_KEYS.map((k) => [k, p[k] ?? null]));
  const m = (p.semanticModels || []).find((x) => x.id === modelId);
  return Object.fromEntries(MODEL_CONTEXT_KEYS.map((k) => [k, m?.context?.[k] ?? null]));
}

/** Change what a model keeps (for the active model: the project itself). */
export function updateModelContext(modelId, patch) {
  const p = getProject();
  if (modelId === p.semanticModel?.id) return updateProject(patch);
  const models = (p.semanticModels || []).map((m) => (m.id === modelId ? { ...m, context: { ...(m.context || {}), ...patch } } : m));
  return updateProject({ semanticModels: models });
}

/**
 * Keep semanticModels in step with a patch that sets semanticModel: a model object adds or updates it and makes it the
 * active one (the previous model keeps its data agent, org app and suggestions); null takes the active model out of the
 * project and makes the next one active. A patch that sets semanticModels itself (a reset) is left as it is.
 */
function syncModels(p, before, patch) {
  const list = (p.semanticModels || []).map((m) => ({ ...m }));
  const prevId = before.semanticModel?.id || null;
  const stash = () => {
    const prev = list.find((m) => m.id === prevId);
    if (prev) prev.context = Object.fromEntries(MODEL_CONTEXT_KEYS.map((k) => [k, before[k] ?? null]));
  };
  const activate = (entry, { patchWins }) => {
    if (entry.id !== prevId) {
      // Another model becomes active: bring back what it kept (a new model starts with nothing). When the model is
      // added or switched to, values the patch sets itself are for the new model; when the active model was taken out,
      // they were for the old one.
      for (const k of MODEL_CONTEXT_KEYS) p[k] = patchWins && has(patch, k) ? patch[k] : entry.context?.[k] ?? null;
    }
    entry.context = null;
    p.semanticModel = plain(entry);
  };
  const sm = patch.semanticModel;
  if (sm?.id) {
    const i = list.findIndex((m) => m.id === sm.id);
    const old = i >= 0 ? list[i] : null;
    const entry = {
      addedAt: new Date().toISOString(), ...(old || {}), ...plain(sm),
      origin: sm.origin || old?.origin || 'studio',
      workspaceId: sm.workspaceId || old?.workspaceId || p.workspace?.id || null,
      workspaceName: sm.workspaceName || old?.workspaceName || (sm.workspaceId && sm.workspaceId !== p.workspace?.id ? null : p.workspace?.name) || null,
      context: old?.context || null,
    };
    if (i >= 0) list[i] = entry; else list.push(entry);
    if (prevId && prevId !== entry.id) stash();
    activate(entry, { patchWins: true });
  } else {
    const rest = list.filter((m) => m.id !== prevId);
    list.length = 0;
    list.push(...rest);
    const next = list[0];
    if (next) activate(next, { patchWins: false }); else p.semanticModel = null;
  }
  p.semanticModels = list;
}

export function updateProject(patch, { silent = false } = {}) {
  const p = getProject();
  if (!p.id) { p.id = newId(); p.createdAt = new Date().toISOString(); }
  const before = has(patch, 'semanticModel') && !has(patch, 'semanticModels') ? { semanticModel: p.semanticModel, ...Object.fromEntries(MODEL_CONTEXT_KEYS.map((k) => [k, p[k]])) } : null;
  Object.assign(p, patch);
  if (before) syncModels(p, before, patch);
  if (patch.workspace && !p.tenant) {
    const me = currentIdentity();
    if (me?.tenantId) p.tenant = { id: me.tenantId, domain: me.tenantDomain || '' };
  }
  writeJson(PROJECT_FILE, p);
  syncDemoState(p);
  if (!silent) emit('project.updated', { project: p });
  return p;
}

/** The project belongs to a different tenant than the signed-in account (null when they match or are unknown). */
export function tenantMismatch() {
  const p = getProject();
  const me = currentIdentity();
  if (!p.tenant?.id || !me?.tenantId || p.tenant.id === me.tenantId) return null;
  return { project: p.tenant, current: { id: me.tenantId, domain: me.tenantDomain || '' } };
}

/** Throw TENANT_MISMATCH (409) when the signed-in account can't act on this project. Resolves the identity first. */
export async function assertProjectTenant() {
  if (getProject().tenant?.id && !currentIdentity()) await whoAmI();
  const m = tenantMismatch();
  if (!m) return;
  const err = new Error(`This project was built in tenant ${m.project.domain || m.project.id}, but you're signed in to ${m.current.domain || m.current.id}. Sign in to ${m.project.domain || m.project.id}, or select "Start a new project" to build in this tenant.`);
  err.code = 'TENANT_MISMATCH';
  err.status = 409;
  throw err;
}

export function setStep(stepId, status, note = '') {
  const p = getProject();
  return updateProject({ steps: { ...p.steps, [stepId]: { status, note, at: new Date().toISOString() } } });
}

export function resetProject() {
  project = structuredClone(EMPTY);
  writeJson(PROJECT_FILE, project);
  syncDemoState(project);
  emit('project.updated', { project });
  return project;
}

function syncDemoState(p) {
  const state = readJson(DEMO_STATE_FILE, {});
  const had = Object.keys(state).length;
  const clear = (...keys) => keys.forEach((k) => delete state[k]);
  if (p.workspace) {
    state.workspaceId = p.workspace.id;
    state.workspaceName = p.workspace.name;
    state.createdWorkspace = Boolean(p.workspace.created);
  } else clear('workspaceId', 'workspaceName', 'createdWorkspace');
  if (p.lakehouse) {
    state.lakehouseId = p.lakehouse.id;
    state.lakehouseName = p.lakehouse.name;
    if (p.lakehouse.sqlEndpointId) state.sqlEndpointId = p.lakehouse.sqlEndpointId;
    if (p.lakehouse.sqlEndpointServer) state.sqlEndpointServer = p.lakehouse.sqlEndpointServer;
  } else clear('lakehouseId', 'lakehouseName', 'sqlEndpointId', 'sqlEndpointServer');
  if (p.ontology) { state.ontologyId = p.ontology.id; state.ontologyName = p.ontology.name; } else clear('ontologyId', 'ontologyName');
  if (p.semanticModel) { state.semanticModelId = p.semanticModel.id; state.semanticModelName = p.semanticModel.name; } else clear('semanticModelId', 'semanticModelName');
  if (had || Object.keys(state).length) {
    try { writeJson(DEMO_STATE_FILE, state); } catch { /* repo may be read-only */ }
  }
}

// ---- activity: artifacts created + notable actions (audit trail) ----

function loadActivity() {
  if (!activity) activity = readJson(ACTIVITY_FILE, { artifacts: [], log: [] });
  return activity;
}

export function getActivity() { return loadActivity(); }

export function logActivity(kind, title, detail = {}) {
  const a = loadActivity();
  const entry = { id: newId(), at: new Date().toISOString(), kind, title, ...detail };
  a.log.unshift(entry);
  if (a.log.length > 1000) a.log.length = 1000;
  writeJson(ACTIVITY_FILE, a);
  emit('activity', { entry });
  return entry;
}

export function recordArtifact({ type, id, name, workspaceId, url, createdBy = 'studio', note = '' }) {
  const a = loadActivity();
  const existing = a.artifacts.find((x) => x.id === id);
  const art = { type, id, name, workspaceId, url: url || fabricUrl(type, workspaceId, id), createdBy, note, at: new Date().toISOString() };
  if (existing) Object.assign(existing, art); else a.artifacts.unshift(art);
  writeJson(ACTIVITY_FILE, a);
  emit('artifact', { artifact: art });
  return art;
}

export function clearActivity() {
  activity = { artifacts: [], log: [] };
  writeJson(ACTIVITY_FILE, activity);
}

export function fabricUrl(type, workspaceId, id) {
  if (!workspaceId) return '';
  const base = `https://app.fabric.microsoft.com/groups/${workspaceId}`;
  const seg = {
    Workspace: '',
    Lakehouse: `/lakehouses/${id}`,
    Warehouse: `/warehouses/${id}`,
    MirroredDatabase: `/mirroreddatabases/${id}`,
    SQLDatabase: `/sqldatabases/${id}`,
    SemanticModel: `/datasets/${id}/details`,
    Ontology: `/ontologies/${id}`,
    Report: `/reports/${id}`,
    DataAgent: `/aiskills/${id}`,
    Eventhouse: `/eventhouses/${id}`,
    KQLDatabase: `/databases/${id}`,
    Eventstream: `/eventstreams/${id}`,
    KQLDashboard: `/kustodashboards/${id}`,
    Reflex: `/reflexes/${id}`,
    Plan: `/plans/${id}`,
    KQLQueryset: `/queryworkbenches/${id}`,
    Notebook: `/synapsenotebooks/${id}`,
  }[type];
  return seg === undefined ? `${base}/list` : `${base}${seg}`;
}
