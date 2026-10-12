import { get } from '../api.js';
import { h, toast, busy, fmtDate } from '../ui.js';
import { app } from '../app.js';

let state = null;

const num = (v) => Number.isFinite(Number(v)) ? Number(v).toLocaleString() : '–';
const scoreClass = (s) => s >= 90 ? 'ok' : s >= 75 ? 'brand' : s >= 60 ? 'warn' : 'err';
const sevClass = (s) => ({ critical: 'err', high: 'err', medium: 'warn', low: 'brand', unknown: 'warn', info: '' })[s] || '';

async function load({ fresh = false } = {}) {
  if (state && !fresh) return state;
  state = await get(`/waf${fresh ? '?refresh=1' : ''}`);
  return state;
}

function kpi(title, value, note, kind = '') {
  return h('div', { class: `kpi ${kind}` }, h('div', { class: 'kl' }, title), h('div', { class: 'kvv' }, value), note ? h('div', { class: 'tiny muted' }, note) : null);
}

function table(cols, rows, empty = 'No rows') {
  if (!rows?.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'scroll' }, h('table', { class: 't' },
    h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label))),
    rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : r[c.key]))))));
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function downloadReport(format) {
  const text = await get(`/waf/report?format=${encodeURIComponent(format)}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  download(`fabric-waf-review-${stamp}.${format === 'html' ? 'html' : 'md'}`, text, format === 'html' ? 'text/html' : 'text/markdown');
  toast(`${format === 'html' ? 'HTML' : 'Markdown'} WAF report downloaded`, 'ok');
}

function fixButton(f) {
  if (f.fixLink) return h('a', { class: 'btn', href: f.fixLink, target: '_blank', rel: 'noopener' }, f.fixLabel || 'Open fix ↗');
  if (f.fixTarget?.view) return h('button', { class: 'btn', onclick: () => app.go(f.fixTarget.view) }, f.fixLabel || `Open ${f.fixTarget.view}`);
  return null;
}

function header(el, s) {
  const refresh = h('button', { class: 'btn pri', 'data-busy': 'Generating…' }, 'Generate WAF review');
  refresh.addEventListener('click', busy(refresh, async () => { state = null; await renderWaf(el); }));
  const html = h('button', { class: 'btn', 'data-busy': 'Exporting…' }, 'Download HTML');
  html.addEventListener('click', busy(html, () => downloadReport('html')));
  const md = h('button', { class: 'btn', 'data-busy': 'Exporting…' }, 'Download Markdown');
  md.addEventListener('click', busy(md, () => downloadReport('markdown')));
  el.append(h('div', { class: 'card' },
    h('div', { class: 'row sp' },
      h('div', {},
        h('h1', {}, 'Fabric Well-Architected Review'),
        h('p', { class: 'lead' }, 'Read-only assessment of the selected Fabric landing zone against reliability, security, cost optimization, operational excellence and performance efficiency.'))),
    h('div', { class: 'row' }, refresh, html, md, s.scope?.workspace ? h('a', { class: 'btn ghost', href: `https://app.fabric.microsoft.com/groups/${s.scope.workspace.id}/list`, target: '_blank', rel: 'noopener' }, 'Open workspace ↗') : null),
    h('div', { class: 'grid g4 mt' },
      kpi('Overall score', `${s.overallScore}/100`, s.overallLabel, scoreClass(s.overallScore) === 'err' ? 'bad' : scoreClass(s.overallScore) === 'warn' ? 'warn' : ''),
      kpi('Recommendations', num(s.recommendations.length), 'Material findings to address first'),
      kpi('Workspace items', num(s.inventory.workspaceItems), 'Visible Fabric artifacts'),
      kpi('Fix paths', `${s.fixSummary.guided + s.fixSummary.auto} guided`, `${s.fixSummary.admin} admin · ${s.fixSummary.manual} manual`)),
    h('div', { class: 'tiny muted mt' }, `Last generated ${fmtDate(s.at)}${s.scope?.workspace?.name ? ` · ${s.scope.workspace.name}` : ''}`)));
}

function pillarCards(s) {
  return h('div', { class: 'grid g3' }, s.pillars.map((p) => h('div', { class: 'card compact' },
    h('div', { class: 'row sp' }, h('h2', {}, p.label), h('span', { class: `pill ${scoreClass(p.score)}` }, `${p.score}/100`)),
    h('p', { class: 'lead' }, p.focus),
    h('div', { class: 'rbar' }, h('i', { style: { width: `${p.score}%` } })),
    h('p', { class: 'small muted' }, p.topFinding))));
}

function recommendationCard(f, i) {
  return h('div', { class: 'actioncard' },
    h('div', { class: 'ahead' }, h('span', { class: 'anum' }, i + 1), h('span', { class: `pill ${sevClass(f.severity)}` }, f.severityLabel), h('span', { class: 'pill' }, f.pillarLabel), h('span', { class: 'pill' }, f.domainLabel)),
    h('b', {}, f.title),
    h('p', {}, f.detail),
    h('p', {}, h('b', {}, 'Recommendation: '), f.recommendation),
    f.evidence?.length ? h('details', {}, h('summary', { class: 'tiny muted' }, `Evidence (${f.evidence.length})`), h('ul', { class: 'pre' }, f.evidence.map((e) => h('li', {}, e)))) : null,
    h('div', { class: 'row' }, h('span', { class: 'pill brand' }, `Fix: ${f.fixType}`), fixButton(f)));
}

function recommendations(s) {
  return h('div', { class: 'card' },
    h('div', { class: 'row sp actiontitle' },
      h('div', {}, h('h2', {}, 'What to fix first'), h('p', { class: 'lead' }, 'Findings are evidence-backed and marked as guided, manual or admin fixes. Use the buttons to jump to the right place when the Studio can help.')),
      h('span', { class: 'pill' }, `${s.recommendations.length} recommendation${s.recommendations.length === 1 ? '' : 's'}`)),
    s.recommendations.length ? h('div', { class: 'actiongrid' }, s.recommendations.map(recommendationCard)) : h('div', { class: 'empty' }, 'No material WAF recommendations found for the current scope.'));
}

function domains(s) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Control domains'),
    h('p', { class: 'lead' }, 'Fabric-specific surfaces behind the WAF score: tenant settings, workspaces, domains, roles, capacity/costs, security, monitoring, reliability, performance and artifacts.'),
    table([
      { label: 'Domain', render: (r) => h('b', {}, r.label) },
      { label: 'Score', num: true, render: (r) => h('span', { class: `pill ${scoreClass(r.score)}` }, `${r.score}/100`) },
      { label: 'Status', key: 'status' },
      { label: 'Top finding', key: 'topFinding' },
    ], s.domains));
}

function inventory(s) {
  return h('div', { class: 'grid g2' },
    h('div', { class: 'card' },
      h('h2', {}, 'Inventory summary'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Workspace items'), h('dd', {}, num(s.inventory.workspaceItems)),
        h('dt', {}, 'Project artifacts'), h('dd', {}, num(s.inventory.projectArtifacts)),
        h('dt', {}, 'Semantic models'), h('dd', {}, num(s.inventory.semanticModels)),
        h('dt', {}, 'Data sources'), h('dd', {}, num(s.inventory.dataSources)),
        h('dt', {}, 'Role assignments'), h('dd', {}, num(s.inventory.roleAssignments)),
        h('dt', {}, 'Tenant settings'), h('dd', {}, s.inventory.tenantSettingsVisible ? 'Visible' : 'Not visible'),
        h('dt', {}, 'Domains'), h('dd', {}, s.inventory.domainsVisible ? num(s.inventory.domains) : 'Not visible'),
        h('dt', {}, 'Capacity Metrics'), h('dd', {}, s.inventory.capacityMetrics))),
    h('div', { class: 'card' },
      h('h2', {}, 'Item type mix'),
      table([{ label: 'Type', key: 'type' }, { label: 'Count', key: 'count', num: true }], s.inventory.itemTypes, 'No visible items in the workspace.')));
}

export async function renderWaf(el) {
  el.innerHTML = '';
  el.append(h('div', { class: 'card' }, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading Fabric inventory and generating WAF scores…')));
  try {
    const s = await load({ fresh: true });
    el.innerHTML = '';
    header(el, s);
    if (!s.scope?.workspace) {
      el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Choose a workspace first. '), 'The review will score the selected landing zone, its artifacts, capacity, access and tenant controls.')));
    }
    el.append(h('h2', { class: 'mt' }, 'Pillar scorecard'), pillarCards(s), recommendations(s), domains(s), inventory(s));
  } catch (e) {
    el.innerHTML = '';
    el.append(h('div', { class: 'banner err' }, e.message));
    toast(e.message, 'err');
  }
}
