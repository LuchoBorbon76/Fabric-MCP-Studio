// The project's semantic models: the ones the studio built and existing models the user adds (from any workspace they
// can read). One model is active at a time – reports, the data agent, the org app, Copilot's answers and suggestions
// work on it. Switching changes nothing in Fabric.
import * as F from './fabric.mjs';
import { getProject, updateProject, setStep, logActivity, assertProjectTenant, projectModels, modelContext, fabricUrl } from './project.mjs';
import { modelMetadata, modelStorageMode } from './powerbi.mjs';
import { resetProfileCache } from './reports/index.mjs';

const STORAGE = { DirectLake: 'Direct Lake', Import: 'Import', DirectQuery: 'DirectQuery', Dual: 'Dual', Mixed: 'Mixed' };
export const storageLabel = (m) => STORAGE[m] || null;

/** What the UI and Copilot need: every model with what is built on it, the active one first. */
export function modelsState() {
  const p = getProject();
  const models = projectModels(p).map((m) => {
    const c = modelContext(p, m.id);
    const reports = (p.reports || []).filter((r) => (r.semanticModelId || p.semanticModel?.id) === m.id);
    // Reports and data agents found in Fabric that the studio didn't build: shown, never changed or deleted.
    const linked = m.linked || null;
    const theirReports = (linked?.reports || []).filter((r) => !reports.some((x) => x.id === r.id));
    const theirAgents = (linked?.agents || []).filter((a) => a.id !== c.dataAgent?.id);
    return {
      id: m.id, name: m.name, active: m.id === p.semanticModel?.id, origin: m.origin || 'studio',
      workspaceId: m.workspaceId || p.workspace?.id || null, workspaceName: m.workspaceName || (m.workspaceId && m.workspaceId !== p.workspace?.id ? null : p.workspace?.name) || null,
      inProjectWorkspace: !m.workspaceId || m.workspaceId === p.workspace?.id,
      tables: m.tables ?? null, measures: m.measures ?? null, relationships: m.relationships ?? null,
      storageMode: m.storageMode || null, storage: storageLabel(m.storageMode),
      builtOnProjectData: Boolean(m.sourceItemId && m.sourceItemId === p.modelSource?.itemId),
      url: fabricUrl('SemanticModel', m.workspaceId || p.workspace?.id, m.id),
      reports: [...reports.map((r) => ({ id: r.id, name: r.name })), ...theirReports.map((r) => ({ id: r.id, name: r.name, url: r.url, existing: true }))],
      dataAgent: c.dataAgent ? { id: c.dataAgent.id, name: c.dataAgent.name } : null,
      existingAgents: theirAgents.map((a) => ({ id: a.id, name: a.name, url: a.url, published: Boolean(a.published) })),
      reads: (linked?.sources || []).map((s) => ({ id: s.id, name: s.name, type: s.type })),
      linkedAt: linked?.at || null,
      orgApp: c.orgApp ? { id: c.orgApp.id, name: c.orgApp.name } : null,
      plan: p.planning?.semanticModelId === m.id ? { planYear: p.planning.planYear } : null,
      addedAt: m.addedAt || null,
    };
  });
  return { active: p.semanticModel?.id || null, models };
}

/** Semantic models in a workspace (the project workspace by default), with the ones already in the project marked. */
export async function availableModels(workspaceId) {
  await assertProjectTenant();
  const p = getProject();
  const ws = workspaceId || p.workspace?.id;
  if (!ws) throw new Error('Select a workspace first.');
  const inProject = new Set((p.semanticModels || []).map((m) => m.id));
  const items = await F.listItems(ws);
  // A lakehouse, warehouse or SQL endpoint may have a default semantic model with its own name: listed last, marked.
  const stores = new Set(items.filter((i) => ['Lakehouse', 'Warehouse', 'SQLEndpoint', 'MirroredDatabase', 'SQLDatabase', 'MirroredWarehouse'].includes(i.type)).map((i) => i.displayName.toLowerCase()));
  return {
    workspaceId: ws,
    models: items.filter((i) => i.type === 'SemanticModel')
      .map((i) => ({ id: i.id, name: i.displayName, description: i.description || '', inProject: inProject.has(i.id), isDefault: stores.has(i.displayName.toLowerCase()) }))
      .sort((a, b) => Number(a.isDefault) - Number(b.isDefault) || a.name.localeCompare(b.name)),
  };
}

/** Make a model of the project the active one (nothing changes in Fabric). */
export async function useModel(id) {
  const p = getProject();
  const m = (p.semanticModels || []).find((x) => x.id === id);
  if (!m) throw Object.assign(new Error('That semantic model isn\'t in the project. Add it first.'), { status: 404 });
  if (p.semanticModel?.id === id) return modelsState();
  updateProject({ semanticModel: m });
  resetProfileCache();
  setStep('model', 'done', m.name);
  logActivity('model.switch', `Active semantic model: ${m.name}`, { semanticModelId: id });
  return modelsState();
}

/**
 * Add an existing semantic model (any workspace the user can read) to the project and make it active. The studio reads
 * its tables, measures and relationships through DAX (INFO.VIEW), so read and build permission is enough.
 */
export async function addExistingModel({ workspaceId, id } = {}) {
  await assertProjectTenant();
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  if (!id) throw Object.assign(new Error('Choose a semantic model.'), { status: 400 });
  const known = (p.semanticModels || []).find((x) => x.id === id);
  if (known) return useModel(id);
  const ws = workspaceId || p.workspace.id;
  let item;
  try { item = await F.getItem(ws, id); } catch (e) { throw new Error(`The semantic model couldn't be read in that workspace (${e.message.split('\n')[0].slice(0, 160)}).`); }
  if (item?.type && item.type !== 'SemanticModel') throw new Error(`"${item.displayName}" is a ${item.type}, not a semantic model.`);
  let meta = null;
  let warning = null;
  try { meta = await modelMetadata(ws, id); } catch (e) {
    warning = `The studio couldn't read the model's tables and measures (${e.message.split('\n')[0].slice(0, 200)}). Reports, the data agent and Copilot answers need Build permission on the model and a running capacity.`;
  }
  const storageMode = meta ? await modelStorageMode(ws, id) : null;
  const wsName = ws === p.workspace.id ? p.workspace.name : await F.getWorkspace(ws).then((w) => w.displayName).catch(() => null);
  updateProject({
    semanticModel: {
      id, name: item.displayName, workspaceId: ws, workspaceName: wsName, origin: 'existing', storageMode,
      tables: meta ? meta.tables.length : null, measures: meta ? meta.measures.length : null, relationships: meta ? meta.relationships.length : null, sourceItemId: null,
    },
  });
  resetProfileCache();
  setStep('model', 'done', item.displayName);
  logActivity('model.add', `Added the existing semantic model ${item.displayName}${wsName && ws !== p.workspace.id ? ` (${wsName})` : ''} to the project`, { semanticModelId: id, workspaceId: ws });
  return { ...modelsState(), added: id, warning };
}

/** Read a model's counts again (after it changed in Fabric). */
export async function refreshModelInfo(id) {
  await assertProjectTenant();
  const p = getProject();
  const m = (p.semanticModels || []).find((x) => x.id === (id || p.semanticModel?.id));
  if (!m) throw Object.assign(new Error('That semantic model isn\'t in the project.'), { status: 404 });
  const ws = m.workspaceId || p.workspace?.id;
  const meta = await modelMetadata(ws, m.id);
  const storageMode = m.origin === 'existing' ? await modelStorageMode(ws, m.id) || m.storageMode : m.storageMode;
  const patch = { tables: meta.tables.length, measures: meta.measures.length, relationships: meta.relationships.length, storageMode };
  if (m.id === p.semanticModel?.id) updateProject({ semanticModel: { ...m, ...patch } });
  else updateProject({ semanticModels: p.semanticModels.map((x) => (x.id === m.id ? { ...x, ...patch } : x)) });
  resetProfileCache();
  return modelsState();
}
