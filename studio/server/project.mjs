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
  scenario: null,                 // sample | byod
  workspace: null,                // { id, name, capacityId, created }
  lakehouse: null,                // { id, name, sqlEndpointId, sqlEndpointServer }
  sqlDatabase: null,              // { id, name, server, database } – Fabric SQL database created by the studio (AdventureWorksDW2022 sample)
  source: null,                   // { kind, type, label, method, itemId, tables[] } + mirror: connectionId, connectionName, server, port, database; fabric: itemType, itemName, workspaceId
  modelSource: null,              // { itemType, itemId, itemName, workspaceId, server, endpointId, database, schema, tables[] }
  modelProposal: null,            // Copilot's suggested semantic model design, applied from the chat or the Semantic model tab
  semanticModel: null,            // { id, name }
  ontology: null,                 // { id, name }
  glossary: '',
  teamsAgent: null,
  steps: {},                      // stepId -> { status, at, note }
};

let project = null;
let activity = null;

export function getProject() {
  if (!project) project = { ...structuredClone(EMPTY), ...readJson(PROJECT_FILE, {}) };
  return project;
}

export function updateProject(patch, { silent = false } = {}) {
  const p = getProject();
  if (!p.id) { p.id = newId(); p.createdAt = new Date().toISOString(); }
  Object.assign(p, patch);
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
  }[type];
  return seg === undefined ? `${base}/list` : `${base}${seg}`;
}
