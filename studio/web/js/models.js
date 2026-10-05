// Semantic models in the project: a switcher shown on every page that works on "the" model (Semantic model, Reports &
// apps, Planning, Ask & share), the list of models with what is built on each, and adding an existing model from any
// workspace. One model is active; switching changes nothing in Fabric.
import { store, get, post, on, fire } from './api.js';
import { h, toast, busy, modal, select, input, fmtNum } from './ui.js';
import { app } from './app.js';
import { removeButton, loadArtifacts } from './artifacts.js';

const STORAGE = { DirectLake: 'Direct Lake', Import: 'Import', DirectQuery: 'DirectQuery', Dual: 'Dual', Mixed: 'Mixed' };
const plural = (n, w) => `${fmtNum(n)} ${w}${n === 1 ? '' : 's'}`;
export const projectModels = () => store.project?.semanticModels || [];

async function switchTo(id) {
  const m = projectModels().find((x) => x.id === id);
  await post('/models/active', { id });
  toast(`Working on ${m?.name || 'the semantic model'}`, 'ok');
  await app.refresh();
}

/**
 * The active model with a way to switch, for pages built on the model. `note` says what follows the model on that page
 * (e.g. "Reports below are built on it").
 */
export function modelBar({ note = '' } = {}) {
  const p = store.project || {};
  const sm = p.semanticModel;
  const models = projectModels();
  if (!sm || !models.length) return null;
  const pick = select(models.map((m) => ({ value: m.id, label: `${m.name}${m.origin === 'existing' ? ' · existing' : ''}` })), { 'aria-label': 'Active semantic model', class: 'i msel' });
  pick.value = sm.id;
  pick.addEventListener('change', async () => {
    pick.disabled = true;
    try { await switchTo(pick.value); } catch (e) { toast(e.message, 'err'); pick.value = sm.id; pick.disabled = false; }
  });
  const theirs = sm.origin === 'existing';
  return h('div', { class: 'modelbar' },
    h('span', { class: 'mbl' }, 'Semantic model'),
    models.length > 1 ? pick : h('b', {}, sm.name),
    h('span', { class: `pill ${theirs ? '' : 'brand'}` }, theirs ? 'Existing model' : 'Built by the studio'),
    STORAGE[sm.storageMode] ? h('span', { class: 'tiny muted' }, STORAGE[sm.storageMode]) : null,
    sm.workspaceId && sm.workspaceId !== p.workspace?.id ? h('span', { class: 'tiny muted', title: 'The model lives in another workspace' }, `in ${sm.workspaceName || 'another workspace'}`) : null,
    note ? h('span', { class: 'tiny muted mbnote' }, note) : null,
    h('span', { style: { flex: 1 } }),
    models.length > 1 ? h('span', { class: 'tiny muted' }, `${models.length} models in the project`) : null,
    h('button', { class: 'btn ghost', onclick: () => modelsDialog() }, models.length > 1 ? 'Manage models' : 'Add a model'));
}

/** Every model in the project, in a pop-up: switch, open, add an existing one, start a new one, remove. */
export function modelsDialog() {
  const p = store.project || {};
  const body = h('div', { class: 'col' });
  let dlg = null;
  let offProject = () => {};
  const close = () => dlg?.close();
  const startNew = () => { close(); fire('model.new'); app.go('model'); setTimeout(() => document.querySelector('#view-model.on .designer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120); };
  const add = h('button', { class: 'btn' }, '+ Add an existing model');
  add.addEventListener('click', () => { close(); addExistingDialog(); });
  const list = h('div', { class: 'muted small' }, h('span', { class: 'spin' }), ' Reading the project\'s models…');
  const draw = () => Promise.all([get('/models'), loadArtifacts().catch(() => [])]).then(([s, arts]) => {
    const proj = store.project || {};
    if (!s.models.length) {
      list.className = 'muted small';
      list.replaceChildren(proj.modelSource ? 'No semantic model yet. Design one from your data, or add an existing model.' : 'No semantic model yet. Add an existing model, or connect data (Data page) to design a new one.');
      return;
    }
    const t = h('table', { class: 't mtable' }, h('tr', {}, h('th', {}, 'Model'), h('th', {}, 'Contents'), h('th', {}, 'Built on it'), h('th', { 'aria-label': 'Actions' })));
    for (const m of s.models) {
      const use = h('button', { class: 'btn pri', 'data-busy': 'Switching…' }, 'Use this model');
      use.addEventListener('click', busy(use, async () => { await switchTo(m.id); close(); }));
      const art = arts.find((a) => a.key === `model:${m.id}`);
      const built = [m.reports.length ? plural(m.reports.length, 'report') : null, m.dataAgent ? 'data agent' : null, m.orgApp ? 'org app' : null, m.plan ? `plan ${m.plan.planYear}` : null].filter(Boolean);
      t.append(h('tr', { class: m.active ? 'sel' : '' },
        h('td', {},
          h('div', { class: 'row', style: { gap: '6px' } }, h('a', { href: m.url, target: '_blank', rel: 'noopener', title: 'Open in Fabric' }, h('b', {}, m.name)), m.active ? h('span', { class: 'pill ok' }, 'Active') : null),
          h('div', { class: 'tiny muted' }, `${m.origin === 'existing' ? 'Existing model' : 'Built by the studio'}${m.storage ? ` · ${m.storage}` : ''}${m.inProjectWorkspace ? '' : ` · ${m.workspaceName || 'another workspace'}`}`)),
        h('td', { class: 'small' }, m.tables === null ? h('span', { class: 'tiny muted' }, 'Not read yet') : `${plural(m.tables, 'table')} · ${plural(m.measures, 'measure')}${m.relationships !== null ? ` · ${plural(m.relationships, 'relationship')}` : ''}`),
        h('td', { class: 'small' }, built.length ? built.join(' · ') : h('span', { class: 'tiny muted' }, '–')),
        h('td', { class: 'act' }, h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px', flexWrap: 'nowrap' } },
          m.active ? null : use,
          art ? removeButton([art], { compact: true, label: m.origin === 'existing' ? 'Stop using' : 'Delete' }) : null))));
    }
    list.className = 'scroll';
    list.replaceChildren(t);
  }).catch((e) => list.replaceChildren(h('div', { class: 'banner err' }, e.message)));
  body.append(
    h('p', { class: 'small muted', style: { margin: 0 } }, 'Reports, the data agent, the org app and Copilot\'s answers work on the active model – switch any time; nothing changes in Fabric. Build new models from your data, or bring existing ones from any workspace you can read.'),
    list,
    p.workspace ? h('div', { class: 'row' }, p.modelSource ? h('button', { class: 'btn pri', onclick: startNew }, '+ New model from my data') : null, add) : h('div', { class: 'banner warn' }, 'Select a workspace first.'));
  dlg = modal({ title: 'Semantic models', className: 'wide models', body, actions: [{ label: 'Close' }], onClose: () => offProject() });
  // Removing or adding a model updates the project: show the new list while the pop-up is open.
  offProject = on('project.updated', () => { if (dlg) draw(); });
  draw();
  return dlg;
}

/** Pick a workspace, then an existing semantic model in it, and add it to the project (it becomes the active model). */
export function addExistingDialog() {
  const p = store.project || {};
  const wsSel = select([{ value: p.workspace?.id || '', label: p.workspace ? `${p.workspace.name} (project workspace)` : 'Loading…' }], { 'aria-label': 'Workspace' });
  const search = input({ placeholder: 'Search models…' });
  const list = h('div', { class: 'scroll', style: { maxHeight: '340px' } });
  const status = h('div', { class: 'tiny muted' });
  let models = [];
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = models.filter((m) => !q || m.name.toLowerCase().includes(q));
    if (!rows.length) { list.replaceChildren(h('div', { class: 'empty' }, models.length ? 'No models match.' : 'No semantic models in this workspace.')); return; }
    const t = h('table', { class: 't' });
    for (const m of rows) {
      const btn = h('button', { class: `btn ${m.inProject ? '' : 'pri'}`, 'data-busy': 'Reading the model…' }, m.inProject ? 'Use' : 'Add');
      btn.addEventListener('click', busy(btn, async () => {
        const r = m.inProject ? await post('/models/active', { id: m.id }) : await post('/models/existing', { workspaceId: wsSel.value, id: m.id });
        dlg.close();
        toast(`Working on ${m.name}`, 'ok');
        if (r.warning) toast(r.warning, 'err');
        await app.refresh();
      }));
      t.append(h('tr', {}, h('td', {}, h('b', {}, m.name), m.isDefault ? h('span', { class: 'pill', style: { marginLeft: '6px' }, title: 'Fabric made it for a lakehouse, warehouse or SQL endpoint with the same name' }, 'Default model') : null, m.description ? h('div', { class: 'tiny muted' }, m.description.slice(0, 120)) : null, m.inProject ? h('span', { class: 'pill ok', style: { marginLeft: '6px' } }, 'In the project') : null), h('td', { class: 'num' }, btn)));
    }
    list.replaceChildren(t);
  };
  const load = async () => {
    list.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading semantic models…'));
    try { models = (await get(`/models/available?workspaceId=${encodeURIComponent(wsSel.value)}`)).models; draw(); }
    catch (e) { list.replaceChildren(h('div', { class: 'banner err' }, e.message)); }
  };
  wsSel.addEventListener('change', load);
  search.addEventListener('input', draw);
  const dlg = modal({
    title: 'Add an existing semantic model', className: 'wide',
    body: h('div', { class: 'col' },
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Any semantic model you can read (Build permission) – Direct Lake, Import or DirectQuery. The studio reads its tables and measures; it never changes or deletes a model you add. Reports and data agents built on it go to the project workspace.'),
      h('div', { class: 'row' }, wsSel, search), status, list),
    actions: [{ label: 'Close' }],
  });
  get('/fabric/workspaces').then((wss) => {
    const cur = wsSel.value;
    wsSel.replaceChildren(...wss.sort((a, b) => (b.id === p.workspace?.id) - (a.id === p.workspace?.id) || a.name.localeCompare(b.name))
      .map((w) => h('option', { value: w.id }, `${w.name}${w.id === p.workspace?.id ? ' (project workspace)' : ''}`)));
    wsSel.value = cur || wss[0]?.id || '';
  }).catch((e) => { status.textContent = `Workspaces couldn't be listed: ${e.message}`; });
  load();
}
