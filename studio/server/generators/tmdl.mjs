// TMDL generators: Direct Lake semantic model and Fabric IQ ontology, from a discovered schema.
import { stableUuid } from '../config.mjs';

const T = '\t';

// ---------------- naming helpers ----------------

export function quoteName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`;
}

export function humanize(name) {
  return String(name)
    .replace(/^(dim|fact|fct|tbl)_?/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const singular = (s) => s.replace(/ies$/i, 'y').replace(/(ss|x|ch|sh)es$/i, '$1').replace(/([^s])s$/i, '$1');
const pascal = (s) => humanize(s).replace(/\s+/g, '');

const AMOUNT_RX = /(amount|amt|total|price|cost|revenue|sales|qty|quantity|due|freight|tax|discount|margin|profit|value|balance|units|weight|hours)/i;
const ID_RX = /(id|key|code|number|no|guid|rowguid|zip|postal|phone|year|month|day|week|quarter)$/i;

// SQL / Delta type -> TMDL data type. Returns null for unsupported types (excluded from the model).
export function mapType(type) {
  const t = String(type || '').toLowerCase();
  if (/^(bigint|int|integer|smallint|tinyint|int2|int4|int8|serial|bigserial)/.test(t)) return 'int64';
  if (/^(decimal|numeric|money|smallmoney)/.test(t)) return 'decimal';
  if (/^(float|real|double)/.test(t)) return 'double';
  if (/^(bit|bool)/.test(t)) return 'boolean';
  if (/^(date|datetime|datetime2|smalldatetime|datetimeoffset|timestamp)/.test(t)) return 'dateTime';
  if (/^(varbinary|binary|image|geography|geometry|hierarchyid|sql_variant|xml|bytea|time\b|time$|interval|json|jsonb|uuid\[\]|tsvector)/.test(t)) {
    if (/^(xml|json|jsonb)/.test(t)) return 'string';
    return null;
  }
  return 'string';
}

function columnFormat(dataType, name) {
  if (dataType === 'int64') return ID_RX.test(name) ? '0' : '#,0';
  if (dataType === 'decimal') return '#,0.00';
  if (dataType === 'double') return '#,0.00';
  if (dataType === 'dateTime') return 'General Date';
  return null;
}

/** Month and weekday name columns sort by their number column (e.g. EnglishMonthName by MonthNumberOfYear). */
function sortByColumns(columns) {
  const out = new Map();
  const numberCol = (rx) => columns.find((c) => c.dataType === 'int64' && rx.test(c.name));
  const month = numberCol(/^(month(number)?(ofyear)?|monthno|month_?num(ber)?(_?of_?year)?|month number( of year)?)$/i);
  const day = numberCol(/^(day(number)?ofweek|weekday(number)?|day of week( number)?|day_?of_?week)$/i);
  for (const c of columns) {
    if (c.dataType !== 'string') continue;
    if (month && /month( ?name)?$/i.test(c.name) && !/number/i.test(c.name)) out.set(c.name, month.name);
    else if (day && /(day ?name(ofweek)?|dayofweek ?name|weekday ?name)$/i.test(c.name)) out.set(c.name, day.name);
  }
  return out;
}

/**
 * Normalize a discovered schema into a model plan.
 * schema: { tables:[{schema,name,columns:[{name,type,isPk,isKey}]}], relationships:[{from:{schema,table,column},to:{...}}] }
 * options: { include?: [tableKeys], names?: {tableKey: displayName}, descriptions?: {tableKey or tableKey.column: text} }
 */
export function buildPlan(schema, options = {}) {
  const include = options.include?.length ? new Set(options.include) : null;
  const names = options.names || {};
  const descs = options.descriptions || {};
  const tables = [];
  const usedNames = new Set();
  const nameCounts = new Map();
  for (const t of schema.tables) nameCounts.set(t.name.toLowerCase(), (nameCounts.get(t.name.toLowerCase()) || 0) + 1);

  for (const t of schema.tables) {
    const key = `${t.schema}.${t.name}`;
    if (include && !include.has(key) && !include.has(t.name)) continue;
    let display = names[key] || names[t.name] || humanize(t.name);
    if (nameCounts.get(t.name.toLowerCase()) > 1) display = `${humanize(t.schema)} ${display}`;
    while (usedNames.has(display.toLowerCase())) display += ' 2';
    usedNames.add(display.toLowerCase());
    const columns = [];
    for (const c of t.columns) {
      const dataType = mapType(c.type);
      if (!dataType) continue;
      columns.push({ name: c.name, dataType, isKey: Boolean(c.isPk || c.isKey), description: descs[`${key}.${c.name}`] || descs[`${t.name}.${c.name}`] || c.description || '' });
    }
    if (!columns.length) continue;
    tables.push({ key, schema: t.schema, source: t.name, name: display, rows: t.rows, columns, description: descs[key] || descs[t.name] || t.description || '' });
  }

  const byKey = new Map(tables.map((t) => [t.key, t]));
  const findTable = (ref) => byKey.get(`${ref.schema || 'dbo'}.${ref.table}`) || tables.find((t) => t.source === ref.table || t.name === ref.table);
  const relationships = [];
  const seen = new Set();
  for (const r of schema.relationships || []) {
    const from = findTable(r.from);
    const to = findTable(r.to);
    if (!from || !to || from === to) continue;
    if (!from.columns.some((c) => c.name === r.from.column) || !to.columns.some((c) => c.name === r.to.column)) continue;
    const sig = `${from.key}.${r.from.column}->${to.key}.${r.to.column}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    // Only one active path between two tables.
    const pair = `${from.key}->${to.key}`;
    const active = r.active !== false && !relationships.some((x) => x.pair === pair && x.active);
    relationships.push({ pair, from, fromColumn: r.from.column, to, toColumn: r.to.column, active, label: r.label });
  }
  // Mark keys used by relationships.
  for (const r of relationships) {
    const tc = r.to.columns.find((c) => c.name === r.toColumn);
    if (tc) tc.isKey = true;
  }
  const facts = new Set(relationships.map((r) => r.from.key));
  for (const t of tables) t.role = facts.has(t.key) ? 'fact' : relationships.some((r) => r.to.key === t.key) ? 'dimension' : 'table';
  return { tables, relationships };
}

/** Default measures: row counts for facts and sums for amount-like columns. */
export function defaultMeasures(plan) {
  const out = [];
  const targets = plan.tables.filter((t) => t.role === 'fact');
  for (const t of (targets.length ? targets : plan.tables)) {
    out.push({ table: t.name, name: `${t.name} Count`, expression: `COUNTROWS(${quoteName(t.name)})`, formatString: '#,0', displayFolder: 'Counts', description: `Number of rows in ${t.name}.` });
    const fkCols = new Set(plan.relationships.filter((r) => r.from === t).map((r) => r.fromColumn));
    const numeric = t.columns.filter((c) => ['int64', 'decimal', 'double'].includes(c.dataType) && !c.isKey && !fkCols.has(c.name) && !ID_RX.test(c.name) && AMOUNT_RX.test(c.name) && !/(price|pct|percent|rate|ratio|unit)/i.test(c.name));
    for (const c of numeric.slice(0, 8)) {
      out.push({ table: t.name, name: `Total ${humanize(c.name)}`, expression: `SUM(${quoteName(t.name)}[${c.name}])`, formatString: c.dataType === 'int64' ? '#,0' : '#,0.00', displayFolder: t.name, description: `Sum of ${humanize(c.name)} in ${t.name}.` });
    }
  }
  const seenNames = new Set();
  return out.filter((m) => (seenNames.has(m.name.toLowerCase()) ? false : seenNames.add(m.name.toLowerCase())));
}

/**
 * Partition annotations that tell Fabric which item a backing table comes from (the ontology editor needs them to
 * preview instances and edit bindings). item: { kind, id, name, workspaceId, workspaceName }.
 */
export function ontSourceAnnotations(item, indent = `${T}${T}`) {
  const pairs = [
    ['ONT_WorkspaceId', item.workspaceId], ['ONT_ItemId', item.id], ['ONT_ItemKind', item.kind],
    ['ONT_ItemName', item.name], ['ONT_WorkspaceName', item.workspaceName], ['ONT_PinnedAtUtc', item.pinnedAt || new Date().toISOString()],
  ].filter(([, v]) => v);
  return pairs.flatMap(([k, v]) => [`${indent}annotation ${k} = ${String(v).replace(/[\r\n]+/g, ' ')}`, '']);
}

function docLines(text, indent) {
  if (!text) return [];
  return String(text).split(/\r?\n/).filter(Boolean).map((l) => `${indent}/// ${l.trim()}`);
}

function exprBlock(expression, indent) {
  const lines = String(expression).replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.length === 1) return { head: ` = ${lines[0]}`, body: [] };
  return { head: ' =', body: lines.map((l) => `${indent}${l}`) };
}

// ---------------- semantic model ----------------

/**
 * Generate a Direct Lake semantic model definition (TMDL).
 * src: { server, endpointId, itemName }
 * plan: from buildPlan; measures: [{table,name,expression,formatString,description,displayFolder}]
 * dateTable: optional { table: displayName, column }
 */
export function semanticModelFiles({ name, src, plan, measures = [], dateTable = null }) {
  const files = {};
  const exprName = `DirectLake - ${src.itemName || 'Source'}`;
  const tag = (...p) => stableUuid('sm', name, ...p);

  files['definition.pbism'] = {
    $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json',
    version: '4.2',
    settings: {},
  };
  files['definition/database.tmdl'] = `database\n${T}compatibilityLevel: 1604\n`;

  const model = [
    'model Model',
    `${T}culture: en-US`,
    `${T}defaultPowerBIDataSourceVersion: powerBI_V3`,
    `${T}discourageImplicitMeasures`,
    `${T}sourceQueryCulture: en-US`,
    `${T}dataAccessOptions`,
    `${T}${T}legacyRedirects`,
    `${T}${T}returnErrorValuesAsNull`,
    '',
    `annotation __PBI_TimeIntelligenceEnabled = 0`,
    '',
    ...plan.tables.map((t) => `ref table ${quoteName(t.name)}`),
    '',
  ];
  files['definition/model.tmdl'] = model.join('\n');

  files['definition/expressions.tmdl'] = [
    `expression ${quoteName(exprName)} =`,
    `${T}${T}let`,
    `${T}${T}    Source = Sql.Database("${src.server}", "${src.endpointId}")`,
    `${T}${T}in`,
    `${T}${T}    Source`,
    `${T}lineageTag: ${tag('expr')}`,
    '',
    `${T}annotation PBI_IncludeFutureArtifacts = False`,
    '',
  ].join('\n');

  const fkByTable = new Map();
  for (const r of plan.relationships) {
    if (!fkByTable.has(r.from.name)) fkByTable.set(r.from.name, new Set());
    fkByTable.get(r.from.name).add(r.fromColumn);
  }

  for (const t of plan.tables) {
    const isDate = dateTable && dateTable.table === t.name;
    const lines = [...docLines(t.description, ''), `table ${quoteName(t.name)}`, `${T}lineageTag: ${tag('table', t.key)}`];
    if (isDate) lines.push(`${T}dataCategory: Time`);
    lines.push('');
    for (const m of measures.filter((x) => x.table === t.name)) {
      const e = exprBlock(m.expression, `${T}${T}${T}`);
      lines.push(...docLines(m.description, T), `${T}measure ${quoteName(m.name)}${e.head}`, ...e.body);
      if (m.formatString) lines.push(`${T}${T}formatString: ${m.formatString}`);
      if (m.displayFolder) lines.push(`${T}${T}displayFolder: ${m.displayFolder}`);
      lines.push(`${T}${T}lineageTag: ${tag('measure', t.key, m.name)}`, '');
    }
    const fks = fkByTable.get(t.name) || new Set();
    const sortBy = sortByColumns(t.columns);
    for (const c of t.columns) {
      const hidden = fks.has(c.name) || (c.isKey && t.role !== 'table' && !(isDate && c.name === dateTable.column));
      const fmt = columnFormat(c.dataType, c.name);
      const summarize = !isDate && !/year$/i.test(c.name) && ['int64', 'decimal', 'double'].includes(c.dataType) && !c.isKey && !fks.has(c.name) && !ID_RX.test(c.name) ? 'sum' : 'none';
      lines.push(...docLines(c.description, T), `${T}column ${quoteName(c.name)}`, `${T}${T}dataType: ${c.dataType}`);
      if (hidden) lines.push(`${T}${T}isHidden`);
      if (isDate && c.name === dateTable.column) lines.push(`${T}${T}isKey`);
      if (fmt) lines.push(`${T}${T}formatString: ${fmt}`);
      if (sortBy.has(c.name)) lines.push(`${T}${T}sortByColumn: ${quoteName(sortBy.get(c.name))}`);
      lines.push(`${T}${T}lineageTag: ${tag('column', t.key, c.name)}`, `${T}${T}summarizeBy: ${summarize}`, `${T}${T}sourceColumn: ${c.name}`, '');
      lines.push(`${T}${T}annotation SummarizationSetBy = Automatic`, '');
    }
    lines.push(
      `${T}partition ${quoteName(t.name)} = entity`,
      `${T}${T}mode: directLake`,
      `${T}${T}source`,
      `${T}${T}${T}entityName: ${t.source}`,
      `${T}${T}${T}schemaName: ${t.schema}`,
      `${T}${T}${T}expressionSource: ${quoteName(exprName)}`,
      '',
    );
    files[`definition/tables/${fileSafe(t.name)}.tmdl`] = lines.join('\n');
  }

  if (plan.relationships.length) {
    const rel = [];
    for (const r of plan.relationships) {
      rel.push(`relationship ${tag('rel', r.from.key, r.fromColumn, r.to.key, r.toColumn)}`);
      if (!r.active) rel.push(`${T}isActive: false`);
      rel.push(`${T}fromColumn: ${quoteName(r.from.name)}.${quoteName(r.fromColumn)}`, `${T}toColumn: ${quoteName(r.to.name)}.${quoteName(r.toColumn)}`, '');
    }
    files['definition/relationships.tmdl'] = rel.join('\n');
  }
  return files;
}

function fileSafe(name) { return String(name).replace(/[\\/:*?"<>|]/g, '_'); }

// ---------------- ontology ----------------

/**
 * Generate a Fabric IQ ontology (new experience, TMDL) bound to the same SQL endpoint.
 * src: { server, endpointId, item?: { kind, id, name, workspaceId, workspaceName } } – item tags the partitions.
 * rules: [{ name, statement, entities: [{ entity, properties?: [] }], relationships?: [names] }]
 */
export function ontologyFiles({ name, src, plan, rules = [], entityNames = {}, descriptions = {} }) {
  const files = {};
  const tag = (...p) => stableUuid('ont', name, ...p);
  const ontType = (dt) => (dt === 'decimal' ? 'double' : dt);
  const tableName = (t) => t.source.toLowerCase() === t.source ? t.source : t.source;

  files['.platform'] = {
    $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
    metadata: { type: 'Ontology', displayName: name },
    config: { version: '2.0', logicalId: tag('logicalId') },
  };
  files['database.tmdl'] = `database\n${T}compatibilityLevel: 1000000\n`;
  files['namespaces/default.tmdl'] = `namespace default\n${T}lineageTag: default\n`;
  files['expressions.tmdl'] = [
    'expression DatabaseQuery =',
    `${T}${T}let`,
    `${T}${T}    database = Sql.Database("${src.server}", "${src.endpointId}")`,
    `${T}${T}in`,
    `${T}${T}    database`,
    `${T}lineageTag: ${tag('expr')}`,
    '',
  ].join('\n');

  const entities = new Map();
  const used = new Set();
  for (const t of plan.tables) {
    let e = entityNames[t.key] || entityNames[t.source] || pascal(singular(t.name));
    if (!/^[A-Za-z_]/.test(e)) e = `E${e}`;
    while (used.has(e.toLowerCase())) e += '2';
    used.add(e.toLowerCase());
    entities.set(t.key, e);
  }

  // Backing tables (TOM tables with Direct Lake partitions).
  const tomTable = new Map(plan.tables.map((t) => [t.key, `${t.schema === 'dbo' ? '' : `${t.schema}_`}${t.source}`.replace(/[^A-Za-z0-9_]/g, '_')]));
  for (const t of plan.tables) {
    const tn = tomTable.get(t.key);
    const lines = [`table ${tn}`, `${T}lineageTag: ${tag('table', t.key)}`, ''];
    for (const c of t.columns) {
      lines.push(`${T}column ${quoteName(c.name)}`, `${T}${T}dataType: ${ontType(c.dataType)}`);
      if (c.dataType === 'int64') lines.push(`${T}${T}formatString: 0`);
      if (c.dataType === 'dateTime') lines.push(`${T}${T}formatString: General Date`);
      lines.push(`${T}${T}lineageTag: ${tag('column', t.key, c.name)}`, `${T}${T}sourceColumn: ${c.name}`, '');
    }
    lines.push(`${T}partition ${tn} = entity`, `${T}${T}mode: directLake`, `${T}${T}source`, `${T}${T}${T}entityName: ${t.source}`, `${T}${T}${T}schemaName: ${t.schema}`, `${T}${T}${T}expressionSource: DatabaseQuery`, '');
    if (src.item?.id) lines.push(...ontSourceAnnotations(src.item));
    files[`tables/${tn}.tmdl`] = lines.join('\n');
  }

  // Entity types.
  for (const t of plan.tables) {
    const e = entities.get(t.key);
    const tn = tomTable.get(t.key);
    const key = t.columns.find((c) => c.isKey);
    const desc = descriptions[e] || t.description || `${humanize(t.name)} records from ${t.schema}.${t.source}.`;
    const lines = [...docLines(desc, ''), `entity ${e}`, `${T}lineageTag: ${tag('entity', t.key)}`, `${T}backingTable: ${tn}`];
    if (key) lines.push(`${T}keyProperty: ${quoteName(key.name)}`);
    lines.push('');
    for (const c of t.columns) {
      lines.push(...docLines(c.description || `${humanize(c.name)}.`, T), `${T}property ${quoteName(c.name)}`, `${T}${T}dataType: ${ontType(c.dataType)}`, `${T}${T}lineageTag: ${tag('property', t.key, c.name)}`, '', `${T}${T}backingConfiguration`, `${T}${T}${T}valueColumn: ${tn}.${quoteName(c.name)}`, '');
    }
    files[`entities/${e}.tmdl`] = lines.join('\n');
  }

  // Relationships.
  const relNames = [];
  if (plan.relationships.length) {
    const tom = [];
    const ent = [];
    const pairCount = new Map();
    for (const r of plan.relationships) pairCount.set(`${r.from.key}|${r.to.key}`, (pairCount.get(`${r.from.key}|${r.to.key}`) || 0) + 1);
    for (const r of plan.relationships) {
      const tomName = `rel_${tomTable.get(r.from.key)}_${r.fromColumn}_${tomTable.get(r.to.key)}`.replace(/[^A-Za-z0-9_]/g, '_');
      tom.push(`relationship ${tomName}`, `${T}fromColumn: ${tomTable.get(r.from.key)}.${quoteName(r.fromColumn)}`, `${T}toColumn: ${tomTable.get(r.to.key)}.${quoteName(r.toColumn)}`, '');
      let label = r.label || `${humanize(entities.get(r.from.key))} To ${humanize(entities.get(r.to.key))}`;
      if (pairCount.get(`${r.from.key}|${r.to.key}`) > 1) label += ` By ${humanize(r.fromColumn)}`;
      label = label.replace(/[:']/g, '');
      relNames.push({ label, from: entities.get(r.from.key), to: entities.get(r.to.key) });
      ent.push(`entityRelationship ${quoteName(label)}`, `${T}lineageTag: ${tag('erel', tomName)}`, `${T}fromEntity: ${entities.get(r.from.key)}`, `${T}toEntity: ${entities.get(r.to.key)}`, '', `${T}backingConfiguration`, `${T}${T}relationship: ${tomName}`, '');
    }
    files['relationships.tmdl'] = tom.join('\n');
    files['entityRelationships.tmdl'] = ent.join('\n');
  }

  // Business rules.
  const entityByName = new Map([...entities.values()].map((e) => [e.toLowerCase(), e]));
  const ruleNames = [];
  for (const rule of rules) {
    const rname = pascal(rule.name).replace(/[^A-Za-z0-9_]/g, '') || `Rule${ruleNames.length + 1}`;
    if (ruleNames.includes(rname)) continue;
    const statement = String(rule.statement || '').replace(/[\r\n]+/g, ' ').replace(/:/g, ' -').trim();
    if (!statement) continue;
    const lines = [`rule ${rname}`, `${T}statement: ${statement}`, `${T}lineageTag: ${tag('rule', rname)}`, ''];
    let refs = rule.entities || [];
    if (!refs.length) {
      // Link the entities the statement talks about (by entity or table name).
      const text = statement.toLowerCase();
      refs = plan.tables.filter((t) => {
        const e = entities.get(t.key);
        return [e, humanize(e), singular(t.name), t.name].some((w) => w && new RegExp(`\\b${w.toLowerCase().replace(/[^a-z0-9 ]/g, '')}s?\\b`).test(text));
      }).map((t) => ({ entity: entities.get(t.key) }));
    }
    for (const ref of refs) {
      const e = entityByName.get(String(ref.entity || ref).toLowerCase());
      if (!e) continue;
      lines.push(`${T}ruleReferencedEntity ${e}`);
      const t = plan.tables.find((x) => entities.get(x.key) === e);
      const props = (ref.properties || []).filter((p) => t?.columns.some((c) => c.name === p));
      if (props.length) {
        lines.push(`${T}${T}propertyScope: specific`, '');
        for (const p of props) lines.push(`${T}${T}ruleReferencedProperty ${quoteName(p)}`, '');
      } else lines.push('');
    }
    for (const relName of rule.relationships || []) {
      if (relNames.some((x) => x.label === relName)) lines.push(`${T}ruleReferencedRelationship ${quoteName(relName)}`, '');
    }
    files[`rules/${rname}.tmdl`] = `${lines.join('\n').replace(/\n+$/, '')}\n\n`;
    ruleNames.push(rname);
  }

  files['model.tmdl'] = [
    'model Model', '',
    ...plan.tables.map((t) => `ref table ${tomTable.get(t.key)}`), '',
    ...plan.tables.map((t) => `ref entity ${entities.get(t.key)}`), '',
    'ref namespace default', '',
    ...ruleNames.map((r) => `ref rule ${r}`),
    '',
  ].join('\n');

  return { files, entities: Object.fromEntries(entities), relationships: relNames, rules: ruleNames };
}
