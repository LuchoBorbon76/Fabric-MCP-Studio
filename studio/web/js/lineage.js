// Solution map: what the studio builds in Microsoft Fabric and how each part depends on the others, from the data
// sources to the people who use the answers. Parts light up as they are configured; the rest stay greyed out.
import { store } from './api.js';
import { h } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

/** Accent colour per family of items (used for icons, edges and the inspector). */
export const CAT = { source: '#64748b', onelake: '#0f8b7d', model: '#c99400', ontology: '#8661c5', reports: '#e2711d', apps: '#2f7fd6', planning: '#2e9e57', ai: '#5b5fc7', rt: '#c43da4', workspace: '#2f7fd6' };

const ICONS = {
  map: '<circle cx="5.5" cy="6" r="2.5"/><circle cx="18.5" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 6h8M7 8l3.6 7.8M17 8l-3.6 7.8"/>',
  workspace: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18M6.5 6.8h.01M9 6.8h.01"/>',
  sample: '<path d="M9.5 3h5M10.5 3v6.2L5.3 18a2 2 0 0 0 1.7 3h10a2 2 0 0 0 1.7-3l-5.2-8.8V3"/><path d="M7.7 15h8.6"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  mirror: '<ellipse cx="9" cy="6" rx="5.5" ry="2.2"/><path d="M3.5 6v11c0 1.2 2.5 2.2 5.5 2.2"/><path d="M14.5 6v4"/><path d="M14 14h7M18 11l3 3-3 3"/>',
  lake: '<path d="M3 7.5c1.8 0 1.8-1.8 4.5-1.8S10.2 7.5 12 7.5s1.8-1.8 4.5-1.8S19.2 7.5 21 7.5"/><path d="M3 12.5c1.8 0 1.8-1.8 4.5-1.8s2.7 1.8 4.5 1.8 1.8-1.8 4.5-1.8 2.7 1.8 4.5 1.8"/><path d="M3 17.5c1.8 0 1.8-1.8 4.5-1.8s2.7 1.8 4.5 1.8 1.8-1.8 4.5-1.8 2.7 1.8 4.5 1.8"/>',
  warehouse: '<path d="M3 10l9-6 9 6"/><path d="M5 9v11h14V9"/><path d="M9.5 20v-5h5v5"/>',
  model: '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M6.5 6.5l3.4 3.4M17.5 6.5l-3.4 3.4M6.5 17.5l3.4-3.4M17.5 17.5l-3.4-3.4"/>',
  ontology: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M10.8 7.3 6.2 15.7M13.2 7.3l4.6 8.4M7.5 18h9"/>',
  reports: '<path d="M4 20h16"/><rect x="5" y="11" width="3" height="7" rx="1"/><rect x="10.5" y="6" width="3" height="12" rx="1"/><rect x="16" y="9" width="3" height="9" rx="1"/>',
  app: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  planning: '<path d="M3.5 17l5-5 4 3 7.5-8"/><path d="M15.5 7H20v4.5"/><path d="M3.5 21h17" stroke-dasharray="2 2.5"/>',
  plan: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M3.5 14h17M9 4v16"/>',
  answers: '<path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/><path d="M12 7.3l1 2.2 2.2 1-2.2 1-1 2.3-1-2.3-2.2-1 2.2-1z"/>',
  agent: '<circle cx="8.5" cy="8" r="3"/><path d="M3 19.5a5.5 5.5 0 0 1 11 0"/><rect x="14.5" y="9" width="6.5" height="6" rx="2"/><path d="M17.75 7v2M16.8 12h.01M18.8 12h.01"/>',
  events: '<path d="M3 12h4l2.5-6.5 4.5 13 2.5-6.5H21"/>',
  eventstream: '<path d="M3 6h11.5a3 3 0 0 1 0 6h-6a3 3 0 0 0 0 6H20"/><path d="M17 15l3 3-3 3"/>',
  eventhouse: '<ellipse cx="10" cy="5.5" rx="6.5" ry="2.4"/><path d="M3.5 5.5v11c0 1.3 2.9 2.4 6.5 2.4"/><path d="M16.5 5.5V10"/><circle cx="17" cy="16.5" r="4.5"/><path d="M17 14.3v2.3l1.6 1"/>',
  dashboard: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4.2-5.2"/><circle cx="12" cy="17" r="1.3"/><path d="M4 21h16"/>',
  alerts: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};

export function icon(name, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.database}</svg>`;
}

export const VIEW_LABEL = { home: 'Overview', copilot: 'Copilot', workspace: 'Workspace', data: 'Data', model: 'Semantic model', ontology: 'Ontology', reports: 'Reports & apps', realtime: 'Real-time', planning: 'Planning', share: 'Ask & share', activity: 'Activity', settings: 'Settings' };
const UTILITY = new Set(['copilot', 'activity', 'settings']);
const COLS = ['Sources', 'OneLake', 'Semantic layer', 'Insights & AI', 'Apps & sharing'];

// Grid position (column, row) of every part. Rows 0-2: analytics; row 3: real-time.
const DEFS = [
  { id: 'source', c: 0, r: 0, view: 'data', module: 'data', cat: 'source', type: 'Data source', desc: 'Sample data, your own databases (mirrored to OneLake) or Fabric data you already have.' },
  { id: 'data', c: 1, r: 0, view: 'data', module: 'data', cat: 'onelake', type: 'OneLake data', desc: 'The tables in OneLake that the semantic model, ontology and plan are built on.' },
  { id: 'model', c: 2, r: 0, view: 'model', module: 'model', cat: 'model', type: 'Semantic model', icon: 'model', desc: 'Direct Lake model with relationships and business measures: one version of every number.' },
  { id: 'ontology', c: 2, r: 2, view: 'ontology', module: 'ontology', cat: 'ontology', type: 'Ontology', icon: 'ontology', desc: 'Business entities, relationships and plain-English rules in Fabric IQ.' },
  { id: 'reports', c: 3, r: 0, view: 'reports', module: 'reports', cat: 'reports', type: 'Power BI reports', icon: 'reports', desc: 'Professional reports built from templates and themes on your model\'s measures.' },
  { id: 'planning', c: 3, r: 1, view: 'planning', module: 'planning', cat: 'planning', type: 'Budget & forecast', icon: 'planning', desc: 'A budget and rolling forecast from your actuals, with variance measures in the model.' },
  { id: 'answers', c: 3, r: 2, view: 'share', module: 'share', cat: 'ai', type: 'Copilot answers', icon: 'answers', desc: 'Governed answers through Fabric IQ, with each person\'s permissions and row-level security.' },
  { id: 'orgapp', c: 4, r: 0, view: 'reports', module: 'reports', cat: 'apps', type: 'Org app', icon: 'app', desc: 'Your reports bundled into one app for business users.' },
  { id: 'planitem', c: 4, r: 1, view: 'planning', module: 'planning', cat: 'planning', type: 'Fabric plan', icon: 'plan', desc: 'Planning sheets where planners refine the budget and forecast.' },
  { id: 'agent', c: 4, r: 2, view: 'share', module: 'share', cat: 'ai', type: 'Microsoft 365 agent', icon: 'agent', desc: 'The same governed answers in Microsoft Teams and Microsoft 365 Copilot.' },
  { id: 'events', c: 0, r: 3, view: 'realtime', module: 'realtime', cat: 'rt', type: 'Live events', icon: 'events', desc: 'Events from the built-in simulator or your own apps.' },
  { id: 'eventstream', c: 1, r: 3, view: 'realtime', module: 'realtime', cat: 'rt', type: 'Eventstream', icon: 'eventstream', desc: 'Custom endpoint that receives the events and routes them to the Eventhouse.' },
  { id: 'eventhouse', c: 2, r: 3, view: 'realtime', module: 'realtime', cat: 'rt', type: 'Eventhouse', icon: 'eventhouse', desc: 'KQL database that keeps every event, ready to query seconds after it arrives.' },
  { id: 'dashboard', c: 3, r: 3, view: 'realtime', module: 'realtime', cat: 'rt', type: 'Real-Time Dashboard', icon: 'dashboard', desc: 'Auto-refreshing tiles over the live events.' },
  { id: 'alerts', c: 4, r: 3, view: 'realtime', module: 'realtime', cat: 'rt', type: 'Activator alerts', icon: 'alerts', desc: 'A Teams or email message when a business rule is broken.' },
];
const DEF = Object.fromEntries(DEFS.map((d) => [d.id, d]));

// [from, to, label, routing]: 'h' left to right, 'up' same column upwards, 'arc' under the node in between.
const EDGES = [
  ['source', 'data', null], ['data', 'model', 'Direct Lake'], ['data', 'ontology', 'Bindings'],
  ['model', 'reports'], ['reports', 'orgapp'], ['model', 'planning'], ['planning', 'planitem'],
  ['model', 'answers', 'Fabric IQ'], ['ontology', 'answers'], ['answers', 'agent'],
  ['events', 'eventstream'], ['eventstream', 'eventhouse'], ['eventhouse', 'dashboard', 'KQL'], ['eventhouse', 'alerts', 'Rules', 'arc'], ['eventhouse', 'ontology', 'Live properties', 'up'],
];

// Order in which the map suggests the next part to set up.
const NEXT = ['source', 'model', 'ontology', 'reports', 'events', 'dashboard', 'planning', 'agent', 'alerts', 'orgapp', 'planitem'];

const JOB_NODES = {
  sample: ['source', 'data'], mirror: ['source', 'data'], shortcut: ['source', 'data'], 'semantic-model': ['model'], ontology: ['ontology'],
  report: ['reports'], 'org-app': ['orgapp'], realtime: ['events', 'eventstream', 'eventhouse'], 'realtime-dashboard': ['dashboard'],
  'realtime-ontology': ['ontology'], 'realtime-alerts': ['alerts'], planning: ['planning'], 'plan-item': ['planitem'], 'teams-agent': ['agent'],
};

const ITEM = { Lakehouse: 'Lakehouse', Warehouse: 'Warehouse', MirroredDatabase: 'Mirrored database', SQLDatabase: 'SQL database' };
const ITEM_ICON = { Lakehouse: 'lake', Warehouse: 'warehouse', MirroredDatabase: 'mirror', SQLDatabase: 'database' };
const ITEM_PATH = { Lakehouse: 'lakehouses', Warehouse: 'warehouses', MirroredDatabase: 'mirroreddatabases', SQLDatabase: 'sqldatabases', SemanticModel: 'datasets', Ontology: 'ontologies', Eventhouse: 'eventhouses', Eventstream: 'eventstreams' };
const METHOD = { files: 'Loaded', 'sql-database': 'Loaded', mirror: 'Mirroring', shortcut: 'Shortcuts', 'in-place': 'In place' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fabricItemUrl(type, workspaceId, id) {
  if (!workspaceId || !id || !ITEM_PATH[type]) return null;
  return `https://app.fabric.microsoft.com/groups/${workspaceId}/${ITEM_PATH[type]}/${id}${type === 'SemanticModel' ? '/details' : ''}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const firstReason = (m) => m?.reasons?.find((r) => r.status === 'error') || m?.reasons?.find((r) => r.status === 'warn');
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');

/** What each part shows: configured or not, name, one-line summary, link and facts for the inspector. */
function describe(id, s) {
  const p = s.project || {};
  const ws = p.workspace;
  const src = p.source;
  const ms = p.modelSource;
  const sm = p.semanticModel;
  const ont = p.ontology;
  const reports = p.reports || [];
  const pl = p.planning;
  const rt = p.realtime;
  const sim = s.realtime?.simulator || {};
  const links = s.realtime?.links || {};
  const rtOk = s.realtime ? s.realtime.available : Boolean(sm);
  const at = (type, itemId) => fabricItemUrl(type, ws?.id, itemId);
  switch (id) {
    case 'source': {
      if (!src) return { done: false, avail: Boolean(ws), needs: 'Needs a workspace', icon: 'database', title: 'Not connected', sub: 'Sample, databases or Fabric data' };
      const [kind, name] = src.kind === 'database' && src.label?.includes(' · ') ? src.label.split(' · ') : [null, null];
      const title = src.kind === 'sample' ? String(src.label || '').replace(/\s*\(.*\)\s*$/, '') : src.kind === 'fabric' ? src.itemName : name || src.label;
      const sub = src.kind === 'sample' ? `Sample · ${plural(src.tables?.length || 0, 'table')}` : src.kind === 'database' ? `${kind || 'Database'} · mirrored` : `${ITEM[src.itemType] || src.itemType} · ${src.method === 'shortcut' ? 'shortcuts' : 'in place'}`;
      return {
        done: true, icon: src.kind === 'sample' ? 'sample' : src.kind === 'fabric' ? ITEM_ICON[src.itemType] || 'lake' : 'database', title, sub,
        facts: [['Kind', src.kind === 'sample' ? 'Sample data' : src.kind === 'database' ? kind || 'Database' : `Fabric ${ITEM[src.itemType] || 'item'}`], ['How it reaches OneLake', { files: 'Parquet files loaded into lakehouse tables', 'sql-database': 'Loaded into a Fabric SQL database, replicated to OneLake', mirror: 'Fabric Mirroring (continuous replication)', shortcut: 'OneLake shortcuts (no copy)', 'in-place': 'Used where it is (no copy)' }[src.method] || src.method], ['Tables', src.tables?.length || '–'], src.connectionName ? ['Connection', src.connectionName] : null],
      };
    }
    case 'data':
      if (!ms) return { done: false, avail: Boolean(ws), needs: 'Needs a workspace', icon: 'lake', title: 'Not created', sub: 'Lakehouse, warehouse or SQL database' };
      return {
        done: true, icon: ITEM_ICON[ms.itemType] || 'lake', title: ms.itemName, sub: `${ITEM[ms.itemType] || ms.itemType}${src?.tables?.length ? ` · ${plural(src.tables.length, 'table')}` : ''}`,
        url: fabricItemUrl(ms.itemType, ms.workspaceId || ws?.id, ms.itemId),
        facts: [['Item', ITEM[ms.itemType] || ms.itemType], ['Name', ms.itemName], ['SQL endpoint', ms.server || '–'], ['Database', ms.database || ms.itemName]],
      };
    case 'model':
      if (!sm) return { done: false, avail: Boolean(ms), needs: 'Needs data', title: 'Not created', sub: 'Direct Lake' };
      return { done: true, title: sm.name, sub: `${plural(sm.tables, 'table')} · ${plural(sm.measures, 'measure')}`, url: at('SemanticModel', sm.id), facts: [['Tables', sm.tables], ['Measures', sm.measures], ['Relationships', sm.relationships ?? '–'], ['Storage mode', 'Direct Lake']] };
    case 'ontology':
      if (!ont) return { done: false, avail: Boolean(ms), needs: 'Needs data', title: 'Not created', sub: 'Entities and business rules' };
      return {
        done: true, title: ont.name, sub: `${plural(ont.entities?.length || 0, 'entity').replace('entitys', 'entities')} · ${plural(ont.rules?.length || 0, 'rule')}${rt?.ontology ? ' · live' : ''}`, url: at('Ontology', ont.id),
        facts: [['Entities', (ont.entities || []).slice(0, 8).join(', ') + ((ont.entities || []).length > 8 ? '…' : '')], ['Business rules', (ont.rules || []).length], ['Live properties', rt?.ontology ? `${plural(rt.ontology.entities?.length || 0, 'entity').replace('entitys', 'entities')} linked to live events` : 'Not connected']],
      };
    case 'reports':
      if (!reports.length) return { done: false, avail: Boolean(sm), needs: 'Needs the semantic model', title: 'Not built', sub: 'Templates and themes' };
      return { done: true, title: plural(reports.length, 'report'), sub: shortName(reports[0].name, sm?.name), url: reports.length === 1 ? reports[0].url : null, facts: reports.slice(0, 5).map((r) => ['Report', shortName(r.name, sm?.name), r.url]) };
    case 'orgapp':
      if (!p.orgApp) return { done: false, avail: reports.length > 0, needs: 'Needs a report', title: 'Not published', sub: 'Bundle your reports' };
      return { done: true, title: p.orgApp.name, sub: plural(p.orgApp.reports?.length || 0, 'report'), url: p.orgApp.url, facts: [['Reports', p.orgApp.reports?.length || 0], ['Built', when(p.orgApp.builtAt)]] };
    case 'planning':
      if (!pl) return { done: false, avail: Boolean(sm), needs: 'Needs the semantic model', title: 'No plan', sub: 'From your actuals' };
      return {
        done: true, title: `Plan ${pl.planYear}`, sub: `${pl.measure?.label || pl.measure?.name || 'Budget'} · ${pl.growthPct >= 0 ? '+' : ''}${pl.growthPct}%`,
        facts: [['Plan year', pl.planYear], ['Measure', pl.measure?.label || pl.measure?.name || '–'], ['Growth over the base year', `${pl.growthPct >= 0 ? '+' : ''}${pl.growthPct}%`], ['Forecast', pl.asOfMonth ? `Actuals to ${MONTHS[pl.asOfMonth - 1]}, forecast from ${MONTHS[pl.asOfMonth % 12]}` : 'Budget only'], ['Built', when(pl.builtAt)]],
      };
    case 'planitem': {
      const pi = pl?.planItem;
      if (!pi) return { done: false, avail: Boolean(pl), needs: 'Needs the budget', title: 'Not created', sub: 'Planning sheets' };
      return { done: true, title: pi.name, sub: pi.connected ? 'Connected to the model' : 'Not connected yet', url: pi.url, facts: [['Connection', pi.connectionName || 'Not connected'], ['Created', when(pi.createdAt)]] };
    }
    case 'answers':
      if (!sm) return { done: false, avail: false, needs: 'Needs the semantic model', title: 'Not available', sub: 'Fabric IQ' };
      return { done: true, title: 'Fabric IQ', sub: ont ? 'Model and ontology' : 'Semantic model', facts: [['Grounded in', `${sm.name}${ont ? ` and ${ont.name}` : ''}`], ['Security', 'Each person\'s permissions and row-level security']] };
    case 'agent':
      if (!p.teamsAgent) return { done: false, avail: Boolean(sm), needs: 'Needs the semantic model', title: 'Not installed', sub: 'Teams and Microsoft 365 Copilot' };
      return { done: true, title: 'Teams & Copilot', sub: p.teamsAgent.published ? 'Published to your organization' : 'Installed for you', facts: [['Installed', when(p.teamsAgent.installedAt)], ['Ontology', p.teamsAgent.includeOntology ? 'Included' : 'Not included'], ['Availability', p.teamsAgent.published ? 'Submitted to your organization' : 'You']] };
    case 'events':
      if (!rt) return { done: false, avail: Boolean(ws) && rtOk, needs: ws ? 'Needs the semantic model' : 'Needs a workspace', title: 'Not set up', sub: 'Simulator or your apps' };
      return { done: true, live: Boolean(sim.running), title: sim.running ? `Streaming · ${sim.rate}/min` : 'Endpoint ready', sub: sim.running ? `${Number(sim.sent || 0).toLocaleString()} events sent` : 'Simulator or your apps', facts: [['Simulator', sim.running ? `Running · ${sim.rate} events/min` : 'Stopped'], ['Events sent', Number(sim.sent || 0).toLocaleString()], ['Scenario', rt.scenario?.label || rt.scenario || '–']] };
    case 'eventstream':
      if (!rt?.eventstream) return { done: false, avail: Boolean(ws) && rtOk, needs: ws ? 'Needs the semantic model' : 'Needs a workspace', title: 'Not created', sub: 'Custom endpoint' };
      return { done: true, title: rt.eventstream.name, sub: 'Custom endpoint', url: links.eventstream || at('Eventstream', rt.eventstream.id), facts: [['Source', 'Custom endpoint (Event Hubs compatible)'], ['Destination', `${rt.eventhouse?.name || 'Eventhouse'} · ${rt.table || 'events'}`]] };
    case 'eventhouse':
      if (!rt?.eventhouse) return { done: false, avail: Boolean(ws) && rtOk, needs: ws ? 'Needs the semantic model' : 'Needs a workspace', title: 'Not created', sub: 'KQL database' };
      return { done: true, live: Boolean(sim.running), title: rt.eventhouse.name, sub: `KQL · ${rt.table || 'events'}`, url: links.eventhouse || at('Eventhouse', rt.eventhouse.id), facts: [['KQL database', rt.database?.name || rt.eventhouse.name], ['Table', rt.table || '–'], ['Query URI', rt.eventhouse.queryUri || '–']] };
    case 'dashboard':
      if (!rt?.dashboard) return { done: false, avail: Boolean(rt), needs: 'Needs live data', title: 'Not built', sub: 'Auto-refresh tiles' };
      return { done: true, title: rt.dashboard.name, sub: `${rt.dashboard.tiles ? `${plural(rt.dashboard.tiles, 'tile')} · ` : ''}auto-refresh`, url: rt.dashboard.url || links.dashboard, facts: [['Pages', (rt.dashboard.pages || []).join(', ') || '–'], ['Tiles', rt.dashboard.tiles || '–'], ['Refresh', rt.dashboard.refreshSeconds ? `Every ${rt.dashboard.refreshSeconds} s` : '–']] };
    case 'alerts':
      if (!rt?.alerts) return { done: false, avail: Boolean(rt), needs: 'Needs live data', title: 'Not set up', sub: 'Teams or email' };
      return { done: true, title: rt.alerts.name, sub: `${plural(rt.alerts.rules?.length || 0, 'rule')} · ${rt.alerts.channel === 'email' ? 'email' : 'Teams'}`, url: rt.alerts.url || links.activator, facts: [['Rules', (rt.alerts.rules || []).join(', ') || '–'], ['Sends to', rt.alerts.channel === 'email' ? `Email · ${rt.alerts.recipients || ''}` : 'Microsoft Teams']] };
    default:
      return { done: false, avail: false, title: '', sub: '' };
  }
}

function shortName(name, model) {
  const n = String(name || '');
  return model && n.startsWith(`${model} – `) ? n.slice(model.length + 3) : n;
}

/** The whole map as data: parts with their state, the dependencies between them, and the next suggested part. */
export function buildGraph(s = store) {
  const p = s.project || {};
  const signedIn = Boolean(s.user?.signedIn);
  const ws = p.workspace;
  const mods = s.readiness?.modules || {};
  const jobs = [...(s.jobs?.values?.() || [])].sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  const running = jobs.filter((j) => j.status === 'running');
  const cleaning = running.some((j) => j.kind === 'teardown');
  const nodes = {};
  for (const d of DEFS) {
    const info = describe(d.id, s);
    const n = { ...d, ...info, icon: info.icon || d.icon || 'database' };
    if (!signedIn) { n.avail = false; n.needs = 'Sign in first'; }
    n.state = n.done ? 'done' : n.avail ? 'available' : 'off';
    const job = running.find((j) => JOB_NODES[j.kind]?.includes(d.id));
    const last = jobs.find((j) => JOB_NODES[j.kind]?.includes(d.id));
    if (job || (cleaning && n.done)) { n.state = 'running'; n.job = job || running.find((j) => j.kind === 'teardown'); }
    else if (!n.done && last && ['failed', 'interrupted'].includes(last.status)) { n.state = 'failed'; n.error = last.error || 'The last run didn\'t finish.'; n.job = last; }
    const m = mods[d.module];
    if (m && n.state !== 'off' && (m.status === 'blocked' || m.status === 'limited')) { n.flag = m.status; n.reason = firstReason(m); }
    n.status = statusText(n);
    nodes[d.id] = n;
  }
  const cap = s.readiness?.capacity;
  const wsMod = mods.workspace;
  const workspace = {
    id: 'workspace', view: 'workspace', module: 'workspace', cat: 'workspace', icon: 'workspace', type: 'Workspace',
    desc: 'The Fabric workspace where everything the studio builds is created, on a Fabric capacity.',
    done: Boolean(ws), title: ws?.name || (signedIn ? 'Choose a workspace' : 'Sign in to start'),
    sub: ws ? (ws.created ? 'Created by the studio' : 'Existing workspace') : signedIn ? 'New or existing' : 'Microsoft Entra account',
    capacity: cap?.visible ? cap : null, role: s.readiness?.role || null,
    url: ws ? `https://app.fabric.microsoft.com/groups/${ws.id}/list` : null,
    facts: ws ? [['Capacity', cap?.visible ? `${cap.name} · ${cap.sku}${cap.trial ? ' (trial)' : ''} · ${cap.state === 'Active' ? 'Running' : 'Paused'}` : 'Not visible to you'], ['Region', cap?.region || '–'], ['Your role', s.readiness?.role || '–'], ['Created by the studio', ws.created ? 'Yes' : 'No']] : [],
  };
  workspace.state = workspace.done ? (cleaning ? 'running' : 'done') : signedIn ? 'available' : 'off';
  workspace.needs = 'Sign in first';
  if (wsMod && wsMod.status !== 'ready' && workspace.state !== 'off') { workspace.flag = wsMod.status; workspace.reason = firstReason(wsMod); }
  workspace.paused = Boolean(cap?.visible && cap.state && cap.state !== 'Active');
  workspace.status = statusText(workspace);

  const sim = s.realtime?.simulator || {};
  const rt = p.realtime;
  const edges = EDGES.map(([from, to, label, kind = 'h'], i) => {
    const a = nodes[from];
    const b = nodes[to];
    let state = a.done && b.done ? 'on' : a.done && b.state !== 'off' ? 'ready' : 'off';
    if (from === 'eventhouse' && to === 'ontology') state = a.done && b.done ? (rt?.ontology ? 'on' : 'ready') : 'off';
    const lbl = from === 'source' ? METHOD[p.source?.method] || null : label || null;
    const live = state === 'on' && ((sim.running && ['events', 'eventstream', 'eventhouse'].includes(from)) || (from === 'source' && p.source?.method === 'mirror'));
    return { key: `${from}>${to}`, i, from, to, label: lbl, kind, state, live };
  });

  let next = null;
  if (!signedIn || !ws) next = 'workspace';
  else next = NEXT.find((id) => ['available', 'failed'].includes(nodes[id].state) && nodes[id].flag !== 'blocked') || null;
  for (const id of Object.keys(nodes)) nodes[id].next = id === next;
  workspace.next = next === 'workspace';

  const all = [...Object.values(nodes), workspace];
  return { nodes, workspace, edges, next, done: all.filter((n) => n.done).length, total: all.length, signedIn };
}

function statusText(n) {
  if (n.state === 'running') return n.job?.kind === 'teardown' ? 'Being deleted…' : `Working… ${n.job?.steps?.at(-1)?.label || ''}`.trim();
  if (n.flag === 'blocked' && !n.done) return `Can't run right now: ${n.reason?.text || ''}`;
  if (n.state === 'failed') return 'The last run didn\'t finish';
  if (n.state === 'done') return n.flag === 'blocked' ? 'Configured · changes paused' : 'Configured';
  if (n.state === 'available') return 'Ready to set up';
  return n.needs || 'Not available yet';
}

export function getNode(g, id) { return id === 'workspace' ? g.workspace : g.nodes[id]; }
export function upstream(g, id) { return g.edges.filter((e) => e.to === id).map((e) => g.nodes[e.from]); }
export function downstream(g, id) { return g.edges.filter((e) => e.from === id).map((e) => g.nodes[e.to]); }

/** What to ask Copilot about a part: set it up when it isn't there yet, otherwise use it. */
export function nodePrompt(id, s = store) {
  const p = s.project || {};
  const q = s.preset?.starterQuestions?.[0];
  switch (id) {
    case 'workspace': return 'List my Fabric capacities and help me create a new workspace for this project.';
    case 'source': case 'data': return p.modelSource ? 'Describe my data: the tables, their row counts and how they reach OneLake.' : 'Help me choose a data source: load a sample, or show me the lakehouses, warehouses and connections I could use.';
    case 'model': return p.semanticModel ? 'Review my semantic model against modeling best practices and suggest improvements.' : 'Describe my data, propose a star schema with business measures, and create the semantic model.';
    case 'ontology': return p.ontology ? 'Which business rules are defined in my ontology, and which ones are broken in my data?' : 'Read my glossary and deploy an ontology with entities, relationships and business rules.';
    case 'reports': return p.reports?.length ? 'Which report should I build next for my semantic model, and why?' : 'Recommend the best Power BI report for my semantic model: read studio_describe_report_options, explain the pages and theme you would use and why, then build it with studio_create_report after I confirm.';
    case 'orgapp': return 'Bundle my Power BI reports into an org app for business users.';
    case 'planning': return p.planning ? 'Are we on plan? Where are we ahead or behind budget?' : 'Recommend a budget and forecast for next year from my actuals.';
    case 'planitem': return 'Create the Fabric plan for my budget so planners can refine it in planning sheets.';
    case 'answers': return q || 'What are the key numbers in my semantic model?';
    case 'agent': return 'How do I share these governed answers in Microsoft Teams and Microsoft 365 Copilot?';
    case 'dashboard': return 'Build the Real-Time Dashboard for my live data.';
    case 'alerts': return 'Alert me in Teams when a business rule is broken.';
    default: return p.realtime ? 'What is happening in my live data right now?' : 'Stream live events shaped like my data and build a real-time dashboard.';
  }
}

// ---------------- drawing ----------------
const SIZES = {
  full: { padL: 34, padR: 14, top: 70, nh: 60, rh: 82, lane: 20, frameTop: 20, colY: 40, bottom: 44, nwMax: 212, nwGap: 58, step: 9, arrow: 6, dot: 2.6, clear: 14, bend: 46 },
  compact: { padL: 30, padR: 12, top: 50, nh: 36, rh: 46, lane: 12, frameTop: 14, colY: 28, bottom: 28, nwMax: 182, nwGap: 46, step: 6, arrow: 5, dot: 2, clear: 9, bend: 34 },
};

/**
 * Mounts the map in `root`. onNode(id, 'click' | 'open') is called for a part (or 'workspace'); onTab(view) for the
 * header tabs. update({ view, selected }) redraws it from the store.
 */
export function mountMap(root, { onNode, onTab }) {
  const uid = Math.random().toString(36).slice(2, 7);
  let mode = '';
  let view = 'home';
  let selected = null;
  let graph = null;
  let geo = null;
  let folded = (() => { try { return localStorage.getItem('studioMapFolded') === '1'; } catch { return false; } })();
  let moveTimer = null;

  const hd = h('div', { class: 'maphd' });
  const canvas = h('div', { class: 'lmap' });
  const scroller = h('div', { class: 'mapscroll' }, canvas);
  root.replaceChildren(hd, scroller);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ledges');
  const defs = document.createElementNS(NS, 'defs');
  const gEdges = document.createElementNS(NS, 'g');
  svg.append(defs, gEdges);
  const colh = COLS.map((t) => h('div', { class: 'lcolh' }, t));
  const lanes = [h('div', { class: 'llane' }, 'Analytics'), h('div', { class: 'llane' }, 'Real-time')];
  const sep = h('div', { class: 'lsep' });
  const fhead = h('button', { class: 'lfhead', type: 'button' });
  const frame = h('div', { class: 'lframe' }, fhead);
  const labels = h('div', { class: 'llabels' });
  canvas.append(frame, sep, ...lanes, ...colh, svg, labels);
  const els = {};
  for (const d of DEFS) {
    const b = h('button', { class: 'lnode off', type: 'button', 'data-id': d.id });
    b.style.setProperty('--nc', CAT[d.cat]);
    canvas.append(b);
    els[d.id] = b;
  }
  const hover = h('div', { class: 'lhover', role: 'tooltip' });
  document.body.append(hover);

  const fire = (id, how) => { hideHover(); onNode?.(id, how); };
  for (const [id, b] of [...Object.entries(els), ['workspace', fhead]]) {
    b.addEventListener('click', () => fire(id, 'click'));
    b.addEventListener('dblclick', () => fire(id, 'open'));
    b.addEventListener('mouseenter', () => showHover(id, b));
    b.addEventListener('focus', () => showHover(id, b));
    b.addEventListener('mouseleave', hideHover);
    b.addEventListener('blur', hideHover);
  }

  new ResizeObserver(() => { if (!root.classList.contains('folded') && graph) { layout(); drawEdges(); } }).observe(scroller);

  function update(opts = {}) {
    if (opts.view !== undefined) view = opts.view;
    if (opts.selected !== undefined) selected = opts.selected;
    graph = buildGraph();
    const next = view === 'home' ? 'full' : UTILITY.has(view) ? 'mini' : 'compact';
    const changed = next !== mode && mode !== '';
    mode = next;
    renderHeader();
    const fold = mode === 'mini' || (mode === 'compact' && folded);
    root.classList.toggle('folded', fold);
    root.classList.toggle('full', mode === 'full');
    canvas.classList.toggle('compact', mode !== 'full');
    paint();
    if (fold) return;
    if (changed && geo) {
      canvas.classList.add('moving');
      layout();
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => { canvas.classList.remove('moving'); layout(); drawEdges(); }, 300);
    } else { layout(); drawEdges(); }
  }

  function renderHeader() {
    const g = graph;
    const pct = Math.round((g.done / g.total) * 100);
    const running = [...(store.jobs?.values?.() || [])].filter((j) => j.status === 'running').length;
    const tab = (id, label, extra) => h('button', { type: 'button', class: view === id ? 'on' : '', onclick: () => onTab?.(id) }, label, extra);
    const fold = mode === 'compact' ? h('button', { type: 'button', class: 'mapfold', title: folded ? 'Show the map' : 'Hide the map', 'aria-expanded': String(!folded), onclick: () => { folded = !folded; try { localStorage.setItem('studioMapFolded', folded ? '1' : '0'); } catch { /* ignore */ } update(); } }, folded ? 'Show map' : 'Hide map', h('span', { class: `chev ${folded ? '' : 'up'}` })) : null;
    fill(hd, 
      h('div', { class: 'mapttl' },
        h('span', { class: 'mapic', html: icon('map') }),
        h('button', { type: 'button', class: 'mapname', onclick: () => onTab?.('home'), title: 'Overview' }, 'Solution map'),
        VIEW_LABEL[view] && view !== 'home' ? h('span', { class: 'crumb' }, h('span', { class: 'sepc' }, '›'), VIEW_LABEL[view]) : null,
        h('span', { class: 'mprog', title: `${g.done} of ${g.total} parts configured` }, h('span', { class: 'mbar' }, h('i', { style: { width: `${pct}%` } })), `${g.done} of ${g.total} in place`)),
      mode === 'full' ? h('div', { class: 'mlegend' },
        h('span', {}, h('i', { class: 'lg on' }), 'Configured'),
        h('span', {}, h('i', { class: 'lg av' }), 'Ready to set up'),
        h('span', {}, h('i', { class: 'lg off' }), 'Needs an earlier step'),
        h('span', {}, h('i', { class: 'lg bl' }), 'Can\'t run')) : null,
      h('nav', { class: 'mtabs', 'aria-label': 'Sections' },
        tab('home', 'Overview'), tab('copilot', '✦ Copilot'), tab('activity', 'Activity', running ? h('span', { class: 'cnt' }, running) : null), tab('settings', 'Settings')),
      fold);
  }

  function badge(n) {
    if (n.state === 'running') return h('span', { class: 'lbadge run' }, h('span', { class: 'spin' }));
    if (n.flag === 'blocked' && !n.done) return h('span', { class: 'lbadge err', html: icon('lock') });
    if (n.state === 'failed') return h('span', { class: 'lbadge err' }, '!');
    if (n.live) return h('span', { class: 'lbadge live' }, 'Live');
    if (n.next) return h('span', { class: 'lbadge next' }, 'Next');
    if (n.done) return h('span', { class: `lbadge ${n.flag === 'blocked' ? 'err' : 'ok'}` }, n.flag === 'blocked' ? '!' : '✓');
    if (n.flag === 'limited') return h('span', { class: 'lbadge warn' }, '!');
    return null;
  }

  function paint() {
    const g = graph;
    for (const d of DEFS) {
      const n = g.nodes[d.id];
      const b = els[d.id];
      const sel = mode === 'full' ? selected === d.id : d.view === view;
      b.className = ['lnode', n.state, n.flag ? `f-${n.flag}` : '', n.next ? 'next' : '', sel ? 'sel' : '', n.live ? 'live' : ''].filter(Boolean).join(' ');
      b.setAttribute('aria-label', `${n.type}: ${n.title}. ${n.status}`);
      if (mode === 'full') b.title = `${n.title}${n.state === 'off' ? '' : ` · ${n.sub}`}\n${n.status}`; else b.removeAttribute('title');
      // Only rebuild the content when it changed: replacing it between two clicks would swallow a double-click.
      const bd = badge(n);
      const sig = JSON.stringify([n.icon, n.type, n.title, n.sub, n.needs, n.state, bd?.className, bd?.textContent]);
      if (b.dataset.sig === sig) continue;
      b.dataset.sig = sig;
      fill(b,
        h('span', { class: 'lic', html: icon(n.icon) }),
        h('span', { class: 'ltx' }, h('span', { class: 'lty' }, n.type), h('span', { class: 'lti' }, n.title), h('span', { class: 'lsu' }, n.state === 'off' ? n.needs : n.sub)),
        bd);
    }
    const w = g.workspace;
    const wsSel = mode === 'full' ? selected === 'workspace' : view === 'workspace';
    frame.className = ['lframe', w.done ? 'on' : 'off', w.next ? 'next' : '', wsSel ? 'sel' : ''].filter(Boolean).join(' ');
    fhead.className = ['lfhead', w.done ? 'on' : 'off', w.next ? 'next' : '', wsSel ? 'sel' : ''].filter(Boolean).join(' ');
    fhead.setAttribute('aria-label', `Workspace: ${w.title}. ${w.status}`);
    const wsig = JSON.stringify([w.title, w.done, w.state, w.next, w.role, w.paused, w.capacity?.sku]);
    if (fhead.dataset.sig === wsig) return;
    fhead.dataset.sig = wsig;
    fill(fhead,
      h('span', { class: 'fic', html: icon('workspace') }),
      h('span', { class: 'fname' }, w.title),
      w.done && w.capacity ? h('span', { class: `fchip ${w.paused ? 'err' : ''}` }, `${w.capacity.sku} · ${w.paused ? 'Paused' : 'Running'}`) : null,
      w.done && w.role ? h('span', { class: 'fchip' }, w.role) : null,
      w.state === 'running' ? h('span', { class: 'spin' }) : null,
      !w.done && w.next ? h('span', { class: 'fcta' }, 'Start here') : null);
  }

  function layout() {
    const S = SIZES[mode === 'full' ? 'full' : 'compact'];
    const W = Math.max(980, scroller.clientWidth || 0);
    const colW = (W - S.padL - S.padR) / 5;
    const nw = Math.min(S.nwMax, colW - Math.max(36, Math.min(S.nwGap, colW * 0.24)));
    const rowY = (r) => S.top + r * S.rh + (r >= 3 ? S.lane : 0);
    const pos = {};
    for (const d of DEFS) pos[d.id] = { x: S.padL + d.c * colW + (colW - nw) / 2, y: rowY(d.r), w: nw, h: S.nh };
    const H = rowY(3) + S.nh + S.bottom;
    geo = { S, W, H, colW, nw, pos, rowY };
    canvas.style.height = `${H}px`;
    for (const d of DEFS) {
      const q = pos[d.id];
      Object.assign(els[d.id].style, { left: `${q.x}px`, top: `${q.y}px`, width: `${q.w}px`, height: `${q.h}px` });
    }
    colh.forEach((el, c) => { Object.assign(el.style, { left: `${S.padL + c * colW + colW / 2}px`, top: `${S.colY}px` }); });
    const fl = pos.data.x - 18;
    Object.assign(frame.style, { left: `${fl}px`, top: `${S.frameTop}px`, width: `${pos.alerts.x + nw + 18 - fl}px`, height: `${H - S.frameTop - 10}px` });
    const a0 = rowY(0) - 6;
    const a1 = rowY(2) + S.nh + 6;
    const midSep = (rowY(2) + S.nh + rowY(3)) / 2;
    Object.assign(lanes[0].style, { top: `${(a0 + a1) / 2}px` });
    Object.assign(lanes[1].style, { top: `${rowY(3) + S.nh / 2}px` });
    Object.assign(sep.style, { top: `${midSep}px`, left: `${S.padL - 6}px`, width: `${W - S.padL - S.padR + 6}px` });
  }

  function drawEdges() {
    const { S, pos } = geo;
    const g = graph;
    defs.replaceChildren();
    gEdges.replaceChildren();
    labels.replaceChildren();
    // Spread the ends of several edges on the same side of a part so they don't overlap.
    const off = new Map();
    const outs = {};
    const ins = {};
    for (const e of g.edges) if (e.kind === 'h') { (outs[e.from] ||= []).push(e); (ins[e.to] ||= []).push(e); }
    for (const list of Object.values(outs)) { list.sort((a, b) => pos[a.to].y - pos[b.to].y); list.forEach((e, i) => off.set(`${e.key}:o`, (i - (list.length - 1) / 2) * S.step)); }
    for (const list of Object.values(ins)) { list.sort((a, b) => pos[a.from].y - pos[b.from].y); list.forEach((e, i) => off.set(`${e.key}:i`, (i - (list.length - 1) / 2) * S.step)); }
    // Draw the inactive edges first so the configured ones sit on top.
    const order = [...g.edges].sort((a, b) => ['off', 'ready', 'on'].indexOf(a.state) - ['off', 'ready', 'on'].indexOf(b.state));
    for (const e of order) {
      const a = pos[e.from];
      const b = pos[e.to];
      let p0; let p1; let p2; let p3;
      if (e.kind === 'up') {
        p0 = [a.x + a.w / 2, a.y]; p3 = [b.x + b.w / 2, b.y + b.h];
        p1 = [p0[0], p0[1] - 10]; p2 = [p3[0], p3[1] + 10];
      } else if (e.kind === 'arc') {
        const mid = pos.dashboard;
        const y0 = a.y + a.h * 0.74;
        const y3 = b.y + b.h * 0.74;
        const py = (8 * (mid.y + mid.h + S.clear) - y0 - y3) / 6;
        p0 = [a.x + a.w, y0]; p3 = [b.x, y3]; p1 = [p0[0] + S.bend, py]; p2 = [p3[0] - S.bend, py];
      } else {
        const y0 = a.y + a.h / 2 + (off.get(`${e.key}:o`) || 0);
        const y3 = b.y + b.h / 2 + (off.get(`${e.key}:i`) || 0);
        p0 = [a.x + a.w, y0]; p3 = [b.x, y3];
        const dx = Math.max(22, (p3[0] - p0[0]) * 0.5);
        p1 = [p0[0] + dx, y0]; p2 = [p3[0] - dx, y3];
      }
      const ux = p3[0] - p2[0];
      const uy = p3[1] - p2[1];
      const len = Math.hypot(ux, uy) || 1;
      const [dx, dy] = [ux / len, uy / len];
      const end = [p3[0] - dx * S.arrow * 0.9, p3[1] - dy * S.arrow * 0.9];
      const d = `M${p0[0]},${p0[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${end[0]},${end[1]}`;
      const ca = CAT[DEF[e.from].cat];
      const cb = CAT[DEF[e.to].cat];
      let stroke = null;
      if (e.state === 'on') {
        const gid = `lg-${uid}-${e.i}`;
        const lg = svgEl('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: p0[0], y1: p0[1], x2: p3[0], y2: p3[1] });
        lg.append(svgEl('stop', { offset: '0', 'stop-color': ca }), svgEl('stop', { offset: '1', 'stop-color': cb }));
        defs.append(lg);
        stroke = `url(#${gid})`;
      }
      const path = svgEl('path', { d, class: `le ${e.state}` });
      if (stroke) path.setAttribute('stroke', stroke);
      gEdges.append(path);
      if (e.live) gEdges.append(svgEl('path', { d, class: 'lflow', stroke: cb }));
      const tip = [p3, [p3[0] - dx * S.arrow - dy * S.arrow * 0.62, p3[1] - dy * S.arrow + dx * S.arrow * 0.62], [p3[0] - dx * S.arrow + dy * S.arrow * 0.62, p3[1] - dy * S.arrow - dx * S.arrow * 0.62]];
      const arr = svgEl('path', { d: `M${tip.map((t) => t.join(',')).join(' L')} Z`, class: `larr ${e.state}` });
      if (e.state === 'on') arr.setAttribute('fill', cb);
      gEdges.append(arr);
      const dot = svgEl('circle', { cx: p0[0], cy: p0[1], r: S.dot, class: `ldot ${e.state}` });
      if (e.state === 'on') dot.setAttribute('fill', ca);
      gEdges.append(dot);
      if (mode === 'full' && e.label && geo.colW - geo.nw >= 52) {
        const m = e.kind === 'up' ? [p0[0] + 8, (p0[1] + p3[1]) / 2] : bez(p0, p1, p2, p3, 0.5);
        labels.append(h('span', { class: `elabel ${e.state} ${e.kind === 'up' ? 'side' : ''}`, style: { left: `${m[0]}px`, top: `${m[1]}px` } }, e.label));
      }
    }
  }

  function showHover(id, el) {
    if (mode === 'full' || !graph) return;
    const n = getNode(graph, id);
    if (!n) return;
    hover.style.setProperty('--nc', CAT[n.cat]);
    fill(hover, 
      h('div', { class: 'lhty' }, n.type),
      h('b', {}, n.title),
      n.sub && n.state !== 'off' ? h('div', { class: 'muted' }, n.sub) : null,
      h('div', { class: `lhst ${n.state} ${n.flag || ''}` }, h('i'), n.status),
      h('div', { class: 'tiny muted' }, `Select to open ${VIEW_LABEL[n.view]}`));
    const r = el.getBoundingClientRect();
    hover.classList.add('on');
    const hh = hover.offsetHeight;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - hover.offsetWidth - 8);
    const below = r.bottom + 8 + hh < window.innerHeight;
    Object.assign(hover.style, { left: `${left}px`, top: `${below ? r.bottom + 8 : r.top - hh - 8}px` });
  }
  function hideHover() { hover.classList.remove('on'); }

  return { update, graph: () => graph };
}

// Element.replaceChildren() would print null as text; skip empty slots.
function fill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); }

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function bez(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]);
}
