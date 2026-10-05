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
  sourceKey: null,                // The active data source (sourceKeyOf): everything built from it is live in the project
  sources: [],                    // Every data source used in the workspace: [{ key, label, addedAt, savedAt, state }] – state holds what was built from an inactive source (null for the active one)
};

// ---- data sources: each source in the workspace keeps its own items; one is active at a time ----

// What belongs to one data source. When another source becomes active these are kept with the source they were built
// from and come back when it is active again; a source used for the first time starts with none of them.
export const SOURCE_KEYS = ['scenario', 'lakehouse', 'sqlDatabase', 'source', 'modelSource', 'modelProposal', 'reportProposal', 'dataAgentProposal', 'dataAgent', 'semanticModel', 'semanticModels', 'ontology', 'reports', 'orgApp', 'realtime', 'planning', 'planStore', 'dataPrep', 'glossary', 'teamsAgent', 'steps'];
// Steps that describe the workspace, not a data source.
const WORKSPACE_STEPS = ['workspace'];

/** A stable identity for a data source: the same source always gets the same key. */
export function sourceKeyOf(src) {
  if (!src) return null;
  const low = (x) => String(x ?? '').trim().toLowerCase();
  if (src.kind === 'sample') return `sample:${low(src.id)}`;
  if (src.method === 'mirror') return src.server ? `mirror:${low(src.type)}:${low(src.server)}:${low(src.port)}:${low(src.database)}` : `mirror:${low(src.type)}:conn:${low(src.connectionId)}:${low(src.database)}`;
  if (src.method === 'shortcut') return `shortcut:${low(src.workspaceId)}:${low(src.itemId)}`;
  if (src.method === 'in-place') return `in-place:${low(src.workspaceId)}:${low(src.itemId)}`;
  return `other:${low(src.itemId || src.label)}`;
}

const sourceSteps = (steps) => Object.fromEntries(Object.entries(steps || {}).filter(([k]) => !WORKSPACE_STEPS.includes(k)));
const workspaceSteps = (steps) => Object.fromEntries(Object.entries(steps || {}).filter(([k]) => WORKSPACE_STEPS.includes(k)));

/** What the project holds for its active data source. */
function pickState(p) {
  const st = Object.fromEntries(SOURCE_KEYS.map((k) => [k, structuredClone(p[k] ?? EMPTY[k])]));
  st.steps = sourceSteps(p.steps);
  return st;
}

/** True when a data source has anything worth keeping. */
function hasContent(st) {
  return Boolean(st && (st.source || st.modelSource || st.lakehouse || st.sqlDatabase || st.semanticModel || st.semanticModels?.length || st.ontology || st.reports?.length
    || st.orgApp || st.dataAgent || st.realtime || st.planning || st.planStore || st.dataPrep || st.teamsAgent));
}

/** A label for a data source the project knows. */
const labelOf = (st, fallback) => st?.source?.label || st?.modelSource?.itemName || fallback || 'Data source';

/** Every data source in the workspace, each as a project view (the active one is the project itself). */
export function contextViews(p = getProject()) {
  const views = [{ key: p.sourceKey || null, active: true, view: p }];
  for (const e of p.sources || []) {
    if (e.key === p.sourceKey || !e.state) continue;
    views.push({ key: e.key, active: false, label: e.label, view: { ...p, ...e.state, steps: { ...workspaceSteps(p.steps), ...(e.state.steps || {}) } } });
  }
  return views;
}

/** The data sources of the workspace with what was built from each (for the UI and Copilot). */
export function sourceContexts(p = getProject()) {
  const describe = (key, st, active, e) => {
    const models = st.semanticModels || [];
    return {
      key, active, label: labelOf(st, e?.label), kind: st.source?.kind || null, method: st.source?.method || null,
      itemType: st.source?.itemType || st.modelSource?.itemType || null, connected: Boolean(st.modelSource),
      data: st.modelSource ? { itemType: st.modelSource.itemType, name: st.modelSource.itemName } : null,
      models: models.map((m) => m.name), activeModel: st.semanticModel?.name || null,
      reports: (st.reports || []).length, ontology: st.ontology?.name || null, plan: st.planning?.planYear || null,
      realtime: Boolean(st.realtime?.eventhouse || st.realtime?.eventstream), dataAgent: Boolean(st.dataAgent), orgApp: Boolean(st.orgApp),
      addedAt: e?.addedAt || null, savedAt: active ? null : e?.savedAt || null,
    };
  };
  const list = [];
  let active = false;
  for (const e of p.sources || []) {
    if (e.state) list.push(describe(e.key, e.state, false, e));
    else if (e.key === p.sourceKey && !active) { list.push(describe(e.key, p, true, e)); active = true; }
  }
  if (!active && hasContent(pickState(p))) list.unshift(describe(p.sourceKey || 'none', p, true, null));
  return list;
}

/** Everything a data source holds, empty – for a source used for the first time in the workspace. */
function emptyState(p) {
  const st = Object.fromEntries(SOURCE_KEYS.map((k) => [k, structuredClone(EMPTY[k])]));
  // A glossary written for the business carries over; a sample's glossary belongs to the sample.
  st.glossary = p.source?.kind === 'sample' ? '' : p.glossary || '';
  return st;
}

/**
 * Make the data source `key` the active one. What the current source built is kept with it; what `key` built before
 * comes back (nothing, for a source used for the first time). A project without a data source yet adopts the new one
 * with what it already has (for example an existing semantic model added first). Nothing changes in Fabric.
 */
export function activateSource(key, { label } = {}) {
  const p = getProject();
  if (!key) throw new Error('No data source to switch to.');
  if (key === p.sourceKey) return { switched: false, key };
  const now = new Date().toISOString();
  const list = (p.sources || []).map((e) => ({ ...e }));
  const target = list.find((e) => e.key === key && e.state);
  const current = pickState(p);
  const curKey = p.sourceKey || (target && hasContent(current) ? 'none' : null);
  if (!curKey && !target) {
    // Nothing to keep apart: the new source starts from what the project has.
    if (!list.some((e) => e.key === key)) list.push({ key, label: label || 'Data source', addedAt: now, savedAt: null, state: null });
    updateProject({ sourceKey: key, sources: list });
    return { switched: true, key, restored: false, adopted: true };
  }
  if (curKey) {
    const i = list.findIndex((e) => e.key === curKey && !e.state);
    if (hasContent(current)) {
      const entry = { addedAt: now, ...(i >= 0 ? list[i] : { key: curKey }), label: curKey === 'none' ? 'Without a data source' : labelOf(current, list[i]?.label), savedAt: now, state: current };
      if (i >= 0) list[i] = entry; else list.push(entry);
    } else if (i >= 0) list.splice(i, 1);
  }
  const restored = target ? target.state : emptyState(p);
  if (target) { target.state = null; target.label = label || target.label; } else list.push({ key, label: label || 'Data source', addedAt: now, savedAt: null, state: null });
  updateProject({
    ...Object.fromEntries(SOURCE_KEYS.map((k) => [k, structuredClone(restored[k] ?? EMPTY[k])])),
    steps: { ...workspaceSteps(p.steps), ...(restored.steps || {}) },
    sourceKey: key, sources: list,
  });
  return { switched: true, key, restored: Boolean(target), previous: curKey };
}

/** Forget the active data source when nothing was built from it any more (after the data source was removed). */
export function dropEmptySource() {
  const p = getProject();
  if (!p.sourceKey || hasContent(pickState(p))) return false;
  updateProject({ sourceKey: null, sources: (p.sources || []).filter((e) => !(e.key === p.sourceKey && !e.state)) });
  return true;
}

/** A patch that empties every data source of the workspace (a new workspace, or after clean up). */
export function blankSourcesPatch() {
  return { ...Object.fromEntries(SOURCE_KEYS.map((k) => [k, structuredClone(EMPTY[k])])), sourceKey: null, sources: [], taskFlow: null, dataPrepItems: [] };
}

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
  // Projects from before data sources kept their own items: what the project has belongs to its current source –
  // except models (and what is built on them) that recorded another source: they go back to that source.
  if (!Array.isArray(p.sources)) p.sources = [];
  if (!p.sourceKey && p.source) {
    p.sourceKey = sourceKeyOf(p.source);
    splitEarlierSources(p);
  }
  if (p.sourceKey && !p.sources.some((e) => e.key === p.sourceKey && !e.state)) p.sources.push({ key: p.sourceKey, label: p.source?.label || null, addedAt: p.createdAt || null, savedAt: null, state: null });
  return p;
}

/** The data source a studio item that once held the data stands for (older projects recorded only its id). */
function earlierSource(p, itemId) {
  const ws = p.workspace?.id || null;
  if (p.sqlDatabase?.id === itemId) {
    // The studio creates a SQL database only for the AdventureWorksDW2022 sample. Its SQL endpoint is found again on switching.
    return {
      source: { kind: 'sample', id: 'adventureworks-dw', label: 'AdventureWorksDW2022 (Fabric SQL database)', method: 'sql-database', itemId, tables: [] },
      modelSource: { itemType: 'SQLDatabase', itemId, itemName: p.sqlDatabase.name, workspaceId: ws },
      scenario: 'sample', sqlDatabase: p.sqlDatabase, lakehouse: null,
    };
  }
  const lh = p.lakehouse?.id === itemId ? { id: itemId, name: p.lakehouse.name, server: p.lakehouse.sqlEndpointServer, endpointId: p.lakehouse.sqlEndpointId }
    : (p.dataPrepItems || []).filter((x) => x.type === 'Lakehouse' && x.id === itemId).map((x) => ({ id: x.id, name: x.name, workspaceId: x.workspaceId }))[0];
  if (!lh) return null;
  return {
    source: { kind: 'fabric', type: 'Lakehouse', itemType: 'Lakehouse', itemName: lh.name, label: `Lakehouse · ${lh.name}`, method: 'in-place', itemId, workspaceId: lh.workspaceId || ws },
    modelSource: { itemType: 'Lakehouse', itemId, itemName: lh.name, workspaceId: lh.workspaceId || ws, ...(lh.server ? { server: lh.server, endpointId: lh.endpointId, database: lh.name } : {}) },
    scenario: 'byod', sqlDatabase: null, lakehouse: p.lakehouse?.id === itemId ? p.lakehouse : null,
  };
}

/**
 * Before data sources kept their own items, choosing another source left the models built on the previous one in the
 * project. Each studio model records the item it reads (sourceItemId): models (with their reports, data agent, org
 * app, plan and ontology) that read another studio item go back to the data source that item stands for.
 */
function splitEarlierSources(p) {
  const ms = p.modelSource;
  if (!ms?.itemId) return;
  const groups = new Map();
  for (const m of p.semanticModels || []) {
    if (m.origin === 'existing' || !m.sourceItemId || m.sourceItemId === ms.itemId) continue;
    if (!groups.has(m.sourceItemId)) groups.set(m.sourceItemId, []);
    groups.get(m.sourceItemId).push(m);
  }
  for (const [itemId, models] of groups) {
    const e = earlierSource(p, itemId);
    if (!e) continue;
    const key = sourceKeyOf(e.source);
    if (!key || key === p.sourceKey || p.sources.some((x) => x.key === key)) continue;
    const ids = new Set(models.map((m) => m.id));
    const ctxOf = (m) => (m.id === p.semanticModel?.id ? Object.fromEntries(MODEL_CONTEXT_KEYS.map((k) => [k, p[k] ?? null])) : m.context || {});
    // The model that is active there, with its data agent, org app and suggestions live.
    const lead = models.find((m) => m.id === p.semanticModel?.id) || models[0];
    const leadCtx = ctxOf(lead);
    const st = Object.fromEntries(SOURCE_KEYS.map((k) => [k, structuredClone(EMPTY[k])]));
    Object.assign(st, {
      scenario: e.scenario, source: e.source, modelSource: e.modelSource, sqlDatabase: e.sqlDatabase, lakehouse: e.lakehouse,
      semanticModels: models.map((m) => ({ ...m, context: m.id === lead.id ? null : ctxOf(m) })),
      semanticModel: plain(lead),
      ...Object.fromEntries(MODEL_CONTEXT_KEYS.map((k) => [k, leadCtx[k] ?? null])),
      reports: (p.reports || []).filter((r) => ids.has(r.semanticModelId)),
      ontology: p.ontology?.sourceItemId === itemId ? p.ontology : null,
      planning: ids.has(p.planning?.semanticModelId) ? p.planning : null,
      planStore: ids.has(p.planning?.semanticModelId) ? p.planStore : null,
      glossary: p.glossary || '',
      steps: Object.fromEntries(Object.entries(p.steps || {}).filter(([k]) => ['model', 'reports', 'ontology', 'planning', 'apps'].includes(k))),
    });
    st.steps.data = { status: 'done', note: `${e.source.label} (earlier data source)`, at: p.steps?.data?.at || null };
    // What stays with the current source.
    const rest = (p.semanticModels || []).filter((m) => !ids.has(m.id));
    if (ids.has(p.semanticModel?.id)) {
      const next = rest[0] || null;
      for (const k of MODEL_CONTEXT_KEYS) p[k] = next?.context?.[k] ?? null;
      p.semanticModel = next ? plain(next) : null;
      p.semanticModels = rest.map((m) => (m.id === next?.id ? { ...m, context: null } : m));
    } else p.semanticModels = rest;
    p.reports = (p.reports || []).filter((r) => !ids.has(r.semanticModelId));
    if (st.ontology) p.ontology = null;
    if (st.planning) { p.planning = null; p.planStore = null; }
    if (st.sqlDatabase && p.sqlDatabase?.id === st.sqlDatabase.id) p.sqlDatabase = null;
    if (st.lakehouse && p.lakehouse?.id === st.lakehouse.id) p.lakehouse = null;
    const steps = { ...(p.steps || {}) };
    if (!p.semanticModel) delete steps.model;
    if (!(p.reports || []).length) delete steps.reports;
    if (!p.ontology) delete steps.ontology;
    if (!p.planning) delete steps.planning;
    p.steps = steps;
    p.sources.push({ key, label: e.source.label, addedAt: p.createdAt || null, savedAt: new Date().toISOString(), state: st });
  }
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
  // The active source's key follows its details (a loader that switched to it first finds the same key here).
  if (patch.source && !has(patch, 'sourceKey')) {
    const key = sourceKeyOf(patch.source);
    if (key !== p.sourceKey) {
      const list = (p.sources || []).map((e) => ({ ...e }));
      const mine = list.find((e) => e.key === p.sourceKey && !e.state);
      if (mine) mine.key = key; else list.push({ key, label: patch.source.label || null, addedAt: new Date().toISOString(), savedAt: null, state: null });
      p.sourceKey = key;
      p.sources = list;
    }
    const mine = (p.sources || []).find((e) => e.key === p.sourceKey && !e.state);
    if (mine && patch.source.label) mine.label = patch.source.label;
  }
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
