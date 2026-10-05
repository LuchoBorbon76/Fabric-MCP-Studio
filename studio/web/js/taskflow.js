// "Task flow" card on the Workspace page: pick a flow – one of Fabric's predesigned flows (the studio builds it as its
// own canvas) or a task flow already in the workspace – see which box each item goes to on a canvas like Fabric's,
// move items to another box, and apply. The studio keeps the flow up to date as it adds or removes items.
import { get, post, del, on } from './api.js';
import { h, toast, busy, confirmDialog } from './ui.js';
import { app } from './app.js';

const TYPE_LABEL = { Lakehouse: 'Lakehouse', SQLDatabase: 'SQL database', MirroredDatabase: 'Mirrored database', Warehouse: 'Warehouse', Notebook: 'Notebook', SemanticModel: 'Semantic model', Report: 'Report', OrgApp: 'Org app', Ontology: 'Ontology', DataAgent: 'Data agent', Plan: 'Plan', Eventstream: 'Eventstream', Eventhouse: 'Eventhouse', KQLQueryset: 'KQL queryset', KQLDashboard: 'Real-Time Dashboard', Reflex: 'Activator' };
// Task type colors, close to Fabric's task flow canvas.
const TASK = {
  'get data': ['#5b8c1a', 'Get data'], 'mirror data': ['#0f6cbd', 'Mirror data'], 'store data': ['#2f8fa3', 'Store data'], 'prepare data': ['#4f52b2', 'Prepare data'],
  'analyze and train data': ['#c4314b', 'Analyze and train data'], 'track data': ['#8764b8', 'Track data'], visualize: ['#c75b12', 'Visualize data'],
  'distribute data': ['#038387', 'Distribute data'], 'develop data': ['#616161', 'Develop data'], general: ['#616161', 'General'],
};
const color = (type) => (TASK[type] || TASK.general)[0];

// What the user picked and moved, kept while they look around the page.
let draft = { choice: null, overrides: null };
on('studio.reset', () => { draft = { choice: null, overrides: null }; });

export function taskFlowCard() {
  const card = h('div', { class: 'card tflow', style: { marginBottom: '14px' } }, h('div', { class: 'muted small' }, h('span', { class: 'spin' }), ' Reading the workspace\'s task flows…'));
  const job = h('div');
  let state = null;
  const load = async ({ fresh = false } = {}) => {
    try {
      const s = draft.choice || draft.overrides
        ? await post('/taskflow/preview', { choice: draft.choice || undefined, overrides: draft.overrides || undefined })
        : await get(`/taskflow${fresh ? '?refresh=1' : ''}`);
      state = s;
      if (card.isConnected || !card.parentNode) draw(s);
    } catch (e) {
      // A choice that no longer exists (deleted in Fabric): forget it and show the default.
      if ((draft.choice || draft.overrides) && /no longer in the workspace|Unknown task flow/i.test(e.message)) { draft = { choice: null, overrides: null }; return load({ fresh: true }); }
      card.replaceChildren(h('h2', {}, 'Task flow'), h('div', { class: 'banner err' }, e.message));
    }
  };
  const pick = (choice) => { draft = { choice, overrides: null }; load(); };
  const move = (itemId, task) => { draft = { choice: state.choice, overrides: { ...(state.plan.overrides || {}), [itemId]: task } }; load(); };

  const draw = (s) => {
    card.replaceChildren();
    const f = s.applied;
    const pl = s.plan;
    const status = !f ? h('span', { class: 'pill brand' }, 'Not applied')
      : s.selectedIsApplied ? h('span', { class: `pill ${s.upToDate ? 'ok' : 'warn'}` }, s.upToDate ? 'Applied' : 'Items to update')
        : h('span', { class: 'pill' }, `Applied: ${f.name}`);
    card.append(h('div', { class: 'row sp' },
      h('div', {}, h('h2', {}, 'Task flow'), h('p', { class: 'lead' }, 'Organize the workspace the way Fabric does: choose one of Fabric\'s predesigned task flows, or the task flow you already have in the workspace. The studio puts every item it builds in the right task (box) and keeps it up to date as items are added or removed.')),
      status));
    if (!pl) { card.append(h('div', { class: 'banner warn' }, s.reason || 'Select a workspace first.')); return; }

    // Choice: task flows in the workspace first (people's own), then the predesigned flows the studio builds.
    const sel = h('select', { class: 'i', 'aria-label': 'Task flow', style: { width: 'auto', minWidth: '300px', maxWidth: '520px' } });
    const theirs = s.existing.filter((x) => !x.studio);
    if (theirs.length) sel.append(h('optgroup', { label: 'Task flows in this workspace' }, theirs.map((x) => h('option', { value: `existing:${x.id}` }, `${x.name} · ${x.tasks} tasks${f?.mode === 'existing' && f.id === x.id ? ' · applied' : ''}`))));
    sel.append(h('optgroup', { label: 'Predesigned (the studio creates the task flow)' }, s.templates.map((t) => h('option', { value: `template:${t.id}` }, `${t.name}${f && f.mode !== 'existing' && f.template === t.id ? ' · applied' : ''}`))));
    sel.value = s.choice;
    sel.addEventListener('change', () => pick(sel.value));
    const what = pl.mode === 'existing'
      ? `Your task flow "${pl.name}": the studio adds its items to the boxes below. Your tasks, connectors, layout and the items you assigned stay as they are.`
      : `${pl.template?.description || ''} The studio creates it as "${pl.name}".`;
    card.append(h('div', { class: 'row', style: { alignItems: 'center', gap: '10px', marginTop: '6px' } },
      h('label', { class: 'tiny muted', style: { fontWeight: 600 } }, 'Task flow'), sel,
      h('button', { class: 'btn ghost', title: 'Read the workspace\'s task flows again (after changing them in Fabric)', onclick: () => { draft = { choice: draft.choice, overrides: draft.overrides }; load({ fresh: true }); } }, '↻')),
    h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, what));
    if (s.listError) card.append(h('div', { class: 'banner warn mt' }, h('div', {}, h('b', {}, 'The workspace\'s task flows couldn\'t be read. '), s.listError)));

    card.append(canvas(pl), boxesTable(pl, move));

    const go = h('button', { class: 'btn pri', 'data-busy': 'Starting…', disabled: !s.available || undefined, title: s.reason || '' },
      !s.selectedIsApplied ? (pl.mode === 'existing' ? `Use "${pl.name}"` : `Apply the ${pl.template?.name || ''} task flow`) : s.upToDate ? '↻ Apply again' : '↻ Update the task flow');
    go.addEventListener('click', busy(go, async () => {
      if (f && !s.selectedIsApplied) {
        const what2 = f.mode === 'existing' ? `The studio takes its items off "${f.name}" (your task flow stays).`
          : pl.mode === 'template' ? `"${f.name}" is changed into the ${pl.template?.name} flow (same canvas).` : `The studio's task flow "${f.name}" is deleted (the items stay).`;
        if (!await confirmDialog('Use another task flow', `${what2} Then the items go to the boxes of "${pl.name}".`, 'Continue')) return;
      }
      const j = await post('/jobs/taskflow', { choice: s.choice, overrides: pl.overrides && Object.keys(pl.overrides).length ? pl.overrides : undefined });
      app.watchJob(j.id);
      const render = (x) => { job.replaceChildren(app.jobCard(x)); };
      render(j);
      const off = on('job', (e) => {
        if (e.job.id !== j.id) return;
        render(e.job);
        if (e.job.status !== 'running') { off(); if (e.job.status === 'succeeded') { toast(`Task flow "${e.job.result?.name || pl.name}" is in the workspace`, 'ok'); draft = { choice: null, overrides: null }; load({ fresh: true }); } }
      });
    }));
    const remove = f ? h('button', { class: 'btn ghost', 'data-busy': 'Removing…' }, f.mode === 'existing' ? 'Stop using it' : 'Remove the task flow') : null;
    remove?.addEventListener('click', busy(remove, async () => {
      const msg = f.mode === 'existing' ? `Take the studio's items off "${f.name}"? Your task flow and the items you assigned stay; the studio stops keeping it up to date.` : `Delete the task flow "${f.name}" from the workspace? The items stay; only the flow above the item list goes.`;
      if (!await confirmDialog(f.mode === 'existing' ? 'Stop using the task flow' : 'Remove the task flow', msg, f.mode === 'existing' ? 'Stop using it' : 'Remove', true)) return;
      await del('/taskflow');
      toast(f.mode === 'existing' ? 'The studio\'s items were taken off the task flow' : 'Task flow removed', 'ok');
      draft = { choice: null, overrides: null };
      load({ fresh: true });
    }));
    const moved = pl.overrides && Object.keys(pl.overrides).length;
    card.append(h('div', { class: 'row mt' }, go,
      h('a', { class: 'btn', href: s.workspace.url, target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗'),
      moved ? h('button', { class: 'btn ghost', onclick: () => { draft = { choice: s.choice, overrides: {} }; load(); } }, 'Undo my moves') : null,
      remove,
      h('button', { class: 'btn ai', onclick: () => app.ask(`Look at my workspace task flow options (studio_task_flow_status): which flow fits my project best, where each item goes in "${pl.name}", and what to add next. Then suggest applying it.`) }, '✦ Ask Copilot')),
    h('p', { class: 'tiny muted' }, f ? `"${f.name}" · ${f.items} items on ${f.tasks} tasks · updated automatically when the studio adds or removes items.` : `${pl.count} items go to ${pl.tasks.filter((t) => t.items.length).length} of the ${pl.tasks.length} tasks. Nothing changes in Fabric until you apply.`),
    job);
  };
  load();
  return card;
}

// ---------------- the canvas: boxes where Fabric puts them, with the connectors ----------------
const BOX_W = 150;
const BOX_H = 62;
const SCALE = 0.5;

function canvas(pl) {
  const xs = pl.tasks.map((t) => t.x);
  const ys = pl.tasks.map((t) => t.y);
  const minX = Math.min(...xs, 0);
  const minY = Math.min(...ys, 0);
  const pos = new Map(pl.tasks.map((t) => [t.key, { x: (t.x - minX) * SCALE + 12, y: (t.y - minY) * SCALE + 12 }]));
  const width = Math.max(...[...pos.values()].map((p) => p.x)) + BOX_W + 24;
  const height = Math.max(...[...pos.values()].map((p) => p.y)) + BOX_H + 24;
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', width); svg.setAttribute('height', height); svg.setAttribute('class', 'tfedges');
  const defs = document.createElementNS(svgNs, 'defs');
  defs.innerHTML = '<marker id="tfarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>';
  svg.append(defs);
  for (const e of pl.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + BOX_W;
    const y1 = a.y + BOX_H / 2;
    const x2 = b.x - 2;
    const y2 = b.y + BOX_H / 2;
    const mid = Math.max(x1 + 12, (x1 + x2) / 2);
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', x2 > x1 ? `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`);
    path.setAttribute('marker-end', 'url(#tfarrow)');
    svg.append(path);
  }
  const boxes = pl.tasks.map((t) => {
    const p = pos.get(t.key);
    const n = t.items.length;
    const box = h('button', {
      type: 'button', class: `tfbox ${n ? 'has' : ''}`, style: `left:${p.x}px;top:${p.y}px;width:${BOX_W}px;height:${BOX_H}px;--tc:${color(t.type)}`,
      title: `${t.name}\n${(TASK[t.type] || TASK.general)[1]}${t.description ? `\n\n${t.description}` : ''}${t.takes?.length ? `\n\nThe studio puts here: ${t.takes.join(', ')}` : ''}`,
      onclick: () => document.getElementById(`tfrow-${t.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    },
    h('b', {}, t.name),
    h('span', { class: 'tftype' }, (TASK[t.type] || TASK.general)[1]),
    h('span', { class: 'tfcount' }, `${n} item${n === 1 ? '' : 's'}${t.others ? ` + ${t.others} yours` : ''}`));
    return box;
  });
  return h('div', { class: 'tfcanvas' }, h('div', { class: 'tfinner', style: { width: `${width}px`, height: `${height}px` } }, svg, ...boxes));
}

// ---------------- the boxes with their items, and moving an item ----------------
function boxesTable(pl, move) {
  const options = (current) => [
    ...pl.tasks.map((t) => h('option', { value: t.key, selected: t.key === current || undefined }, t.name)),
    h('option', { value: '', selected: current === '' || undefined }, 'Not in this flow'),
  ];
  const chip = (i, current) => {
    if (i.pinned) return h('span', { class: 'pill tfitem', title: `${TYPE_LABEL[i.type] || i.type} · you placed it on this task in Fabric, so it stays here` }, h('span', {}, i.name), h('span', { class: 'tiny muted' }, ' · yours'));
    const s = h('select', { class: 'tfmove', 'aria-label': `Move ${i.name}`, title: 'Move to another task' }, options(current));
    s.addEventListener('change', () => move(i.id, s.value));
    return h('span', { class: 'pill tfitem', title: `${TYPE_LABEL[i.type] || i.type} · ${i.role}` }, h('span', { class: 'tfname' }, i.name), s);
  };
  const rows = pl.tasks.map((t) => h('tr', { id: `tfrow-${t.key}` },
    h('td', {}, h('span', { class: 'tftask', style: `--tc:${color(t.type)}` }, t.name), h('div', { class: 'tiny muted' }, t.description || (TASK[t.type] || TASK.general)[1])),
    h('td', {}, t.items.length || t.others
      ? h('div', { class: 'chips' }, t.items.map((i) => chip(i, t.key)), t.others ? h('span', { class: 'tiny muted' }, `+ ${t.others} item${t.others === 1 ? '' : 's'} you assigned`) : null)
      : h('span', { class: 'tiny muted' }, '–'))));
  if (pl.unassigned.length) {
    rows.push(h('tr', { id: 'tfrow-none', class: 'tfnone' },
      h('td', {}, h('span', { class: 'tftask', style: '--tc:#8a8886' }, 'Not in this flow'), h('div', { class: 'tiny muted' }, 'Items no task of this flow takes, or that you kept off. Pick a task to add one.')),
      h('td', {}, h('div', { class: 'chips' }, pl.unassigned.map((i) => h('span', { title: i.reason }, chip(i, '')))))));
  }
  return h('div', { class: 'scroll mt' }, h('table', { class: 't tftable' }, h('tr', {}, h('th', {}, 'Task'), h('th', {}, 'Items')), rows));
}
