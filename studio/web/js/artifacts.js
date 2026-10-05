// Remove buttons for everything the project built. An item something still uses can't be removed: its button is
// disabled and says what uses it (remove those first). The list comes from GET /api/artifacts.
import { get, post, on } from './api.js';
import { h, toast, modal } from './ui.js';
import { app } from './app.js';

let cache = null;
let loading = null;
let gen = 0;     // bumped when the project changes: answers to older requests are thrown away

/** The project's artifacts ({ key, nodes, type, name, url, usedBy, removable, removes }); cached until the project changes. */
export function loadArtifacts({ fresh = false } = {}) {
  if (cache && !fresh) return Promise.resolve(cache);
  if (!loading || fresh) {
    const mine = gen;
    const req = get('/artifacts').then((list) => { if (mine === gen) cache = list; return list; });
    loading = req;
    req.finally(() => { if (loading === req) loading = null; }).catch(() => {});
  }
  return loading;
}
const invalidate = () => { gen += 1; cache = null; loading = null; };
on('project.updated', invalidate);
on('studio.reset', invalidate);

const usedByText = (list) => list.map((u) => u.name).join(', ');

/**
 * A Remove button for one artifact or a group (all reports): disabled, with what uses it, when something does.
 * label: button text; arts: artifacts to remove together.
 */
export function removeButton(arts, { label = 'Remove', compact = false } = {}) {
  const group = arts.map((a) => a.key);
  const blockers = arts.flatMap((a) => a.usedBy.filter((u) => !u.key || !group.includes(u.key)));
  const uniq = [...new Map(blockers.map((b) => [`${b.key}|${b.name}`, b])).values()];
  const btn = h('button', {
    class: `btn ${compact ? 'ghost' : ''} danger-text`, type: 'button', disabled: uniq.length ? true : undefined,
    title: uniq.length ? `Used by ${usedByText(uniq)} – remove ${uniq.length === 1 ? 'it' : 'them'} first` : arts.map((a) => a.removes).join(' · '),
    onclick: () => confirmRemove(arts),
  }, label);
  if (compact || !uniq.length) return btn;
  return h('div', { class: 'col', style: { gap: '3px' } }, btn, h('span', { class: 'tiny muted' }, `Used by ${usedByText(uniq)}`));
}

/** Ask, then remove the artifacts (users first) as one job shown in the job dock. */
export async function confirmRemove(arts) {
  const names = arts.map((a) => a.name);
  const ok = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title: arts.length === 1 ? `Remove ${names[0]}?` : `Remove ${arts.length} items?`,
      body: h('div', {}, h('ul', { class: 'pre' }, arts.map((a) => h('li', {}, `${a.removes}.`))), h('p', { class: 'small muted' }, 'This can\'t be undone from the studio.')),
      actions: [{ label: 'Cancel', onClick: () => finish(false) }, { label: 'Remove', class: 'danger', onClick: () => finish(true) }],
      onClose: () => finish(false),
    });
  });
  if (!ok) return;
  try {
    const j = await post('/jobs/remove', { keys: arts.map((a) => a.key), name: arts.length === 1 ? names[0] : undefined });
    app.watchJob(j.id);
    const off = on('job', (e) => {
      if (e.job.id !== j.id || e.job.status === 'running') return;
      off();
      invalidate();
      if (e.job.status === 'succeeded') toast(`Removed ${arts.length === 1 ? names[0] : `${arts.length} items`}`, 'ok');
      else toast(e.job.error || 'The removal didn\'t finish', 'err');
      app.refresh();
    });
  } catch (e) { toast(e.message, 'err'); }
}

/** Remove buttons for the items behind one part of the solution map (for the Overview inspector). */
export function nodeRemoveActions(nodeId) {
  const box = h('div', { class: 'iremove' });
  loadArtifacts().then((list) => {
    const arts = list.filter((a) => a.nodes.includes(nodeId));
    if (!arts.length) return;
    const reports = arts.filter((a) => a.key.startsWith('report:'));
    const others = arts.filter((a) => !a.key.startsWith('report:'));
    const items = [];
    if (reports.length) items.push(removeButton(reports, { label: reports.length === 1 ? 'Remove the report' : `Remove ${reports.length} reports` }));
    for (const a of others) items.push(removeButton([a], { label: others.length + (reports.length ? 1 : 0) > 1 ? `Remove ${a.type.split(' · ')[0].toLowerCase()}` : 'Remove' }));
    box.replaceChildren(...items);
  }).catch(() => {});
  return box;
}

/** Every item in the project with what uses it and a Remove button (Overview). */
export function itemsTable() {
  const body = h('div', { class: 'muted small' }, 'Loading…');
  loadArtifacts({ fresh: true }).then((list) => {
    if (!list.length) { body.replaceChildren(h('div', { class: 'muted small' }, 'Nothing yet. Items you create appear here with links to Fabric.')); return; }
    const t = h('table', { class: 't items' }, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Used by'), h('th', {}, '')));
    for (const a of list) {
      t.append(h('tr', {},
        h('td', {}, a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.name) : h('span', {}, a.name), h('div', { class: 'tiny muted' }, a.type)),
        h('td', { class: 'small' }, a.usedBy.length ? h('span', { class: 'muted' }, usedByText(a.usedBy)) : h('span', { class: 'tiny muted' }, '–')),
        h('td', { class: 'num' }, removeButton([a], { compact: true }))));
    }
    body.className = 'scroll';
    body.replaceChildren(t);
  }).catch((e) => { body.replaceChildren(h('div', { class: 'banner err' }, e.message)); });
  return body;
}
