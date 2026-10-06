// Prompt suggestions grouped by what the project has (key numbers, comparisons, reports, rules, live data, plan,
// data source, next steps). The server builds them from the semantic model profile; until they arrive (or without a
// model) the built-in next steps are shown.
import { store, get, on, fire } from './api.js';
import { h } from './ui.js';
import { app, suggestions } from './app.js';

const ICON = { numbers: '📈', compare: '🏆', sample: '💬', reports: '📊', rules: '📏', plan: '🎯', live: '⚡', data: '🗂️', next: '🛠️' };

let loadedKey = null;
let pending = null;

// What changes the suggestions: a new source, model, report, ontology, live data, plan or data prep run.
const projectKey = (p) => [p?.workspace?.id, p?.modelSource?.itemId, p?.semanticModel?.id, p?.semanticModel?.measures, p?.semanticModel?.tables,
  (p?.reports || []).map((r) => r.id).join(','), p?.ontology?.id, Boolean(p?.realtime), Boolean(p?.realtime?.medallion), Boolean(p?.realtime?.dashboard),
  p?.planning?.planYear, p?.dataPrep?.lastRun?.status, Boolean(p?.orgApp), Boolean(p?.teamsAgent), Boolean(p?.dataAgent)].join('|');

/** Fetch the suggestions again when the project changed in a way that affects them. */
export function loadPrompts({ force = false } = {}) {
  const key = projectKey(store.project);
  if (!force && key === loadedKey) return pending;
  loadedKey = key;
  store.promptsLoading = true;
  fire('prompts.updated', store.prompts);
  pending = get('/prompts')
    .then((r) => { if (loadedKey === key) store.prompts = r; return r; })
    .catch(() => null)
    .finally(() => { if (loadedKey === key) { store.promptsLoading = false; fire('prompts.updated', store.prompts); } });
  return pending;
}

/** Grouped prompts: from the server when loaded, otherwise the built-in next steps. */
export function promptGroups() {
  const fresh = store.prompts && store.prompts.model === (store.project?.semanticModel?.name || null);
  if (fresh && store.prompts.groups?.length) return store.prompts.groups;
  return [{ id: 'next', title: 'Try asking', kind: 'build', prompts: suggestions(store.project, store.preset) }];
}

/** A short mix across groups (questions first) for small spaces such as the chat welcome. */
export function topPrompts(n = 6) {
  const groups = promptGroups();
  const ask = groups.filter((g) => g.kind === 'ask');
  const order = ask.length ? ask : groups;
  const out = [];
  for (let i = 0; out.length < n && i < 6; i++) {
    for (const g of order) if (g.prompts[i] && out.length < n && !out.includes(g.prompts[i])) out.push(g.prompts[i]);
  }
  return out;
}

/**
 * Prompt gallery: one block per group with its questions as chips (a few at first, "more" shows the rest). It redraws
 * itself when the suggestions change.
 */
export function promptGallery({ perGroup = 4, compact = false, only = null, kind = null, onAsk = (q) => app.ask(q), onEmpty } = {}) {
  const el = h('div', { class: `pgal${compact ? ' compact' : ''}` });
  const open = new Set();
  const draw = () => {
    el.innerHTML = '';
    const groups = promptGroups().filter((g) => (!only || only.includes(g.id)) && (!kind || g.kind === kind));
    onEmpty?.(!groups.length);
    for (const g of groups) {
      const all = g.prompts;
      const shown = open.has(g.id) ? all : all.slice(0, perGroup);
      const chips = h('div', { class: 'chips' }, shown.map((q) => h('button', { class: `chip${g.kind === 'build' ? ' build' : ''}`, onclick: () => onAsk(q), title: q }, q)));
      if (all.length > shown.length) chips.append(h('button', { class: 'chip more', onclick: () => { open.add(g.id); draw(); } }, `+${all.length - shown.length} more`));
      el.append(h('div', { class: 'pgrp' }, h('h4', {}, h('span', { 'aria-hidden': 'true' }, ICON[g.id] || '✦'), g.title), chips));
    }
    if (store.promptsLoading && store.project?.semanticModel) el.append(h('div', { class: 'tiny muted pload' }, h('span', { class: 'spin' }), ` Reading "${store.project.semanticModel.name}" for questions about your measures…`));
  };
  const off = on('prompts.updated', () => { if (!el.isConnected && el.dataset.drawn) { off(); return; } draw(); });
  draw();
  el.dataset.drawn = '1';
  return el;
}

/**
 * "Ask about it" card for a page: the suggestion groups that fit the page (e.g. reports, rules, live data). Hidden
 * while none apply.
 */
export function askCard({ title = 'Start asking', lead = '', only = null, kind = 'ask', perGroup = 3 } = {}) {
  const card = h('div', { class: 'card askcard', style: { marginBottom: '14px' } });
  const gallery = promptGallery({ only, kind, perGroup, onEmpty: (empty) => { card.hidden = empty; } });
  card.append(...[h('div', { class: 'row sp' }, h('h2', {}, `✦ ${title}`), h('button', { class: 'btn ghost', onclick: () => app.ask() }, 'Ask your own question')),
    lead ? h('p', { class: 'lead' }, lead) : null, gallery].filter(Boolean));
  return card;
}
