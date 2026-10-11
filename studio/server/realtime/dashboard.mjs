// Real-Time Dashboard (KQL Dashboard) definition generator: a live overview page and a business-rules page over the
// Eventhouse table the simulator (or any other app) streams into. Tiles adapt to the columns the scenario has.
import { stableUuid } from '../config.mjs';
import { kqlName, kqlString } from './kusto.mjs';

const GRID = 24;
const REFRESH_INTERVALS = [
  [1, '1s'], [10, '10s'], [30, '30s'], [60, '1m'], [300, '5m'], [900, '15m'],
  [1800, '30m'], [3600, '1h'], [7200, '2h'], [86400, '1d'],
];
function refreshInterval(seconds) {
  const s = Math.max(1, Number(seconds) || 30);
  return (REFRESH_INTERVALS.find(([n]) => s <= n) || REFRESH_INTERVALS.at(-1))[1];
}
function refreshText(interval) {
  return interval.replace(/^(\d+)s$/, '$1 seconds').replace(/^(\d+)m$/, '$1 minutes').replace(/^(\d+)h$/, '$1 hours').replace(/^(\d+)d$/, '$1 day');
}

/**
 * @param {object} o
 * @param {string} o.title dashboard title
 * @param {object} o.source { clusterUri, databaseId, databaseName, workspaceId }
 * @param {object} o.scenario { table, columns[], rules[], label, unit }
 * @param {number} [o.refreshSeconds]
 * @param {object} [o.medallion] the medallion layers (project realtime.medallion): tiles read deduplicated Silver data,
 *   trends and mixes come from the Gold per-minute view, and a "Medallion layers" page shows the flow and data quality.
 */
export function buildDashboard({ title, source, scenario, refreshSeconds = 30, medallion = null }) {
  const id = (...p) => stableUuid('rtd', title, ...p);
  const R = Object.fromEntries(scenario.columns.filter((c) => c.role).map((c) => [c.role, c]));
  const name = (role) => (R[role] ? kqlName(R[role].name) : null);
  const label = (role, fallback) => R[role]?.label || fallback;
  const T = name('time');
  const amount = name('amount');
  const amountLabel = label('amount', 'Value');
  const rule = name('rule');
  const order = name('order');
  const unitPlural = `${scenario.unit || 'event'}s`;
  const M = medallion?.names ? medallion : null;
  const perMinute = M?.gold?.find((g) => g.kind === 'perMinute') || null;
  const inGold = (role) => Boolean(perMinute && R[role] && perMinute.by.includes(R[role].name));
  const timeVars = ['_startTime', '_endTime'];
  const autoRefreshInterval = refreshInterval(refreshSeconds);
  const autoRefreshLabel = refreshText(autoRefreshInterval);

  const dsId = id('ds');
  const dataSources = [{
    kind: 'kusto-trident', scopeId: 'kusto-trident', clusterUri: source.clusterUri, database: source.databaseId,
    name: source.databaseName, id: dsId, workspace: source.workspaceId,
  }];
  const pages = [{ id: id('page', 'live'), name: 'Live overview' }];
  if (rule) pages.push({ id: id('page', 'rules'), name: 'Business rules' });
  if (M) pages.push({ id: id('page', 'layers'), name: 'Medallion layers' });
  const [live] = pages;
  const rulesPage = pages.find((x) => x.name === 'Business rules');
  const layersPage = pages.find((x) => x.name === 'Medallion layers');

  const queries = [];
  const tiles = [];
  const baseVar = '_events';
  const baseQueryId = id('q', 'base');
  queries.push({ id: baseQueryId, dataSource: { kind: 'inline', dataSourceId: dsId }, text: `${kqlName(M ? M.names.clean : scenario.table)}\n| where ${T} between (_startTime .. _endTime)`, usedVariables: ['_startTime', '_endTime'] });
  const baseQueries = [{ id: id('bq', 'base'), queryId: baseQueryId, variableName: baseVar }];

  const q = (key, text, vars = [baseVar]) => {
    const qid = id('q', key);
    queries.push({ id: qid, dataSource: { kind: 'inline', dataSourceId: dsId }, text, usedVariables: vars });
    return qid;
  };
  const tile = (page, key, title, visualType, layout, text, visualOptions = {}, vars) => {
    tiles.push({ id: id('tile', key), title, visualType, pageId: page.id, layout, queryRef: { kind: 'query', queryId: q(key, text, vars) }, visualOptions });
  };
  const markdown = (page, key, text, layout) => tiles.push({ id: id('tile', key), title: '', visualType: 'markdownCard', pageId: page.id, layout, markdownText: text, visualOptions: {} });
  const axes = (yLabel = '') => ({ multipleYAxes: { base: { id: '-1', label: yLabel, columns: [], yAxisMaximumValue: null, yAxisMinimumValue: null, yAxisScale: 'linear', horizontalLines: [] }, additional: [], showMultiplePanels: false } });
  const chart = (x, y, series = null, extra = {}) => ({
    ...axes(extra.yLabel), hideLegend: !series, legendLocation: 'bottom', xColumnTitle: extra.xTitle || '', xColumn: x, yColumns: y, seriesColumns: series,
    xAxisScale: 'linear', verticalLine: '', crossFilterDisabled: false, drillthroughDisabled: false, crossFilter: [], drillthrough: [],
    selectedDataOnLoad: { all: true, limit: 10 }, dataPointsTooltip: { all: true, limit: 5 },
  });
  const card = (rules = []) => ({ multiStat__textSize: 'auto', multiStat__valueColumn: null, colorRulesDisabled: !rules.length, colorRules: rules });
  const warnRule = (key, color = 'red', icon = 'warning') => ({
    id: id('rule', key), ruleType: 'colorByCondition', applyToColumn: null, hideText: false, applyTo: 'cells',
    conditions: [{ operator: '>', column: null, values: ['0'] }], chainingOperator: 'and', colorStyle: 'bold', color, tag: '', icon, ruleName: '', visualType: 'card',
  });
  const okRule = (key) => ({
    id: id('rule', key), ruleType: 'colorByCondition', applyToColumn: null, hideText: false, applyTo: 'cells',
    conditions: [{ operator: '==', column: null, values: ['0'] }], chainingOperator: 'and', colorStyle: 'bold', color: 'green', tag: '', icon: 'completed', ruleName: '', visualType: 'card',
  });
  // Totals by a dimension: from the Gold per-minute view when it has that dimension, else from the events.
  const by = (role, n = 10) => {
    if (!R[role]) return null;
    const agg = `| summarize ${kqlName(amountLabel)} = round(sum(${amount}), 2) by ${kqlName(label(role, role))} = ${name(role)}\n| top ${n} by ${kqlName(amountLabel)} desc`;
    return inGold(role) ? [`${kqlName(perMinute.name)}\n| where ${T} between (_startTime .. _endTime)\n${agg}`, timeVars] : [`${baseVar}\n${agg}`];
  };

  // ---- page 1: live overview ----
  const desc = M
    ? `Live events in **${md(source.databaseName)}** · checked and deduplicated in **${md(M.names.clean)}** (Silver), trends from **${md(perMinute?.name || M.names.clean)}** (Gold) · refreshes every ${autoRefreshLabel} · change the time range at the top`
    : `Live events in **${md(source.databaseName)}** · table **${md(scenario.table)}** · refreshes every ${autoRefreshLabel} · change the time range at the top`;
  markdown(live, 'header', `## ${md(title)}\n${desc}`, { x: 0, y: 0, width: GRID, height: 3 });
  const cards = [
    order ? ['orders', R.order.role === 'order' && scenario.unit === 'sales line' ? 'Orders' : `${unitPlural[0].toUpperCase()}${unitPlural.slice(1)}`, `${baseVar}\n| summarize Value = ${scenario.unit === 'sales line' ? `dcount(${order})` : 'count()'}`] : null,
    ['amount', amountLabel, `${baseVar}\n| summarize Value = round(sum(${amount}), 0)`],
    R.margin ? ['margin', 'Margin (%)', `${baseVar}\n| summarize m = sum(${name('margin')}), a = sum(${amount})\n| project Value = iff(a == 0, 0.0, round(100.0 * m / a, 1))`] : null,
    scenario.unit === 'sales line' && order ? ['aov', 'Average order', `${baseVar}\n| summarize a = sum(${amount}), n = dcount(${order})\n| project Value = iff(n == 0, 0.0, round(a / n, 2))`] : ['avg', `Average ${amountLabel.toLowerCase()}`, `${baseVar}\n| summarize Value = round(coalesce(avg(${amount}), 0.0), 2)`],
    rule ? ['breaks', 'Rule breaks', `${baseVar}\n| where isnotempty(${rule})\n| summarize Value = count()`] : null,
  ].filter(Boolean);
  const w = Math.floor(GRID / cards.length);
  cards.forEach(([key, t, text], i) => tile(live, `card-${key}`, t, 'card', { x: i * w, y: 3, width: i === cards.length - 1 ? GRID - w * i : w, height: 3 }, text, card(key === 'breaks' ? [warnRule('breaks'), okRule('breaks-ok')] : [])));

  const perMinuteSrc = inGold('channel') || (perMinute && !R.channel) ? `${kqlName(perMinute.name)}\n| where ${T} between (_startTime .. _endTime)` : baseVar;
  const trend = R.channel
    ? `${perMinuteSrc}\n| summarize ${kqlName(amountLabel)} = round(sum(${amount}), 2) by bin(${T}, 1m), ${kqlName(label('channel', 'Channel'))} = ${name('channel')}\n| order by ${T} asc`
    : `${perMinuteSrc}\n| summarize ${kqlName(amountLabel)} = round(sum(${amount}), 2) by bin(${T}, 1m)\n| order by ${T} asc`;
  tile(live, 'trend', `${amountLabel} per minute${R.channel ? ' by channel' : ''}`, R.channel ? 'stackedarea' : 'line', { x: 0, y: 6, width: 16, height: 8 }, trend,
    chart(R.time.name, [amountLabel], R.channel ? [label('channel', 'Channel')] : null, { xTitle: 'Time' }), perMinuteSrc === baseVar ? undefined : timeVars);
  const mix = by('group', 8) || by('channel', 8);
  if (mix) {
    const role = R.group ? 'group' : 'channel';
    tile(live, 'mix', `${amountLabel} by ${label(role, role).toLowerCase()}`, 'pie', { x: 16, y: 6, width: 8, height: 8 }, mix[0], {
      hideLegend: false, legendLocation: 'bottom', xColumn: label(role, role), yColumns: [amountLabel], seriesColumns: null, crossFilterDisabled: false, drillthroughDisabled: false,
      labelDisabled: false, pie__label: ['name', 'percentage'], tooltipDisabled: false, pie__tooltip: ['name', 'percentage', 'value'], pie__orderBy: 'size', pie__kind: 'donut', pie__topNSlices: null, crossFilter: [], drillthrough: [],
    }, mix[1]);
  }
  const lower = [];
  if (R.region) lower.push(['region', `${amountLabel} by ${label('region', 'region').toLowerCase()}`, 'bar', by('region', 12), label('region', 'Region')]);
  if (R.item) lower.push(['item', `Top ${label('item', 'items').toLowerCase()}s right now`, 'bar', by('item', 10), label('item', 'Item')]);
  const recentCols = scenario.columns.filter((c) => ['time', 'channel', 'item', 'party', 'region', 'qty', 'amount', 'rule'].includes(c.role));
  lower.push(['latest', `Latest ${unitPlural}`, 'table', [`${baseVar}\n| top 50 by ${T} desc\n| project ${friendly(recentCols)}`]]);
  const lw = Math.floor(GRID / lower.length);
  lower.forEach(([key, t, vt, [text, vars], x], i) => tile(live, key, t, vt, { x: i * lw, y: 14, width: i === lower.length - 1 ? GRID - lw * i : lw, height: 9 }, text,
    vt === 'table' ? { table__enableRenderLinks: false, colorRulesDisabled: !rule, colorRules: rule ? tableRules((i) => id('rule', 'latest', i), label('rule', R.rule.name), scenario.rules) : [], crossFilterDisabled: false, drillthroughDisabled: false, crossFilter: [], drillthrough: [], table__renderLinks: [] }
      : chart(x, [amountLabel], null), vars));

  // ---- page 2: business rules ----
  if (rulesPage) {
    const rulesText = scenario.rules.map((r) => `- **${md(r.label)}** – ${md(r.description)}`).join('\n');
    markdown(rulesPage, 'rules-header', `## Business rules, live\n${rulesText}`, { x: 0, y: 0, width: GRID, height: 3 });
    const rc = scenario.rules.slice(0, 3).map((r) => [r.id, r.label, `${baseVar}\n| where ${rule} == ${kqlString(r.label)}\n| summarize Value = count()`]);
    rc.push(['share', `Share of ${unitPlural} breaking a rule (%)`, `${baseVar}\n| summarize b = countif(isnotempty(${rule})), n = count()\n| project Value = iff(n == 0, 0.0, round(100.0 * b / n, 2))`]);
    if (R.margin) rc.push(['loss', 'Loss on lines below cost', `${baseVar}\n| where ${name('margin')} < 0\n| summarize Value = round(-sum(${name('margin')}), 0)`]);
    const cw = Math.floor(GRID / rc.length);
    rc.forEach(([key, t, text], i) => tile(rulesPage, `rcard-${key}`, t, 'card', { x: i * cw, y: 3, width: i === rc.length - 1 ? GRID - cw * i : cw, height: 3 }, text, card(key === 'share' ? [] : [warnRule(`r-${key}`, key === 'loss' ? 'yellow' : 'red'), okRule(`r-${key}-ok`)])));
    tile(rulesPage, 'rule-trend', 'Rule breaks per minute', 'stackedcolumn', { x: 0, y: 6, width: 14, height: 8 },
      `${baseVar}\n| where isnotempty(${rule})\n| summarize Breaks = count() by bin(${T}, 1m), Rule = ${rule}\n| order by ${T} asc`, chart(R.time.name, ['Breaks'], ['Rule'], { xTitle: 'Time' }));
    const who = R.party || R.region || R.item;
    if (who) {
      const whoRole = R.party ? 'party' : R.region ? 'region' : 'item';
      tile(rulesPage, 'rule-who', `Who breaks the rules (by ${label(whoRole, whoRole).toLowerCase()})`, 'bar', { x: 14, y: 6, width: 10, height: 8 },
        `${baseVar}\n| where isnotempty(${rule})\n| summarize Breaks = count() by ${kqlName(label(whoRole, whoRole))} = ${name(whoRole)}\n| top 10 by Breaks desc`, chart(label(whoRole, whoRole), ['Breaks'], null));
    }
    const exCols = scenario.columns.filter((c) => ['time', 'order', 'channel', 'item', 'party', 'region', 'qty', 'price', 'discount', 'amount', 'cost', 'margin', 'rule'].includes(c.role));
    tile(rulesPage, 'rule-list', 'Latest rule breaks – review these first', 'table', { x: 0, y: 14, width: GRID, height: 9 },
      `${baseVar}\n| where isnotempty(${rule})\n| top 100 by ${T} desc\n| project ${friendly(exCols)}`,
      { table__enableRenderLinks: false, colorRulesDisabled: false, colorRules: tableRules((i) => id('rule', 'list', i), label('rule', R.rule.name), scenario.rules), crossFilterDisabled: false, drillthroughDisabled: false, crossFilter: [], drillthrough: [], table__renderLinks: [] });
  }

  // ---- page 3: medallion layers (flow and data quality per layer, by ingestion time) ----
  if (layersPage) {
    const N = M.names;
    const B = kqlName(N.bronze), S = kqlName(N.silver), Q = kqlName(N.quarantine);
    const hash = kqlName(M.extras.find((e) => e.role === 'hash')?.name || 'EventHash');
    const reason = kqlName(M.reasonColumn || 'Reason');
    const qAt = kqlName(M.quarantinedAtColumn || 'QuarantinedAt');
    const inRange = '| where ingestion_time() between (_startTime .. _endTime)';
    const days = (d) => (d ? `${d} days` : 'retention unchanged');
    const o = M.options || {};
    markdown(layersPage, 'layers-header', [
      '## Medallion layers',
      `**Bronze** ${md(N.bronze)} – raw events from the Eventstream (${days(o.bronzeDays)}) → **Silver** ${md(N.silver)} – checked and enriched by an update policy, rejects in ${md(N.quarantine)}, duplicates removed in ${md(N.clean)} (${days(o.silverDays)}) → **Gold** ${(M.gold || []).map((g) => md(g.name)).join(', ')} – materialized views (${days(o.goldDays)}).`,
    ].join('\n'), { x: 0, y: 0, width: GRID, height: 3 });
    const lc = [
      ['bronze', 'Bronze · raw events', `${B}\n${inRange}\n| summarize Value = count()`],
      ['silver', 'Silver · passed the checks', `${S}\n${inRange}\n| summarize Value = count()`],
      ['dups', 'Duplicates removed', `${S}\n${inRange}\n| summarize n = count() by ${hash}\n| summarize Value = sum(n) - count()`],
      ['quarantine', 'Quarantined', `${Q}\n${inRange}\n| summarize Value = count()`],
      ['quality', 'Data quality (%)', `union (${B} ${inRange} | summarize b = count()), (${Q} ${inRange} | summarize q = count())\n| summarize b = sum(b), q = sum(q)\n| project Value = iff(b == 0, 100.0, round(100.0 * (b - q) / b, 2))`],
      ['latency', 'Silver freshness (s)', `${S}\n${inRange}\n| summarize Value = coalesce(datetime_diff('second', now(), max(${T})), 0)`],
    ];
    const lcw = GRID / lc.length;
    lc.forEach(([key, t, text], i) => tile(layersPage, `lcard-${key}`, t, 'card', { x: i * lcw, y: 3, width: lcw, height: 3 }, text,
      card(key === 'quarantine' || key === 'dups' ? [warnRule(`l-${key}`, 'yellow'), okRule(`l-${key}-ok`)] : []), timeVars));
    tile(layersPage, 'layer-flow', 'Events per minute by layer', 'line', { x: 0, y: 6, width: 14, height: 8 },
      `union\n  (${B} ${inRange} | summarize Events = count() by Minute = bin(ingestion_time(), 1m) | extend Layer = "Bronze"),\n  (${S} ${inRange} | summarize Events = count() by Minute = bin(ingestion_time(), 1m) | extend Layer = "Silver"),\n  (${Q} ${inRange} | summarize Events = count() by Minute = bin(ingestion_time(), 1m) | extend Layer = "Quarantine")\n| order by Minute asc`,
      chart('Minute', ['Events'], ['Layer'], { xTitle: 'Ingestion time' }), timeVars);
    tile(layersPage, 'layer-reasons', 'Why events were quarantined', 'bar', { x: 14, y: 6, width: 10, height: 8 },
      `${Q}\n${inRange}\n| summarize Events = count() by Reason = ${reason}\n| order by Events desc`, chart('Reason', ['Events'], null), timeVars);
    const qCols = scenario.columns.filter((c) => ['time', 'order', 'item', 'party', 'qty', 'amount'].includes(c.role));
    tile(layersPage, 'layer-quarantine', 'Latest quarantined events', 'table', { x: 0, y: 14, width: 12, height: 9 },
      `${Q}\n${inRange}\n| top 50 by ${qAt} desc\n| project Quarantined = ${qAt}, Reason = ${reason}, ${friendly(qCols)}`,
      { table__enableRenderLinks: false, colorRulesDisabled: true, colorRules: [], crossFilterDisabled: false, drillthroughDisabled: false, crossFilter: [], drillthrough: [], table__renderLinks: [] }, timeVars);
    const latest = (M.gold || []).find((g) => g.kind === 'latest');
    if (latest) {
      const lCols = scenario.columns.filter((c) => c.name !== latest.by[0] && ['time', 'channel', 'item', 'region', 'amount', 'rule'].includes(c.role));
      const key = scenario.columns.find((c) => c.name === latest.by[0]);
      tile(layersPage, 'layer-latest', `Gold · ${latest.label.toLowerCase()}`, 'table', { x: 12, y: 14, width: 12, height: 9 },
        `${kqlName(latest.name)}\n| top 50 by ${T} desc\n| project ${friendly([key, ...lCols].filter(Boolean))}`,
        { table__enableRenderLinks: false, colorRulesDisabled: true, colorRules: [], crossFilterDisabled: false, drillthroughDisabled: false, crossFilter: [], drillthrough: [], table__renderLinks: [] }, []);
    }
  }

  return {
    schema_version: '52',
    title,
    autoRefresh: { enabled: true, defaultInterval: autoRefreshInterval, minInterval: '1s' },
    tiles,
    baseQueries,
    parameters: [{
      kind: 'duration', id: id('param', 'time'), displayName: 'Time range', description: '', beginVariableName: '_startTime', endVariableName: '_endTime',
      defaultValue: { kind: 'dynamic', count: 1, unit: 'hours' }, showOnPages: { kind: 'all' },
    }],
    dataSources,
    pages,
    queries,
  };
}

// Markdown-safe text for markdown tiles.
const md = (s) => String(s ?? '').replace(/([\\`*_{}[\]()#+!|<>])/g, '\\$1');

/** Table columns renamed to their business labels. */
const friendly = (cols) => cols.map((c) => (c.label && c.label !== c.name ? `${kqlName(c.label)} = ${kqlName(c.name)}` : kqlName(c.name))).join(', ');

// One color rule per business rule: highlight the rule column of rows that break it.
function tableRules(idOf, column, rules) {
  return rules.map((r, i) => ({
    id: idOf(i), ruleType: 'colorByCondition', applyToColumn: column, hideText: false, applyTo: 'cells',
    conditions: [{ operator: '==', column, values: [r.label] }], chainingOperator: 'and', colorStyle: 'light', color: i === 0 ? 'red' : 'yellow', tag: '', icon: 'warning', ruleName: r.label, visualType: 'table',
  }));
}

/** The KQL behind each tile with the time range filled in – used to check every tile before deploying. */
export function tileQueries(dashboard, { minutes = 60 } = {}) {
  const fill = (text) => text.replace(/_startTime/g, `ago(${minutes}m)`).replace(/_endTime/g, 'now()');
  const base = dashboard.queries.find((x) => x.id === dashboard.baseQueries[0].queryId);
  const baseText = fill(base.text);
  return dashboard.tiles.filter((t) => t.queryRef).map((t) => {
    const qx = dashboard.queries.find((x) => x.id === t.queryRef.queryId);
    return { title: t.title, visualType: t.visualType, kql: qx.usedVariables.includes('_events') ? `let _events = ${baseText};\n${fill(qx.text)}` : fill(qx.text) };
  });
}
