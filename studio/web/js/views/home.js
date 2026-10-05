import { store } from '../api.js';
import { h, statusDot } from '../ui.js';
import { app } from '../app.js';
import { buildGraph, getNode, upstream, downstream, nodePrompt, icon, CAT, VIEW_LABEL } from '../lineage.js';
import { askCard } from '../prompts.js';
import { namingCard } from '../naming.js';
import { itemsTable, nodeRemoveActions } from '../artifacts.js';
import { modelsDialog } from '../models.js';
import { sourcesDialog } from '../sources.js';

// Overview: the solution map above shows every part; this page explains the selected one (or the suggested next
// step) and keeps the setup checks and the items the project has (with Remove) in one place.

export function renderHome(el) {
  const g = buildGraph();
  const sel = app.selectedNode?.();
  const n = (sel && getNode(g, sel)) || getNode(g, g.next || 'model');
  // Ask what the environment is for before anything is created; afterwards a one-line summary.
  el.append(h('div', { class: 'sheet' },
    inspector(g, n),
    g.signedIn ? namingCard({ compact: true }) : null,
    store.project?.semanticModel ? askCard({ title: 'Start asking', lead: `Questions from "${store.project.semanticModel.name}", your reports, rules, plan and live data. Select one and Copilot answers with the numbers.`, perGroup: 2 }) : null,
    h('div', { class: 'sheetrow' }, checksSection(), createdSection())));
}

function tint(el, cat) { el.style.setProperty('--nc', CAT[cat] || CAT.workspace); return el; }

function statePill(n) {
  if (n.state === 'running') return h('span', { class: 'pill brand' }, h('span', { class: 'spin' }), 'Working…');
  if (n.flag === 'blocked' && !n.done) return h('span', { class: 'pill err' }, 'Can\'t run right now');
  if (n.state === 'failed') return h('span', { class: 'pill err' }, 'Last run didn\'t finish');
  if (n.done) return h('span', { class: `pill ${n.flag === 'blocked' ? 'warn' : 'ok'}` }, n.flag === 'blocked' ? 'Configured · changes paused' : '✓ Configured');
  if (n.flag === 'limited') return h('span', { class: 'pill warn' }, 'Ready · with limits');
  if (n.state === 'available') return h('span', { class: 'pill brand' }, 'Ready to set up');
  return h('span', { class: 'pill' }, n.needs || 'Not available yet');
}

function inspector(g, n) {
  const isWs = n.id === 'workspace';
  const signedIn = g.signedIn;
  const head = h('div', { class: 'ihead' },
    h('span', { class: 'iic', html: icon(n.icon) }),
    h('div', { class: 'iti' },
      h('div', { class: 'ity' }, n.type, n.next ? h('span', { class: 'inext' }, 'Suggested next') : null),
      h('h2', {}, n.title),
      h('p', {}, n.desc)),
    statePill(n));

  // Left: what it is (facts), or how to start.
  let left;
  if (n.id === 'source' && !n.done && n.state !== 'off') left = startPaths();
  else if ((n.facts || []).filter(Boolean).length) {
    left = h('dl', { class: 'ifacts' }, n.facts.filter(Boolean).flatMap(([k, v, href]) => [
      h('dt', {}, k),
      h('dd', {}, href ? h('a', { href, target: '_blank', rel: 'noopener' }, String(v ?? '–')) : String(v ?? '–'))]));
  } else {
    left = h('p', { class: 'small muted', style: { margin: 0 } }, n.state === 'off'
      ? `${n.needs}. Parts light up on the map as they are configured – set up the earlier ones first.`
      : isWs ? 'Everything the studio builds is created in one Fabric workspace on a capacity. Create a new one or use one you already have.'
        : 'Not configured yet. Open it to set it up with a quick action, or let Copilot do it with your approval.');
  }

  // Middle: how it connects to the rest.
  const chips = (list) => h('div', { class: 'ichips' }, list.map((x) => tint(h('button', { type: 'button', class: `ichip ${x.state}`, onclick: () => app.selectNode(x.id), title: `${x.type}: ${x.status}` },
    h('span', { class: 'ici', html: icon(x.icon) }), x.type), x.cat)));
  const from = isWs ? [] : upstream(g, n.id);
  const to = isWs ? [] : downstream(g, n.id);
  const deps = h('div', { class: 'ideps' },
    from.length ? [h('div', { class: 'ilbl' }, 'Built from'), chips(from)] : null,
    to.length ? [h('div', { class: 'ilbl' }, 'Feeds'), chips(to)] : null,
    isWs ? [h('div', { class: 'ilbl' }, 'Contains'), h('p', { class: 'small muted', style: { margin: 0 } }, 'OneLake data, the semantic model, the ontology, reports, the plan and the real-time items.')] : null);

  // Right: what to do.
  const acts = h('div', { class: 'iact' });
  if (!signedIn) {
    acts.append(h('button', { class: 'btn pri', onclick: () => document.getElementById('userChip').click() }, 'Sign in to Microsoft Fabric'));
  } else {
    acts.append(h('button', { class: `btn ${n.done || n.state === 'off' ? '' : 'pri'}`, onclick: () => app.go(n.view) }, n.done ? `Open ${VIEW_LABEL[n.view]}` : `Set up in ${VIEW_LABEL[n.view]}`, ' ›'));
    if (n.state !== 'off') acts.append(h('button', { class: 'btn ai', onclick: () => app.ask(nodePrompt(n.id), { view: n.view }) }, n.done ? '✦ Ask Copilot about it' : '✦ Let Copilot do it'));
    if (n.id === 'model' && store.project?.workspace) acts.append(h('button', { class: 'btn', title: 'Or double-click Semantic model on the map', onclick: () => modelsDialog() }, (store.project.semanticModels || []).length > 1 ? `⇄ Switch model (${store.project.semanticModels.length})` : '⇄ Switch or add a model'));
    if (n.id === 'source' && store.project?.workspace && (store.project.sources || []).length > 1) acts.append(h('button', { class: 'btn', title: 'Or double-click Data source on the map', onclick: () => sourcesDialog() }, `⇄ Switch data source (${store.project.sources.length})`));
    if (n.url) acts.append(h('a', { class: 'btn ghost', href: n.url, target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗'));
    // Remove what this part built – disabled while something else uses it.
    if (n.done || isWs) acts.append(nodeRemoveActions(n.id));
  }

  const why = n.reason && (n.flag === 'blocked' || n.flag === 'limited')
    ? h('div', { class: `banner ${n.flag === 'blocked' ? 'err' : 'warn'} mt`, style: { marginBottom: 0 } }, h('div', {}, h('b', {}, n.reason.text), n.reason.fix ? h('div', { class: 'tiny muted' }, n.reason.fix) : null))
    : n.state === 'failed' ? h('div', { class: 'banner err mt', style: { marginBottom: 0 } }, h('div', {}, h('b', {}, 'The last run didn\'t finish. '), n.error || '')) : null;

  const insp = h('section', { class: `insp ${n.state}`, 'aria-live': 'polite' }, head, h('div', { class: 'ibody' }, h('div', { class: 'ileft' }, left), deps, acts), why);
  return tint(insp, n.cat);
}

function startPaths() {
  const path = (ico, title, text, onClick) => h('button', { type: 'button', class: 'path', onclick: onClick }, h('span', { class: 'pic', html: icon(ico) }), h('b', {}, title), h('span', { class: 'tiny muted' }, text));
  return h('div', { class: 'paths' },
    path('sample', 'Start from sample data', 'Contoso Retail, or AdventureWorksDW2022 as a Fabric SQL database.', () => app.go('data')),
    path('mirror', 'Connect my databases', 'Azure SQL, SQL Managed Instance, SQL Server or PostgreSQL via Mirroring.', () => app.go('data')),
    path('lake', 'Use my Fabric data', 'Lakehouses, warehouses or mirrored databases, in place or with shortcuts.', () => app.go('data')),
    path('answers', 'Just ask Copilot', 'Describe your business and let Copilot drive each step with your approval.', () => app.ask(nodePrompt('source'), { view: 'data' })));
}

function checksSection() {
  const hc = store.health;
  const rd = store.readiness;
  const list = h('div', { class: 'checks' });
  const line = (c) => h('div', { class: 'check' }, statusDot(c.status === 'unknown' ? 'info' : c.status), h('div', {}, h('b', {}, c.label), h('span', { class: 'muted' }, ` · ${c.detail}`), c.fix ? h('div', { class: 'fx' }, c.fix) : null));
  if (!hc) list.append(h('div', { class: 'row muted small' }, h('span', { class: 'spin' }), 'Checking your setup…'));
  else list.append(...hc.checks.map(line));
  if (rd) list.append(...rd.checks.filter((x) => x.status !== 'ok').map(line));
  const blocked = rd ? Object.values(rd.modules).filter((m) => m.status === 'blocked').length : 0;
  const ok = hc?.ready && !blocked;
  return h('section', {},
    h('div', { class: 'row sp' }, h('h3', {}, 'Setup checks'), hc ? h('span', { class: `pill ${ok ? 'ok' : 'err'}` }, ok ? 'Ready' : 'Action needed') : null),
    list,
    h('button', { class: 'btn ghost mt', onclick: () => app.showHealth?.(true) }, '✓ Run the full setup check'));
}

function createdSection() {
  // Everything the project built, what uses each item, and Remove (disabled while something uses it).
  return h('section', {}, h('div', { class: 'row sp' }, h('h3', {}, 'Items in this project'), h('button', { class: 'btn ghost', onclick: () => app.go('activity') }, 'Activity ›')), itemsTable());
}
