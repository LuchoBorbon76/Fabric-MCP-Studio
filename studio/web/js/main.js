// Entry point: header, KPI strip, navigation, approvals, job dock and the Copilot panel.
import { get, post, patch, store, on, connectEvents } from './api.js';
import { h, $, $$, toast, modal, initials, statusDot, fmtTime, busy, SERVER_LABEL } from './ui.js';
import { app, STEPS, stepStatus, suggestions } from './app.js';
import { chatElement, ask as chatAsk, refreshHeader, refreshSuggestions, setPanelMode } from './chat.js';
import { renderHome } from './views/home.js';
import { renderCopilot } from './views/copilot.js';
import { renderWorkspace } from './views/workspace.js';
import { renderData } from './views/data.js';
import { renderModel } from './views/model.js';
import { renderOntology } from './views/ontology.js';
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
    { id: 'data', view: 'data', label: 'Data', value: p.source?.label || 'Not connected', sub: p.modelSource ? `${p.modelSource.itemType} · ${p.modelSource.itemName}` : 'Sample or your data', state: st.data },
    { id: 'model', view: 'model', label: 'Semantic model', value: p.semanticModel?.name || 'Not created', sub: p.semanticModel ? `${p.semanticModel.tables} tables · ${p.semanticModel.measures} measures` : 'Direct Lake', state: st.model },
    { id: 'ontology', view: 'ontology', label: 'Ontology', value: p.ontology?.name || 'Not created', sub: p.ontology ? `${p.ontology.entities?.length || 0} entities · ${p.ontology.rules?.length || 0} rules` : 'Fabric IQ', state: st.ontology },
  ];
  const running = [...store.jobs.values()].filter((j) => j.status === 'running');
  const el = $('#kpis');
  el.innerHTML = '';
  for (const x of k) {
    const isRun = running.some((j) => (x.id === 'data' && ['sample', 'mirror', 'shortcut'].includes(j.kind)) || (x.id === 'model' && j.kind === 'semantic-model') || (x.id === 'ontology' && j.kind === 'ontology'));
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
}

export function go(id) {
  if (!VIEWS[id]) return;
  current = id;
  history.replaceState(null, '', `#${id}`);
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${id}`));
  renderView(id);
  renderNav();
  placeChat();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderAll() {
  renderHeader();
  renderKpis();
  renderNav();
  if (rendered.has(current)) renderView(current);
  refreshSuggestions();
}

// ---------------- Copilot panel ----------------
const fab = $('#askfab');
const panel = $('#askpanel');
const chatEl = chatElement({
  suggestions: () => suggestions(store.project, store.preset),
  onClose: () => { panel.hidden = true; fab.hidden = current === 'copilot'; },
});

function placeChat() {
  if (current === 'copilot') {
    const slot = $('#chatSlot');
    if (slot && chatEl.parentElement !== slot) slot.append(chatEl);
    panel.hidden = true;
    fab.hidden = true;
    setPanelMode(false);
  } else {
    if (chatEl.parentElement !== panel) panel.append(chatEl);
    fab.hidden = !panel.hidden;
    setPanelMode(true);
  }
}

fab.addEventListener('click', () => { panel.hidden = false; fab.hidden = true; placeChat(); });

function askCopilot(prompt, { open = 'panel' } = {}) {
  if (open === 'tab') go('copilot');
  else if (current !== 'copilot') { panel.hidden = false; fab.hidden = true; placeChat(); }
  chatAsk(prompt);
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

export function jobCard(job, { compact = false } = {}) {
  const icon = job.status === 'running' ? h('span', { class: 'spin' }) : h('span', {}, job.status === 'succeeded' ? '✓' : job.status === 'cancelled' ? '■' : '✗');
  const el = h('div', { class: `job ${job.status}` },
    h('div', { class: 'row sp' }, h('div', { class: 'row' }, icon, h('b', {}, job.title)), h('span', { class: 'tiny muted' }, `${job.progress}%`)),
    h('div', { class: 'bar' }, h('i', { style: { width: `${job.progress}%` } })),
    compact ? h('div', { class: 'tiny muted' }, job.steps.at(-1)?.label || '') : h('div', { class: 'jsteps' }, job.steps.map((s) => h('div', { class: 's' }, statusDot(s.status === 'done' ? 'ok' : s.status === 'failed' ? 'error' : 'running'), s.label))),
    job.error ? h('div', { class: 'banner err mt' }, job.error) : null,
    !compact && job.logLines?.length ? h('details', { open: job.status === 'failed' || undefined }, h('summary', { class: 'tiny muted' }, `Log (${job.logLines.length})`), h('div', { class: 'jlog' }, job.logLines.slice(-60).join('\n'))) : null,
    job.status === 'running' ? h('div', { class: 'row mt' }, h('button', { class: 'btn danger', onclick: () => post(`/jobs/${job.id}/cancel`) }, 'Cancel')) : null);
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

on('job', (e) => {
  const j = e.job;
  if (j.status === 'running') dockJobs.add(j.id);
  else if (dockJobs.has(j.id)) {
    toast(`${j.title}: ${j.status === 'succeeded' ? 'done' : j.status}`, j.status === 'succeeded' ? 'ok' : 'err');
    setTimeout(() => { dockJobs.delete(j.id); renderDock(); }, j.status === 'succeeded' ? 4000 : 12000);
  }
  renderDock();
  renderKpis();
  renderNav();
});

on('project.updated', () => { renderHeader(); renderKpis(); refreshSuggestions(); if (['home', 'model', 'ontology', 'share', 'workspace'].includes(current)) renderView(current); });
on('provider', (e) => { store.provider = e.provider; renderHeader(); renderKpis(); });
on('auth', (e) => { store.user = e.user; renderAll(); });

// ---------------- boot ----------------
async function refresh() {
  try {
    const b = await get('/bootstrap');
    Object.assign(store, { user: b.user, settings: b.settings, provider: b.provider, providers: b.providers, project: b.project, catalog: b.catalog, chats: b.chats, approvals: b.approvals, preset: b.preset, platform: b.platform });
    for (const j of b.jobs) { store.jobs.set(j.id, j); if (j.status === 'running') dockJobs.add(j.id); }
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

Object.assign(app, { go, ask: askCopilot, refresh, rerender: () => renderView(current), jobCard, watchJob: (id) => { dockJobs.add(id); renderDock(); } });

connectEvents();
await refresh();
go(current);
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (VIEWS[v] && v !== current) go(v); });
if (!store.user?.signedIn) signInDialog();
showHealth(false);
