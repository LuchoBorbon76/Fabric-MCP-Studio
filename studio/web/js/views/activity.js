import { store, get } from '../api.js';
import { h, fmtDate, fmtTime } from '../ui.js';
import { app } from '../app.js';

const ICON = { 'job.start': '▶', 'job.done': '✓', 'job.failed': '✗', 'tool.approved': '✔', 'tool.denied': '⛔', 'tool.blocked': '🔒', 'chat.create': '✦', 'workspace.select': '🗂', 'connection.create': '🔌', 'provider.change': '⚙', 'azure.sample': '☁' };
let filter = 'all';

export function renderActivity(el) {
  const jobs = [...store.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const jobsCard = h('div', { class: 'card' }, h('h2', {}, 'Jobs'), h('p', { class: 'lead' }, 'Long-running work started from the app or by Copilot.'),
    jobs.length ? jobs.slice(0, 12).map((j) => app.jobCard(j)) : h('div', { class: 'empty' }, 'No jobs yet.'));

  const arts = h('div', { class: 'card' }, h('h2', {}, 'Created items'), h('div', { class: 'muted small' }, 'Loading…'));
  const log = h('div', { class: 'card audit-card' });
  get('/activity').then((a) => {
    arts.lastChild.remove();
    if (!a.artifacts.length) arts.append(h('div', { class: 'empty' }, 'Nothing created yet.'));
    else {
      const t = h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Type'), h('th', {}, 'Created'), h('th', {}, '')));
      for (const x of a.artifacts) t.append(h('tr', {}, h('td', {}, h('b', {}, x.name)), h('td', {}, x.type), h('td', { class: 'muted' }, fmtDate(x.at)), h('td', { class: 'num' }, x.url ? h('a', { class: 'btn', href: x.url, target: '_blank', rel: 'noopener' }, 'Open ↗') : '')));
      arts.append(h('div', { class: 'scroll' }, t));
    }
    const draw = () => {
      log.innerHTML = '';
      const kinds = { all: 'All', changes: 'Changes', jobs: 'Jobs', chat: 'Copilot' };
      const sel = h('div', { class: 'seg' }, Object.entries(kinds).map(([k, v]) => h('button', { class: filter === k ? 'on' : '', onclick: () => { filter = k; draw(); } }, v)));
      log.append(h('div', { class: 'row sp audit-head' }, h('div', {}, h('h2', {}, 'Audit log'), h('p', { class: 'lead' }, 'Every approval, job and change, newest first.')), sel));
      const rows = a.log.filter((e) => filter === 'all' || (filter === 'changes' && /^tool\.|connection|workspace/.test(e.kind)) || (filter === 'jobs' && e.kind.startsWith('job.')) || (filter === 'chat' && e.kind.startsWith('chat')));
      const tl = h('div', { class: 'timeline' });
      for (const e of rows.slice(0, 200)) tl.append(h('div', { class: 'tl' }, h('span', { class: 'tm' }, `${new Date(e.at).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtTime(e.at)}`), h('span', {}, ICON[e.kind] || '•'), h('span', {}, e.title, e.error ? h('div', { class: 'tiny', style: { color: 'var(--bad)' } }, e.error) : null)));
      log.append(rows.length ? h('div', { class: 'audit-scroll' }, tl) : h('div', { class: 'empty' }, 'No entries.'));
    };
    draw();
  }).catch((e) => { arts.lastChild.textContent = e.message; });

  el.append(h('div', { class: 'grid g2' }, h('div', { class: 'col', style: { gap: '14px' } }, arts, jobsCard), log));
}
