import { get } from '../api.js';
import { h, toast, busy, fmtDate, input, select, initials } from '../ui.js';
import { md } from '../md.js';
import { app } from '../app.js';

let state = null;
const ui = {
  scopeMode: 'workspace',
  domain: 'all',
  itemType: 'all',
  search: '',
  selectedId: '',
  detailTab: 'overview',
  severity: 'all',
};
const SEARCH_COMMIT_MS = 550;

const num = (v) => Number.isFinite(Number(v)) ? Number(v).toLocaleString() : '–';
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const chart = (c) => h('div', { html: md(`\`\`\`studio-chart\n${JSON.stringify(c)}\n\`\`\``) });
const scoreClass = (s) => s >= 90 ? 'ok' : s >= 75 ? 'brand' : s >= 60 ? 'warn' : 'err';
const sevClass = (s) => ({ critical: 'err', high: 'err', medium: 'warn', low: 'brand', unknown: 'warn', info: '' })[s] || '';
const severityLabel = (s) => ({ critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unknown' })[s] || 'Info';
const severityKey = (s) => ['critical', 'high', 'medium', 'low', 'unknown'].includes(s) ? s : 'unknown';
const sevRank = (s) => ({ critical: 5, high: 4, medium: 3, low: 2, unknown: 1 }[severityKey(s)] || 0);
const fixTypeLabel = (t) => ({ auto: 'Auto fix', guided: 'Guided', manual: 'Manual', admin: 'Admin' }[t] || String(t || 'Unknown'));

const dateText = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? fmtDate(new Date(t)) : '';
};

async function load({ fresh = false } = {}) {
  if (state && !fresh) return state;
  const q = new URLSearchParams({ scope: ui.scopeMode });
  if (fresh) q.set('refresh', '1');
  state = await get(`/governance?${q.toString()}`);
  return state;
}

function kpi(title, value, note, kind = '') {
  return h('div', { class: `kpi ${kind}` }, h('div', { class: 'kl' }, title), h('div', { class: 'kvv' }, value), note ? h('div', { class: 'tiny muted' }, note) : null);
}

function miniStat(title, value, note, control = null) {
  return h('div', { class: 'card compact gov-mini' },
    h('h3', {}, title),
    h('div', { class: 'gov-mini-value' }, value),
    note ? h('div', { class: 'tiny muted' }, note) : null,
    control ? h('div', { class: 'mt' }, control) : null);
}

function table(cols, rows, empty = 'No rows') {
  if (!rows?.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'scroll' }, h('table', { class: 't' },
    h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label))),
    rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : r[c.key]))))));
}

function chartOrEmpty(cfg, emptyText = 'No data available for the current scope.') {
  if (Array.isArray(cfg.rows) && cfg.rows.length) return chart(cfg);
  return h('div', { class: 'chart gov-chart-empty' },
    h('div', { class: 'ctitle' }, cfg.title || 'Chart'),
    cfg.subtitle ? h('div', { class: 'csub' }, cfg.subtitle) : null,
    h('div', { class: 'empty' }, emptyText));
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
  const q = new URLSearchParams({ format, scope: ui.scopeMode });
  const text = await get(`/governance/report?${q.toString()}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  download(`fabric-onelake-governance-${stamp}.${format === 'html' ? 'html' : 'md'}`, text, format === 'html' ? 'text/html' : 'text/markdown');
  toast(`${format === 'html' ? 'HTML' : 'Markdown'} governance report downloaded`, 'ok');
}

function fixButton(f) {
  if (f.fixLink) return h('a', { class: 'btn', href: f.fixLink, target: '_blank', rel: 'noopener' }, f.fixLabel || 'Open fix ↗');
  if (f.fixTarget?.view) return h('button', { class: 'btn', onclick: () => app.go(f.fixTarget.view) }, f.fixLabel || `Open ${f.fixTarget.view}`);
  return null;
}

function normalizeItems(s) {
  const fallbackWorkspace = clean(s.scope?.workspace?.name || '');
  const rows = Array.isArray(s.inventory?.itemExplorer) ? s.inventory.itemExplorer : [];
  return rows.map((r, i) => ({
    id: String(r.id || `item-${i}`),
    name: clean(r.name || r.displayName || r.type || 'Item'),
    type: clean(r.type || r.itemType || 'Item'),
    owner: clean(r.owner || r.ownerName || r.createdBy || ''),
    location: clean(r.location || fallbackWorkspace),
    refreshedAt: r.refreshedAt || r.lastUpdatedDateTime || r.lastUpdated || '',
    description: clean(r.description || ''),
  })).filter((x) => x.name);
}

function itemAgeDays(item) {
  const t = Date.parse(item.refreshedAt || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function byType(items, predicate = () => true) {
  const m = new Map();
  for (const i of items) {
    if (!predicate(i)) continue;
    const k = i.type || 'Item';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
}

function byOwner(items) {
  const m = new Map();
  for (const i of items) {
    const k = i.owner || 'Unassigned';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
}

function severityMix(recs) {
  const keys = ['critical', 'high', 'medium', 'low', 'unknown'];
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const r of recs || []) {
    const k = keys.includes(r?.severity) ? r.severity : 'unknown';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return keys.map((key) => ({ key, label: severityLabel(key), count: counts.get(key) || 0 })).filter((x) => x.count > 0);
}

function insightsFor(s, items) {
  let withDescription = 0;
  let withOwner = 0;
  let refreshedLast30d = 0;
  let refreshed31to120d = 0;
  let refreshedOver120d = 0;
  let noRefreshSignal = 0;

  for (const i of items) {
    if (i.description) withDescription++;
    if (i.owner) withOwner++;
    const age = itemAgeDays(i);
    if (age === null) noRefreshSignal++;
    else if (age <= 30) refreshedLast30d++;
    else if (age <= 120) refreshed31to120d++;
    else refreshedOver120d++;
  }

  const selectedWorkspaces = Math.max(0, Number(s.inventory?.workspacesInScope || (s.scope?.workspace ? 1 : 0)));
  const mappedWorkspaces = Number(s.inventory?.workspacesAssignedToDomains ?? (Number(s.inventory?.workspaceDomainAssignments) > 0 ? 1 : 0));
  const withDomainAssignment = Math.max(0, Math.min(selectedWorkspaces, mappedWorkspaces));

  return {
    total: items.length,
    typeCount: new Set(items.map((x) => x.type)).size,
    withDescription,
    withoutDescription: Math.max(0, items.length - withDescription),
    withOwner,
    withoutOwner: Math.max(0, items.length - withOwner),
    refreshedLast30d,
    refreshed31to120d,
    refreshedOver120d,
    noRefreshSignal,
    typeMix: byType(items),
    missingDescriptionByType: byType(items, (i) => !i.description),
    missingOwnerByType: byType(items, (i) => !i.owner),
    staleByType: byType(items, (i) => {
      const age = itemAgeDays(i);
      return age === null || age > 120;
    }),
    ownerMix: byOwner(items),
    severity: severityMix(s.recommendations),
    assignedWorkspaces: withDomainAssignment,
    unassignedWorkspaces: Math.max(0, selectedWorkspaces - withDomainAssignment),
  };
}

function recommendationCard(f, i) {
  return h('div', { class: 'actioncard' },
    h('div', { class: 'ahead' }, h('span', { class: 'anum' }, i + 1), h('span', { class: `pill ${sevClass(f.severity)}` }, f.severityLabel), h('span', { class: 'pill' }, f.domainLabel)),
    h('b', {}, f.title),
    h('p', {}, f.detail),
    h('p', {}, h('b', {}, 'Recommendation: '), f.recommendation),
    f.evidence?.length ? h('details', {}, h('summary', { class: 'tiny muted' }, `Evidence (${f.evidence.length})`), h('ul', { class: 'pre' }, f.evidence.map((e) => h('li', {}, e)))) : null,
    h('div', { class: 'row' }, h('span', { class: 'pill brand' }, `Fix: ${f.fixType}`), fixButton(f)));
}

function recommendationsCard(recs, { title = 'What to fix first', subtitle = '', id = '' } = {}) {
  return h('div', { class: 'card gov-recommendations', id: id || undefined },
    h('div', { class: 'row sp actiontitle' },
      h('div', {}, h('h2', {}, title), subtitle ? h('p', { class: 'lead' }, subtitle) : null),
      h('span', { class: 'pill' }, `${recs.length} recommendation${recs.length === 1 ? '' : 's'}`)),
    recs.length ? h('div', { class: 'actiongrid' }, recs.map(recommendationCard)) : h('div', { class: 'empty' }, 'No recommendations match the current filters.'));
}

function recommendationQueue(recs) {
  const rows = recs.slice(0, 12).map((r, i) => ({
    priority: i + 1,
    severity: r.severity,
    severityLabel: r.severityLabel,
    title: r.title,
    recommendation: r.recommendation,
    domainLabel: r.domainLabel,
    fixType: r.fixType,
  }));
  return h('div', { class: 'card gov-queue', id: 'gov-priority-actions' },
    h('div', { class: 'row sp actiontitle' },
      h('div', {}, h('h2', {}, 'Priority action queue'), h('p', { class: 'lead' }, 'Fast, scan-friendly list to triage governance work by severity, domain, and remediation path.')),
      h('span', { class: 'pill' }, `${rows.length} visible`)),
    table([
      { label: '#' , key: 'priority', num: true },
      { label: 'Severity', render: (r) => h('span', { class: `pill ${sevClass(r.severity)}` }, r.severityLabel) },
      { label: 'Finding', render: (r) => h('div', { class: 'gov-queue-finding' }, h('b', {}, r.title), h('span', { class: 'small muted' }, r.recommendation)) },
      { label: 'Domain', key: 'domainLabel' },
      { label: 'Fix path', render: (r) => h('span', { class: 'pill brand' }, fixTypeLabel(r.fixType)) },
    ], rows, 'No recommendations match the current filter set.'));
}

function actionCenterSection(s, domains, recs, redraw) {
  const scopedRecs = filteredRecommendations(s, { includeSeverity: false });
  const sevMix = severityMix(scopedRecs);
  const highest = scopedRecs.length
    ? scopedRecs.reduce((best, cur) => (sevRank(cur.severity) > sevRank(best.severity) ? cur : best), scopedRecs[0]).severityLabel
    : 'None';
  const fixCounts = new Map([['auto', 0], ['guided', 0], ['manual', 0], ['admin', 0]]);
  for (const r of scopedRecs) fixCounts.set(r.fixType || 'manual', (fixCounts.get(r.fixType || 'manual') || 0) + 1);
  const fixRows = [...fixCounts.entries()].map(([type, count]) => ({ Type: fixTypeLabel(type), Findings: count })).filter((r) => r.Findings > 0);
  const domainRisk = new Map();
  for (const r of scopedRecs) domainRisk.set(r.domainLabel, (domainRisk.get(r.domainLabel) || 0) + 1);
  const domainRows = [...domainRisk.entries()].map(([Domain, Findings]) => ({ Domain, Findings })).sort((a, b) => b.Findings - a.Findings).slice(0, 10);
  const domainScoreRows = domains.map((d) => ({ Domain: d.label, Score: d.score }));
  const autoFix = fixCounts.get('auto') || 0;

  return h('section', { class: 'gov-section' },
    sectionHeader('Governance action center', 'Prioritize remediation using severity-first triage, domain risk concentration, and execution path clarity.'),
    h('div', { class: 'gov-focus-filters' },
      h('span', { class: 'gov-focus-label' }, 'Severity focus'),
      h('button', { type: 'button', class: `pill gov-pill-btn ${ui.severity === 'all' ? 'is-on brand' : ''}`, onclick: () => focusRecommendationDetails(redraw, 'all') }, `All ${scopedRecs.length}`),
      ...sevMix.map((x) => h('button', {
        type: 'button',
        class: `pill gov-pill-btn ${sevClass(x.key)} ${ui.severity === x.key ? 'is-on' : ''}`,
        'aria-pressed': ui.severity === x.key ? 'true' : 'false',
        onclick: () => focusRecommendationDetails(redraw, ui.severity === x.key ? 'all' : x.key),
      }, `${x.label} ${x.count}`))),
    h('div', { class: 'grid g4 gov-kpis' },
      kpi('Findings in scope', num(scopedRecs.length), 'Domain filter applied'),
      kpi('Findings in focus', num(recs.length), ui.severity === 'all' ? 'Showing all severities' : `Filtered to ${severityLabel(ui.severity)}`),
      kpi('Highest severity', highest, 'Current domain scope'),
      kpi('Auto-fix candidates', num(autoFix), 'Potential immediate remediation')),
    h('div', { class: 'grid g2 gov-chart-grid' },
      chartOrEmpty({ type: 'horizontalBar', title: 'Findings by severity', subtitle: 'Use to set triage order', x: 'Severity', y: ['Findings'], rows: sevMix.map((x) => ({ Severity: x.label, Findings: x.count })) }, 'No findings in current scope.'),
      chartOrEmpty({ type: 'horizontalBar', title: 'Findings by domain', subtitle: 'Risk concentration by governance area', x: 'Domain', y: ['Findings'], rows: domainRows, maxRows: 10 }, 'No domain-level findings in current scope.'),
      chartOrEmpty({ type: 'horizontalBar', title: 'Findings by remediation path', subtitle: 'Balance quick wins vs admin/manual work', x: 'Type', y: ['Findings'], rows: fixRows }, 'No remediation path data available.'),
      chartOrEmpty({ type: 'horizontalBar', title: 'Domain score profile', subtitle: 'Higher is healthier', x: 'Domain', y: ['Score'], rows: domainScoreRows }, 'No domain score data available.')),
    recommendationQueue(recs),
    recommendationsCard(recs.slice(0, 6), { title: 'Detailed recommendations', subtitle: 'Use this detail view after triage to execute each action.' }));
}

function domainsTable(domains) {
  return h('div', { class: 'card gov-domain-card' },
    h('h2', {}, 'Control domains'),
    h('p', { class: 'lead' }, 'OneLake-focused governance domains: tenant settings, workspaces, domains, roles/access, capacity/costs, security, monitoring, reliability, performance and catalog quality.'),
    table([
      { label: 'Domain', render: (r) => h('b', {}, r.label) },
      { label: 'Score', num: true, render: (r) => h('span', { class: `pill ${scoreClass(r.score)}` }, `${r.score}/100`) },
      { label: 'Status', key: 'status' },
      { label: 'Top finding', key: 'topFinding' },
    ], domains));
}

function inventoryCards(s) {
  const v = s.inventory;
  const scopeWorkspaces = Number(v.workspacesInScope || (s.scope?.workspace ? 1 : 0));
  const mappedWorkspaces = Number(v.workspacesAssignedToDomains ?? (v.workspaceDomainAssignments > 0 ? 1 : 0));
  return h('div', { class: 'grid g2 gov-inventory' },
    h('div', { class: 'card' },
      h('h2', {}, 'Catalog summary'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Scope'), h('dd', {}, s.scope?.mode === 'capacity' ? 'All workspaces in capacity' : 'Current workspace'),
        h('dt', {}, 'Scoped workspaces'), h('dd', {}, num(scopeWorkspaces)),
        h('dt', {}, 'Workspace items'), h('dd', {}, num(v.workspaceItems)),
        h('dt', {}, 'Data products'), h('dd', {}, num(v.dataProducts)),
        h('dt', {}, 'Data-product descriptions'), h('dd', {}, `${num(v.describedDataProducts)} (${num(v.catalogCoveragePct)}%)`),
        h('dt', {}, 'Lakehouses'), h('dd', {}, `${num(v.lakehouses)} · sampled ${num(v.lakehousesSampled)}`),
        h('dt', {}, 'Lakehouse tables'), h('dd', {}, num(v.lakehouseTables)),
        h('dt', {}, 'Lakehouses without tables'), h('dd', {}, num(v.lakehousesWithoutTables)),
        h('dt', {}, 'Source contexts'), h('dd', {}, num(v.sourceContexts)),
        h('dt', {}, 'Inactive contexts with assets'), h('dd', {}, num(v.inactiveSourcesWithAssets)),
        h('dt', {}, 'Domains visible'), h('dd', {}, v.domainsVisible ? `${num(v.domains)} (${num(mappedWorkspaces)}/${num(scopeWorkspaces)} workspaces mapped)` : 'Not visible'),
        h('dt', {}, 'Workspace read issues'), h('dd', {}, num(v.workspaceItemsPartialErrors?.length || 0)),
        h('dt', {}, 'Capacity Metrics'), h('dd', {}, v.capacityMetrics))),
    h('div', { class: 'card' },
      h('h2', {}, 'Lakehouse table coverage'),
      table([
        { label: 'Lakehouse', key: 'name' },
        { label: 'Tables', key: 'tables', num: true },
        { label: 'Note', render: (r) => r.error || 'OK' },
      ], v.lakehouseTableCoverage, 'No lakehouse table inventory available.')));
}

function filteredItems(items) {
  const q = clean(ui.search).toLowerCase();
  return items.filter((i) => {
    if (ui.itemType !== 'all' && i.type !== ui.itemType) return false;
    if (!q) return true;
    return [i.name, i.type, i.owner, i.location, i.description].join(' ').toLowerCase().includes(q);
  });
}

function filteredRecommendations(s, { includeSeverity = true } = {}) {
  let recs = ui.domain === 'all' ? s.recommendations : s.recommendations.filter((r) => r.domain === ui.domain);
  if (includeSeverity && ui.severity !== 'all') recs = recs.filter((r) => severityKey(r.severity) === ui.severity);
  return recs;
}

function focusRecommendationDetails(redraw, severity = 'all') {
  ui.severity = severity;
  redraw();
  requestAnimationFrame(() => {
    document.getElementById('gov-priority-actions')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function filteredDomains(s) {
  if (ui.domain === 'all') return s.domains;
  return s.domains.filter((d) => d.id === ui.domain);
}

function itemChecks(item, s) {
  const refreshed = dateText(item.refreshedAt);
  const scopedWorkspaces = Number(s.inventory?.workspacesInScope || (s.scope?.workspace ? 1 : 0));
  const mappedWorkspaces = Number(s.inventory?.workspacesAssignedToDomains ?? (Number(s.inventory?.workspaceDomainAssignments) > 0 ? 1 : 0));
  return [
    { label: 'Description', ok: Boolean(item.description), detail: item.description ? 'Present' : 'Missing description' },
    { label: 'Owner', ok: Boolean(item.owner), detail: item.owner || 'No explicit owner detected' },
    { label: 'Freshness', ok: Boolean(refreshed), detail: refreshed ? `Updated ${refreshed}` : 'No freshness timestamp exposed' },
    {
      label: 'Domain mapping',
      ok: Boolean(s.inventory.domainsVisible && mappedWorkspaces > 0),
      detail: s.inventory.domainsVisible
        ? (scopedWorkspaces > 1 ? `${num(mappedWorkspaces)}/${num(scopedWorkspaces)} scoped workspaces mapped` : `${num(s.inventory.workspaceDomainAssignments)} mapping(s) in visible domains`)
        : 'Domain inventory not visible with current permissions',
    },
  ];
}

function relatedRecommendations(item, recs) {
  const name = item.name.toLowerCase();
  const type = item.type.toLowerCase();
  const hits = recs.filter((r) => [r.title, r.detail, r.recommendation, ...(r.evidence || [])].join(' ').toLowerCase().includes(name)
      || [r.title, r.detail, r.recommendation].join(' ').toLowerCase().includes(type));
  return hits.slice(0, 4);
}

function explorerCard(s, items, recs, redraw, { title = 'Item explorer', subtitle = '' } = {}) {
  const rows = filteredItems(items);
  if (!rows.length) ui.selectedId = '';
  if (!rows.some((r) => r.id === ui.selectedId)) ui.selectedId = rows[0]?.id || '';
  const selected = rows.find((r) => r.id === ui.selectedId) || null;

  const list = h('div', { class: 'gov-item-list' },
    rows.length ? rows.map((it) => {
      const updated = dateText(it.refreshedAt);
      const b = h('button', { class: `gov-item ${ui.selectedId === it.id ? 'sel' : ''}` },
        h('span', { class: 'gov-item-avatar', title: it.owner || it.name }, initials(it.owner || it.name)),
        h('div', { class: 'gov-item-main' },
          h('b', {}, it.name),
          h('div', { class: 'gov-item-meta' }, it.owner || 'Owner not set', ' · ', it.location || 'Workspace'),
          h('div', { class: 'tiny muted' }, updated ? `Updated ${updated}` : 'No refresh timestamp')),
        h('span', { class: 'pill' }, it.type));
      b.addEventListener('click', () => { ui.selectedId = it.id; redraw(); });
      return b;
    }) : h('div', { class: 'gov-empty' }, 'No items match the selected filters.'));

  const detailTabs = h('div', { class: 'gov-detail-tabs' },
    ['overview', 'governance', 'actions'].map((tab) => {
      const label = tab[0].toUpperCase() + tab.slice(1);
      const b = h('button', { class: ui.detailTab === tab ? 'on' : '' }, label);
      b.addEventListener('click', () => { ui.detailTab = tab; redraw(); });
      return b;
    }));

  const detail = h('div', { class: 'gov-detail' },
    selected ? [
      h('div', { class: 'gov-detail-head' },
        h('div', {},
          h('h2', {}, selected.name),
          h('div', { class: 'row' }, h('span', { class: 'pill brand' }, selected.type), selected.owner ? h('span', { class: 'pill' }, selected.owner) : null)),
        s.scope?.workspace?.id ? h('a', { class: 'btn ghost', href: `https://app.fabric.microsoft.com/groups/${s.scope.workspace.id}/list`, target: '_blank', rel: 'noopener' }, 'Open workspace ↗') : null),
      detailTabs,
      ui.detailTab === 'overview'
        ? h('div', { class: 'gov-detail-pane' },
          h('dl', { class: 'kv' },
            h('dt', {}, 'Item type'), h('dd', {}, selected.type),
            h('dt', {}, 'Owner'), h('dd', {}, selected.owner || 'Not detected'),
            h('dt', {}, 'Workspace'), h('dd', {}, selected.location || 'Unknown'),
            h('dt', {}, 'Last refresh'), h('dd', {}, dateText(selected.refreshedAt) || 'Not available'),
            h('dt', {}, 'Description'), h('dd', {}, selected.description || 'No description yet')))
        : ui.detailTab === 'governance'
          ? h('div', { class: 'gov-detail-pane' },
            h('div', { class: 'gov-checks' }, itemChecks(selected, s).map((c) => h('div', { class: 'gov-check' }, h('span', { class: `pill ${c.ok ? 'ok' : 'warn'}` }, c.ok ? 'OK' : 'Needs action'), h('b', {}, c.label), h('span', { class: 'small muted' }, c.detail)))),
            h('h3', { class: 'mt' }, 'Related recommendations'),
            relatedRecommendations(selected, recs).length
              ? h('div', { class: 'gov-related' }, relatedRecommendations(selected, recs).map((r) => h('div', { class: 'gov-related-row' }, h('span', { class: `pill ${sevClass(r.severity)}` }, r.severityLabel), h('b', {}, r.title), h('span', { class: 'small muted' }, r.recommendation))))
              : h('div', { class: 'empty' }, 'No recommendation is directly tied to this item name/type.'))
          : h('div', { class: 'gov-detail-pane' },
            h('p', {}, 'Use these actions to continue remediation in the right area.'),
            h('div', { class: 'row' },
              h('button', { class: 'btn', onclick: () => app.go('workspace') }, 'Open workspace'),
              h('button', { class: 'btn', onclick: () => app.go('data') }, 'Open data'),
              h('button', { class: 'btn', onclick: () => app.go('settings') }, 'Open settings')),
            h('p', { class: 'small muted' }, 'For tenant-level or domain-level changes, use the Governance recommendations and Fabric admin portal links.')),
    ] : h('div', { class: 'gov-empty' }, 'Select an item to inspect details.'));

  return h('div', { class: 'card gov-explorer' },
    h('div', { class: 'gov-explorer-head' }, h('h2', {}, title), subtitle ? h('p', { class: 'lead' }, subtitle) : null),
    h('div', { class: 'gov-explorer-body' }, list, detail));
}

function headerCard(el, s, redraw) {
  const html = h('button', { class: 'btn', 'data-busy': 'Exporting…' }, 'Download HTML');
  html.addEventListener('click', busy(html, () => downloadReport('html')));
  const mdBtn = h('button', { class: 'btn', 'data-busy': 'Exporting…' }, 'Download Markdown');
  mdBtn.addEventListener('click', busy(mdBtn, () => downloadReport('markdown')));
  const canScopeCapacity = Boolean(s.scope?.workspace?.capacityId || s.scope?.capacity?.id || s.scope?.scopeCapacity?.id);
  if (!canScopeCapacity && ui.scopeMode === 'capacity') ui.scopeMode = 'workspace';
  const scopeSel = select([
    { value: 'workspace', label: 'Current workspace' },
    { value: 'capacity', label: 'All workspaces in this capacity', disabled: !canScopeCapacity },
  ]);
  scopeSel.value = ui.scopeMode;
  scopeSel.addEventListener('change', () => {
    const next = scopeSel.value === 'capacity' ? 'capacity' : 'workspace';
    if (next === ui.scopeMode) return;
    ui.scopeMode = next;
    ui.selectedId = '';
    state = null;
    renderGovernance(el);
  });

  const scopedRecs = filteredRecommendations(s, { includeSeverity: false });
  const mix = severityMix(scopedRecs);
  const score = Math.max(0, Math.min(100, Number(s.overallScore) || 0));
  const scopedWorkspaceCount = Number(s.scope?.workspacesInScope || s.inventory?.workspacesInScope || (s.scope?.workspace ? 1 : 0));
  const scopeLabel = ui.scopeMode === 'capacity'
    ? `Scope ${num(scopedWorkspaceCount)} workspaces in capacity`
    : `Scope ${s.scope?.workspace?.name || 'No workspace selected'}`;
  return h('div', { class: 'card gov-command' },
    h('div', { class: 'gov-headline' },
      h('div', { class: 'gov-head-main' },
        h('div', { class: 'tiny muted' }, 'All insights'),
        h('h1', {}, 'OneLake catalog governance'),
        h('p', { class: 'lead' }, 'Get an overview of the content in Fabric and identify actions to keep it organized, governed, and up to date.'),
        h('div', { class: 'gov-chipline' },
          h('span', { class: `pill ${scoreClass(s.overallScore)}` }, `Overall ${s.overallScore}/100 · ${s.overallLabel}`),
          h('span', { class: 'pill' }, scopeLabel),
          h('span', { class: 'pill' }, `Items ${num(s.inventory.workspaceItems)}`),
          h('span', { class: 'pill' }, `Data products ${num(s.inventory.dataProducts)}`),
          h('span', { class: 'pill' }, `Coverage ${num(s.inventory.catalogCoveragePct)}%`))),
      h('div', { class: 'gov-head-side' },
        h('div', { class: 'gov-ring-card' },
          h('div', { class: 'gov-ring', style: { '--score': String(score) } },
            h('div', { class: 'gov-ring-num' }, String(score)),
            h('div', { class: 'gov-ring-den' }, '/100')),
          h('div', { class: 'gov-ring-meta' },
            h('b', {}, s.overallLabel),
            h('span', { class: 'tiny muted' }, `Updated ${fmtDate(s.at)}`))),
        h('div', { class: 'gov-head-sev' },
          h('button', { type: 'button', class: 'gov-head-sev-title', title: 'Go to recommendation details', onclick: () => focusRecommendationDetails(redraw, 'all') }, 'Finding severity'),
          mix.length ? h('div', { class: 'gov-head-sev-list' }, mix.map((x) => {
            const active = ui.severity === x.key;
            return h('button', {
              type: 'button',
              class: `pill gov-pill-btn ${sevClass(x.key)} ${active ? 'is-on' : ''}`,
              'aria-pressed': active ? 'true' : 'false',
              title: `Show ${x.label.toLowerCase()} findings`,
              onclick: () => focusRecommendationDetails(redraw, active ? 'all' : x.key),
            }, `${x.label} ${x.count}`);
          })) : h('button', { type: 'button', class: 'pill gov-pill-btn ok', title: 'Go to recommendation details', onclick: () => focusRecommendationDetails(redraw, 'all') }, 'No material findings')))),
    h('div', { class: 'row gov-actions' },
      h('label', { class: 'gov-scope' }, h('span', { class: 'tiny muted' }, 'Scope'), scopeSel),
      html,
      mdBtn,
      s.scope?.workspace ? h('a', { class: 'btn ghost', href: `https://app.fabric.microsoft.com/groups/${s.scope.workspace.id}/list`, target: '_blank', rel: 'noopener' }, 'Open workspace ↗') : null));
}

function hierarchyNode(label, value) {
  return h('div', { class: 'gov-h-node' },
    h('div', { class: 'tiny muted' }, label),
    h('b', {}, value || 'All'));
}

function sectionHeader(title, text) {
  return h('div', { class: 'gov-section-head' }, h('h2', {}, title), h('p', { class: 'lead' }, text));
}

function estateSection(s, items, insights, redraw) {
  const domainOpts = [{ value: 'all', label: 'All domains' }, ...s.domains.map((d) => ({ value: d.id, label: d.label }))];
  const domainSel = select(domainOpts);
  domainSel.value = ui.domain;
  domainSel.addEventListener('change', () => { ui.domain = domainSel.value; redraw(); });

  const typeOpts = [{ value: 'all', label: 'All item types' }, ...[...new Set(items.map((i) => i.type))].sort().map((t) => ({ value: t, label: t }))];
  const typeSel = select(typeOpts);
  typeSel.value = ui.itemType;
  typeSel.addEventListener('change', () => { ui.itemType = typeSel.value; redraw(); });

  const searchBox = input({ placeholder: 'Search item, owner, type, or description…', value: ui.search });
  let searchTimer = 0;
  const commitSearch = () => {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = 0;
    }
    const next = searchBox.value;
    if (next === ui.search) return;
    ui.search = next;
    redraw();
  };
  searchBox.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(commitSearch, SEARCH_COMMIT_MS);
  });
  searchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitSearch();
    }
  });
  searchBox.addEventListener('blur', commitSearch);

  const filtered = filteredItems(items);
  const filteredTypeMix = byType(filtered).slice(0, 12).map((x) => ({ Type: x.type, Items: x.count }));
  const assignedRows = [
    { Status: 'Assigned', Workspaces: insights.assignedWorkspaces },
    { Status: 'Unassigned', Workspaces: insights.unassignedWorkspaces },
  ];
  const selectedName = filtered.find((i) => i.id === ui.selectedId)?.name || (ui.search ? `Matching "${ui.search}"` : 'Any item');
  const scopeWorkspaces = Number(s.inventory?.workspacesInScope || (s.scope?.workspace ? 1 : 0));
  const workspaceHierarchyLabel = s.scope?.mode === 'capacity'
    ? `All in capacity (${num(scopeWorkspaces)})`
    : (s.scope?.workspace?.name || 'Not selected');

  return h('section', { class: 'gov-section' },
    sectionHeader('Your data estate', 'Get an overview of your landing zone and drill into domains, workspaces, item types, and item names.'),
    h('div', { class: 'gov-estate-shell' },
      h('div', { class: 'gov-estate-left' },
        miniStat('Domains & subdomains', s.inventory.domainsVisible ? num(s.inventory.domains) : 'Not visible', s.inventory.domainsVisible ? `${num(s.inventory.workspacesAssignedToDomains ?? (s.inventory.workspaceDomainAssignments > 0 ? 1 : 0))}/${num(scopeWorkspaces)} workspaces mapped` : 'Needs admin visibility', domainSel),
        miniStat('Workspaces', num(scopeWorkspaces), s.scope?.mode === 'capacity' ? 'All workspaces in selected capacity' : (s.scope?.workspace?.name || 'No workspace selected')),
        miniStat('Items', num(filtered.length), `${num(insights.typeCount)} distinct item types in scope`, typeSel),
        miniStat('Find item', ui.search ? `"${ui.search}"` : 'Any', 'Filter by item, owner, type, or description. Applies after you pause typing or press Enter.', searchBox)),
      h('div', { class: 'card gov-estate-main' },
        h('h3', {}, 'Data hierarchy'),
        h('div', { class: 'gov-hierarchy' },
          hierarchyNode('Domain', ui.domain === 'all' ? 'All domains' : (s.domains.find((d) => d.id === ui.domain)?.label || 'Domain')),
          hierarchyNode('Subdomain', 'N/A'),
          hierarchyNode('Workspace', workspaceHierarchyLabel),
          hierarchyNode('Item type', ui.itemType === 'all' ? 'All types' : ui.itemType),
          hierarchyNode('Item name', selectedName)),
        h('div', { class: 'grid g2 gov-estate-charts' },
          chartOrEmpty({ type: 'horizontalBar', title: 'Items by type', subtitle: 'Current filtered scope', x: 'Type', y: ['Items'], rows: filteredTypeMix, maxRows: 12 }, 'No items available for this filter set.'),
          chartOrEmpty({ type: 'donut', title: 'Workspaces assigned to domains', subtitle: 'Domain stewardship signal', x: 'Status', y: 'Workspaces', rows: assignedRows })))));
}

function discoverSection(insights) {
  const descRows = [
    { Status: 'With description', Items: insights.withDescription },
    { Status: 'Without description', Items: insights.withoutDescription },
  ];
  const ownerRows = [
    { Status: 'With owner', Items: insights.withOwner },
    { Status: 'Without owner', Items: insights.withoutOwner },
  ];
  const missingDesc = insights.missingDescriptionByType.slice(0, 12).map((x) => ({ Type: x.type, Items: x.count }));
  const missingOwner = insights.missingOwnerByType.slice(0, 12).map((x) => ({ Type: x.type, Items: x.count }));

  return h('section', { class: 'gov-section' },
    sectionHeader('Discover, trust, and reuse', 'Increase discoverability and usage with stronger metadata, ownership, and stewardship signals.'),
    h('div', { class: 'grid g4 gov-kpis' },
      kpi('With description', num(insights.withDescription), `${num(Math.round((insights.withDescription / Math.max(1, insights.total)) * 100))}% coverage`),
      kpi('Without description', num(insights.withoutDescription), 'Primary metadata gap', insights.withoutDescription ? 'warn' : ''),
      kpi('With owner', num(insights.withOwner), `${num(Math.round((insights.withOwner / Math.max(1, insights.total)) * 100))}% ownership coverage`),
      kpi('Without owner', num(insights.withoutOwner), 'Stewardship follow-up', insights.withoutOwner ? 'warn' : '')),
    h('div', { class: 'grid g2 gov-chart-grid' },
      chartOrEmpty({ type: 'horizontalBar', title: 'Description coverage', subtitle: 'Use to track metadata completeness', x: 'Status', y: ['Items'], rows: descRows }),
      chartOrEmpty({ type: 'horizontalBar', title: 'Metadata gap by type', subtitle: 'Items without description', x: 'Type', y: ['Items'], rows: missingDesc, maxRows: 12 }, 'No metadata gaps in this scope.'),
      chartOrEmpty({ type: 'horizontalBar', title: 'Ownership coverage', subtitle: 'Use to track stewardship assignment', x: 'Status', y: ['Items'], rows: ownerRows }),
      chartOrEmpty({ type: 'horizontalBar', title: 'Owner gap by type', subtitle: 'Items without explicit owner', x: 'Type', y: ['Items'], rows: missingOwner, maxRows: 12 }, 'No owner gaps in this scope.'),
      chartOrEmpty({ type: 'horizontalBar', title: 'Top owners by item count', x: 'Owner', y: ['Items'], rows: insights.ownerMix.map((x) => ({ Owner: x.label, Items: x.value })), maxRows: 8 })));
}

function freshnessSection(insights, domains) {
  const freshnessBars = [
    { Range: 'Last 30 days', Items: insights.refreshedLast30d },
    { Range: '31-120 days', Items: insights.refreshed31to120d },
    { Range: '> 120 days', Items: insights.refreshedOver120d },
    { Range: 'No signal', Items: insights.noRefreshSignal },
  ];
  const staleByType = insights.staleByType.slice(0, 12).map((x) => ({ Type: x.type, Items: x.count }));

  return h('section', { class: 'gov-section' },
    sectionHeader('Freshness and reliability', 'Find stale assets, monitor refresh recency, and focus cleanup on the largest risk pockets.'),
    h('div', { class: 'grid g4 gov-kpis' },
      kpi('Refreshed last 30 days', num(insights.refreshedLast30d), 'Healthy freshness signal'),
      kpi('Refreshed 31-120 days', num(insights.refreshed31to120d), 'Watchlist'),
      kpi('Older than 120 days', num(insights.refreshedOver120d), 'Likely stale inventory', insights.refreshedOver120d ? 'warn' : ''),
      kpi('No refresh signal', num(insights.noRefreshSignal), 'Needs metadata/permissions follow-up', insights.noRefreshSignal ? 'warn' : '')),
    h('div', { class: 'grid g2 gov-chart-grid' },
      chartOrEmpty({ type: 'horizontalBar', title: 'Refresh recency distribution', subtitle: 'Prioritize stale and unknown assets first', x: 'Range', y: ['Items'], rows: freshnessBars }),
      chartOrEmpty({ type: 'horizontalBar', title: 'Potentially stale items by type', subtitle: 'Older than 120 days or without refresh signal', x: 'Type', y: ['Items'], rows: staleByType, maxRows: 12 }, 'No stale items detected in this scope.'),
      domainsTable(domains)));
}

function bodyCard(s, redraw) {
  const items = normalizeItems(s);
  const allTypes = new Set(items.map((i) => i.type));
  if (!allTypes.has(ui.itemType)) ui.itemType = 'all';
  const domainIds = new Set(['all', ...s.domains.map((d) => d.id)]);
  if (!domainIds.has(ui.domain)) ui.domain = 'all';
  const severityIds = new Set(['all', 'critical', 'high', 'medium', 'low', 'unknown']);
  if (!severityIds.has(ui.severity)) ui.severity = 'all';

  const filtered = filteredItems(items);
  const insights = insightsFor(s, filtered);
  const recs = filteredRecommendations(s);
  const domains = filteredDomains(s);

  return h('div', { class: 'gov-insights' },
    estateSection(s, items, insights, redraw),
    actionCenterSection(s, domains, recs, redraw),
    discoverSection(insights),
    freshnessSection(insights, domains),
    inventoryCards(s),
    explorerCard(s, items, recs, redraw, { title: 'Catalog item explorer', subtitle: 'Inspect item-level metadata, governance checks, and related recommendations.' }));
}

function draw(el, s) {
  const redraw = () => draw(el, s);
  el.innerHTML = '';
  el.append(headerCard(el, s, redraw));
  if (!s.scope?.workspace) {
    el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Choose a workspace first. '), 'The governance review scores the selected landing zone and OneLake catalog quality.')));
  }
  el.append(bodyCard(s, redraw));
}

export async function renderGovernance(el) {
  el.innerHTML = '';
  el.append(h('div', { class: 'card' }, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading Fabric inventory and generating OneLake governance scores…')));
  try {
    const s = await load({ fresh: true });
    draw(el, s);
  } catch (e) {
    el.innerHTML = '';
    el.append(h('div', { class: 'banner err' }, e.message));
    toast(e.message, 'err');
  }
}
