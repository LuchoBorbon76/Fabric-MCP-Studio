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
    h('button', { class: 'btn ghost', title: 'Check that every relationship key is unique in the data the model reads (and fix exact copies)', onclick: () => modelCheckDialog() }, '🩺 Check data'),
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

// ---------------- model check: why a model can't answer, and fixing exact duplicate rows ----------------

const isDataError = (e) => e?.code === 'MODEL_DUPLICATE_KEYS' || /duplicate value|one side of a many-to-one|primary key of a table/i.test(String(e?.message || e || ''));

/**
 * An error from the semantic model, as a banner: when the model's data breaks a relationship, with a button that
 * checks the tables and fixes exact copies; otherwise just the message.
 */
export function modelErrorBanner(e) {
  if (!isDataError(e)) return h('div', { class: 'banner err' }, e?.message || String(e));
  return h('div', { class: 'banner err' },
    h('div', { style: { flex: 1 } }, e.message),
    h('div', { class: 'row', style: { flexShrink: 0 } },
      h('button', { class: 'btn pri', onclick: () => modelCheckDialog() }, '🩺 Check and fix the data'),
      h('button', { class: 'btn ai', onclick: () => app.ask('My semantic model fails with a duplicate value / relationship error. Check it with studio_check_semantic_model, explain what is wrong in plain words, and suggest the fix.') }, '✦ Ask Copilot')));
}

const num = (n) => (n === null || n === undefined ? '–' : fmtNum(n));

/** Check the active model's relationship keys against its data; fix exact duplicate rows in a warehouse. */
export function modelCheckDialog() {
  const p = store.project || {};
  const sm = p.semanticModel;
  let dlg = null;
  const body = h('div', { class: 'col' });
  const status = h('div', { class: 'row muted small' }, h('span', { class: 'spin' }), ` Reading the tables ${sm?.name || 'the model'} is built on and checking every relationship key… (about a minute)`);
  const job = h('div');
  body.append(h('p', { class: 'small muted', style: { margin: 0 } }, 'Every relationship needs one row per key on its "one" side (for example one row per date in the date table). The studio reads the data the model is built on – your model isn\'t changed.'), status, job);
  const draw = (r) => {
    status.replaceChildren();
    const rows = r.keys.map((k) => h('tr', {},
      h('td', {}, h('div', { class: 'small' }, k.rel), h('div', { class: 'tiny muted' }, k.sourceTable ? `Data: ${k.sourceTable}${k.source?.itemName ? ` in ${k.source.itemName}` : ''}` : '')),
      h('td', { class: 'num small' }, num(k.rows)),
      h('td', { class: 'num small' }, num(k.keys)),
      h('td', {},
        k.status === 'ok' ? h('span', { class: 'pill ok' }, 'Unique')
          : k.status === 'duplicates' ? h('span', { class: 'pill err' }, `${num(k.extraRows)} extra rows`)
            : k.status === 'warn' ? h('span', { class: 'pill warn' }, 'Empty keys') : h('span', { class: 'pill' }, 'Not checked'),
        k.reason ? h('div', { class: 'tiny muted', style: { marginTop: '4px' } }, k.reason) : null,
        k.sample?.length ? h('div', { class: 'tiny muted' }, `For example ${k.sample.slice(0, 3).map((x) => `${x.value} (${x.rows} rows)`).join(', ')}`) : null)));
    const t = h('table', { class: 't stable' }, h('tr', {}, h('th', {}, 'Relationship'), h('th', { class: 'num' }, 'Rows'), h('th', { class: 'num' }, 'Keys'), h('th', {}, 'Result')), ...rows);
    const fixes = r.keys.filter((k) => k.fix === 'dedupe');
    const where = (k) => `${k.sourceTable}${k.source?.itemName ? ` (${k.source.itemType === 'Warehouse' ? 'warehouse' : k.source.itemType || 'source'} ${k.source.itemName})` : ''}`;
    const unchecked = r.keys.filter((k) => k.status === 'unknown');
    // An all-clear only when every relationship was checked.
    const head = r.problems
      ? h('div', { class: `banner ${fixes.length ? 'warn' : 'err'}` }, h('div', {},
        h('b', {}, `${r.problems} relationship${r.problems === 1 ? '' : 's'} can't work: `),
        `the key repeats in ${[...new Set(r.keys.filter((k) => k.status === 'duplicates').map(where))].join(', ')}. `,
        fixes.length ? 'The extra rows are exact copies, so removing them changes no number.' : 'Fix the data where it is loaded, then refresh the model.',
        unchecked.length ? ` ${unchecked.length} other relationship${unchecked.length === 1 ? '' : 's'} couldn't be checked.` : ''))
      : !r.keys.length || unchecked.length
        ? h('div', { class: 'banner warn' }, h('div', {},
          h('b', {}, r.keys.length ? `${unchecked.length} of ${r.keys.length} relationships couldn't be checked. ` : 'The relationships couldn\'t be checked. '),
          [...r.notes, ...unchecked.map((k) => k.reason)].filter(Boolean).slice(0, 3).join(' ')))
        : h('div', { class: 'banner ok' }, `Every relationship key in ${r.model.name} is unique in its data.`);
    const actions = h('div', { class: 'row mt' });
    if (fixes.length) {
      const fix = h('button', { class: 'btn pri', 'data-busy': 'Starting…' }, `Remove ${num(fixes.reduce((a, k) => a + k.extraRows, 0))} duplicate rows`);
      fix.addEventListener('click', busy(fix, async () => {
        const ok = await confirmFix(r, fixes);
        if (!ok) return;
        const j = await post('/jobs/model-fix', { id: r.model.id, tables: fixes.map((k) => k.fixKey) });
        app.watchJob(j.id);
        const render = (x) => job.replaceChildren(h('div', { class: 'mt' }, app.jobCard(x)));
        render(j);
        const off = on('job', (ev) => {
          if (ev.job.id !== j.id) return;
          render(ev.job);
          if (ev.job.status === 'running') return;
          off();
          if (ev.job.status === 'succeeded') { toast('Duplicate rows removed – the model reloaded', 'ok'); fire('model.fixed'); app.refresh(); }
        });
      }));
      actions.append(fix);
    }
    const again = h('button', { class: 'btn', 'data-busy': 'Checking…' }, '↻ Check again');
    again.addEventListener('click', busy(again, async () => { draw(await get(`/models/check?id=${encodeURIComponent(r.model.id)}&fresh=1`)); }));
    actions.append(again, h('button', { class: 'btn ai', onclick: () => { dlg?.close(); app.ask(`My semantic model ${r.model.name} has duplicate keys: ${r.keys.filter((k) => k.status === 'duplicates').map((k) => `${k.sourceTable} (${k.reason})`).join('; ')}. Explain what happened and how to prevent it where the data is loaded.`); } }, '✦ Ask Copilot'));
    body.replaceChildren(head, h('div', { class: 'scroll' }, t), actions, job,
      fixes.length ? h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Removing them keeps a backup copy of each table in its warehouse (<table>_backup_<time>), works in one transaction per warehouse – all or nothing – and reloads the model. Drop the backup once the numbers look right.') : null);
  };
  dlg = modal({ title: `Check ${sm?.name || 'the semantic model'}`, className: 'wide', body, actions: [{ label: 'Close' }] });
  get('/models/check').then(draw).catch((e) => { status.replaceChildren(h('div', { class: 'banner err' }, e.message)); });
  return dlg;
}

/** Ask before changing the warehouse: what is removed and where, and that a backup is kept. */
function confirmFix(r, fixes) {
  const warehouses = [...new Set(fixes.map((k) => k.source?.itemName).filter(Boolean))];
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title: 'Remove duplicate rows?',
      body: h('div', { class: 'col' },
        h('p', { style: { margin: 0 } }, `This changes data in the warehouse${warehouses.length === 1 ? '' : 's'} `, h('b', {}, warehouses.join(', ')), ':'),
        h('ul', { class: 'pre small', style: { margin: 0 } }, fixes.map((k) => h('li', {}, `${k.sourceTable}${warehouses.length > 1 ? ` in ${k.source.itemName}` : ''}: ${num(k.rows)} → ${num(k.distinctRows)} rows (${num(k.extraRows)} exact copies removed)`))),
        h('p', { class: 'small muted', style: { margin: 0 } }, 'A backup copy of each table is kept first, the change runs in one transaction per warehouse (nothing changes there if a step fails), then the model reloads. Anything else that loads these tables (pipelines, notebooks) may add the copies again – fix it there too.')),
      actions: [{ label: 'Cancel', onClick: () => finish(false) }, { label: 'Remove duplicates', class: 'pri', onClick: () => finish(true) }],
      onClose: () => finish(false),
    });
  });
}