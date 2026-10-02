import { store, get, post } from '../api.js';
import { h, toast, busy, field, input, select, seg, fmtNum } from '../ui.js';
import { app, copilotSlot } from '../app.js';

let mode = 'new';
let caps = null;
let workspaces = null;
let filter = '';

export function renderWorkspace(el) {
  const p = store.project || {};
  if (p.workspace) el.append(currentCard(p));

  const body = h('div');
  const card = h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('div', {}, h('h2', {}, p.workspace ? 'Switch workspace' : 'Choose a workspace'), h('p', { class: 'lead' }, 'Everything the studio builds lands in one Fabric workspace on a capacity.')),
      seg([{ value: 'new', label: 'Create new' }, { value: 'existing', label: 'Use existing' }], mode, (v) => { mode = v; draw(); })),
    body);
  el.append(card, copilotSlot());

  const draw = () => { body.innerHTML = ''; body.append(mode === 'new' ? newForm() : existingList()); };
  draw();
}

function currentCard(p) {
  const items = h('div', { class: 'muted small' }, 'Loading items…');
  get(`/fabric/workspaces/${p.workspace.id}/items`).then((list) => {
    items.innerHTML = '';
    if (!list.length) { items.append('No items yet.'); return; }
    const t = h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Type')));
    for (const i of list.slice(0, 30)) t.append(h('tr', {}, h('td', {}, i.name), h('td', { class: 'muted' }, i.type)));
    items.className = 'scroll';
    items.append(t);
  }).catch((e) => { items.textContent = e.message; });
  return h('div', { class: 'card', style: { marginBottom: '14px' } },
    h('div', { class: 'row sp' },
      h('div', {}, h('h2', {}, p.workspace.name), h('div', { class: 'muted small' }, `${p.workspace.created ? 'Created by the studio' : 'Existing workspace'} · ${p.workspace.id}`)),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: `https://app.fabric.microsoft.com/groups/${p.workspace.id}`, target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗'),
        h('button', { class: 'btn pri', onclick: () => app.go('data') }, 'Next: add data →'))),
    h('div', { class: 'mt' }, items));
}

function newForm() {
  const name = input({ placeholder: 'Fabric MCP Demo', value: 'Fabric MCP Demo' });
  const capSel = select([{ value: '', label: 'Loading capacities…' }]);
  const desc = input({ placeholder: 'Optional description' });
  const loadCaps = async () => {
    try {
      caps = caps || await get('/fabric/capacities');
      capSel.innerHTML = '';
      const active = caps.filter((c) => c.state === 'Active');
      if (!active.length) capSel.append(h('option', { value: '' }, 'No active capacity – start a Fabric trial'));
      for (const c of active.sort((a, b) => (/^FT/.test(a.sku) - /^FT/.test(b.sku)) || a.name.localeCompare(b.name))) {
        capSel.append(h('option', { value: c.id }, `${c.name} · ${c.sku}${/^FT/.test(c.sku) ? ' (trial)' : ''} · ${c.region}`));
      }
    } catch (e) { capSel.innerHTML = ''; capSel.append(h('option', { value: '' }, e.message)); }
  };
  loadCaps();
  const btn = h('button', { class: 'btn pri big', 'data-busy': 'Creating workspace…' }, 'Create workspace');
  btn.addEventListener('click', busy(btn, async () => {
    if (!name.value.trim()) throw new Error('Enter a workspace name.');
    if (!capSel.value) throw new Error('Choose a capacity.');
    const ws = await post('/project/workspace', { name: name.value.trim(), capacityId: capSel.value, description: desc.value });
    toast(`Workspace ${ws.name} is ready`, 'ok');
    await app.refresh();
    app.go('data');
  }));
  return h('div', { class: 'col' },
    h('div', { class: 'formgrid' }, field('Workspace name', name), field('Capacity', capSel, 'Trial capacities work for everything except the Ontology MCP endpoint, which needs paid F2+.'), field('Description', desc)),
    h('div', { class: 'row mt' }, btn, h('button', { class: 'btn ai', onclick: () => app.ask(`Create a new Fabric workspace named "${name.value || 'Fabric MCP Demo'}" on the most suitable capacity I have, and make it the project workspace.`) }, '✦ Ask Copilot to do it')),
    h('p', { class: 'tiny muted' }, 'If a workspace with this name already exists and you have access, the studio uses it instead of creating a duplicate.'));
}

function existingList() {
  const box = h('div', { class: 'col' });
  const search = input({ placeholder: 'Search workspaces…', value: filter });
  const list = h('div', { class: 'scroll' }, h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading workspaces…'));
  const draw = () => {
    list.innerHTML = '';
    const capById = new Map((caps || []).map((c) => [c.id, c]));
    const rows = (workspaces || []).filter((w) => !filter || w.name.toLowerCase().includes(filter.toLowerCase()));
    if (!rows.length) { list.append(h('div', { class: 'empty' }, 'No workspaces match.')); return; }
    const t = h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Workspace'), h('th', {}, 'Capacity'), h('th', {}, '')));
    for (const w of rows.slice(0, 300)) {
      const cap = capById.get(w.capacityId);
      const useBtn = h('button', { class: 'btn', 'data-busy': 'Selecting…' }, 'Use');
      useBtn.addEventListener('click', busy(useBtn, async () => {
        const ws = await post('/project/workspace', { workspaceId: w.id });
        toast(`Using ${ws.name}`, 'ok');
        await app.refresh();
        app.go('data');
      }));
      t.append(h('tr', { class: store.project?.workspace?.id === w.id ? 'sel' : '' },
        h('td', {}, h('b', {}, w.name), w.description ? h('div', { class: 'tiny muted' }, w.description.slice(0, 90)) : null),
        h('td', {}, w.capacityId ? (cap ? `${cap.name} · ${cap.sku}` : h('span', { class: 'pill' }, 'Capacity')) : h('span', { class: 'pill warn' }, 'No capacity')),
        h('td', { class: 'num' }, useBtn)));
    }
    list.append(t);
  };
  search.addEventListener('input', () => { filter = search.value; draw(); });
  (async () => {
    try {
      [workspaces, caps] = await Promise.all([workspaces || get('/fabric/workspaces'), caps || get('/fabric/capacities')]);
      draw();
    } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'banner err' }, e.message)); }
  })();
  box.append(h('div', { class: 'row' }, search, h('span', { class: 'tiny muted' }, `You need Contributor (or higher) to create items.`)), list);
  return box;
}

export const _fmt = fmtNum;
