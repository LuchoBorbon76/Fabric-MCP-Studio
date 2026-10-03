// Real-Time Dashboard (KQL Dashboard) definition generator: a live overview page and a business-rules page over the
// Eventhouse table the simulator (or any other app) streams into. Tiles adapt to the columns the scenario has.
import { stableUuid } from '../config.mjs';
import { kqlName, kqlString } from './kusto.mjs';

const GRID = 24;

/**
 * @param {object} o
 * @param {string} o.title dashboard title
 * @param {object} o.source { clusterUri, databaseId, databaseName, workspaceId }
 * @param {object} o.scenario { table, columns[], rules[], label, unit }
 * @param {number} [o.refreshSeconds]
 */
export function buildDashboard({ title, source, scenario, refreshSeconds = 30 }) {
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

  const dsId = id('ds');
  const dataSources = [{
    kind: 'kusto-trident', scopeId: 'kusto-trident', clusterUri: source.clusterUri, database: source.databaseId,
    name: source.databaseName, id: dsId, workspace: source.workspaceId,
  }];
  const pages = [{ id: id('page', 'live'), name: 'Live overview' }];
  if (rule) pages.push({ id: id('page', 'rules'), name: 'Business rules' });
  const [live, rulesPage] = pages;

  const queries = [];
  const tiles = [];
  const baseVar = '_events';
  const baseQueryId = id('q', 'base');
  queries.push({ id: baseQueryId, dataSource: { kind: 'inline', dataSourceId: dsId }, text: `${kqlName(scenario.table)}\n| where ${T} between (_startTime .. _endTime)`, usedVariables: ['_startTime', '_endTime'] });
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
  const by = (role, n = 10) => (R[role] ? `${baseVar}\n| summarize ${kqlName(amountLabel)} = round(sum(${amount}), 2) by ${kqlName(label(role, role))} = ${name(role)}\n| top ${n} by ${kqlName(amountLabel)} desc` : null);

  // ---- page 1: live overview ----
  const desc = `Live events in **${md(source.databaseName)}** · table **${md(scenario.table)}** · refreshes every ${refreshSeconds} seconds · change the time range at the top`;
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

  const perMinute = R.channel
    ? `${baseVar}\n| summarize ${kqlName(amountLabel)} = round(sum(${amount}), 2) by bin(${T}, 1m), ${kqlName(label('channel', 'Channel'))} = ${name('channel')}\n| order by ${T} asc`
    : `${baseVar}\n| summarize ${kqlName(amountLabel)} = round(sum(${amount}), 2) by bin(${T}, 1m)\n| order by ${T} asc`;
  tile(live, 'trend', `${amountLabel} per minute${R.channel ? ' by channel' : ''}`, R.channel ? 'stackedarea' : 'line', { x: 0, y: 6, width: 16, height: 8 }, perMinute,
    chart(R.time.name, [amountLabel], R.channel ? [label('channel', 'Channel')] : null, { xTitle: 'Time' }));
  const mix = by('group', 8) || by('channel', 8);
  if (mix) {
    const role = R.group ? 'group' : 'channel';
    tile(live, 'mix', `${amountLabel} by ${label(role, role).toLowerCase()}`, 'pie', { x: 16, y: 6, width: 8, height: 8 }, mix, {
      hideLegend: false, legendLocation: 'bottom', xColumn: label(role, role), yColumns: [amountLabel], seriesColumns: null, crossFilterDisabled: false, drillthroughDisabled: false,
      labelDisabled: false, pie__label: ['name', 'percentage'], tooltipDisabled: false, pie__tooltip: ['name', 'percentage', 'value'], pie__orderBy: 'size', pie__kind: 'donut', pie__topNSlices: null, crossFilter: [], drillthrough: [],
    });
  }
  const lower = [];
  if (R.region) lower.push(['region', `${amountLabel} by ${label('region', 'region').toLowerCase()}`, 'bar', by('region', 12), label('region', 'Region')]);
  if (R.item) lower.push(['item', `Top ${label('item', 'items').toLowerCase()}s right now`, 'bar', by('item', 10), label('item', 'Item')]);
  const recentCols = scenario.columns.filter((c) => ['time', 'channel', 'item', 'party', 'region', 'qty', 'amount', 'rule'].includes(c.role));
  lower.push(['latest', `Latest ${unitPlural}`, 'table', `${baseVar}\n| top 50 by ${T} desc\n| project ${friendly(recentCols)}`]);
  const lw = Math.floor(GRID / lower.length);
  lower.forEach(([key, t, vt, text, x], i) => tile(live, key, t, vt, { x: i * lw, y: 14, width: i === lower.length - 1 ? GRID - lw * i : lw, height: 9 }, text,
    vt === 'table' ? { table__enableRenderLinks: false, colorRulesDisabled: !rule, colorRules: rule ? tableRules((i) => id('rule', 'latest', i), label('rule', R.rule.name), scenario.rules) : [], crossFilterDisabled: false, drillthroughDisabled: false, crossFilter: [], drillthrough: [], table__renderLinks: [] }
      : chart(x, [amountLabel], null)));

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

  return {
    schema_version: '52',
    title,
    autoRefresh: { enabled: true, defaultInterval: `${refreshSeconds}s`, minInterval: '30s' },
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
  const base = dashboard.queries.find((x) => x.id === dashboard.baseQueries[0].queryId);
  const baseText = base.text.replace(/_startTime/g, `ago(${minutes}m)`).replace(/_endTime/g, 'now()');
  return dashboard.tiles.filter((t) => t.queryRef).map((t) => {
    const qx = dashboard.queries.find((x) => x.id === t.queryRef.queryId);
    return { title: t.title, visualType: t.visualType, kql: `let _events = ${baseText};\n${qx.text}` };
  });
}
