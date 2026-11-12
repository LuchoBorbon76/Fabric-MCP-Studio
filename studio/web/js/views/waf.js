import { get, store } from '../api.js';
import { h, toast, busy, fmtDate } from '../ui.js';
import { app } from '../app.js';

let state = null;
let activeTab = 'visuals';

const num = (v) => Number.isFinite(Number(v)) ? Number(v).toLocaleString() : '–';
const scoreClass = (s) => s >= 90 ? 'ok' : s >= 75 ? 'brand' : s >= 60 ? 'warn' : 'err';
const sevClass = (s) => ({ critical: 'err', high: 'err', medium: 'warn', low: 'brand', unknown: 'warn', info: '' })[s] || '';
const GOVERNANCE_KEYWORDS = /\b(governance|business\s*rules?|compliance|policy|risk|control|controls|waf|well-architected)\b/i;

async function load({ fresh = false } = {}) {
  if (state && !fresh) return state;
  state = await get(`/waf${fresh ? '?refresh=1' : ''}`);
  return state;
}

function isGovernanceReport(report) {
  const pages = Array.isArray(report?.pages) ? report.pages.map((p) => String(p || '').trim().toLowerCase()) : [];
  if (pages.includes('business rules') || pages.includes('governance')) return true;
  return GOVERNANCE_KEYWORDS.test(String(report?.name || ''));
}

function reportInventory() {
  const p = store.project || {};
  const own = (Array.isArray(p.reports) ? p.reports : []).map((r) => ({ ...r, origin: r.existing ? 'linked-model' : 'studio' }));
  const linkedFromModels = (p.semanticModels || []).flatMap((m) => (m?.linked?.reports || []).map((r) => ({ ...r, semanticModelId: m.id })));
  const linkedFromActive = (p.semanticModel?.linked?.reports || []).map((r) => ({ ...r, semanticModelId: p.semanticModel?.id || null }));
  const linkedRaw = linkedFromModels.length ? linkedFromModels : linkedFromActive;
  const linked = linkedRaw
    .filter((r) => r.type !== 'PaginatedReport')
    .map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      pages: [],
      semanticModelId: r.semanticModelId || null,
      existing: true,
      origin: 'linked-model',
    }));
  const workspace = (Array.isArray(state?.workspaceReports) ? state.workspaceReports : [])
    .filter((r) => r.type !== 'PaginatedReport')
    .map((r) => ({
      id: r.id,
      name: r.name,
      pages: [],
      existing: true,
      origin: 'workspace',
    }));
  const all = [...new Map([...own, ...linked, ...workspace].map((r) => [r.id, r])).values()];
  const governance = all.filter(isGovernanceReport);
  const shown = governance.length ? governance : all;
  const studioCount = shown.filter((r) => r.origin === 'studio').length;
  const linkedCount = shown.filter((r) => r.origin === 'linked-model').length;
  const workspaceCount = shown.filter((r) => r.origin === 'workspace').length;
  return {
    all,
    governance,
    shown,
    fallbackAll: !governance.length && all.length > 0,
    inApp: shown.filter((r) => (p.orgApp?.reports || []).includes(r.id)).length,
    ownCount: shown.filter((r) => !r.existing).length,
    existingCount: shown.filter((r) => r.existing).length,
    studioCount,
    linkedCount,
    workspaceCount,
  };
}

function governanceAssets() {
  const p = store.project || {};
  const inv = reportInventory();
  return h('div', { class: 'card' },
    h('div', { class: 'row sp' },
      h('h2', {}, 'Governance assets'),
      h('span', { class: 'pill brand' }, `${inv.shown.length} report${inv.shown.length === 1 ? '' : 's'}`)),
    h('p', { class: 'lead' }, 'Governance visuals and reports discovered from this project/model context.'),
    inv.fallbackAll ? h('div', { class: 'banner warn', style: { marginBottom: '10px' } }, 'No report name/page explicitly matches governance keywords, so all discovered model reports are shown to avoid hiding existing visuals.') : null,
    inv.shown.length
      ? h('div', { class: 'chips' },
        inv.shown.slice(0, 10).map((r) => h('span', { class: 'pill' }, r.name)),
        inv.shown.length > 10 ? h('span', { class: 'pill' }, `+${inv.shown.length - 10} more`) : null)
      : h('div', { class: 'empty' }, 'No governance-focused reports are built yet. Build one in Reports & apps.'),
    h('div', { class: 'tiny muted mt' }, `${inv.studioCount} built by Studio · ${inv.linkedCount} linked to semantic models · ${inv.workspaceCount} discovered in workspace · ${inv.inApp} currently in Org app`),
    h('div', { class: 'row mt' },
      h('button', { class: 'btn', onclick: () => app.go('reports') }, 'Open Reports & apps'),
      p.orgApp
        ? h('span', { class: 'tiny muted' }, `${inv.inApp} of ${inv.shown.length} shown report${inv.shown.length === 1 ? '' : 's'} are in ${p.orgApp.name}.`)
        : h('span', { class: 'tiny muted' }, 'Create an org app to publish governance reports in a dedicated app section.')));
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

function tabButton(el, id, label) {
  const on = activeTab === id;
  return h('button', {
    class: `btn ${on ? 'pri' : ''}`,
    onclick: () => {
      if (activeTab === id) return;
      activeTab = id;
      renderWaf(el, { fresh: false });
    },
  }, label);
}

function fixButton(f) {
  if (f.fixLink) return h('a', { class: 'btn', href: f.fixLink, target: '_blank', rel: 'noopener' }, f.fixLabel || 'Open fix ↗');
  if (f.fixTarget?.view) return h('button', { class: 'btn', onclick: () => app.go(f.fixTarget.view) }, f.fixLabel || `Open ${f.fixTarget.view}`);
  return null;
}

function header(el, s) {
  const refresh = h('button', { class: 'btn pri', 'data-busy': 'Generating…' }, 'Generate WAF review');
  refresh.addEventListener('click', busy(refresh, async () => { state = null; await renderWaf(el, { fresh: true }); }));
  const html = h('button', { class: 'btn', 'data-busy': 'Exporting…' }, 'Download HTML');
  html.addEventListener('click', busy(html, () => downloadReport('html')));
  const md = h('button', { class: 'btn', 'data-busy': 'Exporting…' }, 'Download Markdown');
  md.addEventListener('click', busy(md, () => downloadReport('markdown')));
  el.append(h('div', { class: 'card' },
    h('div', { class: 'row sp' },
      h('div', {},
        h('h1', {}, 'Governance'),
        h('p', { class: 'lead' }, 'Governance visuals and controls for the selected project, with WAF scoring available in its own tab.'))),
    h('div', { class: 'row' }, tabButton(el, 'visuals', 'Governance visuals'), tabButton(el, 'waf', 'WAF review')),
    h('div', { class: 'row mt' }, refresh, html, md, s.scope?.workspace ? h('a', { class: 'btn ghost', href: `https://app.fabric.microsoft.com/groups/${s.scope.workspace.id}/list`, target: '_blank', rel: 'noopener' }, 'Open workspace ↗') : null),
    h('div', { class: 'grid g4 mt' },
      kpi('Overall score', `${s.overallScore}/100`, s.overallLabel, scoreClass(s.overallScore) === 'err' ? 'bad' : scoreClass(s.overallScore) === 'warn' ? 'warn' : ''),
      kpi('Recommendations', num(s.recommendations.length), 'Material findings to address first'),
      kpi('Workspace items', num(s.inventory.workspaceItems), 'Visible Fabric artifacts'),
      kpi('Fix paths', `${s.fixSummary.guided + s.fixSummary.auto} guided`, `${s.fixSummary.admin} admin · ${s.fixSummary.manual} manual`)),
    h('div', { class: 'tiny muted mt' }, `Last generated ${fmtDate(s.at)}${s.scope?.workspace?.name ? ` · ${s.scope.workspace.name}` : ''}`)));
}

function pillarCards(s) {
  return h('div', { class: 'grid waf-pillars' }, s.pillars.map((p) => h('div', { class: 'card compact' },
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
  return h('div', { class: 'card waf-recommendations' },
    h('div', { class: 'row sp actiontitle' },
      h('div', {}, h('h2', {}, 'What to fix first'), h('p', { class: 'lead' }, 'Findings are evidence-backed and marked as guided, manual or admin fixes. Use the buttons to jump to the right place when the Studio can help.')),
      h('span', { class: 'pill' }, `${s.recommendations.length} recommendation${s.recommendations.length === 1 ? '' : 's'}`)),
    s.recommendations.length ? h('div', { class: 'actiongrid' }, s.recommendations.map(recommendationCard)) : h('div', { class: 'empty' }, 'No material WAF recommendations found for the current scope.'));
}

function domains(s) {
  return h('div', { class: 'card waf-domain-card' },
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
  return h('div', { class: 'grid g2 waf-inventory' },
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

function governanceOverview(s) {
  const weakest = [...(s.domains || [])].sort((a, b) => a.score - b.score).slice(0, 5);
  return h('div', { class: 'grid g2' },
    h('div', { class: 'card' },
      h('h2', {}, 'Governance posture'),
      h('p', { class: 'lead' }, 'Lowest-scoring control domains from the current Fabric governance check.'),
      table([
        { label: 'Domain', render: (r) => h('b', {}, r.label) },
        { label: 'Score', num: true, render: (r) => h('span', { class: `pill ${scoreClass(r.score)}` }, `${r.score}/100`) },
        { label: 'Top finding', key: 'topFinding' },
      ], weakest, 'No domain scores available yet. Generate a review first.')),
    h('div', { class: 'card' },
      h('h2', {}, 'Catalog coverage'),
      h('p', { class: 'lead' }, 'Signals discovered from OneLake/Fabric catalog and project metadata.'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Visible workspaces/items'), h('dd', {}, `${num(s.inventory.workspaceItems)} items`),
        h('dt', {}, 'Item types tracked'), h('dd', {}, num((s.inventory.itemTypes || []).length)),
        h('dt', {}, 'Tenant settings visibility'), h('dd', {}, s.inventory.tenantSettingsVisible ? 'Visible' : 'Not visible'),
        h('dt', {}, 'Domains visibility'), h('dd', {}, s.inventory.domainsVisible ? `${num(s.inventory.domains)} domain(s)` : 'Not visible'),
        h('dt', {}, 'Guided fixes available'), h('dd', {}, num(s.fixSummary.guided + s.fixSummary.auto)),
        h('dt', {}, 'Admin/manual fixes'), h('dd', {}, `${num(s.fixSummary.admin)} admin · ${num(s.fixSummary.manual)} manual`))));
}

export async function renderWaf(el, { fresh = true } = {}) {
  el.innerHTML = '';
  el.append(h('div', { class: 'card' }, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading Fabric inventory and generating WAF scores…')));
  try {
    const s = await load({ fresh });
    el.innerHTML = '';
    header(el, s);
    if (activeTab === 'visuals') {
      el.append(governanceAssets(), governanceOverview(s), inventory(s));
      return;
    }
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
