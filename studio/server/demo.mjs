// Safe demo mode (STUDIO_DEMO=1): training/screenshot data, no Fabric calls and no changes.
import { BUILD, VERSION, publicSettings, pendingUpdate } from './config.mjs';
import { catalog } from './sources.mjs';
import { presetSummary } from './presets.mjs';
import { listJobs } from './jobs.mjs';
import { PROVIDERS, visibleProviders, providerSummary } from './agent.mjs';
import { reportsCatalog } from './reports/index.mjs';

const WS = { id: '11111111-1111-4111-8111-111111111111', name: 'Demo_Sales_WS_DEV', capacityId: 'demo-capacity', created: true };
const MODEL = { id: '33333333-3333-4333-8333-333333333333', name: 'Demo_SM_Sales_DEV', workspaceId: WS.id, workspaceName: WS.name, origin: 'studio', storageMode: 'DirectLake', tables: 7, measures: 18, relationships: 9, sourceItemId: '22222222-2222-4222-8222-222222222222' };

export const demoProject = {
  id: 'demo-project', name: 'Demo project', createdAt: new Date().toISOString(),
  tenant: { id: 'demo-tenant', domain: 'demo.contoso.com' },
  naming: { domain: 'Demo', environment: 'DEV', intent: 'Training', inferred: false },
  scenario: 'byod',
  workspace: WS,
  source: { kind: 'fabric', type: 'Lakehouse', itemType: 'Lakehouse', itemName: 'Demo_LH_Sales_DEV', label: 'Lakehouse · Demo_LH_Sales_DEV', method: 'in-place', itemId: MODEL.sourceItemId, workspaceId: WS.id },
  modelSource: { itemType: 'Lakehouse', itemId: MODEL.sourceItemId, itemName: 'Demo_LH_Sales_DEV', workspaceId: WS.id },
  lakehouse: null, sqlDatabase: null, semanticModel: MODEL, semanticModels: [MODEL],
  reports: [{ id: '44444444-4444-4444-8444-444444444444', name: 'Demo_RPT_Executive_DEV', semanticModelId: MODEL.id, builtAt: new Date().toISOString() }],
  ontology: { id: '55555555-5555-4555-8555-555555555555', name: 'Demo_ONT_Sales_DEV', entities: [{ name: 'Customer' }, { name: 'Product' }], rules: ['High value order'] },
  orgApp: null, dataAgent: null, realtime: null, planning: null, taskFlow: null, planStore: null, dataPrep: null, dataPrepItems: [], glossary: 'Demo sales glossary', teamsAgent: null,
  steps: { workspace: { status: 'done', note: WS.name }, data: { status: 'done', note: 'Demo data connected' }, model: { status: 'done', note: MODEL.name }, reports: { status: 'done', note: 'Executive report' } },
  sourceKey: `in-place:${WS.id}:${MODEL.sourceItemId}`,
  sources: [{ key: `in-place:${WS.id}:${MODEL.sourceItemId}`, label: 'Lakehouse · Demo_LH_Sales_DEV', addedAt: new Date().toISOString(), savedAt: null, state: null }],
};

const user = { signedIn: true, name: 'Demo User', upn: 'demo.user@contoso.com', tenantId: 'demo-tenant', tenantDomain: 'demo.contoso.com', mode: 'demo' };
const readiness = { at: new Date().toISOString(), modules: {}, checks: [], ready: true };
const ok = (body, status = 200) => ({ status, body });
const blocked = () => ok({ error: 'Safe demo mode is read-only. Start the studio without STUDIO_DEMO=1 to make changes in Fabric.', code: 'DEMO_MODE' }, 403);

const profile = {
  model: MODEL.name,
  tables: [{ name: 'Sales', rows: 120000 }, { name: 'Customer', rows: 1800 }, { name: 'Product', rows: 400 }, { name: 'Date', rows: 1826 }],
  measures: [{ table: 'Sales', name: 'Revenue' }, { table: 'Sales', name: 'Margin %' }, { table: 'Sales', name: 'Orders' }],
  relationships: [{ from: 'Sales[CustomerKey]', to: 'Customer[CustomerKey]' }],
  insights: ['Revenue, margin and orders are available by product, customer and date.'],
  geoInfo: { mode: 'locations', places: [{ table: 'Customer', column: 'Country' }, { table: 'Customer', column: 'State' }] },
};

const costs = {
  status: 'ok', install: { url: 'https://appsource.microsoft.com/' }, pricingPage: 'https://azure.microsoft.com/pricing/details/microsoft-fabric/',
  projectWorkspace: WS, capacities: [{ id: WS.capacityId, name: 'Demo F16', sku: 'F16', state: 'Running' }],
  selectedCapacityId: WS.capacityId, selectedCapacity: { id: WS.capacityId, name: 'Demo F16', sku: 'F16', state: 'Running' },
  metricsApp: { name: 'Demo Capacity Metrics', reportUrl: '#' },
  pricing: { available: true, cu: 16, hourly: 2.94, paygMonthly: 2146, reservationMonthly: 1275, reservationSavingsMonthly: 871, note: 'Demo estimate.' },
  summary: {
    avgUtil: 22, peak: 78, maxDelay: 0, maxReject: 0, maxCarry: 12,
    timeline: [{ at: new Date().toISOString(), interactive: 220, background: 80, limit: 480 }],
    overage: [{ at: new Date().toISOString(), add: 0, burndown: 5, cumulative: 12 }],
    byWorkspace: [{ key: WS.name, cu: 56000, operations: 140, users: 6 }],
    byItem: [{ item: 'Demo_RPT_Executive_DEV', itemKind: 'Report', workspace: WS.name, cu: 28000, duration: 7200, operations: 80 }],
    byOperation: [{ key: 'Query', cu: 32000, operations: 120, topItem: 'Demo_RPT_Executive_DEV', topItemKind: 'Report', topWorkspace: WS.name }],
    byKind: [{ key: 'Report', cu: 32000, operations: 120 }, { key: 'SemanticModel', cu: 24000, operations: 20 }],
    byUser: [{ key: 'demo.user@contoso.com', cu: 26000, operations: 64 }], interactiveCu: 36000, backgroundCu: 20000,
    recommendations: ['Start with Demo_RPT_Executive_DEV (Report). It used 28,000 CU seconds across 80 operations. Tune this artifact before changing capacity size.', 'Operation to investigate: Query. If it is user-triggered, reduce result size and add aggregations where applicable.'],
  },
  lastRefresh: new Date().toISOString(),
};

export function demoApi(method, pathname) {
  if (!['GET', 'HEAD'].includes(method)) return blocked();
  if (pathname === '/api/bootstrap') return ok({ version: VERSION, build: BUILD, update: pendingUpdate(), user, settings: publicSettings(), provider: providerSummary(), providers: visibleProviders(), project: demoProject, preset: presetSummary(demoProject), naming: null, catalog: catalog(), jobs: listJobs(), chats: [], approvals: [], realtime: { available: true, simulator: { running: false } }, planning: { available: true }, readiness, platform: process.platform, demoMode: true });
  if (pathname === '/api/health') return ok({ at: new Date().toISOString(), ready: true, checks: [{ id: 'demo', label: 'Safe demo mode', status: 'ok', detail: 'No Fabric calls are made.' }] });
  if (pathname === '/api/providers') return ok({ providers: visibleProviders(), current: providerSummary(), settings: publicSettings().provider });
  if (pathname === '/api/copilot/status') return ok({ ok: true, isAuthenticated: true, statusMessage: 'Demo mode' });
  if (pathname === '/api/copilot/models') return ok([{ id: 'auto', name: 'auto (demo)' }]);
  if (pathname === '/api/openrouter/models') return ok([{ id: 'openrouter/auto', name: 'Auto Router', price: { input: 0, output: 0 }, context: 2000000 }]);
  if (pathname === '/api/fabric/capacities') return ok([{ id: WS.capacityId, name: 'Demo F16', sku: 'F16', state: 'Running', region: 'demo' }]);
  if (pathname === '/api/fabric/workspaces') return ok([{ id: WS.id, name: WS.name, capacityId: WS.capacityId, type: 'Workspace', description: 'Safe demo workspace' }]);
  if (/^\/api\/fabric\/workspaces\/[^/]+\/items$/.test(pathname)) return ok([{ id: MODEL.sourceItemId, name: 'Demo_LH_Sales_DEV', type: 'Lakehouse' }, { id: MODEL.id, name: MODEL.name, type: 'SemanticModel' }]);
  if (pathname === '/api/project') return ok(demoProject);
  if (pathname === '/api/preset') return ok(presetSummary(demoProject));
  if (pathname === '/api/sources/catalog') return ok(catalog());
  if (pathname === '/api/sources/contexts') return ok({ active: demoProject.sourceKey, sources: [{ key: demoProject.sourceKey, active: true, label: demoProject.source.label, data: { itemType: 'Lakehouse', name: 'Demo_LH_Sales_DEV', itemId: MODEL.sourceItemId, workspaceId: WS.id }, models: [MODEL.name], reports: 1, ontology: demoProject.ontology.name }] });
  if (pathname === '/api/sources/workspace') return ok({ workspace: { id: WS.id, name: WS.name, project: true }, projectWorkspace: WS, active: demoProject.sourceKey, items: [{ itemId: MODEL.sourceItemId, itemType: 'Lakehouse', name: 'Demo_LH_Sales_DEV', workspaceId: WS.id, sources: [{ key: demoProject.sourceKey, active: true, label: demoProject.source.label, data: { itemType: 'Lakehouse', name: 'Demo_LH_Sales_DEV', itemId: MODEL.sourceItemId, workspaceId: WS.id }, models: [MODEL.name], reports: 1, ontology: demoProject.ontology.name }] }], others: [], byWorkspace: [{ workspaceId: WS.id, name: WS.name, active: true, sources: [] }] });
  if (pathname === '/api/model/describe') return ok({ source: demoProject.modelSource, tables: profile.tables });
  if (pathname === '/api/models') return ok({ active: MODEL.id, models: [{ ...MODEL, active: true, reports: demoProject.reports, tables: 4, measures: 3, relationships: 1 }] });
  if (pathname === '/api/models/available') return ok({ workspaceId: WS.id, models: [{ id: MODEL.id, name: MODEL.name, inProject: true, isDefault: false }] });
  if (pathname === '/api/reports/catalog') return ok(reportsCatalog());
  if (pathname === '/api/reports/profile') return ok(profile);
  if (pathname === '/api/reports/recommendations') return ok({ recommendations: [{ id: 'executive', title: 'Executive overview', reason: 'Demo recommendation', pages: ['executive'] }], insights: profile.insights, rules: { source: 'demo', count: 0, values: [] } });
  if (pathname === '/api/costs') return ok(costs);
  if (pathname === '/api/taskflow') return ok({ available: true, workspace: WS, templates: [{ id: 'medallion', name: 'Medallion', description: 'Demo medallion flow', tasks: 9 }], existing: [], plan: { name: 'Demo_TF_Sales_DEV', tasks: [], edges: [], unassigned: [], count: 0 }, applied: null, upToDate: false });
  if (pathname === '/api/realtime') return ok({ available: true, setup: {}, simulator: { running: false }, limits: {} });
  if (pathname === '/api/planning') return ok({ available: true, writable: true, model: MODEL, plan: null });
  if (pathname === '/api/activity') return ok({ artifacts: [], log: [{ at: new Date().toISOString(), kind: 'demo', title: 'Safe demo mode' }] });
  if (pathname === '/api/jobs') return ok(listJobs());
  if (pathname === '/api/chats') return ok([]);
  if (pathname === '/api/approvals') return ok([]);
  return null;
}
