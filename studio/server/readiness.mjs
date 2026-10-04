// Up-front checks: what each module needs from the environment (capacity, workspace role, tenant settings, data
// source, platform) and whether it can run. Modules that can't run are greyed out in the UI with the reason, and jobs
// stop before they change anything. Everything here is read-only.
import { getToken, SCOPES, currentIdentity } from './auth.mjs';
import { fabric } from './fabric.mjs';
import { getProject } from './project.mjs';
import { scenarioKind } from './realtime/scenarios.mjs';

const PBI = 'https://api.powerbi.com/v1.0/myorg';
const TTL_MS = 2 * 60 * 1000;
export const MODULES = ['workspace', 'data', 'model', 'ontology', 'reports', 'realtime', 'planning', 'share'];
const LABELS = { workspace: 'Workspace', data: 'Data', model: 'Semantic model', ontology: 'Ontology', reports: 'Reports & apps', realtime: 'Real-time', planning: 'Planning', share: 'Ask & share' };
const ADMIN_PORTAL = 'https://app.fabric.microsoft.com/admin-portal/tenantSettings';
const CAPACITY_PORTAL = 'https://app.fabric.microsoft.com/admin-portal/capacities';
const AZURE_FABRIC = 'https://portal.azure.com/#browse/Microsoft.Fabric%2Fcapacities';

// Tenant settings the modules depend on (Fabric admin portal › Tenant settings).
const TENANT = {
  FabricGAWorkloads: 'Users can create Fabric items',
  OntologyPreview: 'Users can create Ontology (preview) items',
  DatasetExecuteQueries: 'Semantic Model Execute Queries REST API',
  AllowNonEntraADAuthInEventStream: 'Allow non-Entra ID auth in Eventstream',
  OnPremAnalyzeInExcel: 'Allow XMLA endpoints and Analyze in Excel with on-premises semantic models',
  PowerBIMCP: 'Users can use the Power BI Model Context Protocol server endpoints (preview)',
  ExportToPowerPoint: 'Export reports as PowerPoint presentations or PDF documents',
  EnableAOAI: 'Users can use Copilot, AI Agents and other AI experiences powered by Azure OpenAI',
  CreateAppWorkspaces: 'Create workspaces',
  ShareToTeamsTenant: 'Enable Microsoft Teams integration',
};

let cache = { key: '', at: 0, data: null, pending: null };

async function pbi(path) {
  const token = await getToken(SCOPES.powerbi);
  const r = await fetch(`${PBI}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

/** The workspace's capacity: name, SKU, state and whether the user administers it (null fields when not visible). */
async function capacityInfo(capacityId) {
  if (!capacityId) return null;
  const id = capacityId.toLowerCase();
  const [fab, pb] = await Promise.all([
    fabric('GET', '/capacities').then((r) => r?.value || []).catch(() => []),
    pbi('/capacities').then((r) => r?.value || []).catch(() => []),
  ]);
  const f = fab.find((c) => c.id?.toLowerCase() === id);
  const p = pb.find((c) => c.id?.toLowerCase() === id);
  if (!f && !p) return { id: capacityId, visible: false };
  const sku = f?.sku || p?.sku || '';
  const info = {
    id: capacityId, visible: true, name: f?.displayName || p?.displayName || '', sku, region: f?.region || p?.region || '',
    state: f?.state || p?.state || 'Unknown', admin: p?.capacityUserAccessRight === 'Admin',
    trial: /^FT/i.test(sku), ppu: /^PP/i.test(sku), paid: /^(F\d+|P\d|A\d|EM\d)$/i.test(sku),
  };
  // Workload switches are visible to capacity admins only.
  if (info.admin) {
    info.workloads = await pbi(`/capacities/${capacityId}/Workloads`).then((r) => Object.fromEntries((r?.value || []).map((w) => [w.name, w.state]))).catch(() => null);
  }
  return info;
}

/** The user's role in the workspace: Admin, Member, Contributor, Viewer, or null when it can't be read. */
async function workspaceRole(workspaceId) {
  if (!workspaceId) return null;
  const me = currentIdentity();
  try {
    const r = await fabric('GET', `/workspaces/${workspaceId}/roleAssignments`);
    const mine = (r?.value || []).find((a) => a.principal?.id && me?.oid && a.principal.id.toLowerCase() === me.oid.toLowerCase());
    return { role: mine?.role || null, viaGroup: !mine, canList: true };
  } catch (e) {
    // Listing members needs Member or higher: a Contributor or Viewer gets 401/403 here.
    return { role: null, viaGroup: false, canList: false, error: e.status || e.message };
  }
}

/** Tenant settings by name, or null when the user isn't a Fabric administrator. */
async function tenantSettings() {
  try {
    const r = await fabric('GET', '/admin/tenantsettings');
    const list = r?.tenantSettings || r?.value || [];
    return Object.fromEntries(list.map((s) => [s.settingName, { enabled: Boolean(s.enabled), groups: (s.enabledSecurityGroups || []).length, title: s.title }]));
  } catch {
    return null;
  }
}

/** One requirement on a module. status: error (blocks), warn (partly limited), info, unknown (couldn't check). */
const req = (status, text, fix = '', link = '') => ({ status, text, fix, link });

function tenantReq(ts, name, { blocks = true, impact = '' } = {}) {
  const title = TENANT[name] || name;
  if (!ts) return req('unknown', `Tenant setting "${title}" couldn't be checked (needs a Fabric administrator).`, impact ? `If it's off: ${impact}` : 'Ask your Fabric administrator to confirm it is on.', ADMIN_PORTAL);
  const s = ts[name];
  if (!s) return null;
  if (!s.enabled) return req(blocks ? 'error' : 'warn', `Tenant setting "${title}" is off.${impact ? ` ${impact}` : ''}`, 'A Fabric administrator can turn it on in Admin portal › Tenant settings.', ADMIN_PORTAL);
  if (s.groups) return req('info', `Tenant setting "${title}" is on for ${s.groups} security group${s.groups === 1 ? '' : 's'} – you need to be in one of them.`, '', ADMIN_PORTAL);
  return null;
}

/** Compute the checks and per-module readiness for the current project. */
async function compute() {
  const p = getProject();
  const ws = p.workspace;
  const [cap, role, ts] = await Promise.all([
    ws ? fabric('GET', `/workspaces/${ws.id}`).then((w) => capacityInfo(w?.capacityId)).catch(() => ({ id: null, visible: false })) : null,
    ws ? workspaceRole(ws.id) : null,
    tenantSettings(),
  ]);
  return evaluate({ project: p, capacity: cap, role, tenant: ts, platform: process.platform, user: currentIdentity()?.upn || null });
}

/**
 * The rules: environment facts in, checks and per-module readiness out (no I/O, so every case can be tested).
 * capacity: capacityInfo() result; role: workspaceRole() result; tenant: tenantSettings() result (null = not visible).
 */
export function evaluate({ project: p, capacity: cap, role, tenant: ts, platform, user = null }) {
  const ws = p.workspace;
  const checks = [];
  const add = (id, label, status, detail, fix = '', link = '') => checks.push({ id, label, status, detail, fix, link });
  const mods = Object.fromEntries(MODULES.map((m) => [m, []]));
  const put = (list, r) => { if (r) for (const m of list) mods[m].push(r); };
  const fabricMods = ['data', 'model', 'ontology', 'reports', 'realtime', 'planning'];

  // Capacity of the project's workspace.
  if (!ws) add('ws-capacity', 'Workspace capacity', 'info', 'Select a workspace to check its capacity and your role.');
  else if (!cap) {
    const r = req('error', `${ws.name} isn't on a Fabric capacity.`, 'Assign the workspace to a Fabric capacity (F SKU, Premium or trial) in Workspace settings › License info.');
    add('ws-capacity', 'Workspace capacity', 'error', r.text, r.fix);
    put(fabricMods, r);
  }
  else if (!cap.visible) add('ws-capacity', 'Workspace capacity', 'unknown', 'The capacity isn\'t visible to you, so its state couldn\'t be checked.', 'If actions fail with "can\'t be queried", ask the capacity admin whether it is paused.');
  else {
    const label = `${cap.name} · ${cap.sku}${cap.region ? ` · ${cap.region}` : ''}`;
    if (cap.state !== 'Active') {
      const r = req('error', `The workspace's capacity ${cap.name} is ${cap.state === 'Inactive' ? 'paused' : cap.state.toLowerCase()}.`, 'Resume it in the Azure portal (Microsoft Fabric capacity › Resume), then select Check setup.', AZURE_FABRIC);
      add('ws-capacity', 'Workspace capacity', 'error', `${label} · ${cap.state === 'Inactive' ? 'Paused' : cap.state}`, r.fix, r.link);
      put(fabricMods, r);
      put(['share'], req('error', `The capacity ${cap.name} is paused – Fabric IQ and the agents can't answer.`, r.fix, r.link));
    } else add('ws-capacity', 'Workspace capacity', cap.trial ? 'warn' : 'ok', `${label} · Running${cap.admin ? ' · you are a capacity admin' : ''}`, cap.trial ? 'Trial capacity: everything works except the ontology endpoint for agents, which needs a paid F2+ or P1+ capacity.' : '');
    if (cap.trial) put(['ontology', 'share'], req('warn', 'Trial capacity: the ontology endpoint for agents (entities and rules) needs a paid F2+ or P1+ capacity.', 'Use a paid capacity for the Teams agent with ontology.'));
    if (cap.ppu) put(['planning'], req('warn', 'Premium Per User doesn\'t support Fabric planning (XMLA scenarios need an F SKU or Premium capacity).', 'Move the workspace to a Fabric capacity to use the plan in Fabric.'));
    const wl = cap.workloads;
    if (wl) {
      if (wl.Planning && wl.Planning !== 'Enabled') put(['planning'], req('warn', `The Planning workload is ${wl.Planning.toLowerCase()} on ${cap.name}.`, 'A capacity admin can enable it in the capacity settings.', CAPACITY_PORTAL));
      if (wl.SQLDb && wl.SQLDb !== 'Enabled') put(['data'], req('warn', `The SQL database workload is ${wl.SQLDb.toLowerCase()} on ${cap.name} – the AdventureWorks sample can't be created.`, 'A capacity admin can enable it in the capacity settings.', CAPACITY_PORTAL));
    }
  }

  // Role in the workspace.
  if (ws && role) {
    if (role.role === 'Viewer') {
      const r = req('error', `You're a Viewer in ${ws.name}, so the studio can't create or change items there.`, 'Ask a workspace admin for Contributor or higher, or use another workspace.');
      add('ws-role', 'Workspace role', 'error', 'Viewer', r.fix);
      put(fabricMods, r);
    } else if (role.role) {
      add('ws-role', 'Workspace role', 'ok', role.role);
    } else if (role.canList) {
      add('ws-role', 'Workspace role', 'info', 'Through a security group', '');
    } else {
      add('ws-role', 'Workspace role', 'info', 'Contributor or Viewer (members can\'t be listed)', 'Creating the AdventureWorks SQL database and some mirroring setups need Admin or Member.');
      put(['data'], req('info', 'Creating a Fabric SQL database (AdventureWorks sample) needs the Admin or Member role.', 'Ask a workspace admin if the sample fails with a permission error.'));
    }
    if (role.role === 'Contributor') put(['data'], req('warn', 'Creating a Fabric SQL database (AdventureWorks sample) needs the Admin or Member role.', 'Ask a workspace admin for Member, or use the Contoso Retail sample or your own data.'));
  }

  // Tenant settings (Fabric administrators can read them).
  if (!ts) add('tenant', 'Tenant settings', 'unknown', 'Only Fabric administrators can read tenant settings – each tab lists the ones it needs.', 'Ask your Fabric administrator to confirm the settings listed on each tab.', ADMIN_PORTAL);
  else {
    const off = Object.keys(TENANT).filter((k) => ts[k] && !ts[k].enabled);
    add('tenant', 'Tenant settings', off.length ? 'warn' : 'ok', off.length ? `Off: ${off.map((k) => TENANT[k]).join(' · ')}` : `All ${Object.keys(TENANT).length} settings the studio uses are on`, off.length ? 'A Fabric administrator can turn them on in Admin portal › Tenant settings.' : '', ADMIN_PORTAL);
  }
  put(['workspace'], tenantReq(ts, 'CreateAppWorkspaces', { blocks: false, impact: 'You can still use an existing workspace.' }));
  put(['data', 'ontology', 'realtime', 'planning'], tenantReq(ts, 'FabricGAWorkloads', { impact: 'SQL databases, Eventhouses, Eventstreams, Activators, ontologies and plans can\'t be created.' }));
  put(['ontology'], tenantReq(ts, 'OntologyPreview', { impact: 'Ontologies can\'t be created.' }));
  put(['reports', 'planning'], tenantReq(ts, 'DatasetExecuteQueries', { impact: 'The studio reads your model with this API to design reports and plans.' }));
  put(['model'], tenantReq(ts, 'DatasetExecuteQueries', { blocks: false, impact: 'Model checks and Copilot answers from the model don\'t work.' }));
  put(['model', 'reports'], tenantReq(ts, 'PowerBIMCP', { blocks: false, impact: 'Copilot\'s Power BI authoring tools are off; the studio\'s own buttons still work.' }));
  put(['reports'], tenantReq(ts, 'ExportToPowerPoint', { blocks: false, impact: 'Report previews aren\'t available; the reports still build.' }));
  put(['realtime'], tenantReq(ts, 'AllowNonEntraADAuthInEventStream', { blocks: false, impact: 'Live events and your own apps send to the Eventstream with a key, so the simulator can\'t send. Setup, the dashboard, the live ontology and alerts still work.' }));
  put(['planning'], tenantReq(ts, 'OnPremAnalyzeInExcel', { blocks: false, impact: 'The plan in Fabric needs XMLA endpoints; the budget, forecast and report still work.' }));
  put(['share'], tenantReq(ts, 'EnableAOAI', { blocks: false, impact: 'Fabric IQ answers and agents use Azure OpenAI.' }));
  put(['share'], tenantReq(ts, 'ShareToTeamsTenant', { blocks: false, impact: 'The agent can\'t be used in Teams.' }));
  if (ts?.OnPremAnalyzeInExcel?.enabled !== false) put(['planning'], req('info', 'Fabric planning also needs the capacity\'s XMLA endpoint set to Read Only or Read Write (not readable through an API).', 'Check Admin portal › Capacity settings › your capacity › Power BI workloads › XMLA Endpoint.', CAPACITY_PORTAL));

  // Data source and model capabilities.
  const ms = p.modelSource;
  if (ms && !['SQLDatabase', 'Warehouse'].includes(ms.itemType)) {
    put(['planning'], req('warn', `Plans are written next to your data, and ${ms.itemName} (${{ Lakehouse: 'lakehouse', MirroredDatabase: 'mirrored database' }[ms.itemType] || ms.itemType}) can't be written to yet – you can preview the plan but not build it.`, 'Use a Fabric SQL database or a warehouse (for example the AdventureWorks sample).'));
  }
  if (p.realtime && scenarioKind(p) === 'generic') {
    put(['realtime'], req('info', 'Live events for your model carry names, not entity keys, so the live ontology can\'t bind them to entity types.', 'Live ontology works with the samples, or with your own events that include the entity keys.'));
  }
  if (platform !== 'win32') put(['share'], req('warn', 'The Teams agent installer is a PowerShell script for Windows.', 'Run scripts/install-teams-agent.ps1 with PowerShell 7 on macOS or Linux.'));

  const order = { error: 3, warn: 2, unknown: 1, info: 0 };
  const modules = Object.fromEntries(MODULES.map((m) => {
    const reasons = mods[m].sort((a, b) => order[b.status] - order[a.status]);
    const status = reasons.some((r) => r.status === 'error') ? 'blocked' : reasons.some((r) => r.status === 'warn') ? 'limited' : 'ready';
    return [m, { id: m, label: LABELS[m], status, reasons }];
  }));
  return {
    at: new Date().toISOString(),
    user,
    workspace: ws ? { id: ws.id, name: ws.name } : null,
    capacity: cap ? { name: cap.name, sku: cap.sku, state: cap.state, region: cap.region, admin: cap.admin, trial: cap.trial, visible: cap.visible } : null,
    role: role?.role || null,
    tenantSettings: ts ? 'checked' : 'not-visible',
    checks, modules,
  };
}

/**
 * Readiness for the project (cached two minutes; `refresh` forces a new check). With `allowStale`, an older result for
 * the same project is returned right away and refreshed in the background.
 */
export async function readiness({ refresh = false, allowStale = false } = {}) {
  const p = getProject();
  const key = [p.workspace?.id || '', p.modelSource?.itemId || '', currentIdentity()?.oid || '', Boolean(p.realtime)].join('|');
  const fresh = cache.key === key && cache.data && Date.now() - cache.at < TTL_MS;
  if (!refresh && fresh) return cache.data;
  if (!refresh && allowStale && cache.key === key && cache.data) {
    if (!cache.pending) readiness({ refresh: true }).catch(() => {});
    return cache.data;
  }
  if (cache.pending && cache.key === key) return cache.pending;
  cache.key = key;
  cache.pending = compute().then((data) => { cache = { key, at: Date.now(), data, pending: null }; return data; }).catch((e) => { cache.pending = null; throw e; });
  return cache.pending;
}

export const cachedReadiness = () => cache.data;
export const resetReadiness = () => { cache = { key: '', at: 0, data: null, pending: null }; };

// Which module a job belongs to (jobs of blocked modules stop before they change anything). Keys are job kinds and
// the /api/jobs/<name> routes.
const JOB_MODULE = {
  sample: 'data', mirror: 'data', shortcut: 'data', shortcuts: 'data', 'semantic-model': 'model', ontology: 'ontology',
  report: 'reports', 'org-app': 'reports', realtime: 'realtime', 'realtime-setup': 'realtime', 'realtime-dashboard': 'realtime', 'realtime-ontology': 'realtime', 'realtime-alerts': 'realtime',
  planning: 'planning', 'plan-item': 'planning',
};

/**
 * Throw a readable 409 when the module a job belongs to is blocked. A blocked state is re-checked first, so a capacity
 * that was just resumed doesn't keep the module greyed out.
 */
export async function assertModuleReady(kindOrModule) {
  const mod = JOB_MODULE[kindOrModule] || (MODULES.includes(kindOrModule) ? kindOrModule : null);
  if (!mod) return;
  let r;
  try { r = await readiness({ allowStale: true }); } catch { return; }
  if (r.modules[mod]?.status === 'blocked') {
    try { r = await readiness({ refresh: true }); } catch { return; }
  }
  const m = r.modules[mod];
  if (m?.status !== 'blocked') return;
  const first = m.reasons.find((x) => x.status === 'error');
  const err = new Error(`${m.label} can't run right now: ${first.text}${first.fix ? ` ${first.fix}` : ''}`);
  err.status = 409;
  err.code = 'MODULE_BLOCKED';
  throw err;
}

/** Live events need key-based auth on the Eventstream; stop before sending when the tenant setting is off. */
export async function assertLiveEventsAllowed() {
  let r;
  try { r = await readiness({ allowStale: true }); } catch { return; }
  const off = r.modules.realtime?.reasons.find((x) => x.status === 'warn' && x.text.includes(TENANT.AllowNonEntraADAuthInEventStream));
  if (!off) return;
  const err = new Error(`Live events can't be sent: ${off.text.split('. ')[0]}. ${off.fix}`);
  err.status = 409;
  err.code = 'MODULE_BLOCKED';
  throw err;
}
