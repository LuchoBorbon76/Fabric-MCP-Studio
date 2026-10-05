// Entry point: header, solution map (navigation), approvals, job dock and the embedded Copilot.
import { get, post, store, on, fire, connectEvents } from './api.js';
import { h, $, $$, toast, modal, initials, statusDot, busy, SERVER_LABEL } from './ui.js';
import { app } from './app.js';
import { loadPrompts, topPrompts } from './prompts.js';
import { ensureDisclaimer, showDisclaimer, showWhatsNew } from './about.js';
import { mountMap, getNode } from './lineage.js';
import { modelsDialog } from './models.js';
import { chatElement, ask as chatAsk, refreshHeader, refreshSuggestions, setPanelMode, scrollChatToEnd, focusChat } from './chat.js';
import { renderHome } from './views/home.js';
import { renderCopilot } from './views/copilot.js';
import { renderWorkspace } from './views/workspace.js';
import { renderData } from './views/data.js';
import { renderModel } from './views/model.js';
import { renderOntology } from './views/ontology.js';
import { renderReports } from './views/reports.js';
import { renderRealtime } from './views/realtime.js';
import { renderPlanning } from './views/planning.js';
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
  realtime: { label: 'Real-time', render: renderRealtime },
  planning: { label: 'Planning', render: renderPlanning },
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
  if (p?.semanticModel) parts.push(`Model: ${p.semanticModel.name}${(p.semanticModels || []).length > 1 ? ` (1 of ${p.semanticModels.length})` : ''}`);
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
  const line = (c) => h('div', { class: 'check' }, statusDot(c.status === 'unknown' ? 'info' : c.status), h('div', {}, h('b', {}, c.label), h('span', { class: 'muted' }, ` · ${c.detail}`), c.fix ? h('div', { class: 'fx' }, c.fix, c.link ? [' ', h('a', { href: c.link, target: '_blank', rel: 'noopener' }, 'Open ↗')] : null) : null));
  try {
    const [hc, rd] = await Promise.all([get('/health'), store.user?.signedIn ? loadReadiness(Boolean(open)) : Promise.resolve(null)]);
    store.health = hc;
    body.innerHTML = '';
    body.append(...hc.checks.map(line));
    if (open && rd) {
      body.append(h('h3', { style: { margin: '12px 0 4px' } }, rd.workspace ? `Workspace ${rd.workspace.name}` : 'Your workspace'), ...rd.checks.map(line));
      body.append(h('h3', { style: { margin: '12px 0 4px' } }, 'What can run'), moduleGrid(rd));
    }
    updateMap();
    if (rendered.has('home') && current === 'home') renderView('home');
  } catch (e) {
    body.innerHTML = '';
    body.append(h('div', { class: 'banner err' }, e.message));
  }
  return m;
}

/** One line per module: ready, limited or can't run, with the main reason. */
export function moduleGrid(rd) {
  const pill = { ready: ['ok', 'Ready'], limited: ['warn', 'Limited'], blocked: ['err', 'Can\'t run'] };
  return h('div', { class: 'rgrid' }, Object.values(rd.modules).map((m) => {
    const [cls, text] = pill[m.status];
    const r = firstReason(m);
    return h('div', { class: 'mrow', onclick: () => go(m.id), title: `Open ${m.label}` }, h('span', { class: `pill ${cls}` }, text), h('b', {}, m.label), h('span', { class: 'tiny muted' }, r ? r.text : m.reasons.some((x) => x.status === 'unknown') ? 'Some tenant settings couldn\'t be checked' : ''));
  }));
}

// ---------------- solution map (replaces the KPI strip and the tabs) ----------------
const mapState = { selected: null };
const map = mountMap($('#map'), {
  onTab: (id) => go(id),
  onNode: (id, how) => {
    const g = map.graph();
    const n = g && getNode(g, id);
    if (!n) return;
    // A double-click on Semantic model opens the models pop-up: switch the active model, add an existing one or start a new one.
    if (id === 'model' && how === 'open' && store.project?.workspace) { modelsDialog(); return; }
    // On the overview a click shows the part's details; elsewhere (or a double-click) opens its page.
    if (current === 'home' && how === 'click') { app.selectNode(id); return; }
    go(n.view);
  },
});
function updateMap() { map.update({ view: current, selected: mapState.selected }); }

// ---------------- navigation ----------------
const MODULE_VIEWS = ['workspace', 'data', 'model', 'ontology', 'reports', 'realtime', 'planning', 'share'];
const firstReason = (m) => m?.reasons?.find((r) => r.status === 'error') || m?.reasons?.find((r) => r.status === 'warn');

// ---------------- readiness (up-front checks) ----------------
let readinessKey = '';
export async function loadReadiness(refresh = false) {
  try {
    store.readiness = await get(`/readiness${refresh ? '?refresh=1' : ''}`);
  } catch { return store.readiness; }
  updateMap();
  for (const id of MODULE_VIEWS) if (rendered.has(id)) applyReadiness(id);
  if (current === 'home' && rendered.has('home')) renderView('home');
  return store.readiness;
}

function readinessBanner(m) {
  const main = m.reasons.filter((r) => r.status === 'error' || r.status === 'warn');
  const more = m.reasons.filter((r) => r.status === 'unknown' || r.status === 'info');
  if (!main.length && !more.length) return null;
  const item = (r) => h('li', {}, r.text, r.fix ? h('div', { class: 'tiny muted' }, r.fix, r.link ? [' ', h('a', { href: r.link, target: '_blank', rel: 'noopener' }, 'Open ↗')] : null) : null);
  const kind = m.status === 'blocked' ? 'err' : m.status === 'limited' ? 'warn' : '';
  const title = m.status === 'blocked' ? `${m.label} can't run right now` : m.status === 'limited' ? `${m.label} works with limits` : 'Good to know';
  const recheck = h('button', { class: 'btn ghost', 'data-busy': 'Checking…' }, '↻ Check again');
  recheck.addEventListener('click', busy(recheck, async () => { await loadReadiness(true); }));
  return h('div', { class: `banner rbanner ${kind}` },
    h('div', { style: { flex: 1 } },
      main.length ? [h('b', {}, title), h('ul', { class: 'pre small', style: { margin: '6px 0 0' } }, main.map(item))] : null,
      more.length ? h('details', { style: { marginTop: main.length ? '6px' : 0 } }, h('summary', { class: 'small' }, main.length ? `More checks (${more.length})` : `Checks for this page (${more.length})`), h('ul', { class: 'pre small', style: { margin: '6px 0 0' } }, more.map(item))) : null),
    recheck);
}

/** Banner with the reasons, and job buttons disabled while the module is blocked (also for content drawn later). */
const watched = new WeakSet();
function applyReadiness(id) {
  const el = $(`#view-${id}`);
  if (!el || !MODULE_VIEWS.includes(id)) return;
  el.querySelector(':scope > .rbanner')?.remove();
  const m = store.readiness?.modules?.[id];
  const blocked = m?.status === 'blocked';
  el.classList.toggle('blocked', blocked);
  el.dataset.blockReason = blocked ? firstReason(m)?.text || '' : '';
  for (const b of el.querySelectorAll('button[data-rblock]')) { b.disabled = false; b.title = b.dataset.rtitle || ''; delete b.dataset.rblock; }
  const banner = m ? readinessBanner(m) : null;
  if (banner) el.prepend(banner);
  disableBlocked(el);
  if (!watched.has(el)) {
    watched.add(el);
    new MutationObserver(() => disableBlocked(el)).observe(el, { childList: true, subtree: true });
  }
}

function disableBlocked(el) {
  if (!el.classList.contains('blocked')) return;
  for (const b of el.querySelectorAll('button[data-busy="Starting…"]:not([data-rblock])')) {
    if (b.disabled) continue;
    b.dataset.rblock = '1'; b.dataset.rtitle = b.title || '';
    b.disabled = true;
    b.title = `Can't run right now: ${el.dataset.blockReason}`;
  }
}

function renderView(id) {
  const el = $(`#view-${id}`);
  el.innerHTML = '';
  try { VIEWS[id].render(el); } catch (e) { el.append(h('div', { class: 'banner err' }, `Could not render this view: ${e.message}`)); console.error(e); }
  rendered.add(id);
  applyReadiness(id);
  if (id === current) placeChat();
}

export function go(id) {
  if (!VIEWS[id]) return;
  current = id;
  history.replaceState(null, '', `#${id}`);
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${id}`));
  renderView(id);
  updateMap();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderAll() {
  renderHeader();
  updateMap();
  if (rendered.has(current)) renderView(current);
  refreshSuggestions();
}

// ---------------- Copilot (embedded) ----------------
// One chat component. It lives in the Copilot tab, or embedded in the current view's Copilot slot (.cslot) when the
// user asks from that view. Nothing floats over the page.
const inlineOpen = new Set();
const chatEl = chatElement({
  suggestions: () => topPrompts(6),
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
const approvalSeen = new Set();   // a refresh must not queue the same request twice
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

on('approval.request', (e) => { if (approvalSeen.has(e.approval.id)) return; approvalSeen.add(e.approval.id); approvalQueue.push(e.approval); showNextApproval(); });

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
  updateMap();
  if (j.kind === 'teardown' && j.status !== 'running' && !cleanedUp.has(j.id)) { cleanedUp.add(j.id); refreshAll(); }
});

// Clean up (or a new project) changes every tab: reload the project, live data, plan and readiness, and let the
// views forget what they cached from Fabric.
const cleanedUp = new Set();
async function refreshAll() {
  fire('studio.reset', {});
  await refresh();
  loadReadiness(true);
}

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
  updateMap();
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
  renderHeader(); updateMap(); refreshSuggestions();
  loadPrompts();
  // The Data page keeps in-progress forms, so it only re-renders when the data source itself changes.
  const dk = dataKey(store.project);
  const dataChanged = dk !== dataSourceKey;
  dataSourceKey = dk;
  if (['home', 'model', 'ontology', 'reports', 'realtime', 'planning', 'share', 'workspace'].includes(current) || (current === 'data' && dataChanged)) renderView(current);
  // A new workspace or data source changes what can run.
  const rk = [store.project?.workspace?.id, store.project?.modelSource?.itemId, Boolean(store.project?.realtime)].join('|');
  if (rk !== readinessKey) { readinessKey = rk; loadReadiness(); }
});
on('provider', (e) => { store.provider = e.provider; renderHeader(); updateMap(); });
// Streaming lights up the real-time part of the map; only re-draw it when running/stopped flips.
on('realtime.simulator', (e) => { const was = store.realtime?.simulator?.running; store.realtime = { ...(store.realtime || {}), simulator: e.simulator }; if (was !== e.simulator.running) updateMap(); });
on('auth', (e) => { store.user = e.user; renderAll(); loadReadiness(true); });

// ---------------- boot ----------------
async function refresh() {
  try {
    const b = await get('/bootstrap');
    Object.assign(store, { version: b.version, build: b.build || null, user: b.user, settings: b.settings, provider: b.provider, providers: b.providers, project: b.project, naming: b.naming || null, catalog: b.catalog, chats: b.chats, approvals: b.approvals, preset: b.preset, platform: b.platform, realtime: b.realtime || null, planning: b.planning || null, readiness: b.readiness || store.readiness || null });
    readinessKey = [b.project?.workspace?.id, b.project?.modelSource?.itemId, Boolean(b.project?.realtime)].join('|');
    presetSource = b.project?.source?.id || null;
    dataSourceKey = dataKey(b.project);
    for (const j of b.jobs) {
      store.jobs.set(j.id, j);
      if (j.status === 'running') dockJobs.add(j.id);
      // A job cut off by the last shut down: show it once so the user knows to run it again.
      else if (j.status === 'interrupted' && Date.now() - Date.parse(j.endedAt) < 10 * 60 * 1000 && !dockJobs.has(j.id)) { dockJobs.add(j.id); setTimeout(() => { dockJobs.delete(j.id); renderDock(); }, 20000); }
    }
    if (b.settings?.theme && !localStorage.getItem('studioTheme')) setTheme(b.settings.theme);
    for (const a of b.approvals || []) if (!approvalSeen.has(a.id)) { approvalSeen.add(a.id); approvalQueue.push(a); }
    showNextApproval();
  } catch (e) {
    toast(`Could not reach the studio server: ${e.message}`, 'err');
  }
  renderAll();
  renderDock();
  refreshHeader();
  loadPrompts();
}

Object.assign(app, {
  go, ask: askCopilot, placeChat, refresh, refreshAll, rerender: () => renderView(current), jobCard, watchJob: (id) => { dockJobs.add(id); renderDock(); }, loadReadiness, moduleGrid, showHealth,
  selectedNode: () => mapState.selected,
  selectNode: (id) => {
    mapState.selected = id;
    updateMap();
    if (current !== 'home') return;
    renderView('home');
    $('#view-home .insp')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
});
on('studio.reset', () => { mapState.selected = null; store.prompts = null; });
// New suggestions (e.g. questions about the model's measures) refresh the chat welcome.
on('prompts.updated', () => refreshSuggestions());

connectEvents();
await refresh();
go(current);
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (VIEWS[v] && v !== current) go(v); });
$('#buildChip')?.addEventListener('click', () => showWhatsNew());
$('#whatsNewLink')?.addEventListener('click', (e) => { e.preventDefault(); showWhatsNew(); });
$('#disclaimerLink')?.addEventListener('click', (e) => { e.preventDefault(); showDisclaimer(); });
// Everyone who runs the studio sees the disclaimer once, before signing in.
await ensureDisclaimer();
if (!store.user?.signedIn) signInDialog();
showHealth(false);
