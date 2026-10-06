// OpenRouter model lists (developer mode): one list grouped by lab, with price and context, used by Settings and the
// Copilot header. The models come from GET /api/copilot/models when OpenRouter is the provider.
import { h } from './ui.js';

export const OPENROUTER_AUTO = 'openrouter/auto';

const money = (v) => (v === null || v === undefined ? '?' : v === 0 ? '0' : v < 1 ? v.toFixed(2).replace(/0$/, '') : String(Math.round(v * 100) / 100));
const ctx = (n) => (!n ? '' : n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1e3)}K`);

/** "$3 / $15 · 200K" – input / output price per million tokens and the context window. */
export function modelFacts(m) {
  const free = m.price?.input === 0 && m.price?.output === 0;
  const price = free ? 'free' : m.price?.input === null && m.price?.output === null ? '' : `$${money(m.price?.input)} / $${money(m.price?.output)}`;
  return [price, ctx(m.context)].filter(Boolean).join(' · ');
}

/** Fill a <select> with the models matching `query`, grouped by lab; the selected model always stays listed. */
export function fillModelSelect(sel, models, selected, query = '') {
  const q = query.trim().toLowerCase();
  const show = models.filter((m) => m.id === selected || !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  sel.innerHTML = '';
  const groups = new Map();
  for (const m of show) {
    // "~anthropic/claude-sonnet-latest": OpenRouter aliases that always point to the lab's newest model.
    const g = m.id === OPENROUTER_AUTO ? 'OpenRouter' : m.vendor.startsWith('~') ? `${m.vendor.slice(1)} · always the latest` : m.vendor;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  for (const [g, list] of groups) {
    const og = h('optgroup', { label: g });
    for (const m of list) {
      const label = m.id === OPENROUTER_AUTO ? 'Auto Router – OpenRouter picks a model for each request' : `${m.name.replace(/^[^:]+:\s*/, '')}${modelFacts(m) ? `  ·  ${modelFacts(m)}` : ''}`;
      og.append(h('option', { value: m.id, selected: m.id === selected || undefined, title: m.id }, label));
    }
    sel.append(og);
  }
  if (!show.length) sel.append(h('option', { value: '', disabled: true }, 'No model matches'));
  return show.length;
}
