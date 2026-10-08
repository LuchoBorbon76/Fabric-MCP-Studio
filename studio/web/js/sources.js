// Data sources of the workspace: each keeps its own OneLake data, semantic models, reports, ontology, plan and live
// data. One is active – the map and every page show what was built from it, and parts not built for it yet stay grey.
// Switching changes nothing in Fabric.
import { store, get, post, on } from './api.js';
import { h, toast, busy, modal, fmtDate, breakable, select, input } from './ui.js';
import { app } from './app.js';

const HOW = { files: 'Loaded into a lakehouse', 'sql-database': 'Fabric SQL database', mirror: 'Mirrored', shortcut: 'OneLake shortcuts', 'in-place': 'Used in place' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The workspace's data sources from the project (what the map knows without asking the server). */
export const workspaceSources = () => store.project?.sources || [];

/** Make another data source of the workspace the active one. */
export async function switchSource(key, label) {
  await post('/sources/switch', { key });
  toast(`Working on ${label || 'the data source'} – its items are back on the map`, 'ok');
  await app.refresh();
}

const builtText = (x) => [
  x.data ? `${x.data.name}` : null,
  x.models.length ? plural(x.models.length, 'semantic model') : null,
  x.reports ? plural(x.reports, 'report') : null,
  x.ontology ? 'ontology' : null,
  x.plan ? `plan ${x.plan}` : null,
  x.dataAgent ? 'data agent' : null,
  x.orgApp ? 'org app' : null,
  x.realtime ? 'live data' : null,
].filter(Boolean);

const ITEM_LABEL = { Lakehouse: 'Lakehouse', Warehouse: 'Warehouse', MirroredDatabase: 'Mirrored database', SQLDatabase: 'SQL database' };

/** One data source the project used: what was built from it, and Use this source (or Active). */
function contextLine(x, close) {
  const use = h('button', { class: 'btn pri', 'data-busy': 'Switching…' }, 'Use this source');
  use.addEventListener('click', busy(use, async () => { await switchSource(x.key, x.label); close(); }));
  const built = builtText(x).filter((t) => t !== x.data?.name);
  return h('div', { class: 'srcline' },
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'small' }, breakable(x.label)), x.active ? h('span', { class: 'pill ok' }, 'Active') : null),
      h('div', { class: 'tiny muted' }, [HOW[x.method] || (x.kind === 'sample' ? 'Sample data' : x.key === 'none' || String(x.key).startsWith('none:') ? 'Items built without a data source' : 'Data source'), built.length ? built.join(' · ') : 'nothing built yet', x.active || !x.savedAt ? null : `last used ${fmtDate(x.savedAt)}`].filter(Boolean).join(' · '))),
    x.active ? null : use);
}

/**
 * The data items of a workspace and the project's data sources, in a pop-up: the project workspace first, any other one
 * from the list (its data is used in place). Switch, use another item, or connect one.
 */
export function sourcesDialog() {
  const p = store.project || {};
  let home = p.workspace?.id || '';
  let dlg = null;
  let off = () => {};
  let data = null;
  let seq = 0;
  const names = new Map(home ? [[home.toLowerCase(), p.workspace.name]] : []);
  const close = () => dlg?.close();
  const wsSel = select([{ value: home, label: home ? `${p.workspace.name} (project workspace)` : 'Loading…' }], { 'aria-label': 'Workspace' });
  const search = input({ placeholder: 'Search data…', 'aria-label': 'Search data' });
  const hint = h('div', { class: 'col srchint', style: { gap: '4px' } });
  const list = h('div', { class: 'muted small' });
  const nameOf = (id) => names.get(String(id).toLowerCase()) || 'another workspace';
  const isHomeId = (id) => String(id).toLowerCase() === home.toLowerCase();
  const show = (id) => {
    if (![...wsSel.options].some((o) => o.value === id)) wsSel.append(h('option', { value: id }, nameOf(id)));
    wsSel.value = id;
    search.value = '';
    load();
  };

  // Where the project's other data sources read their data: a line per workspace with Show.
  const drawHint = () => {
    if (!data) { hint.replaceChildren(); return; }
    const lines = data.byWorkspace.filter((w) => w.workspaceId.toLowerCase() !== data.workspace.id.toLowerCase())
      .sort((a, b) => Number(b.active) - Number(a.active) || Number(isHomeId(b.workspaceId)) - Number(isHomeId(a.workspaceId)))
      .map((w) => {
        const n = w.sources.length;
        const ws = `${w.name || nameOf(w.workspaceId)}${isHomeId(w.workspaceId) ? ' (project workspace)' : ''}`;
        const text = w.active
          ? (n === 1 ? `The active data source reads data in ${ws}.` : `${n} data sources of the project read data in ${ws} – the active one too.`)
          : `${plural(n, 'data source')} of the project read${n === 1 ? 's' : ''} data in ${ws}.`;
        return h('div', { class: 'row small muted', style: { gap: '8px', flexWrap: 'nowrap' } },
          h('span', { style: { minWidth: 0 } }, breakable(text)),
          h('button', { class: 'btn ghost tiny', style: { flexShrink: 0 }, onclick: () => show(w.workspaceId) }, 'Show'));
      });
    hint.replaceChildren(...lines);
  };

  const draw = () => {
    drawHint();
    if (!data) return;
    const s = data;
    const q = search.value.trim().toLowerCase();
    const match = (...texts) => !q || texts.some((t) => String(t || '').toLowerCase().includes(q));
    const items = s.items.filter((it) => match(it.name, ITEM_LABEL[it.itemType] || it.itemType, ...it.sources.map((c) => c.label)));
    const others = s.others.filter((x) => match(x.data?.name, x.label));
    if (!items.length && !others.length) {
      list.className = 'muted small';
      list.replaceChildren(q ? 'No data matches.'
        : s.workspace.project ? `No lakehouse, warehouse or database in ${s.workspace.name} yet. Load sample data or mirror a database on the Data page, or pick another workspace above to use its data in place.`
          : `No lakehouse, warehouse or database in ${s.workspace.name} that you can read.`);
      return;
    }
    const t = h('table', { class: 't stable' }, h('tr', {}, h('th', {}, s.workspace.project ? 'Data in the project workspace' : `Data in ${s.workspace.name}`), h('th', {}, 'Used by the project'), h('th', { 'aria-label': 'Actions' })));
    for (const it of items) {
      const active = it.sources.some((c) => c.active);
      const useItem = h('button', { class: 'btn', 'data-busy': 'Connecting…', title: s.workspace.project ? 'Use it in place as a new data source (no copy) – the current source keeps its items' : `Use it in place from ${s.workspace.name} as a new data source (no copy) – what you build from it goes to the project workspace; the current source keeps its items` }, 'Use as data source');
      useItem.addEventListener('click', busy(useItem, async () => {
        await post('/sources/in-place', { workspaceId: it.workspaceId, itemId: it.itemId, itemType: it.itemType });
        toast(`${it.name} is the data source now – build its semantic model next`, 'ok');
        await app.refresh();
        close();
      }));
      t.append(h('tr', { class: active ? 'sel' : '' },
        h('td', {}, h('b', {}, breakable(it.name)), h('div', { class: 'tiny muted' }, ITEM_LABEL[it.itemType] || it.itemType)),
        h('td', {}, it.sources.length ? it.sources.map((x) => contextLine(x, close)) : h('span', { class: 'tiny muted' }, 'Not used yet')),
        h('td', { class: 'act' }, it.sources.length ? null : useItem)));
    }
    for (const x of others) {
      const where = x.lost ? 'In a workspace you can\'t open any more – switch to it to remove what was built from it'
        : x.missing ? 'No longer in Fabric – switch to it to remove what was built from it'
          : x.data ? ITEM_LABEL[x.data.itemType] || x.data.itemType : 'Not connected yet';
      t.append(h('tr', { class: x.active ? 'sel' : '' },
        h('td', {}, h('b', {}, breakable(x.data?.name || x.label)), h('div', { class: `tiny ${x.missing || x.lost ? 'warnx' : 'muted'}` }, where)),
        h('td', {}, contextLine(x, close)),
        h('td', { class: 'act' })));
    }
    list.className = 'scroll';
    list.replaceChildren(t);
  };

  const load = ({ quiet = false } = {}) => {
    const mine = ++seq;
    const id = wsSel.value || home;
    if (!quiet) {
      data = null;
      drawHint();
      list.className = 'muted small';
      list.replaceChildren(h('span', { class: 'spin' }), ` Reading the data in ${nameOf(id)}…`);
    }
    // Always the chosen workspace: the project workspace can change while the pop-up is open (Copilot can do that).
    return get(`/sources/workspace?workspaceId=${encodeURIComponent(id)}`).then((s) => {
      if (mine !== seq) return;
      data = s;
      names.set(s.workspace.id.toLowerCase(), s.workspace.name);
      for (const w of s.byWorkspace) if (w.name) names.set(w.workspaceId.toLowerCase(), w.name);
      fillOptions();
      draw();
    }).catch((e) => { if (mine === seq) { data = null; drawHint(); list.className = ''; list.replaceChildren(h('div', { class: 'banner err' }, e.message)); } });
  };

  // The project workspace first, then the ones the project's data sources read, then the rest by name.
  let wss = null;
  let usedKey = null;
  const fillOptions = () => {
    if (!wss) return;
    const used = new Set((data?.byWorkspace || []).map((w) => w.workspaceId.toLowerCase()));
    const key = `${home.toLowerCase()}|${[...used].sort().join(',')}`;
    if (key === usedKey) return;
    usedKey = key;
    const rank = (w) => (isHomeId(w.id) ? 0 : used.has(w.id.toLowerCase()) ? 1 : 2);
    const cur = wsSel.value;
    wsSel.replaceChildren(...[...wss].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .map((w) => h('option', { value: w.id }, `${w.name}${isHomeId(w.id) ? ' (project workspace)' : used.has(w.id.toLowerCase()) ? ' – used by the project' : ''}`)));
    if (![...wsSel.options].some((o) => o.value === cur)) wsSel.prepend(h('option', { value: cur }, nameOf(cur)));
    wsSel.value = cur;
  };

  wsSel.addEventListener('change', () => { search.value = ''; load(); });
  search.addEventListener('input', draw);
  dlg = modal({
    title: 'Data sources', className: 'wide',
    body: h('div', { class: 'col' },
      h('p', { class: 'small muted', style: { margin: 0 } }, 'The lakehouses, warehouses and databases in the project workspace – or in another workspace you pick, to use its data in place – and what the project built from each. Each data source keeps its own semantic models, reports, ontology, plan and live data; the map shows the active one – parts not built for it yet stay grey. Switching changes nothing in Fabric.'),
      p.workspace ? h('div', { class: 'row' }, wsSel, search) : null,
      hint,
      list,
      p.workspace
        ? h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { close(); app.go('data'); } }, '+ Connect another data source (sample, database, other workspace)'))
        : h('div', { class: 'banner warn' }, 'Select a workspace first.')),
    actions: [{ label: 'Close' }],
    onClose: () => off(),
  });
  if (!p.workspace) return dlg;
  off = on('project.updated', () => {
    if (!dlg) return;
    const now = store.project?.workspace;
    if (!now) { close(); return; }
    if (now.id.toLowerCase() !== home.toLowerCase()) {
      // The project moved to another workspace: start again from the new project workspace.
      home = now.id;
      names.set(home.toLowerCase(), now.name);
      usedKey = null;
      if (!wss) wsSel.replaceChildren(h('option', { value: home }, `${now.name} (project workspace)`));
      else if (![...wsSel.options].some((o) => o.value === home)) wsSel.prepend(h('option', { value: home }, now.name));
      wsSel.value = home;
      search.value = '';
      fillOptions();
      load();
      return;
    }
    load({ quiet: true });
  });
  get('/fabric/workspaces').then((all) => {
    wss = all;
    for (const w of wss) names.set(w.id.toLowerCase(), w.name);
    fillOptions();
    draw();
  }).catch(() => { /* The project workspace still works; other workspaces can't be picked. */ });
  load();
  return dlg;
}

/** The active data source with a way to switch – shown on the Data page when the workspace has several. */
export function sourceBar() {
  const p = store.project || {};
  const others = workspaceSources().filter((e) => e.state && e.key !== p.sourceKey);
  if (!p.workspace || !others.length) return null;
  return h('div', { class: 'modelbar' },
    h('span', { class: 'mbl' }, 'Data source'),
    h('b', {}, p.source?.label || p.modelSource?.itemName || 'None connected yet'),
    h('span', { class: 'tiny muted mbnote' }, `${plural(others.length, 'other data source')} in this workspace keep${others.length === 1 ? 's' : ''} ${others.length === 1 ? 'its' : 'their'} own items`),
    h('span', { style: { flex: 1 } }),
    ...others.slice(0, 2).map((e) => {
      const b = h('button', { class: 'btn', 'data-busy': 'Switching…', title: `Work on ${e.label || 'this data source'} again – its items come back` }, `⇄ ${e.label || 'Data source'}`);
      b.addEventListener('click', busy(b, () => switchSource(e.key, e.label)));
      return b;
    }),
    others.length > 2 ? h('button', { class: 'btn ghost', onclick: () => sourcesDialog() }, 'All data sources') : null);
}
