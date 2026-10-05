// Data sources of the workspace: each keeps its own OneLake data, semantic models, reports, ontology, plan and live
// data. One is active – the map and every page show what was built from it, and parts not built for it yet stay grey.
// Switching changes nothing in Fabric.
import { store, get, post, on } from './api.js';
import { h, toast, busy, modal, fmtDate } from './ui.js';
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

/** Every data source of the workspace, in a pop-up: switch, or connect another one. */
export function sourcesDialog() {
  const p = store.project || {};
  let dlg = null;
  let off = () => {};
  const close = () => dlg?.close();
  const list = h('div', { class: 'muted small' }, h('span', { class: 'spin' }), ' Reading the workspace\'s data sources…');
  const draw = () => get('/sources/contexts').then((s) => {
    if (!s.sources.length) {
      list.className = 'muted small';
      list.replaceChildren('No data source yet. Load sample data, mirror a database or use Fabric data on the Data page.');
      return;
    }
    const t = h('table', { class: 't stable' }, h('tr', {}, h('th', {}, 'Data source'), h('th', {}, 'Built from it'), h('th', { 'aria-label': 'Actions' })));
    for (const x of s.sources) {
      const use = h('button', { class: 'btn pri', 'data-busy': 'Switching…' }, 'Use this source');
      use.addEventListener('click', busy(use, async () => { await switchSource(x.key, x.label); close(); }));
      const built = builtText(x);
      t.append(h('tr', { class: x.active ? 'sel' : '' },
        h('td', {},
          h('div', { class: 'row', style: { gap: '6px' } }, h('b', {}, x.label), x.active ? h('span', { class: 'pill ok' }, 'Active') : null),
          h('div', { class: 'tiny muted' }, [x.key === 'none' ? 'Items built without a data source' : HOW[x.method] || (x.kind === 'sample' ? 'Sample data' : 'Data source'), x.active || !x.savedAt ? null : `last used ${fmtDate(x.savedAt)}`].filter(Boolean).join(' · '))),
        h('td', { class: 'small' }, built.length ? built.join(' · ') : h('span', { class: 'tiny muted' }, x.connected ? 'Connected – nothing built yet' : 'Not connected yet')),
        h('td', { class: 'act' }, x.active ? null : use)));
    }
    list.className = 'scroll';
    list.replaceChildren(t);
  }).catch((e) => list.replaceChildren(h('div', { class: 'banner err' }, e.message)));
  dlg = modal({
    title: 'Data sources in this workspace', className: 'wide',
    body: h('div', { class: 'col' },
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Each data source keeps its own OneLake data, semantic models, reports, ontology, plan and live data. The map shows the active one – parts not built for it yet stay grey. Switch any time; nothing changes in Fabric.'),
      list,
      p.workspace
        ? h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { close(); app.go('data'); } }, '+ Connect another data source'))
        : h('div', { class: 'banner warn' }, 'Select a workspace first.')),
    actions: [{ label: 'Close' }],
    onClose: () => off(),
  });
  off = on('project.updated', () => { if (dlg) draw(); });
  draw();
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
