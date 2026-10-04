// Naming standard [Domain]_[Object]_[Purpose]_[Environment] on the client: the same rules as server/naming.mjs, so
// the pages show the names items will get, and the card that asks what the environment is for.
import { store, put, on } from './api.js';
import { h, toast, busy, field, input } from './ui.js';
import { app } from './app.js';

const STANDARD = /^([A-Za-z][A-Za-z0-9]*)_([A-Za-z0-9]+)_([A-Za-z0-9]+)_([A-Za-z0-9]+)$/;
const words = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
export const pascal = (s) => words(s).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const cleanDomain = (s) => { let d = pascal(s); if (d && !/^[A-Za-z]/.test(d)) d = `D${d}`; return d.slice(0, 24); };
const cleanEnv = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const objects = () => store.naming?.objects || [];
const codeOf = (type) => objects().find((o) => o.type === type)?.code || cleanEnv(type).slice(0, 5) || 'ITEM';

export function parseName(name) {
  const m = STANDARD.exec(String(name ?? '').trim());
  if (!m || !objects().some((o) => o.code === m[2].toUpperCase())) return null;
  return { domain: m[1], code: m[2].toUpperCase(), purpose: m[3], environment: m[4] };
}

/** The project's naming settings with the same defaults as the server. */
export function naming(over = {}) {
  const p = store.project || {};
  const n = { ...(p.naming || {}), ...over };
  const ws = parseName(p.workspace?.name);
  const domain = cleanDomain(n.domain) || ws?.domain || 'Data';
  const environment = cleanEnv(n.environment) || ws?.environment?.toUpperCase() || 'DEV';
  const env = (store.naming?.environments || []).find((e) => e.code === environment);
  return { domain, environment, intent: n.intent || env?.intent || environment, configured: Boolean(p.naming?.domain && p.naming?.environment && !p.naming?.inferred), inferred: Boolean(p.naming?.inferred) };
}

/** The standard name for an item type and a purpose ("Executive" -> Retail_RPT_Executive_DEMO). */
export function standardName(type, purpose, over) {
  const { domain, environment } = naming(over);
  const code = codeOf(type);
  const room = 86 - domain.length - code.length - environment.length;
  return `${domain}_${code}_${(pascal(purpose) || 'Main').slice(0, Math.max(8, Math.min(40, room)))}_${environment}`;
}

// Words that only repeat the object type (same list as the server).
const NOISE = {
  Workspace: ['workspace'], Lakehouse: ['lakehouse'], Warehouse: ['warehouse'], SQLDatabase: ['sql', 'database', 'db'],
  MirroredDatabase: ['mirror', 'mirrored', 'database', 'db'], Connection: ['connection'], Notebook: ['notebook'],
  DataPipeline: ['pipeline'], SemanticModel: ['semantic', 'model'], Report: ['report'], OrgApp: ['app'], Ontology: ['ontology'],
  DataAgent: ['agent'], Plan: ['plan'], Eventhouse: ['eventhouse'], KQLDatabase: ['database', 'db'], Eventstream: ['eventstream'],
  KQLQueryset: ['queryset'], KQLDashboard: ['dashboard'], Reflex: ['activator'], TaskFlow: ['task', 'flow'],
};

/** Any name brought to the standard, as the server does it (a standard name of the same type is kept). */
export function standardize(type, given, fallback = 'Main', over) {
  const s = String(given ?? '').trim();
  if (!s) return standardName(type, fallback, over);
  const x = parseName(s);
  if (x && x.code === codeOf(type)) return s;
  if (x) return standardName(type, x.purpose, over);
  const { domain, environment } = naming(over);
  const codes = new Set(objects().map((o) => o.code));
  const envs = new Set((store.naming?.environments || []).map((e) => e.code));
  const drop = new Set([domain.toLowerCase(), environment.toLowerCase(), ...(NOISE[type] || [])]);
  const kept = words(s).filter((w) => !drop.has(w.toLowerCase()) && !(w === w.toUpperCase() && (codes.has(w) || envs.has(w))));
  return standardName(type, pascal(kept.join(' ')) || fallback, over);
}

/** The purpose part of a name: "Retail_SM_Sales_DEMO" -> "Sales"; with a type, words like "Model" are left out. */
export function purposeOf(name, type) {
  const x = parseName(name);
  if (x) return x.purpose;
  if (type && String(name ?? '').trim()) return parseName(standardize(type, name))?.purpose || pascal(name);
  return pascal(name);
}

// Draft of the naming editor, kept across re-renders until it is saved or cancelled.
const draft = { open: false, env: null, domain: null };
const resetDraft = () => Object.assign(draft, { open: false, env: null, domain: null });
on('studio.reset', resetDraft);

/**
 * "What is this environment for?" – the intent (DEMO, POC, DEV…), the business domain and a live preview of the names.
 * compact: a one-line summary with Change while the settings are confirmed.
 */
export function namingCard({ compact = false, onSaved } = {}) {
  // A server older than this page has no naming standard to show.
  if (!store.naming?.environments) return null;
  const card = h('div', { class: 'card namingcard', style: { marginBottom: '14px' } });
  // The open editor and what was typed survive the page re-rendering (project updates, checks).
  const editing = () => !compact || !naming().configured || draft.open;
  const draw = () => {
    card.replaceChildren();
    const cur = naming();
    if (!editing()) {
      card.classList.add('compact');
      card.append(h('div', { class: 'row sp' },
        h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
          h('b', {}, 'Naming standard'),
          h('code', { class: 'nmpat' }, `${cur.domain}_[Object]_[Purpose]_${cur.environment}`),
          h('span', { class: 'pill ok' }, cur.intent)),
        h('button', { class: 'btn ghost', onclick: () => { draft.open = true; draw(); } }, 'Change')));
      return;
    }
    card.classList.remove('compact');
    let env = draft.env || cur.environment;
    const domain = input({ value: draft.domain ?? (cur.configured || cur.inferred || store.project?.naming?.domain ? cur.domain : ''), placeholder: 'Sales, Finance, Retail, Supply chain…', maxlength: 40 });
    const preview = h('div', { class: 'nmprev' });
    const intents = h('div', { class: 'intents', role: 'radiogroup', 'aria-label': 'What the environment is for' });
    const drawIntents = () => {
      intents.replaceChildren(...(store.naming?.environments || []).map((e) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(e.code === env), class: `intent${e.code === env ? ' on' : ''}`,
        onclick: () => { env = e.code; draft.env = env; drawIntents(); drawPreview(); },
      }, h('span', { class: 'row sp' }, h('b', {}, e.intent), h('code', {}, e.code)), h('span', { class: 'tiny muted' }, e.hint))));
    };
    const drawPreview = () => {
      const over = { domain: domain.value || cur.domain, environment: env };
      const rows = (store.naming?.examples || []).map((x) => h('tr', {}, h('td', { class: 'muted' }, x.label), h('td', {}, h('code', {}, standardName(x.type, parseName(x.name)?.purpose || 'Main', over)))));
      preview.replaceChildren(h('table', { class: 't' }, ...rows));
    };
    domain.addEventListener('input', () => { draft.domain = domain.value; drawPreview(); });
    drawIntents(); drawPreview();
    const save = h('button', { class: 'btn pri', 'data-busy': 'Saving…' }, cur.configured ? 'Save naming' : 'Use this naming');
    save.addEventListener('click', busy(save, async () => {
      if (!pascal(domain.value)) throw new Error('Enter the business domain, for example Sales or Finance.');
      const r = await put('/naming', { domain: domain.value, environment: env });
      store.naming = r;
      toast(`New items are named ${r.domain}_[Object]_[Purpose]_${r.environment}`, 'ok');
      resetDraft();
      onSaved?.(r);
      // The page may already have re-rendered with the editor open (project update): draw it again closed.
      if (card.isConnected) draw(); else app.rerender?.();
    }));
    card.append(
      h('div', { class: 'row sp' },
        h('div', {},
          h('h2', {}, 'What is this environment for?'),
          h('p', { class: 'lead' }, 'Every item the studio creates is named ', h('code', {}, '[Domain]_[Object]_[Purpose]_[Environment]'), ' – so anyone can tell what it is, what it\'s for and where it runs. Items that already exist keep their names.')),
        cur.configured ? h('span', { class: 'pill ok' }, 'Confirmed') : cur.inferred ? h('span', { class: 'pill brand' }, 'Suggested') : h('span', { class: 'pill warn' }, 'Not set yet')),
      intents,
      h('div', { class: 'nmrow' },
        h('div', {}, field('Business domain', domain, 'The business area the data belongs to. Letters and numbers; spaces become capitals.')),
        h('div', {}, h('div', { class: 'tiny muted', style: { marginBottom: '4px' } }, 'Names the studio will use'), preview)),
      h('div', { class: 'row mt' }, save,
        compact && cur.configured ? h('button', { class: 'btn ghost', onclick: () => { resetDraft(); draw(); } }, 'Cancel') : null,
        h('button', { class: 'btn ai', onclick: () => app.ask('Help me choose the naming standard: ask what this environment is for and the business domain, then set it.') }, '✦ Ask Copilot')),
    );
  };
  draw();
  return card;
}
