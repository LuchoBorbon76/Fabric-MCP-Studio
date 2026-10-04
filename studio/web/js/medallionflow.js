// "Medallion task flow" card: Fabric's predesigned Medallion task flow applied to the project's existing items, with the
// layer each item goes to. Shown on the Workspace page (a task flow belongs to the workspace).
import { get, post, del, on } from './api.js';
import { h, toast, busy, confirmDialog } from './ui.js';
import { app } from './app.js';

const TYPE_LABEL = { Lakehouse: 'Lakehouse', SQLDatabase: 'SQL database', MirroredDatabase: 'Mirrored database', Warehouse: 'Warehouse', Notebook: 'Notebook', SemanticModel: 'Semantic model', Report: 'Report', OrgApp: 'Org app', Ontology: 'Ontology', DataAgent: 'Data agent', Plan: 'Plan' };
const LAYER_CLASS = { bronze: 'bronze', silver: 'silver', gold: 'gold' };

export function medallionFlowCard() {
  const card = h('div', { class: 'card mflow', style: { marginBottom: '14px' } }, h('div', { class: 'muted small' }, h('span', { class: 'spin' }), ' Reading the project\'s items…'));
  const job = h('div');
  const draw = (s) => {
    card.replaceChildren();
    const f = s.flow;
    const head = h('div', { class: 'row sp' },
      h('div', {},
        h('h2', {}, 'Medallion task flow'),
        h('p', { class: 'lead' }, 'Organize what the studio built with Fabric\'s predesigned Medallion task flow: Bronze (data as it lands), Silver (curated), Gold (business-ready), with each item assigned to its layer in the workspace.')),
      f ? h('span', { class: `pill ${s.upToDate ? 'ok' : 'warn'}` }, s.upToDate ? 'Applied' : 'New items to add') : h('span', { class: 'pill brand' }, 'Not applied'));
    const rows = s.layers.map((l) => h('tr', {},
      h('td', {}, h('span', { class: `mftask ${LAYER_CLASS[l.key] || ''}` }, l.name), h('div', { class: 'tiny muted' }, l.description)),
      h('td', {}, l.items.length ? h('div', { class: 'chips' }, l.items.map((i) => h('span', { class: 'pill', title: TYPE_LABEL[i.type] || i.type }, i.name))) : h('span', { class: 'tiny muted' }, '–'))));
    const table = h('div', {}, h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Task (layer)'), h('th', {}, 'Items')), rows));
    const go = h('button', { class: 'btn pri', 'data-busy': 'Starting…', disabled: !s.available || undefined, title: s.reason || '' }, f ? (s.upToDate ? '↻ Apply again' : '↻ Update the task flow') : 'Apply the Medallion task flow');
    go.addEventListener('click', busy(go, async () => {
      const j = await post('/jobs/medallion-flow');
      app.watchJob(j.id);
      const render = (x) => { job.replaceChildren(app.jobCard(x)); };
      render(j);
      const off = on('job', (e) => {
        if (e.job.id !== j.id) return;
        render(e.job);
        if (e.job.status !== 'running') { off(); if (e.job.status === 'succeeded') toast(`Task flow "${e.job.result?.name || s.name}" is in the workspace`, 'ok'); load(); }
      });
    }));
    const remove = f ? h('button', { class: 'btn ghost', 'data-busy': 'Removing…' }, 'Remove the task flow') : null;
    remove?.addEventListener('click', busy(remove, async () => {
      if (!await confirmDialog('Remove the task flow', `Delete the task flow "${f.name}" from the workspace? The items stay; only the flow above the item list goes.`, 'Remove', true)) return;
      await del('/medallion-flow');
      toast('Task flow removed', 'ok');
      load();
    }));
    card.append(head, table,
      h('div', { class: 'row mt' }, go,
        f && s.flow?.url ? h('a', { class: 'btn', href: s.flow.url, target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗') : null,
        remove,
        h('button', { class: 'btn ai', onclick: () => app.ask('Explain how my items map to the Medallion layers (studio_medallion_task_flow_status), what each layer is for, and what to add next.') }, '✦ Ask Copilot')),
      h('p', { class: 'tiny muted' }, f ? `"${f.name}" · ${f.items} items on ${f.tasks} tasks · updated automatically when the studio adds items.` : `The task flow is named ${s.name}. Live events have their own medallion on the Real-time page.`),
      job);
  };
  const load = () => get('/medallion-flow').then((s) => { if (card.isConnected || !card.parentNode) draw(s); }).catch((e) => { card.replaceChildren(h('div', { class: 'banner err' }, e.message)); });
  load();
  return card;
}
