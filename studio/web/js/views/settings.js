import { store, get, post, put, patch, on } from '../api.js';
import { h, toast, busy, field, input, select, seg, confirmDialog, typedConfirmDialog, statusDot } from '../ui.js';
import { app } from '../app.js';
import { showDisclaimer, showWhatsNew } from '../about.js';
import { OPENROUTER_AUTO, fillModelSelect } from '../openrouter.js';

let draftProvider = null;

export function renderSettings(el) {
  el.append(h('div', { class: 'grid g2' },
    h('div', { class: 'col', style: { gap: '14px' } }, providerCard(), approvalsCard(), diagnosticsCard(), aboutCard()),
    h('div', { class: 'col', style: { gap: '14px' } }, mcpCard(), entraCard(), dangerCard())));
}

// ---------------- about ----------------
function aboutCard() {
  const s = store.settings?.disclaimer;
  return h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('h2', {}, 'About'), h('span', { class: 'pill brand' }, `v${store.version || ''}`)),
    h('p', { class: 'lead' }, 'Fabric MCP Studio is a sample app, provided as is – not an official Microsoft product or supported service. The version counts improvements and fixes: 1.<improvements>.<fixes>.'),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Build'), h('dd', {}, store.build ? `${store.build.commit} · ${store.build.date}` : '– (not a git copy)'),
      h('dt', {}, 'Disclaimer'), h('dd', {}, s?.acceptedAt ? `Acknowledged ${new Date(s.acceptedAt).toLocaleDateString()}` : 'Not acknowledged yet'),
    store.demoMode ? [h('dt', {}, 'Safe demo mode'), h('dd', {}, 'On – read-only mock Fabric data; no Fabric changes are made')] : null,
    store.settings?.developer ? [h('dt', {}, 'Developer mode'), h('dd', {}, 'On – GitHub Copilot is available as an AI provider')] : null),
    h('div', { class: 'row mt' },
      h('button', { class: 'btn', onclick: () => showWhatsNew() }, 'What\'s new'),
      h('button', { class: 'btn', onclick: () => showDisclaimer() }, 'Disclaimer')));
}

function diagnosticsCard() {
  const dl = h('button', { class: 'btn pri', 'data-busy': 'Building…' }, 'Download diagnostics');
  dl.addEventListener('click', busy(dl, async () => {
    const bundle = await get('/diagnostics');
    const name = `fabric-mcp-studio-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Diagnostics bundle downloaded', 'ok');
  }));
  return h('div', { class: 'card' },
    h('h2', {}, 'Diagnostics'),
    h('p', { class: 'lead' }, 'Download a redacted troubleshooting bundle with app version, project summary, readiness, recent jobs, activity and logs. API keys and tokens are removed.'),
    h('div', { class: 'row' }, dl, store.demoMode ? h('span', { class: 'pill ok' }, 'Safe demo mode') : null));
}

// ---------------- AI provider ----------------
function providerCard() {
  const card = h('div', { class: 'card' });
  const cur = store.settings?.provider || { id: 'azure-openai' };
  if (!draftProvider || draftProvider.saved !== cur.id) draftProvider = { id: cur.id, model: cur.model, reasoningEffort: cur.reasoningEffort || '', config: { ...(cur.config || {}) }, saved: cur.id };
  const d = draftProvider;
  const body = h('div');
  const cards = h('div', { class: 'srcs' }, store.providers.map((p) => h('div', { class: `src ${d.id === p.id ? 'on' : ''}`, onclick: () => { d.id = p.id; d.config = p.id === cur.id ? { ...(cur.config || {}) } : {}; d.model = p.id === cur.id ? cur.model : ''; d.reasoningEffort = p.id === cur.id ? cur.reasoningEffort || '' : ''; d.read = null; redraw(); } },
    h('div', { class: 'h' }, h('div', { class: 'ic' }, { github: '🐙', 'azure-openai': '☁', openai: '◎', anthropic: '✳', local: '🖥', openrouter: '🔀' }[p.id] || '✦'), p.name, p.developer ? h('span', { class: 'pill', title: 'Only in developer mode' }, 'Dev') : null),
    h('div', { class: 'meta' }, p.license))));
  const redraw = () => { card.replaceWith(providerCard()); };

  const meta = store.providers.find((p) => p.id === d.id);
  // Each provider's form sets its own reader below; a reader left from another provider's form must never run.
  d.read = null;
  if (d.id === 'github') {
    const status = h('div', { class: 'row' }, h('span', { class: 'spin' }), 'Checking GitHub sign-in…');
    get('/copilot/status').then((s) => {
      status.innerHTML = '';
      status.append(statusDot(s.isAuthenticated ? 'ok' : 'error'), h('span', {}, s.isAuthenticated ? `Signed in: ${s.statusMessage || s.login}` : (s.statusMessage || 'Not signed in')));
      if (s.note) status.append(h('span', { class: 'tiny muted', style: { flexBasis: '100%' } }, s.note));
    }).catch((e) => { status.textContent = e.message; });
    const model = select([{ value: d.model || 'auto', label: d.model || 'auto' }]);
    get('/copilot/models').then((ms) => { model.innerHTML = ''; for (const m of ms) model.append(h('option', { value: m.id, selected: m.id === (d.model || 'auto') || undefined }, m.id === 'auto' ? 'auto (best available)' : m.name)); }).catch(() => {});
    model.addEventListener('change', () => { d.model = model.value; });
    const effort = select(['', 'low', 'medium', 'high', 'xhigh'].map((x) => ({ value: x, label: x || 'default', selected: x === d.reasoningEffort })));
    effort.addEventListener('change', () => { d.reasoningEffort = effort.value; });
    const tok = input({ type: 'password', placeholder: 'GitHub token (optional)' });
    const showLoginJob = (j, anchor) => {
      app.watchJob(j.id);
      const box = h('div', { class: 'mt' });
      anchor.after(box);
      const render = (x) => { box.innerHTML = ''; box.append(app.jobCard(x)); };
      render(j);
      const off = on('job', (e) => { if (e.job.id !== j.id) return; render(e.job); if (e.job.status !== 'running') { off(); redraw(); } });
    };
    const login = h('button', { class: 'btn', 'data-busy': 'Starting…' }, 'Sign in with GitHub CLI');
    login.addEventListener('click', busy(login, async () => {
      const j = await post('/copilot/login');
      showLoginJob(j, login);
    }));
    const switchAcct = h('button', { class: 'btn', 'data-busy': 'Switching…' }, 'Switch GitHub account');
    switchAcct.addEventListener('click', busy(switchAcct, async () => {
      if (!(await confirmDialog('Switch GitHub account?', 'The app will sign GitHub CLI out of the current github.com account on this computer, then open the browser sign-in flow for the new account. This does not revoke the old token in GitHub; it only removes it locally.', 'Switch account'))) return;
      const j = await post('/copilot/switch');
      showLoginJob(j, switchAcct);
    }));
    const useTok = h('button', { class: 'btn', 'data-busy': 'Checking…' }, 'Use token');
    useTok.addEventListener('click', busy(useTok, async () => { const s = await post('/copilot/token', { token: tok.value }); toast(s.isAuthenticated ? 'GitHub token accepted' : 'Token not accepted', s.isAuthenticated ? 'ok' : 'err'); redraw(); }));
    body.append(h('div', { class: 'col mt' }, status,
      h('div', { class: 'formgrid' }, field('Model', model, 'Models available to your Copilot plan'), field('Reasoning effort', effort)),
      h('div', { class: 'row' }, login, switchAcct, tok, useTok),
      h('p', { class: 'tiny muted' }, 'Uses your GitHub Copilot seat (Free, Pro, Pro+, Business or Enterprise). Business/Enterprise admins may need to allow MCP servers and the models you pick. Tokens are kept in memory only.')));
  } else if (d.id === 'openrouter') {
    const saved = store.settings?.provider?.hasApiKey && cur.id === 'openrouter';
    const key = input({ type: 'password', placeholder: saved ? '•••••••• (saved in memory)' : 'sk-or-…' });
    const search = input({ placeholder: 'Search models – claude, gpt, gemini, free…' });
    const model = select([{ value: d.model || OPENROUTER_AUTO, label: 'Loading OpenRouter models…' }]);
    const info = h('div', { class: 'tiny muted' });
    let models = [];
    const showInfo = () => {
      const m = models.find((x) => x.id === model.value);
      if (!m) { info.textContent = ''; return; }
      const free = m.price?.input === 0 && m.price?.output === 0;
      const price = free ? 'free' : m.price?.input !== null ? `$${m.price.input} in / $${m.price.output} out per million tokens` : '';
      const ctx = m.context ? `${m.context.toLocaleString()} tokens of context` : '';
      info.textContent = [m.id, price, ctx, m.reasoning ? 'supports reasoning effort' : ''].filter(Boolean).join(' · ');
    };
    get('/openrouter/models').then((ms) => { models = ms; fillModelSelect(model, models, d.model || OPENROUTER_AUTO); showInfo(); })
      .catch((e) => { model.innerHTML = ''; model.append(h('option', { value: d.model || OPENROUTER_AUTO }, d.model || OPENROUTER_AUTO)); info.textContent = e.message; });
    search.addEventListener('input', () => { fillModelSelect(model, models, model.value, search.value); showInfo(); });
    model.addEventListener('change', () => { d.model = model.value; showInfo(); });
    const effort = select(['', 'low', 'medium', 'high'].map((x) => ({ value: x, label: x || 'default', selected: x === d.reasoningEffort })));
    effort.addEventListener('change', () => { d.reasoningEffort = effort.value; });
    body.append(h('div', { class: 'col mt' },
      h('div', { class: 'formgrid' }, field('API key', key, h('span', {}, 'From ', h('a', { href: 'https://openrouter.ai/settings/keys', target: '_blank', rel: 'noopener' }, 'openrouter.ai › Keys ↗'))), field('Search', search)),
      field('Model', model, 'Only models that can call tools – Copilot works through tools. Prices are per million tokens, input / output.'),
      info,
      h('div', { class: 'formgrid' }, field('Reasoning effort', effort, 'Used by models that support it')),
      h('p', { class: 'tiny muted' }, 'Developer mode only. The key is kept in memory until the studio stops – set the OPENROUTER_API_KEY environment variable to have it every time. Prompts and data in answers go to OpenRouter and the model\'s lab under their terms.')));
    d.read = () => { if (key.value.trim()) d.config.apiKey = key.value.trim(); d.model = model.value || d.model; };
  } else {
    const inputs = {};
    const fields = meta.fields.map((f) => {
      let ctl;
      if (f.options) { ctl = select(f.options.map((o) => ({ value: o, label: { entra: 'Microsoft Entra ID (recommended)', key: 'API key' }[o] || o, selected: (d.config[f.id] || f.options[0]) === o }))); }
      else ctl = input({ type: f.secret ? 'password' : 'text', placeholder: f.secret && store.settings?.provider?.hasApiKey && d.id === cur.id ? '•••••••• (saved in memory)' : f.placeholder || '', value: f.secret ? '' : d.config[f.id] || '' });
      inputs[f.id] = ctl;
      return field(f.label, ctl);
    });
    body.append(h('div', { class: 'col mt' }, h('div', { class: 'formgrid' }, fields), h('p', { class: 'tiny muted' }, `${meta.needs}. API keys are kept in memory only (or set environment variables such as AZURE_OPENAI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY before starting the studio). Pick a model that supports tool calling.`)));
    d.read = () => { for (const f of meta.fields) { const v = inputs[f.id].value; if (f.secret && !v) continue; d.config[f.id] = v; } };
  }

  const save = h('button', { class: 'btn pri', 'data-busy': 'Saving…' }, 'Save');
  save.addEventListener('click', busy(save, async () => {
    d.read?.();
    const r = await put('/providers', { id: d.id, model: d.model, reasoningEffort: d.reasoningEffort, config: d.config });
    store.provider = r.current;
    store.settings.provider = r.settings;
    d.saved = d.id;
    toast(`AI provider: ${r.current.name}. New chats use it.`, 'ok');
    app.refresh();
  }));
  const test = h('button', { class: 'btn', 'data-busy': 'Testing…' }, 'Test');
  test.addEventListener('click', busy(test, async () => {
    const r = await post('/providers/test');
    toast(`${r.name}${r.model ? ` (${r.model})` : ''} replied "${r.reply}" in ${(r.ms / 1000).toFixed(1)}s`, 'ok');
  }));
  card.append(h('h2', {}, 'AI provider'), h('p', { class: 'lead' }, 'Use the Copilot or model your organization already licenses. The Fabric MCP servers are the same for every provider.'), cards, body, h('div', { class: 'row mt' }, save, test, h('span', { class: 'tiny muted' }, 'Save first, then Test.')));
  return card;
}

// ---------------- approvals ----------------
function approvalsCard() {
  const cur = store.settings?.approvalMode || 'ask';
  return h('div', { class: 'card' },
    h('h2', {}, 'Approvals'),
    h('p', { class: 'lead' }, 'Decide how Copilot handles calls that create or change things in Fabric. Read-only calls never need approval.'),
    seg([{ value: 'ask', label: 'Ask every time' }, { value: 'auto', label: 'Auto-approve' }, { value: 'readonly', label: 'Read-only' }], cur, async (v) => {
      try { store.settings = await patch('/settings', { approvalMode: v }); toast('Approval mode updated', 'ok'); } catch (e) { toast(e.message, 'err'); }
    }),
    h('ul', { class: 'pre' }, h('li', {}, 'Ask every time (recommended): each change opens a review dialog with the exact request.'), h('li', {}, 'Auto-approve: for demos in a sandbox workspace.'), h('li', {}, 'Read-only: Copilot can explore and answer, but every change is blocked.')));
}

// ---------------- MCP servers ----------------
function mcpCard() {
  const s = store.settings?.mcp || {};
  const health = store.health?.checks || [];
  const rows = [
    ['fabric-core', 'Fabric Core', 'Workspaces, items, roles and item definitions', 'toggle'],
    ['powerbi-authoring', 'Power BI Authoring', 'Create and edit semantic models (hosted = remote, preview; local = npx, works with Desktop/PBIP)', 'pbi'],
    ['fabric-iq', 'Fabric IQ', 'Read-only answers over semantic models with DAX', 'toggle'],
    ['fabric-local', 'Fabric (local)', 'API specs, item schemas, best practices and OneLake tools (runs with npx)', 'toggle'],
    ['fabric-ontology', 'Ontology', 'Business entities and rules (after the ontology is deployed; paid F2+). Ontology questions are turned off for now – numbers come from Fabric IQ', 'toggle'],
  ];
  const save = async (k, v) => {
    try { store.settings = await patch('/settings', { mcp: { [k]: v } }); toast('MCP servers updated. New chats use the new set.', 'ok'); } catch (e) { toast(e.message, 'err'); }
  };
  const t = h('table', { class: 't' });
  for (const [k, name, desc, kind] of rows) {
    const hc = health.find((c) => c.id === `mcp-${k}`);
    let ctl;
    if (kind === 'pbi') ctl = seg([{ value: 'hosted', label: 'Hosted' }, { value: 'local', label: 'Local' }, { value: 'off', label: 'Off' }], s[k] || 'hosted', (v) => save(k, v));
    else { ctl = h('input', { type: 'checkbox', checked: Boolean(s[k]) || undefined }); ctl.addEventListener('change', () => save(k, ctl.checked)); }
    t.append(h('tr', {}, h('td', {}, h('div', { class: 'row' }, h('span', { class: `srv ${k}` }, name), hc ? statusDot(hc.status) : null), h('div', { class: 'tiny muted' }, desc), hc ? h('div', { class: 'tiny muted' }, hc.detail) : null), h('td', { class: 'num' }, ctl)));
  }
  return h('div', { class: 'card' }, h('h2', {}, 'MCP servers'), h('p', { class: 'lead' }, 'All servers run as the signed-in user with a token from your Microsoft Entra sign-in.'), t);
}

// ---------------- Entra ----------------
function entraCard() {
  const s = store.settings?.azure || {};
  const u = store.user || {};
  const mode = select([{ value: 'auto', label: 'Automatic (Azure CLI, then browser)' }, { value: 'azure-cli', label: 'Azure CLI only (az login)' }, { value: 'browser', label: 'Browser sign-in' }].map((o) => ({ ...o, selected: o.value === (s.authMode || 'auto') })));
  const tenant = input({ value: s.tenantId || '', placeholder: 'Optional: tenant ID or domain' });
  const save = h('button', { class: 'btn pri', 'data-busy': 'Saving…' }, 'Save');
  save.addEventListener('click', busy(save, async () => {
    store.settings = await patch('/settings', { azure: { authMode: mode.value, tenantId: tenant.value.trim() } });
    toast('Saved. Sign in again to apply.', 'ok');
    await app.refresh();
  }));
  return h('div', { class: 'card' },
    h('h2', {}, 'Microsoft Entra sign-in'),
    h('p', { class: 'lead' }, u.signedIn ? `Signed in as ${u.upn} (${u.tenantDomain || u.tenantId}) via ${u.mode === 'azure-cli' ? 'Azure CLI' : 'browser'}.` : 'Not signed in.'),
    h('div', { class: 'formgrid' }, field('Sign-in method', mode), field('Tenant', tenant)),
    h('div', { class: 'row mt' }, save, h('button', { class: 'btn', onclick: () => document.getElementById('userChip').click() }, u.signedIn ? 'Switch account' : 'Sign in')));
}

// ---------------- danger zone ----------------
let cleanupJobId = null;   // the last clean up, still shown after the tab re-renders

function cleanupSummary(plan) {
  const ws = plan.workspace.name;
  const muted = (text) => h('p', { class: 'small muted' }, text);
  if (plan.deleteWorkspace) {
    return h('div', {},
      h('p', {}, 'This deletes the workspace ', h('b', {}, ws), ' and everything in it, including items the studio didn\'t create.'),
      muted('A Fabric administrator can restore a deleted workspace during its retention period (7 days by default).'));
  }
  const n = plan.items.length;
  const restorable = plan.items.some((i) => i.recoverable);
  return h('div', {},
    h('p', {}, `This deletes ${n} item${n === 1 ? '' : 's'} the studio created in `, h('b', {}, ws), `${plan.sources > 1 ? ` for all ${plan.sources} data sources of the workspace` : ''}. Your own data sources and the other items in the workspace aren't touched.`),
    h('div', { class: 'tclist' }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Name'), h('th', {}, 'After deleting'))),
      h('tbody', {}, plan.items.map((i) => h('tr', {},
        h('td', {}, i.label, i.source ? h('div', { class: 'tiny muted' }, i.source) : null), h('td', {}, i.name),
        h('td', {}, i.recoverable ? h('span', { class: 'pill ok', title: 'Can be restored from the workspace recycle bin' }, 'Recycle bin') : h('span', { class: 'pill err' }, 'Gone for good'))))))),
    plan.ontologyCompanions ? muted('The ontology\'s graph and Eventhouse companion items are deleted with it.') : null,
    (plan.taskFlows || (plan.taskFlow ? [plan.taskFlow] : [])).length ? muted(`The workspace task flow${(plan.taskFlows || [plan.taskFlow]).length === 1 ? '' : 's'} ${(plan.taskFlows || [plan.taskFlow]).map((x) => `"${x.name}"`).join(' and ')} ${(plan.taskFlows || [plan.taskFlow]).length === 1 ? 'is' : 'are'} removed too (your other task flows stay).`) : null,
    plan.liveEvents ? muted('The live event simulator stops.') : null,
    muted(restorable
      ? 'Items marked Recycle bin can be restored from the workspace recycle bin for a few days (3 by default) when item recovery is on in your tenant. The others can\'t be restored, but the studio can build them again.'
      : 'These items can\'t be restored, but the studio can build them again.'),
    muted('Afterwards the project is empty: the map and every tab start over, and you choose a workspace again. The workspace itself stays in Fabric unless you chose to delete it.'));
}

function dangerCard() {
  const p = store.project || {};
  const delWs = h('input', { type: 'checkbox', disabled: !p.workspace?.created || undefined });
  const job = h('div', { class: 'mt' });
  const showJob = (x) => { job.innerHTML = ''; if (x) job.append(app.jobCard(x)); };
  const follow = (id) => {
    const off = on('job', (e) => { if (e.job.id !== id) return; if (!job.isConnected) { off(); return; } showJob(e.job); if (e.job.status !== 'running') off(); });
  };
  const last = cleanupJobId && store.jobs.get(cleanupJobId);
  if (last) { showJob(last); if (last.status === 'running') follow(last.id); }
  const clean = h('button', { class: 'btn danger', 'data-busy': 'Checking…', disabled: !p.workspace || undefined }, 'Clean up resources');
  clean.addEventListener('click', busy(clean, async () => {
    const plan = await get(`/teardown/plan?workspace=${delWs.checked ? 1 : 0}`);
    if (!plan.workspace) return;
    if (!plan.deleteWorkspace && !plan.items.length) {
      // Nothing to delete: just let go of the workspace so the project starts empty.
      if (!(await confirmDialog('Clean up', `Nothing the studio created is left in ${plan.workspace.name}. Clear the project so the map and every tab start over? ${plan.workspace.name} stays in Fabric.`, 'Clear the project'))) return;
      const j = await post('/jobs/teardown', { deleteWorkspace: false, confirm: plan.workspace.name });
      cleanupJobId = j.id;
      app.watchJob(j.id);
      showJob(j);
      follow(j.id);
      return;
    }
    const n = plan.items.length;
    const phrase = await typedConfirmDialog(plan.deleteWorkspace ? 'Delete the workspace' : 'Clean up resources', cleanupSummary(plan), plan.workspace.name, plan.deleteWorkspace ? 'Delete workspace' : `Delete ${n} item${n === 1 ? '' : 's'}`);
    if (!phrase) return;
    const j = await post('/jobs/teardown', { deleteWorkspace: plan.deleteWorkspace, confirm: phrase });
    cleanupJobId = j.id;
    app.watchJob(j.id);
    showJob(j);
    follow(j.id);
  }));
  const reset = h('button', { class: 'btn', 'data-busy': 'Resetting…' }, 'Start a new project');
  reset.addEventListener('click', busy(reset, async () => {
    if (!(await confirmDialog('Start a new project', 'This clears the studio\'s local project state and activity log. Nothing is deleted in Fabric.'))) return;
    await post('/project/reset');
    toast('Project reset', 'ok');
    await app.refreshAll();
    app.go('home');
  }));
  return h('div', { class: 'card' },
    h('h2', {}, 'Clean up'),
    h('p', { class: 'lead' }, 'Remove what the studio created, or start over.'),
    h('label', { class: 'row small' }, delWs, `Delete the whole workspace${p.workspace?.created ? ` "${p.workspace.name}"` : ' (only for workspaces the studio created)'}`),
    h('div', { class: 'row mt' }, clean, reset), job);
}
