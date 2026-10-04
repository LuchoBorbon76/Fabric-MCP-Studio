import { store } from '../api.js';
import { h } from '../ui.js';
import { app, suggestions } from '../app.js';

export function renderCopilot(el) {
  const p = store.project || {};
  const ctx = h('dl', { class: 'ctx' },
    h('dt', {}, 'AI provider'), h('dd', {}, `${store.provider?.name || '–'}${store.provider?.model ? ` · ${store.provider.model}` : ''}`),
    h('dt', {}, 'Workspace'), h('dd', {}, p.workspace?.name || 'Not selected'),
    h('dt', {}, 'Data'), h('dd', {}, p.source?.label || 'Not connected'),
    h('dt', {}, 'Semantic model'), h('dd', {}, p.semanticModel?.name || '–'),
    h('dt', {}, 'Ontology'), h('dd', {}, p.ontology?.name || '–'),
    h('dt', {}, 'Approvals'), h('dd', {}, { ask: 'Ask before every change', auto: 'Auto-approve changes', readonly: 'Read-only' }[store.settings?.approvalMode] || 'Ask'));

  const servers = h('div', { class: 'srvlist' }, Object.entries(store.settings?.mcp || {}).filter(([, v]) => v && v !== 'off').map(([k, v]) => h('span', { class: `srv ${k}` }, `${k}${v === 'local' ? ' (local)' : ''}`)));

  const side = h('div', { class: 'chatside' },
    h('div', { class: 'card' }, h('h3', {}, 'Context'), ctx, h('div', { class: 'mt' }, h('div', { class: 'tiny muted mb' }, 'MCP servers'), servers)),
    h('div', { class: 'card' }, h('h3', {}, 'Try asking'), h('div', { class: 'chips' }, suggestions(p, store.preset).map((s) => h('button', { class: 'chip', onclick: () => app.ask(s) }, s)))),
    h('div', { class: 'card' }, h('h3', {}, 'How it works'), h('p', { class: 'small muted' }, 'Copilot plans the work, calls Microsoft Fabric MCP servers as you, and shows each call inline. Anything that creates or changes items waits for your approval. Secrets never go through the chat – database credentials are entered in the Data page and sent straight to Fabric.')));

  el.append(h('div', { class: 'chatwrap' }, h('div', { id: 'chatSlot', style: { minHeight: 0 } }), side));
  requestAnimationFrame(fitChat);
}

// Fill the window below the chat's actual position (KPI cards and banners can wrap to more rows).
function fitChat() {
  const wrap = document.querySelector('.view.on .chatwrap');
  if (!wrap) return;
  const top = wrap.getBoundingClientRect().top + window.scrollY;
  wrap.style.height = `${Math.max(480, window.innerHeight - top - 24)}px`;
}
window.addEventListener('resize', fitChat);
