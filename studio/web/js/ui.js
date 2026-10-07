// DOM helpers, toasts, modals and formatting.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}

export function modal({ title, body, actions = [], className = '', onClose }) {
  const root = document.getElementById('modalRoot');
  let closed = false;
  // Esc closes the top pop-up (approvals need an answer, so they stay).
  const onKey = (e) => { if (e.key === 'Escape' && !className.includes('appr') && root.lastElementChild === ov) { e.stopPropagation(); close(); } };
  const close = () => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey); ov.remove(); onClose?.(); };
  const ov = h('div', { class: 'overlay', onclick: (e) => { if (e.target === ov && !className.includes('appr')) close(); } },
    h('div', { class: `modal ${className}` },
      h('div', { class: 'mh' }, h('h3', {}, title), className.includes('appr') ? null : h('button', { class: 'btn ghost', onclick: close, title: 'Close' }, '✕')),
      h('div', { class: 'mb' }, body),
      actions.length ? h('div', { class: 'mf' }, actions.map((a) => h('button', { class: `btn ${a.class || ''}`, onclick: async () => { if ((await a.onClick?.()) !== false) close(); } }, a.label))) : null));
  root.append(ov);
  document.addEventListener('keydown', onKey);
  return { close, el: ov };
}

export function confirmDialog(title, message, okLabel = 'Continue', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title, body: h('p', {}, message),
      actions: [{ label: 'Cancel', onClick: () => finish(false) }, { label: okLabel, class: danger ? 'danger' : 'pri', onClick: () => finish(true) }],
      onClose: () => finish(false),
    });
  });
}

/** For changes that can't be undone: the delete button unlocks only once `phrase` is typed. Resolves to the phrase or false. */
export function typedConfirmDialog(title, body, phrase, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const box = input({ autocomplete: 'off', spellcheck: 'false', 'aria-label': `Type ${phrase} to confirm` });
    const typed = () => box.value.trim() === phrase;
    const m = modal({
      title,
      body: h('div', {}, body, h('label', { class: 'f mt' }, h('span', {}, 'To confirm, type ', h('b', {}, phrase)), box)),
      actions: [{ label: 'Cancel', onClick: () => finish(false) }, { label: okLabel, class: 'danger', onClick: () => { if (!typed()) return false; finish(phrase); return true; } }],
      onClose: () => finish(false),
    });
    const ok = m.el.querySelector('.mf .btn.danger');
    ok.disabled = true;
    box.addEventListener('input', () => { ok.disabled = !typed(); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && typed()) ok.click(); });
    setTimeout(() => box.focus({ preventScroll: true }), 0);
  });
}

export const fmtNum = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString());
export const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const initials = (name) => String(name || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('');
/** An item name that wraps after its underscores and dots (FabricMCP_LH_Curated_SBX), never inside a word. */
export const breakable = (name) => String(name ?? '').split(/(?<=[_.])/).flatMap((part, i) => (i ? [h('wbr'), part] : [part]));

export function busy(btn, fn) {
  return async (...args) => {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span> ${btn.dataset.busy || 'Working…'}`;
    try { return await fn(...args); } catch (e) { toast(e.message, 'err'); return undefined; } finally { btn.disabled = false; btn.innerHTML = label; }
  };
}

export function field(label, control, hint) {
  return h('label', { class: 'f' }, label, control, hint ? h('span', { class: 'tiny muted', style: { fontWeight: 400 } }, hint) : null);
}

export function input(attrs = {}) { return h('input', { class: 'i', ...attrs }); }

export function select(options, attrs = {}) {
  const s = h('select', { class: 'i', ...attrs });
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    s.append(h('option', { value: opt.value, selected: opt.selected || undefined, disabled: opt.disabled || undefined }, opt.label));
  }
  return s;
}

export function seg(options, value, onChange) {
  const wrap = h('div', { class: 'seg' });
  for (const o of options) {
    const b = h('button', { type: 'button', class: o.value === value ? 'on' : '' }, o.label);
    b.addEventListener('click', () => { $$('button', wrap).forEach((x) => x.classList.remove('on')); b.classList.add('on'); onChange(o.value); });
    wrap.append(b);
  }
  return wrap;
}

export function statusDot(s) {
  return h('span', { class: `dot ${{ ok: 'ok', done: 'ok', succeeded: 'ok', warn: 'warn', info: '', error: 'err', failed: 'err', running: 'run' }[s] || ''}` });
}

export const SERVER_LABEL = { 'fabric-core': 'Fabric Core', 'powerbi-authoring': 'Power BI', 'fabric-iq': 'Fabric IQ', 'fabric-local': 'Fabric local', 'fabric-ontology': 'Ontology', studio: 'Studio', 'built-in': 'Agent' };
