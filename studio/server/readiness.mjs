// Up-front checks: what each module needs from the environment (capacity, workspace role, tenant settings, data
// source, platform) and whether it can run. Modules that can't run are greyed out in the UI with the reason, and jobs
// stop before they change anything. Everything here is read-only.
import { getToken, SCOPES, currentIdentity } from './auth.mjs';
import { netFetch } from './config.mjs';
import { fabric } from './fabric.mjs';
import { getProject, logActivity } from './project.mjs';
import { emit, clientCount } from './events.mjs';
import { scenarioKind } from './realtime/scenarios.mjs';
import { planStoreProblem } from './planning/store.mjs';

const PBI = 'https://api.powerbi.com/v1.0/myorg';
const TTL_MS = 2 * 60 * 1000;
// How often a paused capacity is checked (STUDIO_CAPACITY_CHECK_SECONDS, at least 15 s) and a running one.
const WATCH_PAUSED_MS = Math.max(15, Number(process.env.STUDIO_CAPACITY_CHECK_SECONDS) || 60) * 1000;
const WATCH_RUNNING_MS = 5 * 60 * 1000;
const everyText = (s) => (s === 60 ? 'minute' : s % 60 === 0 ? `${s / 60} minutes` : `${Math.round(s)} seconds`);
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
  const r = await netFetch(`${PBI}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
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
      const r = req('error', `The workspace's capacity ${cap.name} is ${cap.state === 'Inactive' ? 'paused' : cap.state.toLowerCase()}.`, `Resume it in the Azure portal (Microsoft Fabric capacity › Resume). The studio checks it every ${everyText(WATCH_PAUSED_MS / 1000)} and lights up again by itself once it runs.`, AZURE_FABRIC);
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
  const planProblem = ms ? planStoreProblem(ms) : null;
  if (planProblem) {
    put(['planning'], req('warn', `You can preview the plan but not build it: ${ms.itemName} (${{ MirroredDatabase: 'mirrored database' }[ms.itemType] || ms.itemType}) can't hold the plan values.`, planProblem));
  } else if (ms?.itemType === 'Lakehouse') {
    put(['planning'], req('info', `A lakehouse's SQL endpoint is read-only, so the plan values go to a planning warehouse in the project workspace and ${ms.itemName} reads them through a OneLake shortcut.`, 'Creating the warehouse needs the Contributor role (or higher) in the project workspace.'));
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
    capacity: cap ? { id: cap.id || null, name: cap.name, sku: cap.sku, state: cap.state, region: cap.region, admin: cap.admin, trial: cap.trial, visible: cap.visible, checkEverySeconds: cap.visible && cap.state && cap.state !== 'Active' ? Math.round(WATCH_PAUSED_MS / 1000) : null } : null,
    role: role?.role || null,
    tenantSettings: ts ? 'checked' : 'not-visible',
    checks, modules,
  };
}

/**
 * Readiness for the project (cached two minutes; `refresh` forces a new check). With `allowStale`, an older result for
 * the same project is returned right away and refreshed in the background.
 */
const keyOf = (p) => [p.workspace?.id || '', p.modelSource?.itemId || '', currentIdentity()?.oid || '', Boolean(p.realtime)].join('|');

export async function readiness({ refresh = false, allowStale = false } = {}) {
  const p = getProject();
  const key = keyOf(p);
  const fresh = cache.key === key && cache.data && Date.now() - cache.at < TTL_MS;
  if (!refresh && fresh) return cache.data;
  if (!refresh && allowStale && cache.key === key && cache.data) {
    if (!cache.pending) readiness({ refresh: true }).catch(() => {});
    return cache.data;
  }
  if (cache.pending && cache.key === key) return cache.pending;
  cache.key = key;
  cache.pending = compute().then((data) => { cache = { key, at: Date.now(), data, pending: null }; watchCapacity(key, data); return data; }).catch((e) => { cache.pending = null; throw e; });
  return cache.pending;
}

export const cachedReadiness = () => cache.data;
export const resetReadiness = () => { cache = { key: '', at: 0, data: null, pending: null }; };

// ---------------- capacity watch ----------------
// A paused capacity blocks most of the studio. While it is paused the studio checks it every minute (and every few
// minutes while it runs, to notice a pause): when the state changes, readiness is checked again and pushed to the
// pages, so the map and every tab light up again by themselves once the capacity is resumed – no reload needed.
let watch = { timer: null, key: '', capacityId: null, state: null, errors: 0 };

function watchCapacity(key, data) {
  clearTimeout(watch.timer);
  const cap = data?.capacity;
  if (!cap?.visible || !cap.id) { watch = { timer: null, key: '', capacityId: null, state: null, errors: 0 }; return; }
  const errors = watch.key === key ? watch.errors : 0;
  const base = cap.state !== 'Active' ? WATCH_PAUSED_MS : WATCH_RUNNING_MS;
  watch = { timer: null, key, capacityId: cap.id, state: cap.state, errors };
  watch.timer = setTimeout(checkCapacity, base * Math.min(4, 2 ** errors));
  watch.timer.unref?.();
}

async function checkCapacity() {
  const w = watch;
  // Another workspace or data source since: the next readiness check watches that one.
  if (keyOf(getProject()) !== w.key) return;
  let state = null;
  // No page open: nothing to light up (a page that opens gets the next check's result).
  if (!clientCount()) { watchCapacity(w.key, cache.key === w.key && cache.data ? cache.data : { capacity: { visible: true, id: w.capacityId, state: w.state } }); return; }
  try {
    const caps = (await fabric('GET', '/capacities'))?.value || [];
    state = caps.find((c) => c.id?.toLowerCase() === String(w.capacityId).toLowerCase())?.state || null;
    w.errors = 0;
  } catch { w.errors = Math.min(w.errors + 1, 3); }
  if (state && state !== w.state) {
    const fresh = await readiness({ refresh: true }).catch(() => null);
    if (fresh) {
      const name = fresh.capacity?.name || 'The capacity';
      emit('readiness', { readiness: fresh, change: { capacity: name, from: w.state, to: fresh.capacity?.state || state } });
      logActivity('capacity.state', `${name} is ${state === 'Active' ? 'running again' : 'paused'}`, { capacityId: w.capacityId, from: w.state, to: state });
      return;
    }
  }
  watchCapacity(w.key, cache.key === w.key && cache.data ? cache.data : { capacity: { visible: true, id: w.capacityId, state: w.state } });
}

/** The capacity watch, for tests and diagnostics. */
export const capacityWatch = () => ({ capacityId: watch.capacityId, state: watch.state, errors: watch.errors, active: Boolean(watch.timer) });

// Which module a job belongs to (jobs of blocked modules stop before they change anything). Keys are job kinds and
// the /api/jobs/<name> routes.
const JOB_MODULE = {
  sample: 'data', mirror: 'data', shortcut: 'data', shortcuts: 'data', 'data-prep': 'data', 'semantic-model': 'model', ontology: 'ontology',
  report: 'reports', 'report-template': 'reports', 'model-fix': 'model', 'model-reload': 'model', 'org-app': 'reports', realtime: 'realtime', 'realtime-setup': 'realtime', 'realtime-dashboard': 'realtime', 'realtime-ontology': 'realtime', 'realtime-alerts': 'realtime',
  medallion: 'realtime', 'medallion-remove': 'realtime',
  planning: 'planning', 'plan-item': 'planning', 'data-agent': 'share', 'medallion-flow': 'workspace', taskflow: 'workspace',
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
