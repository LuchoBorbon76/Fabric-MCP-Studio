// Workspace task flows: the visual flow above a workspace's item list. The user picks a flow – one of Fabric's
// predesigned flows (built by the studio as its own canvas) or a task flow that is already in the workspace – and the
// studio assigns every item it built to the right task ("box"), then keeps the assignments up to date as items are
// added or removed. In a task flow that was already in the workspace the studio only adds and removes its own
// assignments: the tasks, connectors, layout and the items people assigned stay as they are.
import { stableUuid } from './config.mjs';
import * as TF from './taskflow.mjs';
import { getProject, updateProject, logActivity, assertProjectTenant, projectModels, modelContext, contextViews } from './project.mjs';
import { standardName } from './naming.mjs';

export const taskFlowUrl = (ws) => `https://app.fabric.microsoft.com/groups/${ws}/list?experience=fabric-developer`;

// Jobs after which the task flow (when there is one) is updated with the new items.
export const SYNC_KINDS = new Set(['sample', 'mirror', 'shortcut', 'data-prep', 'semantic-model', 'ontology', 'report', 'report-template', 'org-app', 'data-agent', 'planning', 'plan-item', 'remove', 'realtime', 'realtime-dashboard', 'realtime-alerts', 'medallion', 'medallion-remove']);

// What an item does in the solution. A task accepts roles; an item goes to the first task (in flow order) that accepts
// its role, else the first that accepts the next role in its fallback chain.
const ROLE_LABEL = {
  ingest: 'Ingest', mirror: 'Mirrored data', stream: 'Live events ingest', raw: 'Raw data (as it lands)', events: 'Live events store',
  prep: 'Data preparation', eventPrep: 'Live events processing', curated: 'Curated data', eventCurated: 'Curated live events',
  serve: 'Business-ready data (semantic models)', eventServe: 'Live Gold data', visualize: 'Reports', eventVisualize: 'Real-time dashboards',
  distribute: 'Apps', ai: 'Business context and AI', track: 'Plans', alerts: 'Alerts',
};
const FALLBACK = {
  ingest: ['ingest', 'stream'], mirror: ['mirror', 'raw', 'ingest'], stream: ['stream', 'ingest'], raw: ['raw', 'events'], events: ['events', 'raw'],
  prep: ['prep', 'eventPrep'], eventPrep: ['eventPrep', 'prep'], curated: ['curated', 'raw'], eventCurated: ['eventCurated', 'curated', 'events'],
  serve: ['serve'], eventServe: ['eventServe', 'serve'], visualize: ['visualize', 'eventVisualize'], eventVisualize: ['eventVisualize', 'visualize'],
  distribute: ['distribute'], ai: ['ai'], track: ['track', 'alerts'], alerts: ['alerts', 'track'],
};

const T = (key, name, type, x, y, roles, description) => ({ key, name, type, x, y, roles, description });

/**
 * The studio's versions of Fabric's predesigned task flows (same task types and shape, with descriptions of what the
 * studio puts in each task). The Medallion flow keeps the task keys and layout of earlier versions, so a flow the
 * studio created before is updated in place.
 */
export const TEMPLATES = [
  {
    id: 'medallion', purpose: 'Medallion', name: 'Medallion',
    description: 'Bronze (data as it lands), Silver (curated) and Gold (business-ready) layers, with processing between them and reports, AI, plans and apps on the Gold layer.',
    tasks: [
      T('ingest', 'Data ingest', 'get data', 0, 80, ['ingest', 'stream'], 'Bring data in: sample data, mirroring, shortcuts, pipelines, dataflows or live events.'),
      T('bronze', 'Bronze data', 'store data', 360, 80, ['raw', 'mirror', 'events'], 'Raw data as it lands in Fabric, kept as it is so it can be reprocessed.'),
      T('process', 'Initial process', 'prepare data', 720, 80, ['prep', 'eventPrep'], 'Clean and validate the Bronze data: the data prep notebook (business names, data fixes, keys and relationships).'),
      T('silver', 'Silver data', 'store data', 1080, 80, ['curated', 'eventCurated'], 'Curated tables: cleaned, renamed and checked.'),
      T('transform', 'Further transform', 'prepare data', 1440, 80, [], 'Optional: notebooks, dataflows or materialized lake views that aggregate Silver into Gold tables.'),
      T('gold', 'Gold data', 'store data', 1800, 80, ['serve', 'eventServe'], 'Business-ready data: the semantic models with governed measures (one version of every number) and the plan values.'),
      T('visualize', 'Visualize', 'visualize', 2160, 80, ['visualize', 'eventVisualize'], 'Power BI reports and Real-Time Dashboards on the Gold layer.'),
      T('distribute', 'Distribute', 'distribute data', 2520, 80, ['distribute'], 'Org apps that share the reports with the organization.'),
      T('context', 'Business context and AI', 'analyze and train data', 2160, 300, ['ai'], 'The ontology (entities, relationships and business rules) and the Fabric data agents that answer from the Gold layer.'),
      T('plan', 'Plan and forecast', 'track data', 2160, 520, ['track', 'alerts'], 'Fabric plans where planners refine the budget and forecast, and Activator alerts.'),
    ],
    edges: [['ingest', 'bronze'], ['bronze', 'process'], ['process', 'silver'], ['silver', 'transform'], ['transform', 'gold'], ['gold', 'visualize'], ['visualize', 'distribute'], ['gold', 'context'], ['gold', 'plan']],
  },
  {
    id: 'basic', purpose: 'BasicAnalytics', name: 'Basic data analytics',
    description: 'Get, store and prepare the data, model it for business users, then visualize and share it. A good fit for a single source and a few reports.',
    tasks: [
      T('get', 'Get data', 'get data', 0, 80, ['ingest', 'stream'], 'Bring data into Fabric: sample data, mirroring, shortcuts, pipelines or live events.'),
      T('store', 'Store data', 'store data', 360, 80, ['raw', 'mirror', 'events', 'curated', 'eventCurated'], 'Lakehouses, warehouses and databases that hold the data.'),
      T('prepare', 'Prepare data', 'prepare data', 720, 80, ['prep', 'eventPrep'], 'Clean and shape the data: the data prep notebook and querysets.'),
      T('model', 'Semantic models', 'store data', 1080, 80, ['serve', 'eventServe'], 'Business-ready semantic models with governed measures, and the plan values.'),
      T('visualize', 'Visualize data', 'visualize', 1440, 80, ['visualize', 'eventVisualize'], 'Power BI reports and dashboards.'),
      T('distribute', 'Distribute data', 'distribute data', 1800, 80, ['distribute'], 'Org apps that share the reports.'),
      T('ai', 'Analyze with AI', 'analyze and train data', 1440, 300, ['ai'], 'The ontology and the Fabric data agents.'),
      T('track', 'Plan and track', 'track data', 1440, 520, ['track', 'alerts'], 'Fabric plans and Activator alerts.'),
    ],
    edges: [['get', 'store'], ['store', 'prepare'], ['prepare', 'model'], ['model', 'visualize'], ['visualize', 'distribute'], ['model', 'ai'], ['model', 'track']],
  },
  {
    id: 'event', purpose: 'EventAnalytics', name: 'Event analytics',
    description: 'Capture events as they happen, store and transform them, then watch them on dashboards and act on them with alerts. Batch data and semantic models join on the side.',
    tasks: [
      T('getEvents', 'Get events', 'get data', 0, 80, ['stream', 'ingest'], 'Live events from apps and devices through Eventstreams, and other data coming in.'),
      T('storeEvents', 'Store events', 'store data', 360, 80, ['events', 'raw', 'mirror'], 'The Eventhouse (KQL database) and the other stores.'),
      T('transform', 'Transform events', 'prepare data', 720, 80, ['eventPrep', 'prep'], 'Querysets, update policies and notebooks that clean and enrich the data.'),
      T('curated', 'Curated data', 'store data', 1080, 300, ['eventCurated', 'curated'], 'Cleaned events and curated tables, also in OneLake.'),
      T('visualize', 'Visualize', 'visualize', 1080, 80, ['eventVisualize', 'visualize'], 'Real-Time Dashboards and Power BI reports.'),
      T('act', 'Act on events', 'track data', 1440, 80, ['alerts', 'track'], 'Activator alerts on business-rule breaks, and plans.'),
      T('model', 'Semantic models', 'store data', 1440, 300, ['eventServe', 'serve'], 'Semantic models over the events and the business data.'),
      T('ai', 'Business context and AI', 'analyze and train data', 1800, 300, ['ai'], 'The ontology and the Fabric data agents.'),
      T('distribute', 'Distribute', 'distribute data', 1800, 80, ['distribute'], 'Org apps.'),
    ],
    edges: [['getEvents', 'storeEvents'], ['storeEvents', 'transform'], ['transform', 'visualize'], ['transform', 'curated'], ['visualize', 'act'], ['curated', 'model'], ['model', 'ai'], ['act', 'distribute']],
  },
  {
    id: 'eventMedallion', purpose: 'EventMedallion', name: 'Event medallion',
    description: 'The medallion pattern for live data: events land in Bronze, are checked and deduplicated into Silver and aggregated into Gold as they arrive.',
    tasks: [
      T('ingest', 'Events ingest', 'get data', 0, 80, ['stream', 'ingest'], 'Eventstreams and other incoming data.'),
      T('bronze', 'Bronze layer', 'store data', 360, 80, ['events', 'raw', 'mirror'], 'Raw events and data exactly as they arrive.'),
      T('toSilver', 'Bronze to Silver', 'prepare data', 720, 80, ['eventPrep', 'prep'], 'Checks, enrichment and deduplication (querysets, update policies, notebooks).'),
      T('silver', 'Silver layer', 'store data', 1080, 80, ['eventCurated', 'curated'], 'Checked, enriched and deduplicated data.'),
      T('toGold', 'Silver to Gold', 'prepare data', 1440, 80, [], 'Aggregations that build the Gold layer.'),
      T('gold', 'Gold layer', 'store data', 1800, 80, ['eventServe', 'serve'], 'Business-ready aggregates and semantic models.'),
      T('visualize', 'Visualize', 'visualize', 2160, 80, ['eventVisualize', 'visualize'], 'Real-Time Dashboards and Power BI reports.'),
      T('activate', 'Activate', 'track data', 1440, 300, ['alerts', 'track'], 'Activator alerts and plans.'),
      T('context', 'Business context and AI', 'analyze and train data', 1800, 300, ['ai'], 'The ontology and the Fabric data agents.'),
      T('distribute', 'Distribute', 'distribute data', 2520, 80, ['distribute'], 'Org apps.'),
    ],
    edges: [['ingest', 'bronze'], ['bronze', 'toSilver'], ['toSilver', 'silver'], ['silver', 'toGold'], ['toGold', 'gold'], ['gold', 'visualize'], ['visualize', 'distribute'], ['silver', 'activate'], ['gold', 'context']],
  },
  {
    id: 'lambda', purpose: 'Lambda', name: 'Lambda',
    description: 'A batch layer for complete, accurate history and a speed layer for live events, joined in one serving layer for reports, AI and alerts.',
    tasks: [
      T('batchIngest', 'Batch ingest', 'get data', 0, 0, ['ingest'], 'Sample data, mirroring, shortcuts, pipelines and dataflows.'),
      T('batchStore', 'Batch layer', 'store data', 360, 0, ['raw', 'mirror', 'curated'], 'Lakehouses, warehouses and databases with the complete history.'),
      T('batchProcess', 'Batch processing', 'prepare data', 720, 0, ['prep'], 'Notebooks that clean and shape the batch data.'),
      T('speedIngest', 'Speed ingest', 'get data', 0, 240, ['stream'], 'Eventstreams with live events.'),
      T('speedStore', 'Speed layer', 'store data', 360, 240, ['events', 'eventCurated'], 'The Eventhouse with the live events.'),
      T('speedProcess', 'Speed processing', 'prepare data', 720, 240, ['eventPrep'], 'Querysets and update policies over the live events.'),
      T('serve', 'Serving layer', 'store data', 1080, 120, ['serve', 'eventServe'], 'Semantic models that combine both layers, and the plan values.'),
      T('visualize', 'Visualize', 'visualize', 1440, 0, ['visualize', 'eventVisualize'], 'Power BI reports and Real-Time Dashboards.'),
      T('ai', 'Business context and AI', 'analyze and train data', 1440, 240, ['ai'], 'The ontology and the Fabric data agents.'),
      T('track', 'Act and plan', 'track data', 1440, 460, ['alerts', 'track'], 'Activator alerts and Fabric plans.'),
      T('distribute', 'Distribute', 'distribute data', 1800, 0, ['distribute'], 'Org apps.'),
    ],
    edges: [['batchIngest', 'batchStore'], ['batchStore', 'batchProcess'], ['batchProcess', 'serve'], ['speedIngest', 'speedStore'], ['speedStore', 'speedProcess'], ['speedProcess', 'serve'], ['serve', 'visualize'], ['visualize', 'distribute'], ['serve', 'ai'], ['serve', 'track']],
  },
  {
    id: 'ml', purpose: 'MachineLearning', name: 'Basic machine learning models',
    description: 'Prepare data, train and score models and AI, and serve the results to reports and apps.',
    tasks: [
      T('get', 'Get data', 'get data', 0, 80, ['ingest', 'stream'], 'Sample data, mirroring, shortcuts, pipelines or live events.'),
      T('store', 'Store data', 'store data', 360, 80, ['raw', 'mirror', 'events', 'curated', 'eventCurated'], 'Lakehouses, warehouses, databases and the Eventhouse.'),
      T('prepare', 'Prepare data', 'prepare data', 720, 80, ['prep', 'eventPrep'], 'Notebooks and querysets that build features.'),
      T('train', 'Train and analyze', 'analyze and train data', 1080, 80, ['ai'], 'Models, experiments, the ontology and the Fabric data agents.'),
      T('serve', 'Serve results', 'store data', 1440, 80, ['serve', 'eventServe'], 'Semantic models with the results and governed measures.'),
      T('visualize', 'Visualize', 'visualize', 1800, 80, ['visualize', 'eventVisualize'], 'Power BI reports and dashboards.'),
      T('track', 'Track', 'track data', 1800, 300, ['track', 'alerts'], 'Plans and alerts.'),
      T('distribute', 'Distribute', 'distribute data', 2160, 80, ['distribute'], 'Org apps.'),
    ],
    edges: [['get', 'store'], ['store', 'prepare'], ['prepare', 'train'], ['train', 'serve'], ['serve', 'visualize'], ['visualize', 'distribute'], ['serve', 'track']],
  },
];
const templateById = (id) => TEMPLATES.find((t) => t.id === id) || null;

/** Everything the project built in the workspace, with its role – for every data source of the workspace. A task flow belongs to one workspace. */
export function projectItems(p = getProject()) {
  const ws = p.workspace?.id;
  const out = [];
  const seen = new Set();
  const put = (role, type, it, wsId) => {
    if (!it?.id || (wsId && wsId !== ws) || seen.has(it.id)) return;
    seen.add(it.id);
    out.push({ id: it.id, type, name: it.name || it.displayName || it.itemName || it.id, role });
  };
  for (const v of contextViews(p)) contextItems(v.view, ws, put);
  return out.map((i) => ({ ...i, roleLabel: ROLE_LABEL[i.role] || i.role }));
}

function contextItems(p, ws, put) {
  const ms = p.modelSource;
  const prep = (p.dataPrepItems || []).filter((x) => !x.workspaceId || x.workspaceId === ws);
  const curated = new Set(prep.filter((x) => x.type === 'Lakehouse').map((x) => x.id));
  // Data as it lands (a curated lakehouse used as the model source stays curated).
  if (ms && ['Lakehouse', 'Warehouse', 'MirroredDatabase', 'SQLDatabase'].includes(ms.itemType) && !curated.has(ms.itemId)) put(ms.itemType === 'MirroredDatabase' ? 'mirror' : 'raw', ms.itemType, { id: ms.itemId, name: ms.itemName }, ms.workspaceId);
  put('raw', 'Lakehouse', p.lakehouse);
  put('raw', 'SQLDatabase', p.sqlDatabase);
  for (const x of prep) put(x.type === 'Notebook' ? 'prep' : 'curated', x.type, x, x.workspaceId);
  // Business-ready data: every semantic model in the workspace (built by the studio or added to the project).
  for (const m of projectModels(p)) put('serve', 'SemanticModel', m, m.workspaceId);
  put('serve', 'Warehouse', [p.planning?.target?.warehouse, p.planStore?.warehouse].find((w) => w?.id));
  for (const r of p.reports || []) put('visualize', 'Report', r);
  const contexts = projectModels(p).map((m) => modelContext(p, m.id));
  if (!p.semanticModel) contexts.push({ dataAgent: p.dataAgent, orgApp: p.orgApp });
  for (const c of contexts) put('distribute', 'OrgApp', c.orgApp);
  put('ai', 'Ontology', p.ontology);
  for (const c of contexts) put('ai', 'DataAgent', c.dataAgent, c.dataAgent?.workspaceId);
  put('track', 'Plan', p.planning?.planItem);
  const rt = p.realtime;
  if (rt) {
    const med = rt.medallion?.items || {};
    put('stream', 'Eventstream', rt.eventstream);
    put('events', 'Eventhouse', rt.eventhouse);
    put('eventPrep', 'KQLQueryset', med.silverQueryset);
    put('eventCurated', 'Lakehouse', med.silverLakehouse);
    put('eventPrep', 'KQLQueryset', med.goldQueryset);
    put('eventServe', 'SemanticModel', med.goldModel);
    put('eventVisualize', 'KQLDashboard', rt.dashboard);
    put('alerts', 'Reflex', rt.alerts);
  }
}

const flowName = (tf) => tf?.name || tf?.id || 'task flow';

// ---------------- task flows already in the workspace: which task takes which role ----------------

const EVENT = /event|stream|real[\s-]?time|kql|eventhouse|telemetry|iot|live|speed/i;
const BRONZE = /bronze|raw|landing|staging|ingest/i;
const SILVER = /silver|curated|clean|cleans|enrich|conform|validated|refined/i;
const GOLD = /gold|golden|semantic|model|serv|presentation|business[\s-]?ready|mart|aggregate/i;
const ALERT = /alert|activator|reflex|notify|monitor/i;

/** Order of the tasks along the connectors (left to right), then by position. */
function flowOrder(tasks, edges) {
  const depth = new Map(tasks.map((t) => [t.id, 0]));
  for (let i = 0; i < tasks.length; i++) {
    for (const e of edges) if (depth.has(e.source) && depth.has(e.target)) depth.set(e.target, Math.max(depth.get(e.target), depth.get(e.source) + 1));
  }
  const pos = (t) => String(t.loc || '0 0').split(/\s+/).map(Number);
  return [...tasks].sort((a, b) => depth.get(a.id) - depth.get(b.id) || pos(a)[0] - pos(b)[0] || pos(a)[1] - pos(b)[1]);
}

/** Roles of the tasks in a task flow the studio didn't design: from each task's type, name and place in the flow. */
export function inferRoles(tasks, edges = []) {
  const ordered = flowOrder(tasks, edges);
  const roles = new Map(tasks.map((t) => [t.id, []]));
  const text = (t) => `${t.name || ''} ${t.description || ''}`;
  const ofType = (type) => ordered.filter((t) => t.type === type);
  const add = (t, ...r) => { if (t) roles.get(t.id).push(...r.filter((x) => !roles.get(t.id).includes(x))); };

  // Get data: live events go to a task about events when there is one.
  const gets = ofType('get data');
  const evGet = gets.find((t) => EVENT.test(text(t)));
  for (const t of gets) add(t, ...(t === evGet ? ['stream'] : evGet ? ['ingest'] : ['ingest', 'stream']));
  for (const t of ofType('mirror data')) add(t, 'mirror');

  // Store data: Bronze / Silver / Gold from the names first, then by position (first raw, last business-ready).
  const stores = ofType('store data');
  const cls = new Map();
  for (const t of stores) {
    const s = text(t);
    if (GOLD.test(s)) cls.set(t.id, 'gold'); else if (SILVER.test(s)) cls.set(t.id, 'silver'); else if (BRONZE.test(s)) cls.set(t.id, 'bronze');
    else if (EVENT.test(s)) cls.set(t.id, 'events');
  }
  const free = stores.filter((t) => !cls.has(t.id));
  const covered = (c) => [...cls.values()].includes(c);
  if (!covered('bronze') && free.length) cls.set(free.shift().id, 'bronze');
  if (!covered('gold') && free.length && stores.length > 1) cls.set(free.pop().id, 'gold');
  if (!covered('silver') && free.length) cls.set(free.shift().id, 'silver');
  for (const t of free) cls.set(t.id, 'silver');
  const firstOf = (c) => stores.find((t) => cls.get(t.id) === c);
  const bronze = firstOf('bronze') || firstOf('events') || stores[0];
  const silver = firstOf('silver');
  const gold = firstOf('gold') || stores[stores.length - 1];
  const events = stores.find((t) => cls.get(t.id) === 'events' || (EVENT.test(text(t)) && cls.get(t.id) !== 'gold'));
  add(bronze, 'raw', 'mirror');
  add(events || bronze, 'events');
  add(silver || (stores.length > 2 ? stores[1] : bronze), 'curated');
  add(events && silver && EVENT.test(text(silver)) ? silver : (silver || events || bronze), 'eventCurated');
  add(gold, 'serve', 'eventServe');

  // Prepare data: the first one prepares the raw data (Initial process); one about events takes the live processing.
  const preps = ofType('prepare data');
  const evPrep = preps.find((t) => EVENT.test(text(t)));
  add(preps.find((t) => t !== evPrep) || preps[0], 'prep');
  add(evPrep || preps[0], 'eventPrep');

  const vis = ofType('visualize');
  const evVis = vis.find((t) => EVENT.test(text(t)) || /dashboard/i.test(text(t)));
  add(vis.find((t) => t !== evVis) || vis[0], 'visualize');
  add(evVis || vis[0], 'eventVisualize');
  for (const t of ofType('distribute data')) add(t, 'distribute');
  for (const t of ofType('analyze and train data')) add(t, 'ai');
  const tracks = ofType('track data');
  const alertTask = tracks.find((t) => ALERT.test(text(t)) || EVENT.test(text(t)));
  add(tracks.find((t) => t !== alertTask) || tracks[0], 'track');
  add(alertTask || tracks[0], 'alerts');
  return ordered.map((t) => ({ key: t.id, roles: roles.get(t.id) }));
}

/** Which task each item goes to: by role (with the fallback chain), then the user's own moves. */
function assign(tasks, items, overrides = {}) {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const mapping = new Map();
  const unassigned = [];
  for (const i of items) {
    const o = overrides[i.id];
    if (o !== undefined && (o === '' || byKey.has(o))) {
      if (o) mapping.set(i.id, o); else unassigned.push({ ...i, reason: 'You chose not to assign it' });
      continue;
    }
    const role = (FALLBACK[i.role] || [i.role]).find((r) => tasks.some((t) => t.roles.includes(r)));
    const t = role ? tasks.find((x) => x.roles.includes(role)) : null;
    if (t) mapping.set(i.id, t.key); else unassigned.push({ ...i, reason: `No task in this flow takes ${(ROLE_LABEL[i.role] || i.role).toLowerCase()}` });
  }
  return { mapping, unassigned };
}

const xy = (loc) => { const [x, y] = String(loc || '0 0').split(/\s+/).map(Number); return { x: x || 0, y: y || 0 }; };

// Task flows in the workspace, cached briefly (reading them calls the Power BI metadata service).
let canvases = { ws: null, at: 0, list: null, error: null };
async function workspaceFlows(ws, { fresh = false } = {}) {
  if (!fresh && canvases.ws === ws && Date.now() - canvases.at < 20000) return canvases;
  try { canvases = { ws, at: Date.now(), list: await TF.listTaskFlows(ws), error: null }; }
  catch (e) { canvases = { ws, at: Date.now(), list: [], error: e.message.split('\n')[0].slice(0, 300) }; }
  return canvases;
}

/** "template:<id>" or "existing:<task flow id>" from what the UI, Copilot or the saved project gives. */
function parseChoice(choice, p, flows) {
  const s = String(choice || '').trim();
  if (s.startsWith('template:') && templateById(s.slice(9))) return { mode: 'template', id: s.slice(9) };
  // The studio's own canvas is the template it was made from, not a flow to leave and re-map.
  if (s.startsWith('existing:') && s.slice(9) === p.taskFlow?.id && p.taskFlow?.mode !== 'existing') return { mode: 'template', id: p.taskFlow.template || 'medallion' };
  if (s.startsWith('existing:') && s.slice(9) === liveFlowId(p)) throw Object.assign(new Error('That is the studio\'s Event medallion task flow for the live events (Real-time page). Choose another task flow.'), { status: 400 });
  if (s.startsWith('existing:')) return { mode: 'existing', id: s.slice(9) };
  if (templateById(s)) return { mode: 'template', id: s };
  // Copilot may name a template or a task flow.
  const t = TEMPLATES.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (t) return { mode: 'template', id: t.id };
  const f = flows.find((x) => x.id === s || String(x.name).toLowerCase() === s.toLowerCase());
  if (f && f.id === liveFlowId(p)) throw Object.assign(new Error(`"${f.name}" is the studio's Event medallion task flow for the live events (Real-time page). Choose another task flow.`), { status: 400 });
  if (f) return f.id === p.taskFlow?.id && p.taskFlow?.mode !== 'existing' ? { mode: 'template', id: p.taskFlow.template } : { mode: 'existing', id: f.id };
  if (s) throw Object.assign(new Error(`Unknown task flow "${s}". Choose one of ${TEMPLATES.map((x) => x.name).join(', ')} or a task flow in the workspace.`), { status: 400 });
  // Default: what is applied; else the one task flow people made in the workspace; else Medallion.
  if (p.taskFlow?.id) return p.taskFlow.mode === 'existing' ? { mode: 'existing', id: p.taskFlow.id } : { mode: 'template', id: p.taskFlow.template || 'medallion' };
  const theirs = flows.filter((x) => !studioOwned(p, x.id));
  if (theirs.length === 1) return { mode: 'existing', id: theirs[0].id };
  return { mode: 'template', id: 'medallion' };
}

// Task flows the studio itself made: its workspace flow, and the Event medallion flow of the live events (kept in step
// by the Real-time page, which rewrites it whole – so it is never treated as a flow people made).
const liveFlowId = (p) => p.realtime?.medallion?.taskFlow?.id || null;
const studioOwned = (p, id) => (p.taskFlow?.mode !== 'existing' && id === p.taskFlow?.id) || id === liveFlowId(p);

/** The tasks of a choice with the items that go to each one. */
async function planFor(choice, p, flows, overrides) {
  const items = projectItems(p);
  if (choice.mode === 'template') {
    const tpl = templateById(choice.id);
    const { mapping, unassigned } = assign(tpl.tasks, items, overrides);
    return {
      name: p.taskFlow?.mode !== 'existing' && p.taskFlow?.template === tpl.id && p.taskFlow?.name ? p.taskFlow.name : standardName('TaskFlow', tpl.purpose, p),
      description: `${tpl.name} task flow for the project, built by Fabric MCP Studio on Fabric's predesigned ${tpl.name} task flow. ${tpl.description}`,
      template: tpl,
      tasks: tpl.tasks.map((t) => ({ key: t.key, name: t.name, type: t.type, description: t.description, x: t.x, y: t.y, roles: t.roles, others: 0, items: items.filter((i) => mapping.get(i.id) === t.key) })),
      edges: tpl.edges.map(([a, b]) => ({ from: a, to: b })),
      unassigned, items, mapping, pinned: new Set(),
    };
  }
  const flow = flows.find((f) => f.id === choice.id);
  if (!flow) throw Object.assign(new Error('That task flow is no longer in the workspace. Choose another one.'), { status: 404 });
  const tasksIn = flow.tasks || [];
  const roles = new Map(inferRoles(tasksIn, flow.edges || []).map((r) => [r.key, r.roles]));
  const ordered = flowOrder(tasksIn, flow.edges || []);
  // What the studio added, per task: a reference on another task than the one the studio put it on was placed (or
  // moved) there by a person.
  const assignedTo = p.taskFlow?.mode === 'existing' && p.taskFlow.id === flow.id ? p.taskFlow.assigned || {} : {};
  const ours = new Set(Object.values(assignedTo).flat());
  // Items people already put on a task (in Fabric) stay there: they count as placed, and the studio adds them nowhere
  // else. Semantic models and reports are matched by their portal ids too.
  const refs = await TF.itemRefs(items, { workspaceId: p.workspace.id });
  const placed = {};
  for (const i of items) {
    const t = ordered.find((x) => (x.items || []).some((r) => !(assignedTo[x.id] || []).includes(r.artifactUniqueId) && TF.sameItem(r, refs.get(i.id) || [])));
    if (t) placed[i.id] = t.id;
  }
  const tasks = ordered.map((t) => ({ key: t.id, roles: roles.get(t.id) || [] }));
  const { mapping, unassigned } = assign(tasks, items, { ...overrides, ...placed });
  const mine = (x) => ours.has(x.artifactUniqueId) || items.some((i) => TF.sameItem(x, refs.get(i.id) || []));
  return {
    name: flow.name, description: flow.description || '', template: null, existing: flow,
    tasks: tasksIn.map((t) => ({
      key: t.id, name: t.name, type: t.type, description: t.description || '', ...xy(t.loc), roles: roles.get(t.id) || [],
      // Other items people assigned to the task (the studio leaves them as they are).
      others: (t.items || []).filter((x) => !mine(x)).length,
      items: items.filter((i) => mapping.get(i.id) === t.id),
    })),
    edges: (flow.edges || []).map((e) => ({ from: e.source, to: e.target })),
    unassigned: unassigned.filter((i) => !placed[i.id]), items, mapping, pinned: new Set(Object.keys(placed)), refs,
  };
}

const signature = (mapping) => [...mapping.entries()].map(([i, t]) => `${i}>${t}`).sort().join('|');

/** What the Workspace page and Copilot need: the choices, the selected flow with the items per task, and its status. */
export async function taskFlowState({ choice, overrides, fresh = false } = {}) {
  const p = getProject();
  if (!p.workspace) return { available: false, reason: 'Select a workspace first.', templates: TEMPLATES.map(summary), existing: [], plan: null, applied: null };
  const { list, error } = await workspaceFlows(p.workspace.id, { fresh });
  const flows = list || [];
  let sel = parseChoice(choice, p, flows);
  // The applied flow was deleted in Fabric (or the flows couldn't be read): show Medallion instead of failing – and
  // say so, so the UI and Copilot don't present Medallion as the flow that was asked for.
  let notFound = null;
  if (sel.mode === 'existing' && !flows.some((f) => f.id === sel.id)) {
    notFound = { id: sel.id, name: p.taskFlow?.mode === 'existing' && p.taskFlow.id === sel.id ? p.taskFlow.name : null, reason: error ? 'The workspace\'s task flows couldn\'t be read' : 'That task flow is no longer in the workspace' };
    sel = { mode: 'template', id: 'medallion' };
  }
  const ov = overrides || (sameChoice(p.taskFlow, sel) ? p.taskFlow.overrides : null) || {};
  const plan = await planFor(sel, p, flows, ov);
  const applied = p.taskFlow?.id ? { ...p.taskFlow, url: taskFlowUrl(p.workspace.id), exists: flows.some((f) => f.id === p.taskFlow.id) || Boolean(error) } : null;
  const isApplied = sameChoice(p.taskFlow, sel);
  return {
    available: plan.items.length > 0,
    reason: plan.items.length ? null : 'Add data first – the task flow organizes the items the studio builds.',
    workspace: { id: p.workspace.id, name: p.workspace.name, url: taskFlowUrl(p.workspace.id) },
    templates: TEMPLATES.map(summary),
    existing: flows.map((f) => ({ id: f.id, name: f.name, tasks: (f.tasks || []).length, items: (f.tasks || []).reduce((a, t) => a + (t.items || []).length, 0), studio: studioOwned(p, f.id), live: f.id === liveFlowId(p) })),
    listError: error,
    choice: sel.mode === 'template' ? `template:${sel.id}` : `existing:${sel.id}`,
    mode: sel.mode,
    requestedNotFound: Boolean(notFound),
    notice: notFound ? `${notFound.reason}${notFound.name ? ` ("${notFound.name}")` : ''} – showing Medallion instead.` : null,
    plan: {
      name: plan.name, description: plan.description, mode: sel.mode, template: plan.template ? summary(plan.template) : null,
      tasks: plan.tasks.map(({ roles, ...t }) => ({ ...t, takes: roles.map((r) => ROLE_LABEL[r] || r), items: t.items.map((i) => ({ ...view(i), pinned: plan.pinned.has(i.id) })) })),
      edges: plan.edges,
      unassigned: plan.unassigned.map((i) => ({ ...view(i), reason: i.reason })),
      overrides: ov,
      count: plan.mapping.size,
    },
    applied,
    selectedIsApplied: isApplied,
    upToDate: isApplied && Boolean(applied?.exists) && p.taskFlow.mapping === signature(plan.mapping),
  };
}
const summary = (t) => ({ id: t.id, name: t.name, description: t.description, tasks: t.tasks.length });
const view = (i) => ({ id: i.id, type: i.type, name: i.name, role: i.roleLabel });
const sameChoice = (tf, sel) => Boolean(tf?.id) && (sel.mode === 'existing' ? tf.mode === 'existing' && tf.id === sel.id : tf.mode !== 'existing' && (tf.template || 'medallion') === sel.id);

// Creating, syncing and removing run one at a time, so a background sync can't bring back a task flow that was just
// removed (or overwrite a newer one).
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

export function runTaskFlow(ctx, opts = {}) { return serial(() => applyTaskFlow(ctx, opts)); }

const QUIET = { step() {}, log() {}, progress() {} };

async function applyTaskFlow(ctx, { choice, overrides } = {}) {
  await assertProjectTenant();
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  const ws = p.workspace.id;
  const { list, error } = await workspaceFlows(ws, { fresh: true });
  // Without the list the studio can't tell which task flows exist (it could create a second canvas): change nothing.
  if (error) throw new Error(`The workspace's task flows couldn't be read, so nothing was changed: ${error}`);
  const flows = list || [];
  const sel = parseChoice(choice, p, flows);
  const ov = overrides || (sameChoice(p.taskFlow, sel) ? p.taskFlow.overrides : null) || {};
  const plan = await planFor(sel, p, flows, ov);
  if (!plan.items.length) throw new Error('Add data first – the task flow organizes the items the studio builds.');
  ctx.step(`Map the project's items to the tasks of "${plan.name}"`);
  for (const t of plan.tasks) if (t.items.length) ctx.log(`${t.name}: ${t.items.map((i) => i.name).join(', ')}`);
  for (const i of plan.unassigned) ctx.log(`Not assigned: ${i.name} – ${i.reason}`);
  ctx.progress(25);

  // The previous flow is left only after the new one is saved, so a failed save never leaves the project pointing to a
  // flow the studio already took its items off (or deleted).
  const prev = p.taskFlow?.id ? p.taskFlow : null;
  const leaving = prev && !sameChoice(prev, sel) && !(prev.mode !== 'existing' && sel.mode === 'template') ? prev : null;

  let saved;
  let assigned = {};
  if (sel.mode === 'template') {
    const tpl = plan.template;
    // The Medallion flow keeps the ids earlier versions used, so it is updated in place.
    const seed = tpl.id === 'medallion' ? 'medallion-flow' : `taskflow-${tpl.id}`;
    const reuse = prev && prev.mode !== 'existing' && flows.some((f) => f.id === prev.id) ? prev.id : undefined;
    ctx.step(`${reuse ? 'Update' : 'Create'} the task flow "${plan.name}"`);
    const flow = await TF.buildTaskFlow({
      name: plan.name, description: plan.description,
      tasks: plan.tasks.map((t) => ({ key: t.key, name: t.name, type: t.type, description: t.description, x: t.x, y: t.y, items: t.items.map((i) => ({ type: i.type, id: i.id })) })),
      edges: plan.edges.map((e) => [e.from, e.to]),
    }, { idOf: (...k) => stableUuid(seed, ws, ...k), workspaceId: ws });
    saved = await TF.saveTaskFlow(ws, flow, { id: reuse });
    ctx.log(`Task flow "${plan.name}" ${saved.created ? 'created' : 'updated'}: ${flow.tasks.length} tasks, ${plan.mapping.size} items assigned`);
  } else {
    ctx.step(`Assign the items to the tasks of "${plan.name}"`);
    const refs = plan.refs;
    const before = sameChoice(prev, sel) ? prev.assigned || {} : {};
    let added = 0;
    let removed = 0;
    await TF.patchTaskFlow(ws, sel.id, (flow) => {
      assigned = {};
      added = 0; removed = 0;
      for (const task of flow.tasks) {
        task.items = task.items || [];
        const want = plan.items.filter((i) => plan.mapping.get(i.id) === task.id);
        const wantRefs = want.flatMap((i) => refs.get(i.id) || []);
        // Take off what the studio added before and doesn't belong here any more (never items people assigned).
        const mine = new Set(before[task.id] || []);
        const keep = task.items.filter((x) => !(mine.has(x.artifactUniqueId) && !TF.sameItem(x, wantRefs)));
        removed += task.items.length - keep.length;
        task.items = keep;
        // Add what is missing, and remember which references the studio added.
        const ours = [...mine].filter((u) => task.items.some((x) => x.artifactUniqueId === u));
        for (const i of want) {
          for (const r of refs.get(i.id) || []) {
            if (task.items.some((x) => TF.sameItem(x, [r]))) continue;
            task.items.push(r);
            ours.push(r.artifactUniqueId);
            added += 1;
          }
        }
        if (ours.length) assigned[task.id] = [...new Set(ours)];
      }
      // An item the studio moved to another task leaves its old one too (only references the studio added).
      return flow;
    });
    saved = { id: sel.id, created: false };
    ctx.log(`Task flow "${plan.name}": ${plan.mapping.size} items on its tasks${added ? ` · ${added} assignment${added === 1 ? '' : 's'} added` : ''}${removed ? ` · ${removed} removed` : ''}. Its tasks, connectors and the items people assigned stay as they are.`);
  }
  canvases.at = 0;
  const taskFlow = {
    mode: sel.mode, template: sel.mode === 'template' ? sel.id : null, id: saved.id, name: plan.name,
    tasks: plan.tasks.length, items: plan.mapping.size, itemIds: [...plan.mapping.keys()], mapping: signature(plan.mapping),
    overrides: ov, assigned, syncedAt: new Date().toISOString(),
  };
  updateProject({ taskFlow });
  // Leaving the previous flow: a flow the studio created goes (it only organized these items); in a flow that was in
  // the workspace before, the studio takes its own items off the tasks.
  if (leaving) {
    ctx.step(`Leave the task flow "${leaving.name}"`);
    try { ctx.log(await leave(leaving, ws)); } catch (e) {
      ctx.log(`Couldn't ${leaving.mode === 'existing' ? `take the studio's items off "${leaving.name}"` : `delete "${leaving.name}"`} (${e.message.split('\n')[0].slice(0, 200)}) – do it in Fabric if you don't need it`);
    }
  }
  logActivity('taskflow.apply', `Task flow "${plan.name}" ${sel.mode === 'existing' ? 'kept in sync' : saved.created ? 'created' : 'updated'} (${plan.mapping.size} items)`, { taskFlowId: saved.id });
  ctx.progress(95);
  return { ...taskFlow, url: taskFlowUrl(ws), unassigned: plan.unassigned.map((i) => i.name) };
}

/** Stop using a task flow: delete the studio's own canvas, or take the studio's items off a flow people made. */
async function leave(tf, ws) {
  const name = flowName(tf);
  if (tf.mode === 'existing') {
    const ids = new Set(Object.values(tf.assigned || {}).flat());
    if (!ids.size) return `Nothing of the studio's was on "${name}"`;
    try {
      let n = 0;
      await TF.patchTaskFlow(ws, tf.id, (flow) => {
        n = 0;
        for (const task of flow.tasks) {
          const before = (task.items || []).length;
          task.items = (task.items || []).filter((x) => !(tf.assigned?.[task.id] || []).includes(x.artifactUniqueId));
          n += before - task.items.length;
        }
        return flow;
      });
      return `Took ${n} of the studio's assignment${n === 1 ? '' : 's'} off "${name}" – the task flow stays`;
    } catch (e) {
      if (e.status === 404) return `"${name}" is no longer in the workspace`;
      throw e;
    }
  }
  return (await TF.deleteTaskFlow(ws, tf.id)) ? `Deleted the task flow "${name}" (the items stay)` : `The task flow "${name}" was already deleted`;
}

/** Keep the task flow in step with new or removed items (quietly; only when there is one). */
export function syncTaskFlow() {
  return serial(async () => {
    // Checked when its turn comes: the task flow may have been removed in the meantime.
    const p = getProject();
    if (!p.workspace || !p.taskFlow?.id) return null;
    const choice = p.taskFlow.mode === 'existing' ? `existing:${p.taskFlow.id}` : `template:${p.taskFlow.template || 'medallion'}`;
    const s = await taskFlowState({ choice, fresh: true }).catch(() => null);
    if (!s || s.upToDate || !s.applied?.exists) return null;
    return applyTaskFlow(QUIET, { choice }).catch(() => null);
  });
}

/** Remove the task flow from the project (Remove button, Copilot): the studio's canvas is deleted, a flow people made keeps everything but the studio's assignments. */
export function removeTaskFlow() {
  return serial(async () => {
    await assertProjectTenant();
    const p = getProject();
    let message = 'No task flow';
    if (p.workspace && p.taskFlow?.id) message = await leave(p.taskFlow, p.workspace.id);
    updateProject({ taskFlow: null });
    canvases.at = 0;
    return { ok: true, message };
  });
}

/** Clean up: same as removing, with a line for the job log. */
export function teardownTaskFlow() {
  return removeTaskFlow().then((r) => r.message);
}
