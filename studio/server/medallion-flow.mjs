// Fabric's predesigned Medallion task flow applied to what the project already has: the workspace gets a task flow
// with Bronze, Silver and Gold layers (plus processing, analytics and sharing tasks) and the project's items assigned
// to them, so the workspace list shows how the data flows. Only items in the project workspace can be assigned (a task
// flow belongs to one workspace). The live events have their own "Event medallion" flow on the Real-time page.
import { stableUuid } from './config.mjs';
import * as TF from './taskflow.mjs';
import { getProject, updateProject, logActivity, assertProjectTenant } from './project.mjs';
import { standardName } from './naming.mjs';

export const taskFlowUrl = (ws) => `https://app.fabric.microsoft.com/groups/${ws}/list?experience=fabric-developer`;

// Jobs after which the task flow (when it exists) is updated with the new items.
export const SYNC_KINDS = new Set(['sample', 'mirror', 'shortcut', 'data-prep', 'semantic-model', 'ontology', 'report', 'report-template', 'org-app', 'data-agent', 'planning', 'plan-item', 'remove']);

const METHOD = { files: 'loaded from files', 'sql-database': 'created as a Fabric SQL database', mirror: 'mirrored from your database', shortcuts: 'OneLake shortcuts to your Fabric data', 'in-place': 'used in place' };

/**
 * The layers and the items in each, from the project. Tasks follow Fabric's Medallion template:
 * Data ingest → Bronze data → Initial process → Silver data → Further transform → Gold data → Visualize / Business
 * context / Plan → Distribute.
 */
export function medallionLayers(p = getProject()) {
  const ws = p.workspace?.id;
  const ms = p.modelSource;
  const src = p.source;
  const inWs = (wsId) => !wsId || wsId === ws;
  const one = (type, it, wsId) => (it?.id && inWs(wsId) ? [{ type, id: it.id, name: it.name || it.displayName || it.itemName }] : []);
  const prep = (p.dataPrepItems || []).filter((x) => inWs(x.workspaceId));
  const curatedIds = new Set(prep.filter((x) => x.type === 'Lakehouse').map((x) => x.id));
  const sourceIsCurated = ms && curatedIds.has(ms.itemId);

  // Bronze: the data as it lands in Fabric (the project lakehouse, the SQL database, the mirrored database or the item
  // used in place). A curated lakehouse used as the model source stays in Silver. An item goes in one task only.
  const seen = new Set();
  const put = (list, items) => { for (const i of items) if (i.id && !seen.has(i.id)) { seen.add(i.id); list.push(i); } };
  const bronze = [];
  put(bronze, one('Lakehouse', p.lakehouse));
  put(bronze, one('SQLDatabase', p.sqlDatabase));
  if (ms && !sourceIsCurated && ['Lakehouse', 'Warehouse', 'MirroredDatabase', 'SQLDatabase'].includes(ms.itemType)) put(bronze, one(ms.itemType, { id: ms.itemId, name: ms.itemName }, ms.workspaceId));
  const process = []; put(process, prep.filter((x) => x.type === 'Notebook').map((x) => ({ type: 'Notebook', id: x.id, name: x.name })));
  const silver = []; put(silver, prep.filter((x) => x.type === 'Lakehouse').map((x) => ({ type: 'Lakehouse', id: x.id, name: x.name })));
  const gold = [];
  put(gold, one('SemanticModel', p.semanticModel));
  put(gold, one('Warehouse', p.planning?.target?.warehouse));
  const context = []; put(context, [...one('Ontology', p.ontology), ...one('DataAgent', p.dataAgent)]);
  const visualize = []; put(visualize, (p.reports || []).map((r) => ({ type: 'Report', id: r.id, name: r.name })));
  const plan = []; put(plan, one('Plan', p.planning?.planItem));
  const distribute = []; put(distribute, one('OrgApp', p.orgApp));

  const how = src?.method ? METHOD[src.method] || src.method : null;
  return [
    { key: 'ingest', name: 'Data ingest', type: src?.method === 'mirror' ? 'mirror data' : 'get data', x: 0, y: 80, items: [],
      description: how ? `${src.label || 'The data source'}: ${how}.` : 'Bring data in: sample data, mirroring, shortcuts or your own pipelines and dataflows.' },
    { key: 'bronze', name: 'Bronze data', type: 'store data', x: 360, y: 80, items: bronze,
      description: 'Raw data as it lands in Fabric, kept as it is so it can be reprocessed.' },
    { key: 'process', name: 'Initial process', type: 'prepare data', x: 720, y: 80, items: process,
      description: process.length ? 'The data prep notebook: business names, data fixes, keys and relationships, measures and charts.' : 'Clean and validate the Bronze data – for a lakehouse, run the data prep notebook on the Data page.' },
    { key: 'silver', name: 'Silver data', type: 'store data', x: 1080, y: 80, items: silver,
      description: silver.length ? 'Curated tables: cleaned, renamed and checked.' : 'Curated tables appear here once the data prep notebook has run; until then the model reads Bronze.' },
    { key: 'transform', name: 'Further transform', type: 'prepare data', x: 1440, y: 80, items: [],
      description: 'Optional: notebooks, dataflows or materialized lake views that aggregate Silver into Gold tables.' },
    { key: 'gold', name: 'Gold data', type: 'store data', x: 1800, y: 80, items: gold,
      description: gold.length ? `Business-ready data: the semantic model with governed measures (one version of every number)${gold.some((i) => i.type === 'Warehouse') ? ', and the plan values' : ''}.` : 'Business-ready data: create the semantic model to fill this layer.' },
    { key: 'visualize', name: 'Visualize', type: 'visualize', x: 2160, y: 80, items: visualize,
      description: 'Power BI reports on the Gold layer.' },
    { key: 'distribute', name: 'Distribute', type: 'distribute data', x: 2520, y: 80, items: distribute,
      description: 'The org app that shares the reports with the organization.' },
    { key: 'context', name: 'Business context and AI', type: 'analyze and train data', x: 2160, y: 300, items: context,
      description: 'The ontology (entities, relationships and business rules) and the Fabric data agent that answer from the Gold layer.' },
    { key: 'plan', name: 'Plan and forecast', type: 'track data', x: 2160, y: 520, items: plan,
      description: 'The Fabric plan where planners refine the budget and forecast in planning sheets.' },
  ];
}

const EDGES = [['ingest', 'bronze'], ['bronze', 'process'], ['process', 'silver'], ['silver', 'transform'], ['transform', 'gold'], ['gold', 'visualize'], ['visualize', 'distribute'], ['gold', 'context'], ['gold', 'plan']];

/** What the Workspace page shows: the layers with their items, and whether the task flow exists and is up to date. */
export function medallionFlowState() {
  const p = getProject();
  if (!p.workspace) return { available: false, reason: 'Select a workspace first.', layers: [], flow: null };
  const layers = medallionLayers(p).map((l) => ({ key: l.key, name: l.name, type: l.type, description: l.description, items: l.items.map((i) => ({ type: i.type, name: i.name, id: i.id })) }));
  const ids = layers.flatMap((l) => l.items.map((i) => i.id)).sort();
  const flow = p.medallionFlow ? { ...p.medallionFlow, url: taskFlowUrl(p.workspace.id) } : null;
  const synced = (flow?.itemIds || []).slice().sort();
  return {
    available: ids.length > 0,
    reason: ids.length ? null : 'Add data first – the task flow organizes the items the studio creates.',
    name: flow?.name || standardName('TaskFlow', 'Medallion', p),
    layers,
    flow,
    upToDate: Boolean(flow) && ids.length === synced.length && ids.every((x, i) => x === synced[i]),
  };
}

/** Create or update the Medallion task flow in the project workspace. */
// Creating, syncing and deleting the task flow run one at a time, so a background sync can't bring back a task flow
// that was just removed (or overwrite a newer one).
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

export function runMedallionTaskFlow(ctx) { return serial(() => applyTaskFlow(ctx)); }

async function applyTaskFlow(ctx) {
  await assertProjectTenant();
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  const layers = medallionLayers(p);
  const count = layers.reduce((a, l) => a + l.items.length, 0);
  if (!count) throw new Error('Add data first – the task flow organizes the items the studio creates.');
  ctx.step('Map the project\'s items to the Medallion layers');
  for (const l of layers) ctx.log(`${l.name}: ${l.items.length ? l.items.map((i) => i.name).join(', ') : '–'}`);
  ctx.progress(30);
  const name = p.medallionFlow?.name || standardName('TaskFlow', 'Medallion', p);
  ctx.step(`${p.medallionFlow?.id ? 'Update' : 'Create'} the task flow "${name}"`);
  const flow = await TF.buildTaskFlow({
    name,
    description: 'Medallion architecture (Bronze, Silver, Gold) for the project\'s data, built by Fabric MCP Studio on Fabric\'s predesigned Medallion task flow. Each task shows the items of that layer.',
    tasks: layers, edges: EDGES,
  }, { idOf: (...k) => stableUuid('medallion-flow', p.workspace.id, ...k), workspaceId: p.workspace.id });
  const saved = await TF.saveTaskFlow(p.workspace.id, flow, { id: p.medallionFlow?.id });
  const itemIds = layers.flatMap((l) => l.items.map((i) => i.id));
  const medallionFlow = { id: saved.id, name, tasks: flow.tasks.length, items: itemIds.length, itemIds, syncedAt: new Date().toISOString() };
  updateProject({ medallionFlow });
  ctx.log(`Task flow "${name}" ${saved.created ? 'created' : 'updated'}: ${flow.tasks.length} tasks, ${itemIds.length} items assigned`);
  logActivity('taskflow.medallion', `Medallion task flow "${name}" ${saved.created ? 'created' : 'updated'} (${itemIds.length} items)`, { taskFlowId: saved.id });
  ctx.progress(95);
  return { ...medallionFlow, url: taskFlowUrl(p.workspace.id) };
}

/** Keep the task flow in step with new items (quietly; only when it exists). */
export function syncMedallionTaskFlow() {
  return serial(async () => {
    // Checked when its turn comes: the task flow may have been removed in the meantime.
    const p = getProject();
    if (!p.workspace || !p.medallionFlow?.id) return null;
    if (medallionFlowState().upToDate) return null;
    return applyTaskFlow({ step() {}, log() {}, progress() {} }).catch(() => null);
  });
}

/** Delete the task flow (the items stay). */
export function removeMedallionTaskFlow() {
  return serial(async () => {
    const p = getProject();
    if (p.workspace && p.medallionFlow?.id) await TF.deleteTaskFlow(p.workspace.id, p.medallionFlow.id);
    updateProject({ medallionFlow: null });
    return { ok: true };
  });
}
