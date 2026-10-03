// Entry point: header, KPI strip, navigation, approvals, job dock and the embedded Copilot.
import { get, post, store, on, connectEvents } from './api.js';
import { h, $, $$, toast, modal, initials, statusDot, busy, SERVER_LABEL } from './ui.js';
import { app, stepStatus, suggestions } from './app.js';
import { chatElement, ask as chatAsk, refreshHeader, refreshSuggestions, setPanelMode, scrollChatToEnd, focusChat } from './chat.js';
import { renderHome } from './views/home.js';
import { renderCopilot } from './views/copilot.js';
import { renderWorkspace } from './views/workspace.js';
import { renderData } from './views/data.js';
import { renderModel } from './views/model.js';
import { renderOntology } from './views/ontology.js';
import { renderReports } from './views/reports.js';
import { renderShare } from './views/share.js';
import { renderActivity } from './views/activity.js';
import { renderSettings } from './views/settings.js';

const VIEWS = {
  home: { label: 'Home', render: renderHome },
  copilot: { label: '✦ Copilot', render: renderCopilot },
  workspace: { label: 'Workspace', render: renderWorkspace },
  data: { label: 'Data', render: renderData },
  model: { label: 'Semantic model', render: renderModel },
  ontology: { label: 'Ontology', render: renderOntology },
  reports: { label: 'Reports & apps', render: renderReports },
  share: { label: 'Ask & share', render: renderShare },
  activity: { label: 'Activity', render: renderActivity },
  settings: { label: 'Settings', render: renderSettings },
};
let current = location.hash.slice(1) || 'home';
if (!VIEWS[current]) current = 'home';
const rendered = new Set();

// ---------------- theme ----------------
function setTheme(t) {
  const r = document.documentElement;
  if (t) r.setAttribute('data-theme', t); else r.removeAttribute('data-theme');
  try { localStorage.setItem('studioTheme', t || ''); } catch { /* ignore */ }
  $('#themesel').value = t || '';
}
$('#themesel').addEventListener('change', (e) => setTheme(e.target.value));
setTheme((() => { try { return localStorage.getItem('studioTheme') || ''; } catch { return ''; } })());

// ---------------- header ----------------
function renderHeader() {
  const u = store.user;
  $('#avatar').textContent = u?.signedIn ? initials(u.name) : '?';
  $('#userName').textContent = u?.signedIn ? (u.name || u.upn) : 'Sign in';
  $('#userChip').title = u?.signedIn ? `${u.upn} · ${u.tenantDomain || u.tenantId}` : 'Sign in to Microsoft Fabric';
  const p = store.project;
  const parts = [];
  if (u?.signedIn) parts.push(`${u.upn || u.name} · ${u.tenantDomain || 'tenant'}`);
  if (store.provider) parts.push(`AI: ${store.provider.name}${store.provider.model ? ` (${store.provider.model})` : ''}`);
  if (p?.workspace) parts.push(`Workspace: ${p.workspace.name}`);
  $('#subtitle').textContent = parts.length ? parts.join(' · ') : 'Build lakehouses, semantic models and ontologies in Microsoft Fabric by chatting with the Copilot you already use.';
  renderTenantBanner();
}

// The project's workspace lives in one Microsoft Entra tenant; warn when the signed-in account is in another.
function renderTenantBanner() {
  const el = $('#tenantBanner');
  el.innerHTML = '';
  const u = store.user;
  const pt = store.project?.tenant;
  if (!u?.signedIn || !pt?.id || !u.tenantId || pt.id === u.tenantId) return;
  const reset = h('button', { class: 'btn pri', 'data-busy': 'Starting…' }, 'Start a new project here');
  reset.addEventListener('click', busy(reset, async () => {
    if (!confirm(`Start a new project in ${u.tenantDomain || u.tenantId}? Nothing is deleted in Fabric; the studio forgets the current project and its activity.`)) return;
    await post('/project/reset');
    toast('New project started. Choose a workspace to begin.', 'ok');
    await app.refresh();
  }));
  el.append(h('div', { class: 'banner warn' },
    h('div', { style: { flex: '1' } },
      h('b', {}, 'This project belongs to another tenant. '),
      `It was built in ${pt.domain || pt.id}, but you're signed in to ${u.tenantDomain || u.tenantId}. Changes are paused until you switch back or start a new project.`),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => signInDialog() }, `Sign in to ${pt.domain || 'that tenant'}`), reset)));
}

$('#userChip').addEventListener('click', () => {
  const u = store.user;
  if (u?.signedIn) {
    modal({
      title: 'Microsoft Entra account',
      body: h('dl', { class: 'kv' }, h('dt', {}, 'Name'), h('dd', {}, u.name), h('dt', {}, 'Account'), h('dd', {}, u.upn), h('dt', {}, 'Tenant'), h('dd', {}, `${u.tenantDomain || ''} (${u.tenantId})`), h('dt', {}, 'Sign-in method'), h('dd', {}, u.mode === 'azure-cli' ? 'Azure CLI (az login)' : 'Browser')),
      actions: [{ label: 'Switch account', onClick: () => signInDialog() }, { label: 'Sign out', class: 'danger', onClick: async () => { await post('/auth/signout'); store.user = { signedIn: false }; renderAll(); } }],
    });
  } else signInDialog();
});

function signInDialog() {
  const b1 = h('button', { class: 'btn pri big', 'data-busy': 'Waiting for the browser…' }, 'Sign in with browser');
  const b2 = h('button', { class: 'btn big', 'data-busy': 'Waiting for az login…' }, 'Sign in with Azure CLI');
  const m = modal({
    title: 'Sign in to Microsoft Fabric',
    body: h('div', { class: 'col' },
      h('p', { class: 'muted' }, 'Use the work account that has access to Microsoft Fabric. The studio calls Fabric and the MCP servers as you – it never stores your password.'),
      h('div', { class: 'row' }, b1, b2),
      h('p', { class: 'tiny muted' }, 'Tip: to use a specific tenant, set the tenant ID in Settings › Microsoft Entra.')),
  });
  const go = (mode) => async () => {
    const me = await post('/auth/signin', { mode });
    store.user = me;
    m.close();
    toast(`Signed in as ${me.upn || me.name}`, 'ok');
    await app.refresh();
  };
  b1.addEventListener('click', busy(b1, go('browser')));
  b2.addEventListener('click', busy(b2, go('azure-cli')));
}

$('#exitBtn').addEventListener('click', async () => {
  if (!confirm('Shut down Fabric MCP Studio? Running jobs will stop.')) return;
  try { await post('/shutdown'); } catch { /* ignore */ }
  document.body.innerHTML = '<div style="padding:60px;text-align:center;font:16px Segoe UI">Fabric MCP Studio has stopped. You can close this tab.<br><br>Start it again with <code>Start-Studio.cmd</code> or <code>npm start</code>.</div>';
});

$('#healthBtn').addEventListener('click', () => showHealth(true));

export async function showHealth(open) {
  const body = h('div', { class: 'checks' }, h('div', { class: 'row' }, h('span', { class: 'spin' }), 'Running checks…'));
  const m = open ? modal({ title: 'Setup check', body }) : null;
  try {
    store.health = await get('/health');
    body.innerHTML = '';
    for (const c of store.health.checks) {
      body.append(h('div', { class: 'check' }, statusDot(c.status), h('div', {}, h('b', {}, c.label), h('span', { class: 'muted' }, ` · ${c.detail}`), c.fix ? h('div', { class: 'fx' }, c.fix) : null)));
    }
    renderKpis();
    if (rendered.has('home') && current === 'home') renderView('home');
  } catch (e) {
    body.innerHTML = '';
    body.append(h('div', { class: 'banner err' }, e.message));
  }
  return m;
}

// ---------------- KPIs ----------------
function renderKpis() {
  const p = store.project || {};
  const st = stepStatus(p, store);
  const aiCheck = store.health?.checks?.find((c) => c.id === 'copilot');
  const k = [
    { id: 'ai', view: 'settings', label: 'AI provider', value: store.provider?.name || '–', sub: store.provider?.model || (aiCheck?.detail ?? 'Not checked yet'), state: aiCheck ? (aiCheck.status === 'ok' ? 'done' : aiCheck.status === 'error' ? 'err' : 'todo') : 'todo' },
    { id: 'fabric', view: 'settings', label: 'Microsoft Fabric', value: store.user?.signedIn ? (store.user.tenantDomain || 'Signed in') : 'Not signed in', sub: store.user?.signedIn ? store.user.upn : 'Select Sign in', state: store.user?.signedIn ? 'done' : 'err' },
    { id: 'workspace', view: 'workspace', label: 'Workspace', value: p.workspace?.name || 'Not selected', sub: p.workspace ? (p.workspace.created ? 'Created by the studio' : 'Existing workspace') : 'New or existing', state: st.workspace },
    { id: 'data', view: 'data', label: 'Data', value: p.source?.label || 'Not connected', sub: p.modelSource ? `${{ MirroredDatabase: 'Mirrored database', SQLDatabase: 'SQL database' }[p.modelSource.itemType] || p.modelSource.itemType} · ${p.modelSource.itemName}` : 'Sample or your data', state: st.data },
    { id: 'model', view: 'model', label: 'Semantic model', value: p.semanticModel?.name || 'Not created', sub: p.semanticModel ? `${p.semanticModel.tables} tables · ${p.semanticModel.measures} measures` : 'Direct Lake', state: st.model },
    { id: 'ontology', view: 'ontology', label: 'Ontology', value: p.ontology?.name || 'Not created', sub: p.ontology ? `${p.ontology.entities?.length || 0} entities · ${p.ontology.rules?.length || 0} rules` : 'Fabric IQ', state: st.ontology },
    { id: 'reports', view: 'reports', label: 'Reports & apps', value: p.reports?.length ? `${p.reports.length} report${p.reports.length === 1 ? '' : 's'}` : 'Not built', sub: p.reports?.length ? p.reports[0].name : 'Power BI', state: st.reports },
  ];
  const running = [...store.jobs.values()].filter((j) => j.status === 'running');
  const el = $('#kpis');
  el.innerHTML = '';
  for (const x of k) {
    const isRun = running.some((j) => (x.id === 'data' && ['sample', 'mirror', 'shortcut'].includes(j.kind)) || (x.id === 'model' && j.kind === 'semantic-model') || (x.id === 'ontology' && j.kind === 'ontology') || (x.id === 'reports' && j.kind === 'report'));
    const state = isRun ? 'run' : x.state;
    el.append(h('div', { class: `kpi ${state}`, onclick: () => go(x.view), title: `Open ${x.label}` },
      h('div', { class: 'l' }, statusDot(state === 'done' ? 'ok' : state === 'err' ? 'error' : state === 'run' ? 'running' : ''), x.label),
      h('div', { class: 'v', title: x.value }, x.value),
      h('div', { class: 'sub', title: x.sub }, x.sub)));
  }
}

// ---------------- navigation ----------------
function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const [id, v] of Object.entries(VIEWS)) {
    let cnt = null;
    if (id === 'activity') { const n = [...store.jobs.values()].filter((j) => j.status === 'running').length; if (n) cnt = h('span', { class: 'cnt' }, n); }
    nav.append(h('button', { class: `tab ${id === current ? 'on' : ''}`, onclick: () => go(id) }, v.label, cnt));
  }
}

function renderView(id) {
  const el = $(`#view-${id}`);
  el.innerHTML = '';
  try { VIEWS[id].render(el); } catch (e) { el.append(h('div', { class: 'banner err' }, `Could not render this view: ${e.message}`)); console.error(e); }
  rendered.add(id);
  if (id === current) placeChat();
}

export function go(id) {
  if (!VIEWS[id]) return;
  current = id;
  history.replaceState(null, '', `#${id}`);
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${id}`));
  renderView(id);
  renderNav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderAll() {
  renderHeader();
  renderKpis();
  renderNav();
  if (rendered.has(current)) renderView(current);
  refreshSuggestions();
}

// ---------------- Copilot (embedded) ----------------
// One chat component. It lives in the Copilot tab, or embedded in the current view's Copilot slot (.cslot) when the
// user asks from that view. Nothing floats over the page.
const inlineOpen = new Set();
const chatEl = chatElement({
  suggestions: () => suggestions(store.project, store.preset),
  onClose: () => { inlineOpen.delete(current); placeChat(); },
});

function viewSlot(id = current) {
  return id === 'copilot' ? $('#chatSlot') : $(`#view-${id} .cslot`);
}

function placeChat() {
  const slot = viewSlot();
  for (const s of $$('.cslot')) if (s !== slot) s.hidden = true;
  if (current === 'copilot' && slot) {
    if (chatEl.parentElement !== slot) { slot.append(chatEl); scrollChatToEnd(); }
    setPanelMode(false);
    return;
  }
  if (slot && inlineOpen.has(current)) {
    slot.hidden = false;
    if (chatEl.parentElement !== slot) { slot.append(chatEl); scrollChatToEnd(); }
    setPanelMode(true);
    return;
  }
  if (slot) slot.hidden = true;
  if (chatEl.parentElement && chatEl.parentElement.id !== 'chatSlot') chatEl.remove();
}

/** Open Copilot embedded in a view (default: the current one) and send a prompt. */
function askCopilot(prompt, { view } = {}) {
  if (view && view !== current) go(view);
  const slot = viewSlot();
  if (!slot) { go('copilot'); } else if (current !== 'copilot') {
    inlineOpen.add(current);
    placeChat();
    setTimeout(() => slot.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
  if (prompt) chatAsk(prompt);
  else focusChat();
}

// ---------------- approvals ----------------
const approvalQueue = [];
let approvalOpen = false;

function showNextApproval() {
  if (approvalOpen || !approvalQueue.length) return;
  const a = approvalQueue.shift();
  approvalOpen = true;
  const finish = async (decision) => {
    try { await post(`/approvals/${a.id}`, { decision }); } catch (e) { toast(e.message, 'err'); }
    approvalOpen = false;
    showNextApproval();
  };
  modal({
    title: 'Copilot wants to make a change',
    className: 'appr',
    body: h('div', { class: 'col' },
      h('div', { class: 'row' }, h('span', { class: `srv ${a.server}` }, SERVER_LABEL[a.server] || a.server), h('b', {}, a.title || a.tool)),
      h('p', { class: 'muted small' }, 'Review what will be sent. Nothing changes in Fabric unless you approve.'),
      h('pre', {}, a.args)),
    actions: [{ label: 'Decline', class: 'danger', onClick: () => finish('deny') }, { label: 'Approve', class: 'pri', onClick: () => finish('allow') }],
  });
}

on('approval.request', (e) => { approvalQueue.push(e.approval); showNextApproval(); });

// ---------------- jobs ----------------
const dockJobs = new Set();
// Reserve room below the footer for the job dock so it never covers the end of the page.
new ResizeObserver(() => document.documentElement.style.setProperty('--dockh', `${$('#dock').offsetHeight}px`)).observe($('#dock'));

const JOB_ICON = { succeeded: '✓', cancelled: '■', interrupted: '!', failed: '✗' };
const JOB_WORD = { succeeded: 'done', cancelled: 'cancelled', interrupted: 'interrupted', failed: 'failed' };

export function jobCard(job, { compact = false } = {}) {
  const icon = job.status === 'running' ? h('span', { class: 'spin' }) : h('span', { class: 'jicon' }, JOB_ICON[job.status] || '✗');
  const el = h('div', { class: `job ${job.status}${compact ? ' compact' : ''}` },
    h('div', { class: 'jhead' }, icon, h('b', { title: job.title }, job.title), h('span', { class: 'tiny muted' }, job.status === 'running' ? `${job.progress}%` : JOB_WORD[job.status] || job.status)),
    h('div', { class: 'bar' }, h('i', { style: { width: `${job.status === 'running' || job.status === 'succeeded' ? job.progress : Math.max(job.progress, 100)}%` } })),
    compact ? h('div', { class: 'tiny muted jstep', title: job.steps.at(-1)?.label || '' }, job.status === 'interrupted' ? 'Stopped when the studio closed – run it again to finish.' : job.steps.at(-1)?.label || '') : h('div', { class: 'jsteps' }, job.steps.map((s) => h('div', { class: 's' }, statusDot(s.status === 'done' ? 'ok' : s.status === 'failed' ? 'error' : 'running'), s.label))),
    job.error && !compact ? h('div', { class: `banner ${job.status === 'interrupted' ? 'warn' : 'err'} mt` }, job.error) : null,
    job.error && compact && job.status !== 'interrupted' ? h('div', { class: 'tiny jerr', title: job.error }, job.error) : null,
    !compact && job.logLines?.length ? h('details', { open: job.status === 'failed' || undefined }, h('summary', { class: 'tiny muted' }, `Log (${job.logLines.length})`), h('div', { class: 'jlog' }, job.logLines.slice(-60).join('\n'))) : null,
    job.status === 'running' && !compact ? h('div', { class: 'row mt' }, h('button', { class: 'btn danger', onclick: () => post(`/jobs/${job.id}/cancel`) }, 'Cancel')) : null);
  return el;
}

function renderDock() {
  const dock = $('#dock');
  dock.innerHTML = '';
  for (const id of dockJobs) {
    const j = store.jobs.get(id);
    if (!j) continue;
    const card = jobCard(j, { compact: true });
    card.style.cursor = 'pointer';
    card.title = 'Open Activity';
    card.addEventListener('click', () => go('activity'));
    dock.append(card);
  }
}

function settleDockJob(j) {
  if (!dockJobs.has(j.id)) return;
  toast(`${j.title}: ${JOB_WORD[j.status] || j.status}`, j.status === 'succeeded' ? 'ok' : 'err');
  setTimeout(() => { dockJobs.delete(j.id); renderDock(); }, j.status === 'succeeded' ? 4000 : 15000);
}

on('job', (e) => {
  const j = e.job;
  if (j.status === 'running') dockJobs.add(j.id);
  else settleDockJob(j);
  renderDock();
  renderKpis();
  renderNav();
});

// After a reconnect, the server's job list is the truth: jobs that ended (or vanished) while disconnected must
// not keep spinning.
async function resyncJobs() {
  let list;
  try { list = await get('/jobs'); } catch { return; }
  const byId = new Map(list.map((j) => [j.id, j]));
  for (const j of list) store.jobs.set(j.id, j);
  for (const id of [...dockJobs]) {
    const local = store.jobs.get(id);
    if (local?.status !== 'running') continue;
    const remote = byId.get(id) || { ...local, status: 'interrupted', error: 'The studio stopped while this job was running.' };
    store.jobs.set(id, remote);
    if (remote.status !== 'running') settleDockJob(remote);
  }
  renderDock();
  renderKpis();
  renderNav();
}

let disconnected = false;
on('sse.error', () => { disconnected = true; });
on('sse.open', () => { if (disconnected) { disconnected = false; resyncJobs(); } });
// The studio runs on this computer: if it can't be reached, its jobs have stopped too.
on('server.down', () => {
  $('#offline').hidden = false;
  for (const id of dockJobs) {
    const j = store.jobs.get(id);
    if (j?.status !== 'running') continue;
    const stopped = { ...j, status: 'interrupted', error: 'Fabric MCP Studio stopped while this job was running.' };
    store.jobs.set(id, stopped);
    settleDockJob(stopped);
  }
  renderDock();
});
on('server.up', () => { $('#offline').hidden = true; });

let presetSource;
let dataSourceKey;
const dataKey = (p) => [p?.source?.kind, p?.source?.method, p?.source?.itemId, p?.modelSource?.itemId].join('|');
on('project.updated', async () => {
  const sid = store.project?.source?.id || null;
  if (sid !== presetSource) { presetSource = sid; try { store.preset = await get('/preset'); } catch { /* keep */ } }
  renderHeader(); renderKpis(); refreshSuggestions();
  // The Data tab keeps in-progress forms, so it only re-renders when the data source itself changes.
  const dk = dataKey(store.project);
  const dataChanged = dk !== dataSourceKey;
  dataSourceKey = dk;
  if (['home', 'model', 'ontology', 'reports', 'share', 'workspace'].includes(current) || (current === 'data' && dataChanged)) renderView(current);
});
on('provider', (e) => { store.provider = e.provider; renderHeader(); renderKpis(); });
on('auth', (e) => { store.user = e.user; renderAll(); });

// ---------------- boot ----------------
async function refresh() {
  try {
    const b = await get('/bootstrap');
    Object.assign(store, { user: b.user, settings: b.settings, provider: b.provider, providers: b.providers, project: b.project, catalog: b.catalog, chats: b.chats, approvals: b.approvals, preset: b.preset, platform: b.platform });
    presetSource = b.project?.source?.id || null;
    dataSourceKey = dataKey(b.project);
    for (const j of b.jobs) {
      store.jobs.set(j.id, j);
      if (j.status === 'running') dockJobs.add(j.id);
      // A job cut off by the last shut down: show it once so the user knows to run it again.
      else if (j.status === 'interrupted' && Date.now() - Date.parse(j.endedAt) < 10 * 60 * 1000 && !dockJobs.has(j.id)) { dockJobs.add(j.id); setTimeout(() => { dockJobs.delete(j.id); renderDock(); }, 20000); }
    }
    if (b.settings?.theme && !localStorage.getItem('studioTheme')) setTheme(b.settings.theme);
    for (const a of b.approvals || []) approvalQueue.push(a);
    showNextApproval();
  } catch (e) {
    toast(`Could not reach the studio server: ${e.message}`, 'err');
  }
  renderAll();
  renderDock();
  refreshHeader();
}

Object.assign(app, { go, ask: askCopilot, placeChat, refresh, rerender: () => renderView(current), jobCard, watchJob: (id) => { dockJobs.add(id); renderDock(); } });

connectEvents();
await refresh();
go(current);
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (VIEWS[v] && v !== current) go(v); });
if (!store.user?.signedIn) signInDialog();
showHealth(false);
