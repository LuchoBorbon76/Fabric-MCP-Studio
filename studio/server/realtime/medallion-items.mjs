// The Fabric items that make each medallion layer visible in the workspace (one item per task in the task flow),
// named by the naming standard (naming.mjs):
//   KQL queryset   <Domain>_KQS_BronzeToSilver_<Env>  update policies, data-quality checks, quarantine and duplicates
//   KQL queryset   <Domain>_KQS_SilverToGold_<Env>    the Gold materialized views, their health and sample queries
//   Semantic model <Domain>_SM_LiveGold_<Env>         DirectQuery over the Gold views (single sign-on), for Power BI and Copilot
import { stableUuid } from '../config.mjs';
import { kqlName, kqlString } from './kusto.mjs';
import { quoteName } from '../generators/tmdl.mjs';

const T = '\t';

/** RealTimeQueryset.json for a queryset over one KQL database. */
export function querysetDefinition({ key, cluster, database, tabs }) {
  const ds = stableUuid('kqs', key, 'ds');
  return {
    queryset: {
      version: '1.0.0',
      dataSources: [{ id: ds, clusterUri: `${String(cluster).replace(/\/+$/, '')}/`, type: 'AzureDataExplorer', databaseName: database }],
      tabs: tabs.map((t, i) => ({ id: stableUuid('kqs', key, 'tab', i, t.title), title: t.title, content: t.kql, dataSourceId: ds })),
    },
  };
}

/** Tabs of the Bronze → Silver queryset. */
export function silverTabs(med) {
  const N = med.names;
  const reason = kqlName(med.reasonColumn);
  const time = kqlName(med.timeColumn);
  const hash = kqlName(med.extras.find((e) => e.role === 'hash')?.name || 'EventHash');
  return [
    { title: 'Medallion flow', kql: [
      `// Bronze ${N.bronze} → update policies → Silver ${N.silver} (+ ${N.quarantine}) → ${N.clean} (deduplicated)`,
      `union (${kqlName(N.bronze)} | summarize Rows = count(), LastIngested = max(ingestion_time()) | extend Layer = "1 Bronze"),`,
      `      (${kqlName(N.silver)} | summarize Rows = count(), LastIngested = max(ingestion_time()) | extend Layer = "2 Silver"),`,
      `      (${kqlName(N.quarantine)} | summarize Rows = count(), LastIngested = max(ingestion_time()) | extend Layer = "2 Quarantine"),`,
      `      (${kqlName(N.clean)} | summarize Rows = count() | extend Layer = "2 Silver deduplicated")`,
      '| project Layer, Rows, LastIngested',
      '| order by Layer asc',
    ].join('\n') },
    { title: 'Update policies', kql: `// The update policies that move every new Bronze event to Silver or to quarantine (run one at a time)\n.show table ${kqlName(N.silver)} policy update\n\n.show table ${kqlName(N.quarantine)} policy update` },
    { title: 'Silver transform', kql: `// What the Silver update policy does with the Bronze events (checks, then enrichment)\n.show function ${kqlName(N.toSilver)}` },
    { title: 'Data-quality checks', kql: [
      '// The checks every Bronze event must pass to reach Silver',
      `datatable(Check: string, Rule: string) [${med.checks.map((c) => `${kqlString(c.reason)}, ${kqlString(c.kql)}`).join(', ')}]`,
    ].join('\n') },
    { title: 'Quarantine by reason', kql: `${kqlName(N.quarantine)}\n| where ingestion_time() > ago(24h)\n| summarize Events = count() by Reason = ${reason}, bin(ingestion_time(), 15m)\n| render timechart` },
    { title: 'Latest quarantined', kql: `${kqlName(N.quarantine)}\n| top 100 by ${kqlName(med.quarantinedAtColumn)} desc` },
    { title: 'Duplicates removed', kql: `${kqlName(N.silver)}\n| where ingestion_time() > ago(24h)\n| summarize Copies = count() by ${hash}\n| where Copies > 1\n| summarize DuplicateEvents = sum(Copies - 1), Hashes = count()` },
    { title: 'Silver, deduplicated', kql: `${kqlName(N.clean)}\n| where ${time} > ago(1h)\n| top 100 by ${time} desc` },
  ];
}

/** Tabs of the Silver → Gold queryset. */
export function goldTabs(med) {
  const time = kqlName(med.timeColumn);
  const names = [med.names.clean, ...med.gold.map((g) => g.name)];
  return [
    { title: 'Gold views health', kql: `// Materialized views of the Silver and Gold layers\n.show materialized-views\n| where Name in (${names.map(kqlString).join(', ')})\n| project Name, Folder, SourceTable, IsHealthy, IsEnabled, MaterializedTo, LastRun, LastRunResult` },
    ...med.gold.map((g) => ({
      title: `Gold · ${g.label}`,
      kql: `// ${g.doc}\n// Definition:\n${g.query.split('\n').map((l) => `//   ${l}`).join('\n')}\nmaterialized_view(${kqlString(g.name)})\n| ${g.kind === 'daily' ? `top 100 by ${kqlName(g.by[0])} desc` : `top 100 by ${time} desc`}`,
    })),
  ];
}

const tomType = (t) => ({ datetime: 'dateTime', date: 'dateTime', long: 'int64', int: 'int64', real: 'double', double: 'double', decimal: 'decimal', bool: 'boolean', boolean: 'boolean', string: 'string', guid: 'string', timespan: 'string' })[String(t).toLowerCase().replace(/^system\./, '').replace('int64', 'long').replace('int32', 'int')] || null;

/**
 * Gold semantic model (TMDL): one DirectQuery table per Gold view, with business measures on the daily table.
 * schemas: { [viewName]: [{ name, type }] } read from the Eventhouse; scenario: the live events scenario summary.
 */
export function goldModelFiles({ name, cluster, database, med, schemas, scenario }) {
  const tag = (...p) => stableUuid('gold-sm', name, ...p);
  const R = Object.fromEntries(scenario.columns.filter((c) => c.role).map((c) => [c.role, c]));
  const labelOf = (col) => scenario.columns.find((c) => c.name === col)?.label || null;
  const files = {
    'definition.pbism': { $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json', version: '4.2', settings: {} },
    'definition/database.tmdl': `database\n${T}compatibilityLevel: 1604\n`,
  };
  const tables = med.gold.map((g) => ({ g, display: { perMinute: 'Gold per minute', daily: 'Gold daily', latest: `Gold latest per ${String(labelOf(g.by[0]) || g.by[0]).toLowerCase()}` }[g.kind] || g.name }));
  files['definition/model.tmdl'] = [
    'model Model', `${T}culture: en-US`, `${T}defaultPowerBIDataSourceVersion: powerBI_V3`, `${T}discourageImplicitMeasures`, `${T}sourceQueryCulture: en-US`,
    `${T}dataAccessOptions`, `${T}${T}legacyRedirects`, `${T}${T}returnErrorValuesAsNull`, '',
    'annotation __PBI_TimeIntelligenceEnabled = 0', '', ...tables.map((t) => `ref table ${quoteName(t.display)}`), '',
  ].join('\n');

  const daily = tables.find((t) => t.g.kind === 'daily');
  const perMinute = tables.find((t) => t.g.kind === 'perMinute');
  const latest = tables.find((t) => t.g.kind === 'latest');
  const sumOf = (t, col) => `SUM ( ${quoteName(t.display)}[${col}] )`;
  const amountLabel = R.amount?.label || 'Amount';
  const measures = new Map();
  const add = (t, m) => { if (t) measures.set(t.display, [...(measures.get(t.display) || []), m]); };
  // Measures and columns share one namespace in a model (case-insensitive): Gold views have Events, Quantity… columns.
  const taken = new Set(Object.values(schemas).flat().map((c) => String(c.name).toLowerCase()));
  const nm = (name) => {
    let x = name;
    if (taken.has(x.toLowerCase())) x = `Total ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
    for (let i = 2; taken.has(x.toLowerCase()); i++) x = `${name} (${i})`;
    taken.add(x.toLowerCase());
    return x;
  };
  const ref = (name) => `[${name.replace(/]/g, ']]')}]`;
  if (daily) {
    if (R.amount) add(daily, { name: nm(amountLabel), expr: sumOf(daily, R.amount.name), fmt: '#,0.00', doc: `Total ${amountLabel.toLowerCase()} from the Gold layer (deduplicated, checked events).` });
    const events = nm('Events');
    add(daily, { name: events, expr: sumOf(daily, 'Events'), fmt: '#,0', doc: 'Number of checked, deduplicated events.', key: 'events' });
    if (med.extras.some((e) => e.role === 'isRule')) {
      const breaks = nm('Rule breaks');
      add(daily, { name: breaks, expr: sumOf(daily, 'RuleBreaks'), fmt: '#,0', doc: 'Events that broke a business rule.' });
      add(daily, { name: nm('Rule break rate'), expr: `DIVIDE ( ${ref(breaks)}, ${ref(events)} )`, fmt: '0.00%', doc: 'Share of events that broke a business rule.' });
    }
    if (R.margin && R.amount) add(daily, { name: nm('Margin %'), expr: `DIVIDE ( ${sumOf(daily, R.margin.name)}, ${sumOf(daily, R.amount.name)} )`, fmt: '0.0%', doc: 'Margin as a share of the amount.' });
    if (R.qty) add(daily, { name: nm(R.qty.label || 'Quantity'), expr: sumOf(daily, R.qty.name), fmt: '#,0', doc: 'Units in the events.' });
  }
  if (perMinute && R.amount) {
    add(perMinute, { name: nm(`${amountLabel} last 15 minutes`), expr: `CALCULATE ( ${sumOf(perMinute, R.amount.name)}, ${quoteName(perMinute.display)}[${med.timeColumn}] >= NOW () - 15 / 1440 )`, fmt: '#,0.00', doc: `${amountLabel} in the last 15 minutes (per-minute Gold view).` });
    add(perMinute, { name: nm('Events last 15 minutes'), expr: `CALCULATE ( ${sumOf(perMinute, 'Events')}, ${quoteName(perMinute.display)}[${med.timeColumn}] >= NOW () - 15 / 1440 )`, fmt: '#,0', doc: 'Events in the last 15 minutes.' });
  }
  if (latest) {
    const key = String(labelOf(latest.g.by[0]) || latest.g.by[0]);
    add(latest, { name: nm(`${key.charAt(0).toUpperCase()}${key.slice(1)} count`), expr: `COUNTROWS ( ${quoteName(latest.display)} )`, fmt: '#,0', doc: `Distinct ${key.toLowerCase()} values with at least one event.` });
  }

  for (const t of tables) {
    const cols = (schemas[t.g.name] || []).map((c) => ({ ...c, tom: tomType(c.type) })).filter((c) => c.tom);
    const lines = [`/// ${t.g.doc.replace(/[\r\n]+/g, ' ')}`, `table ${quoteName(t.display)}`, `${T}lineageTag: ${tag('table', t.g.kind)}`, ''];
    for (const m of measures.get(t.display) || []) {
      lines.push(`${T}/// ${m.doc}`, `${T}measure ${quoteName(m.name)} = ${m.expr}`, `${T}${T}formatString: ${m.fmt}`, `${T}${T}displayFolder: Gold`, `${T}${T}lineageTag: ${tag('measure', t.g.kind, m.name)}`, '');
    }
    for (const c of cols) {
      const numeric = ['int64', 'double', 'decimal'].includes(c.tom) && !/key$|id$/i.test(c.name);
      lines.push(`${T}column ${quoteName(c.name)}`, `${T}${T}dataType: ${c.tom}`);
      if (c.tom === 'dateTime') lines.push(`${T}${T}formatString: General Date`);
      else if (c.tom === 'double') lines.push(`${T}${T}formatString: #,0.00`);
      else if (c.tom === 'int64') lines.push(`${T}${T}formatString: ${numeric ? '#,0' : '0'}`);
      lines.push(`${T}${T}lineageTag: ${tag('column', t.g.kind, c.name)}`, `${T}${T}summarizeBy: ${numeric ? 'sum' : 'none'}`, `${T}${T}sourceColumn: ${c.name}`, '');
    }
    lines.push(
      `${T}partition ${quoteName(t.display)} = m`, `${T}${T}mode: directQuery`, `${T}${T}source =`,
      `${T}${T}${T}${T}let`,
      `${T}${T}${T}${T}    Source = AzureDataExplorer.Contents("${String(cluster).replace(/\/+$/, '')}", "${database}", "${t.g.name}", [MaxRows = null, MaxSize = null, NoTruncate = null, AdditionalSetStatements = null])`,
      `${T}${T}${T}${T}in`, `${T}${T}${T}${T}    Source`, '',
    );
    files[`definition/tables/${t.display.replace(/[\\/:*?"<>|]/g, '_')}.tmdl`] = lines.join('\n');
  }
  return { files, tables: tables.map((t) => ({ name: t.display, view: t.g.name, measures: (measures.get(t.display) || []).map((m) => m.name) })), measures: [...measures.values()].flat().map((m) => m.name), eventsMeasure: [...measures.values()].flat().find((m) => m.key === 'events')?.name || null };
}
