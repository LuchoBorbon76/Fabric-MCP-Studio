import { store, get, post, put, patch, on } from '../api.js';
import { h, toast, busy, field, input, select, seg, confirmDialog, statusDot } from '../ui.js';
import { app } from '../app.js';

let draftProvider = null;

export function renderSettings(el) {
  el.append(h('div', { class: 'grid g2' },
    h('div', { class: 'col', style: { gap: '14px' } }, providerCard(), approvalsCard()),
    h('div', { class: 'col', style: { gap: '14px' } }, mcpCard(), entraCard(), dangerCard())));
}

// ---------------- AI provider ----------------
function providerCard() {
  const card = h('div', { class: 'card' });
  const cur = store.settings?.provider || { id: 'github' };
  if (!draftProvider || draftProvider.saved !== cur.id) draftProvider = { id: cur.id, model: cur.model, reasoningEffort: cur.reasoningEffort || '', config: { ...(cur.config || {}) }, saved: cur.id };
  const d = draftProvider;
  const body = h('div');
  const cards = h('div', { class: 'srcs' }, store.providers.map((p) => h('div', { class: `src ${d.id === p.id ? 'on' : ''}`, onclick: () => { d.id = p.id; d.config = p.id === cur.id ? { ...(cur.config || {}) } : {}; d.model = p.id === cur.id ? cur.model : ''; redraw(); } },
    h('div', { class: 'h' }, h('div', { class: 'ic' }, { github: '🐙', 'azure-openai': '☁', openai: '◎', anthropic: '✳', local: '🖥' }[p.id] || '✦'), p.name),
    h('div', { class: 'meta' }, p.license))));
  const redraw = () => { card.replaceWith(providerCard()); };

  const meta = store.providers.find((p) => p.id === d.id);
  if (d.id === 'github') {
    const status = h('div', { class: 'row' }, h('span', { class: 'spin' }), 'Checking GitHub sign-in…');
    get('/copilot/status').then((s) => {
      status.innerHTML = '';
      status.append(statusDot(s.isAuthenticated ? 'ok' : 'error'), h('span', {}, s.isAuthenticated ? `Signed in: ${s.statusMessage || s.login}` : (s.statusMessage || 'Not signed in')));
    }).catch((e) => { status.textContent = e.message; });
    const model = select([{ value: d.model || 'auto', label: d.model || 'auto' }]);
    get('/copilot/models').then((ms) => { model.innerHTML = ''; for (const m of ms) model.append(h('option', { value: m.id, selected: m.id === (d.model || 'auto') || undefined }, m.id === 'auto' ? 'auto (best available)' : m.name)); }).catch(() => {});
    model.addEventListener('change', () => { d.model = model.value; });
    const effort = select(['', 'low', 'medium', 'high', 'xhigh'].map((x) => ({ value: x, label: x || 'default', selected: x === d.reasoningEffort })));
    effort.addEventListener('change', () => { d.reasoningEffort = effort.value; });
    const tok = input({ type: 'password', placeholder: 'GitHub token (optional)' });
    const login = h('button', { class: 'btn', 'data-busy': 'Starting…' }, 'Sign in with GitHub CLI');
    login.addEventListener('click', busy(login, async () => {
      const j = await post('/copilot/login');
      app.watchJob(j.id);
      const box = h('div', { class: 'mt' });
      login.after(box);
      const render = (x) => { box.innerHTML = ''; box.append(app.jobCard(x)); };
      render(j);
      const off = on('job', (e) => { if (e.job.id !== j.id) return; render(e.job); if (e.job.status !== 'running') { off(); redraw(); } });
    }));
    const useTok = h('button', { class: 'btn', 'data-busy': 'Checking…' }, 'Use token');
    useTok.addEventListener('click', busy(useTok, async () => { const s = await post('/copilot/token', { token: tok.value }); toast(s.isAuthenticated ? 'GitHub token accepted' : 'Token not accepted', s.isAuthenticated ? 'ok' : 'err'); redraw(); }));
    body.append(h('div', { class: 'col mt' }, status,
      h('div', { class: 'formgrid' }, field('Model', model, 'Models available to your Copilot plan'), field('Reasoning effort', effort)),
      h('div', { class: 'row' }, login, tok, useTok),
      h('p', { class: 'tiny muted' }, 'Uses your GitHub Copilot seat (Free, Pro, Pro+, Business or Enterprise). Business/Enterprise admins may need to allow MCP servers and the models you pick. Tokens are kept in memory only.')));
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
function dangerCard() {
  const p = store.project || {};
  const delWs = h('input', { type: 'checkbox', disabled: !p.workspace?.created || undefined });
  const job = h('div', { class: 'mt' });
  const clean = h('button', { class: 'btn danger', 'data-busy': 'Starting…', disabled: !p.workspace || undefined }, 'Clean up resources');
  clean.addEventListener('click', busy(clean, async () => {
    const what = delWs.checked ? `the whole workspace "${p.workspace.name}"` : 'the lakehouse, SQL database, mirrored database, semantic model and ontology created by the studio';
    if (!(await confirmDialog('Clean up resources', `This deletes ${what}. This cannot be undone.`, 'Delete', true))) return;
    const j = await post('/jobs/teardown', { deleteWorkspace: delWs.checked });
    app.watchJob(j.id);
    const render = (x) => { job.innerHTML = ''; job.append(app.jobCard(x)); };
    render(j);
    const off = on('job', (e) => { if (e.job.id !== j.id) return; render(e.job); if (e.job.status !== 'running') off(); });
  }));
  const reset = h('button', { class: 'btn', 'data-busy': 'Resetting…' }, 'Start a new project');
  reset.addEventListener('click', busy(reset, async () => {
    if (!(await confirmDialog('Start a new project', 'This clears the studio\'s local project state and activity log. Nothing is deleted in Fabric.'))) return;
    await post('/project/reset');
    toast('Project reset', 'ok');
    await app.refresh();
    app.go('home');
  }));
  return h('div', { class: 'card' },
    h('h2', {}, 'Clean up'),
    h('p', { class: 'lead' }, 'Remove what the studio created, or start over.'),
    h('label', { class: 'row small' }, delWs, `Delete the whole workspace${p.workspace?.created ? ` "${p.workspace.name}"` : ' (only for workspaces the studio created)'}`),
    h('div', { class: 'row mt' }, clean, reset), job);
}
