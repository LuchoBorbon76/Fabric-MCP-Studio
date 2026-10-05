// Workspaces on a Fabric capacity, in a pop-up (double-click the workspace name on the map): see them, open one in
// Fabric, or use another one for the project – which starts the project over there (the studio asks first).
import { store, get, post } from './api.js';
import { h, toast, busy, modal, select, input, confirmDialog } from './ui.js';
import { app } from './app.js';

/**
 * Another workspace starts everything over (data sources, models, reports, live data, plans, task flow): ask first
 * when the project has something. targetId: the workspace chosen (null for a new one).
 */
export async function confirmStartOver(targetId) {
  const p = store.project || {};
  if (!p.workspace || targetId === p.workspace.id) return true;
  const has = (p.sources || []).length || p.semanticModel || p.realtime || (p.reports || []).length;
  if (!has) return true;
  const n = (p.sources || []).length;
  return confirmDialog('Use another workspace?', `Everything the studio shows starts over in the new workspace: ${n > 1 ? `the ${n} data sources` : 'the data source'}, semantic models, reports, ontology, live data, plans, naming and the task flow. Nothing is deleted – the items stay in ${p.workspace.name} in Fabric. To delete them, use Clean up resources (Settings) before you switch.`, 'Start over in the new workspace');
}

/** Make a workspace the project workspace (after confirming a start-over). */
export async function useWorkspace(w) {
  if (!(await confirmStartOver(w.id))) return false;
  const ws = await post('/project/workspace', { workspaceId: w.id });
  toast(`Using ${ws.name}`, 'ok');
  await app.refresh();
  return true;
}

const fabricWs = (id) => `https://app.fabric.microsoft.com/groups/${id}/list?experience=fabric-developer`;

/** The workspaces on the project's capacity (or any capacity), with Use and Open in Fabric. */
export function workspacesDialog() {
  const p = store.project || {};
  let dlg = null;
  let caps = [];
  let wss = [];
  const capSel = select([{ value: p.workspace?.capacityId || '', label: 'Loading capacities…' }], { 'aria-label': 'Capacity', style: 'flex:0 1 340px;width:auto' });
  const search = input({ placeholder: 'Search workspaces…', style: 'flex:1 1 200px;width:auto' });
  const list = h('div', { class: 'scroll', style: { maxHeight: '380px' } }, h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading workspaces…'));
  const count = h('span', { class: 'tiny muted' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const cap = capSel.value;
    const rows = wss.filter((w) => (cap === '*' || w.capacityId === cap) && (!q || w.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.id === p.workspace?.id) - Number(a.id === p.workspace?.id) || a.name.localeCompare(b.name));
    count.textContent = `${rows.length} workspace${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) { list.replaceChildren(h('div', { class: 'empty' }, wss.length ? 'No workspaces match.' : 'No workspaces you can see.')); return; }
    const capName = new Map(caps.map((c) => [c.id, `${c.name} · ${c.sku}`]));
    const t = h('table', { class: 't stable' }, h('tr', {}, h('th', {}, 'Workspace'), cap === '*' ? h('th', {}, 'Capacity') : null, h('th', { 'aria-label': 'Actions' })));
    for (const w of rows) {
      const current = w.id === p.workspace?.id;
      const use = h('button', { class: 'btn pri', 'data-busy': 'Switching…', title: 'Make it the project workspace – the project starts over there' }, 'Use');
      use.addEventListener('click', busy(use, async () => { if (await useWorkspace(w)) dlg?.close(); }));
      t.append(h('tr', { class: current ? 'sel' : '' },
        h('td', {}, h('div', { class: 'row', style: { gap: '6px' } }, h('b', {}, w.name), current ? h('span', { class: 'pill ok' }, 'Project workspace') : null),
          w.description ? h('div', { class: 'tiny muted' }, w.description.slice(0, 120)) : null),
        cap === '*' ? h('td', { class: 'small' }, w.capacityId ? capName.get(w.capacityId) || 'Capacity' : h('span', { class: 'pill warn' }, 'No capacity')) : null,
        h('td', { class: 'act' }, h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px', flexWrap: 'nowrap' } },
          h('a', { class: 'btn ghost', href: fabricWs(w.id), target: '_blank', rel: 'noopener', title: 'Open in Fabric' }, '↗'),
          current ? null : use))));
    }
    list.replaceChildren(t);
  };
  capSel.addEventListener('change', draw);
  search.addEventListener('input', draw);
  dlg = modal({
    title: 'Workspaces on the capacity', className: 'wide',
    body: h('div', { class: 'col' },
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Every workspace you can see on the Fabric capacity. Using another one starts the project over there (the studio asks first); nothing is deleted.'),
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, capSel, search, count),
      list,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { dlg.close(); app.go('workspace'); } }, '+ Create a new workspace'))),
    actions: [{ label: 'Close' }],
  });
  Promise.all([get('/fabric/capacities').catch(() => []), get('/fabric/workspaces')]).then(([c, w]) => {
    caps = c;
    wss = w;
    const options = [
      ...caps.map((x) => ({ value: x.id, label: `${x.name} · ${x.sku}${x.state && x.state !== 'Active' ? ` (${x.state.toLowerCase()})` : ''}${x.id === p.workspace?.capacityId ? ' – project capacity' : ''}` })),
      { value: '*', label: 'All capacities' },
    ];
    capSel.replaceChildren(...options.map((o) => h('option', { value: o.value }, o.label)));
    capSel.value = p.workspace?.capacityId && caps.some((x) => x.id === p.workspace.capacityId) ? p.workspace.capacityId : '*';
    draw();
  }).catch((e) => list.replaceChildren(h('div', { class: 'banner err' }, e.message)));
  return dlg;
}
