import { store, get } from '../api.js';
import { h, statusDot, fmtDate } from '../ui.js';
import { app, STEPS, stepStatus } from '../app.js';

export function renderHome(el) {
  const p = store.project || {};
  const st = stepStatus(p, store);

  const paths = h('div', { class: 'paths' },
    h('div', { class: 'path', onclick: () => app.go('data') },
      h('div', { class: 'ico' }, '🧪'), h('b', {}, 'Start from sample data'),
      h('div', { class: 'tiny muted' }, 'Contoso Retail in minutes, or AdventureWorksDW2022 as a Fabric SQL database replicated to OneLake.')),
    h('div', { class: 'path', onclick: () => app.go('data') },
      h('div', { class: 'ico' }, '🗄️'), h('b', {}, 'Connect my databases'),
      h('div', { class: 'tiny muted' }, 'Azure SQL, SQL Managed Instance, SQL Server on-premises or Azure PostgreSQL via Fabric Mirroring.')),
    h('div', { class: 'path', onclick: () => app.go('data') },
      h('div', { class: 'ico' }, '🏞️'), h('b', {}, 'Use my Fabric data'),
      h('div', { class: 'tiny muted' }, 'Existing lakehouses, warehouses or mirrored databases – in place or with OneLake shortcuts.')),
    h('div', { class: 'path', onclick: () => app.go('copilot') },
      h('div', { class: 'ico' }, '✦'), h('b', {}, 'Just ask Copilot'),
      h('div', { class: 'tiny muted' }, 'Describe your business in plain language and let Copilot drive every step with your approval.')));

  const hero = h('div', { class: 'card' },
    h('h2', {}, store.user?.signedIn ? `Welcome, ${String(store.user.name || '').split(' ')[0]}` : 'Welcome to Fabric MCP Studio'),
    h('p', { class: 'lead' }, 'Turn data into a governed semantic model and a business ontology in Microsoft Fabric – by chatting with the Copilot you already use. Every change in Fabric is shown to you first.'),
    paths);

  const steps = h('div', { class: 'steps' }, STEPS.map((s, i) => {
    const done = st[s.id] === 'done';
    const cur = st.current === s.id;
    return h('div', { class: `step ${done ? 'done' : cur ? 'cur' : ''}`, onclick: () => app.go(s.view) },
      h('div', { class: 'n' }, done ? '✓' : String(i + 1)),
      h('div', {}, h('div', { class: 't' }, s.title), h('div', { class: 'd' }, stepDetail(s.id, p) || s.desc)),
      cur ? h('button', { class: 'btn pri', onclick: (e) => { e.stopPropagation(); app.go(s.view); } }, 'Start') : h('span', { class: 'tiny muted' }, done ? 'Done' : ''));
  }));

  const journey = h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('h2', {}, 'Your journey'), st.current ? h('button', { class: 'btn ai', onclick: () => app.ask(nextPrompt(st.current, p), { view: STEPS.find((x) => x.id === st.current)?.view }) }, '✦ Let Copilot do the next step') : h('span', { class: 'pill ok' }, 'All steps complete')),
    h('p', { class: 'lead' }, 'Each step can be done with a quick action or by asking Copilot.'),
    steps);

  const checks = h('div', { class: 'checks' });
  const hc = store.health;
  const rd = store.readiness;
  if (!hc) checks.append(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Checking your setup…'));
  else for (const c of hc.checks) checks.append(h('div', { class: 'check' }, statusDot(c.status), h('div', {}, h('b', {}, c.label), h('span', { class: 'muted' }, ` · ${c.detail}`), c.fix ? h('div', { class: 'fx' }, c.fix) : null)));
  if (rd) for (const c of rd.checks.filter((x) => x.status !== 'ok')) checks.append(h('div', { class: 'check' }, statusDot(c.status === 'unknown' ? 'info' : c.status), h('div', {}, h('b', {}, c.label), h('span', { class: 'muted' }, ` · ${c.detail}`), c.fix ? h('div', { class: 'fx' }, c.fix) : null)));
  const blocked = rd ? Object.values(rd.modules).filter((m) => m.status === 'blocked').length : 0;
  const ok = hc?.ready && !blocked;
  const ready = h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('h3', {}, 'Readiness'), hc ? h('span', { class: `pill ${ok ? 'ok' : 'err'}` }, ok ? 'Ready' : 'Action needed') : null),
    checks,
    rd ? [h('h3', { style: { margin: '14px 0 6px' } }, 'What can run'), app.moduleGrid(rd)] : null);

  const recent = h('div', { class: 'card' }, h('h3', {}, 'Created by the studio'), h('div', { class: 'muted small' }, 'Loading…'));
  get('/activity').then((a) => {
    recent.lastChild.remove();
    if (!a.artifacts.length) { recent.append(h('div', { class: 'muted small' }, 'Nothing yet. Items you create appear here with links to Fabric.')); return; }
    const t = h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Type'), h('th', {}, 'Created')));
    for (const x of a.artifacts.slice(0, 6)) t.append(h('tr', {}, h('td', {}, x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener' }, x.name) : x.name), h('td', {}, x.type), h('td', { class: 'muted' }, fmtDate(x.at))));
    recent.append(t);
  }).catch(() => {});

  el.append(h('div', { class: 'hero' }, h('div', { class: 'col', style: { gap: '14px' } }, hero, journey), h('div', { class: 'col', style: { gap: '14px' } }, ready, recent)));
}

function stepDetail(id, p) {
  if (id === 'workspace' && p.workspace) return p.workspace.name;
  if (id === 'data' && p.source) return p.source.label;
  if (id === 'model' && p.semanticModel) return `${p.semanticModel.name} · ${p.semanticModel.measures} measures`;
  if (id === 'ontology' && p.ontology) return `${p.ontology.name} · ${p.ontology.rules?.length || 0} rules`;
  if (id === 'reports' && p.reports?.length) return `${p.reports.length} report${p.reports.length === 1 ? '' : 's'} · ${p.reports[0].name}`;
  if (id === 'ai' && store.provider) return `${store.provider.name}${store.provider.model ? ` · ${store.provider.model}` : ''}`;
  return '';
}

function nextPrompt(step, p) {
  switch (step) {
    case 'ai': return 'Check that you can reach my Fabric workspaces and summarize what you can do for me.';
    case 'workspace': return 'List my Fabric capacities and help me create a new workspace for this project.';
    case 'data': return 'Help me choose a data source: load the Contoso Retail sample, or show me the lakehouses and connections I could use.';
    case 'model': return 'Describe my data, propose a star schema with business measures, and create the semantic model.';
    case 'ontology': return 'Read my glossary and deploy an ontology with entities, relationships and business rules.';
    case 'reports': return 'Recommend the best Power BI report for my semantic model: read studio_describe_report_options, explain the pages and theme you would use and why, then build it with studio_create_report after I confirm.';
    default: return `Summarize what we built in workspace ${p.workspace?.name || ''} and answer a first business question with Fabric IQ.`;
  }
}
