import { store, get, post, put, patch, on } from '../api.js';
import { h, toast, busy, field, input, select, seg, confirmDialog, typedConfirmDialog, statusDot, modal } from '../ui.js';
import { app } from '../app.js';
import { showDisclaimer, showWhatsNew } from '../about.js';
import { OPENROUTER_AUTO, fillModelSelect, modelFacts } from '../openrouter.js';

let draftProvider = null;
const promptedRecommendations = new Set();

const STATIC_RECOMMENDATIONS = {
  github: [
    { model: 'auto', title: 'Auto (best available)', badge: 'Recommended', why: 'Lets GitHub Copilot pick the strongest available model for tool-heavy Fabric MCP work.' },
  ],
  'azure-openai': [
    { model: 'gpt-5.4', title: 'GPT-5.4', badge: 'Recommended', why: 'Best default when your Azure AI Foundry deployment supports tool calling, larger context and reasoning.', config: { modelId: 'gpt-5.4', deployment: 'gpt-5.4', authMode: 'entra', wireApi: 'responses' }, effort: 'medium' },
    { model: 'gpt-5.4-mini', title: 'GPT-5.4 Mini', badge: 'Lower cost', why: 'Good for demos and lighter Fabric actions when you want faster/lower-cost responses.', config: { modelId: 'gpt-5.4-mini', deployment: 'gpt-5.4-mini', authMode: 'entra', wireApi: 'responses' }, effort: 'low' },
    { model: 'gpt-4.1', title: 'GPT-4.1', badge: 'Compatibility', why: 'Use when this is the strongest tool-calling deployment available in your Azure resource.', config: { modelId: 'gpt-4.1', deployment: 'gpt-4.1', authMode: 'entra', wireApi: 'responses' }, effort: '' },
  ],
  openai: [
    { model: 'gpt-5.4', title: 'GPT-5.4', badge: 'Recommended', why: 'Strong tool use and reasoning for multi-step Fabric build/debug workflows.', config: { modelId: 'gpt-5.4' }, effort: 'medium' },
    { model: 'gpt-5.4-mini', title: 'GPT-5.4 Mini', badge: 'Lower cost', why: 'Good for everyday assistance and shorter Fabric MCP tasks.', config: { modelId: 'gpt-5.4-mini' }, effort: 'low' },
    { model: 'gpt-4.1', title: 'GPT-4.1', badge: 'Compatibility', why: 'Fallback when the GPT-5 family is not available on your account.', config: { modelId: 'gpt-4.1' }, effort: '' },
  ],
  anthropic: [
    { model: 'claude-sonnet-4-5', title: 'Claude Sonnet 4.5', badge: 'Recommended', why: 'Best balance for tool-calling, long reasoning and code/report planning.', config: { modelId: 'claude-sonnet-4-5' }, effort: 'medium' },
    { model: 'claude-opus-4-5', title: 'Claude Opus 4.5', badge: 'Deep reasoning', why: 'Use for difficult architecture or troubleshooting work when latency/cost matter less.', config: { modelId: 'claude-opus-4-5' }, effort: 'high' },
    { model: 'claude-haiku-4-5', title: 'Claude Haiku 4.5', badge: 'Fast', why: 'Use for quick answers and simple Fabric navigation tasks.', config: { modelId: 'claude-haiku-4-5' }, effort: 'low' },
  ],
  local: [
    { model: 'qwen3:32b', title: 'Qwen3 32B', badge: 'Recommended local', why: 'Good local default when served through Ollama/LM Studio/vLLM with tool calling.', config: { modelId: 'qwen3:32b', baseUrl: 'http://localhost:11434/v1' } },
    { model: 'gpt-oss:120b', title: 'gpt-oss 120B', badge: 'Large local', why: 'Use if your machine/server can host a larger local tool-calling model.', config: { modelId: 'gpt-oss:120b', baseUrl: 'http://localhost:11434/v1' } },
    { model: 'llama3.1:70b', title: 'Llama 3.1 70B', badge: 'Compatible local', why: 'Fallback local model family when Qwen/GPT-OSS is not available.', config: { modelId: 'llama3.1:70b', baseUrl: 'http://localhost:11434/v1' } },
  ],
};

function openRouterRecommendations(models = []) {
  const recs = [{ model: OPENROUTER_AUTO, title: 'OpenRouter Auto Router', badge: 'Recommended', why: 'Best default: OpenRouter picks a tool-capable model per request, useful when availability and pricing change.' }];
  const usable = models.filter((m) => m.id !== OPENROUTER_AUTO && m.context && m.price?.input !== -1000000);
  const score = (m) => {
    const name = `${m.id} ${m.name}`.toLowerCase();
    const family = /claude|gpt-|gemini|grok|kimi|qwen|mistral/.test(name) ? 3 : 0;
    const reason = m.reasoning ? 2.5 : 0;
    const ctxScore = Math.min(4, Math.log10(Math.max(1, m.context / 1000)));
    const price = Number(m.price?.input || 0) + Number(m.price?.output || 0);
    const pricePenalty = price > 0 ? Math.min(3, Math.log10(price + 1)) : 0;
    return family + reason + ctxScore - pricePenalty;
  };
  const best = [...usable].sort((a, b) => score(b) - score(a))[0];
  const budget = [...usable].filter((m) => (m.price?.input === 0 && m.price?.output === 0) || (Number(m.price?.input || 0) + Number(m.price?.output || 0) <= 1)).sort((a, b) => (b.context || 0) - (a.context || 0))[0];
  const long = [...usable].sort((a, b) => (b.context || 0) - (a.context || 0))[0];
  for (const [m, badge, why] of [
    [best, 'Strongest fit', 'Best scored tool-capable option by context, reasoning support, model family and cost.'],
    [long, 'Largest context', 'Use for long chats, large schemas and broad project troubleshooting.'],
    [budget, 'Budget', 'Use when you want a lower-cost or free model that can still call tools.'],
  ]) {
    if (m && !recs.some((r) => r.model === m.id)) recs.push({ model: m.id, title: m.name, badge, why, facts: modelFacts(m), effort: m.reasoning ? 'medium' : '' });
  }
  return recs.slice(0, 4);
}

function recommendations(providerId, liveModels = []) {
  if (providerId === 'openrouter') return openRouterRecommendations(liveModels);
  if (providerId === 'github' && liveModels.length > 1) {
    const extras = liveModels.filter((m) => m.id !== 'auto').slice(0, 3).map((m) => ({ model: m.id, title: m.name || m.id, badge: m.reasoning ? 'Reasoning' : 'Available', why: m.reasoning ? 'Good when you want explicit reasoning effort support.' : 'Available in your GitHub Copilot plan.' }));
    return [...STATIC_RECOMMENDATIONS.github, ...extras];
  }
  return STATIC_RECOMMENDATIONS[providerId] || [];
}

function applyRecommendation(d, r) {
  if (!r) return;
  d.model = r.model || d.model || '';
  if (r.effort !== undefined) d.reasoningEffort = r.effort || '';
  d.config = { ...(d.config || {}), ...(r.config || {}) };
}

function showRecommendations(providerId, d, redraw) {
  const list = recommendations(providerId, d.liveModels || []);
  if (!list.length) { toast('No built-in model recommendations for this provider yet.', 'err'); return; }
  const body = h('div', { class: 'col' },
    h('p', { class: 'small muted', style: { margin: 0 } }, 'These models are suggested for Fabric MCP because they support tool use, reasoning, enough context for schemas/project state, or a good cost/performance trade-off. You can still edit the fields after choosing.'),
    h('div', { class: 'recmodels' }, list.map((r, i) => {
      const choose = h('button', { class: `btn ${i === 0 ? 'pri' : ''}` }, i === 0 ? 'Use recommended' : 'Use this');
      const row = h('div', { class: 'recmodel' },
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'row', style: { gap: '6px' } }, h('b', {}, r.title || r.model), h('span', { class: 'pill' }, r.badge || 'Suggested')),
          h('div', { class: 'tiny muted' }, [r.model, r.facts].filter(Boolean).join(' · ')),
          h('p', { class: 'small muted' }, r.why)),
        choose);
      choose.addEventListener('click', () => { applyRecommendation(d, r); dlg.close(); redraw(); toast(`Model set to ${r.model}`, 'ok'); });
      return row;
    })));
  const dlg = modal({ title: 'Recommended models for Fabric MCP', className: 'wide', body, actions: [{ label: 'Close' }] });
}

export function renderSettings(el) {
  el.append(h('div', { class: 'grid g2' },
    h('div', { class: 'col', style: { gap: '14px' } }, providerCard(), prerequisitesCard(), approvalsCard(), diagnosticsCard(), aboutCard()),
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
    store.settings?.developer ? [h('dt', {}, 'Developer mode'), h('dd', {}, 'On – developer diagnostics and client setup hints are visible')] : null),
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

function prerequisitesCard() {
  const body = h('div', { class: 'col' }, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Checking prerequisites…'));
  const load = async () => {
    body.replaceChildren(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Checking prerequisites…'));
    try {
      const r = await get('/readiness/fixes?refresh=1');
      body.innerHTML = '';
      if (r.allReady && !r.modules.length && !r.checks.length) {
        body.append(h('div', { class: 'banner ok' }, h('div', {}, h('b', {}, 'Everything important is ready. '), 'No required prerequisite fixes were found.')));
        return;
      }
      const groups = r.modules.filter((m) => m.fixes.length);
      if (r.checks.length) body.append(h('div', { class: 'pgrp' }, h('h4', {}, 'Environment checks'), fixChips(r.checks)));
      for (const m of groups) body.append(h('div', { class: 'pgrp' }, h('h4', {}, m.label, h('span', { class: `pill ${m.status === 'blocked' ? 'err' : 'warn'}`, style: { marginLeft: '8px' } }, m.status)), fixChips(m.fixes)));
    } catch (e) {
      body.replaceChildren(h('div', { class: 'banner err' }, e.message));
    }
  };
  const retry = h('button', { class: 'btn', 'data-busy': 'Checking…' }, 'Check again');
  retry.addEventListener('click', busy(retry, load));
  load();
  return h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('h2', {}, 'Fix prerequisites'), retry),
    h('p', { class: 'lead' }, 'When something is blocked or limited, this shows exactly what is missing, who can fix it, and where to go next.'),
    body);
}

function fixChips(items) {
  return h('div', { class: 'col', style: { gap: '8px' } }, items.map((x) => h('div', { class: `banner ${x.status === 'error' ? 'err' : x.status === 'warn' || x.status === 'unknown' ? 'warn' : ''}` },
    h('div', {}, h('b', {}, x.text), x.fix ? h('div', { class: 'small', style: { marginTop: '4px' } }, x.fix) : null),
    x.link ? h('a', { class: 'btn', href: x.link, target: '_blank', rel: 'noopener' }, 'Open fix ↗') : null)));
}

// ---------------- AI provider ----------------
function providerCard() {
  const card = h('div', { class: 'card' });
  const cur = store.settings?.provider || { id: 'azure-openai' };
  if (!draftProvider || draftProvider.saved !== cur.id) draftProvider = { id: cur.id, model: cur.model, reasoningEffort: cur.reasoningEffort || '', config: { ...(cur.config || {}) }, saved: cur.id };
  if (!draftProvider.model && !draftProvider.config?.modelId && !draftProvider.config?.deployment) applyRecommendation(draftProvider, recommendations(draftProvider.id)[0]);
  const d = draftProvider;
  const body = h('div');
  const cards = h('div', { class: 'srcs' }, store.providers.map((p) => h('div', { class: `src ${d.id === p.id ? 'on' : ''}`, onclick: () => {
    const changed = d.id !== p.id;
    d.id = p.id;
    d.config = p.id === cur.id ? { ...(cur.config || {}) } : {};
    d.model = p.id === cur.id ? cur.model : '';
    d.reasoningEffort = p.id === cur.id ? cur.reasoningEffort || '' : '';
    d.read = null;
    if (changed) {
      d.promptRecommendation = true;
      applyRecommendation(d, recommendations(p.id)[0]);
      if (p.id !== 'openrouter' && recommendations(p.id).length > 1 && !promptedRecommendations.has(p.id)) {
        d.promptRecommendation = false;
        promptedRecommendations.add(p.id);
        setTimeout(() => showRecommendations(p.id, draftProvider, () => app.rerender()), 0);
      }
    }
    redraw();
  } },
    h('div', { class: 'h' }, h('div', { class: 'ic' }, { github: '🐙', 'azure-openai': '☁', openai: '◎', anthropic: '✳', local: '🖥', openrouter: '🔀' }[p.id] || '✦'), p.name),
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
    get('/copilot/models').then((ms) => {
      d.liveModels = ms; model.innerHTML = ''; for (const m of ms) model.append(h('option', { value: m.id, selected: m.id === (d.model || 'auto') || undefined }, m.id === 'auto' ? 'auto (best available)' : m.name));
      if (d.promptRecommendation && recommendations('github', ms).length > 1 && !promptedRecommendations.has('github')) { d.promptRecommendation = false; promptedRecommendations.add('github'); setTimeout(() => showRecommendations('github', d, redraw), 0); }
    }).catch(() => {});
    model.addEventListener('change', () => { d.model = model.value; });
    const effort = select(['', 'low', 'medium', 'high', 'xhigh'].map((x) => ({ value: x, label: x || 'default', selected: x === d.reasoningEffort })));
    effort.addEventListener('change', () => { d.reasoningEffort = effort.value; });
    const tok = input({ type: 'password', placeholder: 'GitHub token (optional)' });
    const showLoginJob = (j, anchor) => {
      app.watchJob(j.id);
      let box = card.querySelector(`[data-gh-job="${j.id}"]`);
      if (!box) {
        box = h('div', { class: 'mt', 'data-gh-job': j.id });
        anchor.after(box);
      }
      const render = (x) => { box.innerHTML = ''; box.append(app.jobCard(x)); };
      let done = false;
      let timer = null;
      const finish = (x) => {
        if (!box.isConnected) { clearInterval(timer); return; }
        render(x);
        if (x.status === 'running') return;
        if (done) return;
        done = true;
        clearInterval(timer);
        off?.();
        redraw();
      };
      const off = on('job', (e) => { if (e.job.id === j.id) finish(e.job); });
      timer = setInterval(async () => {
        try {
          const latest = await get(`/jobs/${j.id}`);
          store.jobs.set(j.id, latest);
          finish(latest);
        } catch { /* SSE/reconnect will handle it */ }
      }, 3000);
      finish(j);
    };
    const login = h('button', { class: 'btn', 'data-busy': 'Starting…' }, 'Sign in with GitHub CLI');
    login.addEventListener('click', busy(login, async () => {
      const j = await post('/copilot/login');
      showLoginJob(j, login);
    }));
    const switchAcct = h('button', { class: 'btn', 'data-busy': 'Switching…' }, 'Switch GitHub account');
    switchAcct.addEventListener('click', busy(switchAcct, async () => {
      if (!(await confirmDialog('Switch GitHub account?', 'The app will sign GitHub CLI out of the current github.com account on this computer, then show a GitHub device code and open the browser sign-in flow for the new account. This does not revoke the old token in GitHub; it only removes it locally.', 'Switch account'))) return;
      const j = await post('/copilot/switch');
      showLoginJob(j, switchAcct);
    }));
    const useTok = h('button', { class: 'btn', 'data-busy': 'Checking…' }, 'Use token');
    useTok.addEventListener('click', busy(useTok, async () => { const s = await post('/copilot/token', { token: tok.value }); toast(s.isAuthenticated ? 'GitHub token accepted' : 'Token not accepted', s.isAuthenticated ? 'ok' : 'err'); redraw(); }));
    body.append(h('div', { class: 'col mt' }, status,
      h('div', { class: 'formgrid' }, field('Model', model, 'Models available to your Copilot plan'), field('Reasoning effort', effort)),
      h('div', { class: 'row' }, login, switchAcct, tok, useTok),
      h('p', { class: 'tiny muted' }, 'Uses your GitHub Copilot seat (Free, Pro, Pro+, Business or Enterprise). The sign-in job shows the GitHub device code and opens github.com/login/device; the code is copied to the clipboard when GitHub CLI supports it. Business/Enterprise admins may need to allow MCP servers and the models you pick. Tokens are kept in memory only.')));
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
    get('/openrouter/models').then((ms) => {
      models = ms; d.liveModels = ms;
      if (!d.model) applyRecommendation(d, openRouterRecommendations(models)[0]);
      fillModelSelect(model, models, d.model || OPENROUTER_AUTO); showInfo();
      if (d.promptRecommendation && !promptedRecommendations.has('openrouter')) { d.promptRecommendation = false; promptedRecommendations.add('openrouter'); setTimeout(() => showRecommendations('openrouter', d, redraw), 0); }
    })
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
      h('p', { class: 'tiny muted' }, 'The key is kept in memory until the studio stops – set the OPENROUTER_API_KEY environment variable to have it every time. Prompts and data in answers go to OpenRouter and the model\'s lab under their terms.')));
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
  const recommend = h('button', { class: 'btn', onclick: () => showRecommendations(d.id, d, redraw) }, 'Recommended models');
  card.append(h('h2', {}, 'AI provider'), h('p', { class: 'lead' }, 'Use the Copilot or model your organization already licenses. The Fabric MCP servers are the same for every provider.'), cards, body, h('div', { class: 'row mt' }, save, test, recommend, h('span', { class: 'tiny muted' }, 'Save first, then Test.')));
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
    const oldTenant = (s.tenantId || '').trim();
    const newTenant = tenant.value.trim();
    const oldMode = s.authMode || 'auto';
    store.settings = await patch('/settings', { azure: { authMode: mode.value, tenantId: tenant.value.trim() } });
    if (oldTenant !== newTenant) toast('Saved. Use Switch account to sign in to the selected tenant.', 'ok');
    else if (oldMode !== mode.value) toast('Saved. The current account stays active; use Switch account if you want to sign in again with this method.', 'ok');
    else toast('Saved. The current account stays active.', 'ok');
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
