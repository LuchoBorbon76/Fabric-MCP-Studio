// Live ontology: binds an Eventhouse events table to ontology entity types as time-series properties (matched on the
// entity key), links the Real-Time Dashboard to those entity types, and tags Direct Lake partitions with their source
// item. Works on an ontology definition as a files map ({ path: text }) so it can patch any existing TMDL ontology.
import { stableUuid } from '../config.mjs';
import { quoteName, ontSourceAnnotations } from './tmdl.mjs';

const T = '\t';
const SERIES_ROLES = ['amount', 'qty', 'price', 'discount', 'cost', 'margin', 'rule', 'order', 'channel'];
const KQL_TO_TOM = { datetime: 'dateTime', string: 'string', long: 'int64', int: 'int64', real: 'double', decimal: 'double', double: 'double', bool: 'boolean', boolean: 'boolean', guid: 'string', dynamic: 'string', timespan: 'string' };

const unq = (s) => {
  const t = String(s || '').trim();
  return /^'.*'$/.test(t) ? t.slice(1, -1).replace(/''/g, "'") : t;
};
const lf = (t) => String(t).replace(/\r\n/g, '\n');
const tomType = (kqlType) => KQL_TO_TOM[String(kqlType).toLowerCase()] || 'string';
const sameUri = (a, b) => String(a).replace(/\/+$/, '').toLowerCase() === String(b).replace(/\/+$/, '').toLowerCase();

/** The live events of a project with real-time set up (or null). */
export function liveEventsOf(p) {
  const rt = p?.realtime;
  if (!rt?.database?.id || !rt.eventhouse?.queryUri || !rt.scenario?.columns?.length) return null;
  return { queryUri: rt.eventhouse.queryUri, database: rt.database, table: rt.table, columns: rt.scenario.columns, workspace: p.workspace ? { id: p.workspace.id, name: p.workspace.name } : null };
}

/** The Direct Lake source item behind the project's ontology tables (for the partition annotations). */
export function ontologySourceOf(p) {
  const ms = p?.modelSource;
  if (!ms?.itemId || !ms.itemType) return null;
  const sameWs = !ms.workspaceId || ms.workspaceId === p.workspace?.id;
  return { kind: ms.itemType, id: ms.itemId, name: ms.itemName, workspaceId: ms.workspaceId || p.workspace?.id, workspaceName: sameWs ? p.workspace?.name : undefined };
}

/** "Table.Column" (either part may be quoted) → { table, column }. */
function splitRef(ref) {
  const m = String(ref).trim().match(/^('(?:[^']|'')*'|[^.']+)\.(.+)$/);
  return m ? { table: unq(m[1]), column: unq(m[2]) } : null;
}

/** Split a TMDL object into its header and top-level child blocks (with their /// doc lines). */
function blocks(text, indent, keywords) {
  const lines = lf(text).replace(/\n+$/, '').split('\n');
  const rx = new RegExp(`^${indent}(${keywords.join('|')})\\b`);
  const starts = [];
  lines.forEach((l, i) => {
    if (!rx.test(l)) return;
    let s = i;
    while (s > 0 && lines[s - 1].startsWith(`${indent}///`)) s--;
    starts.push(s);
  });
  const trim = (arr) => { const a = [...arr]; while (a.length && !a[a.length - 1].trim()) a.pop(); return a; };
  return {
    head: trim(lines.slice(0, starts.length ? starts[0] : lines.length)),
    parts: starts.map((s, i) => trim(lines.slice(s, i + 1 < starts.length ? starts[i + 1] : lines.length))),
  };
}

const keywordLine = (part, indent) => part.find((l) => !l.startsWith(`${indent}///`)) || '';
const joinBlocks = (head, parts) => `${[head.join('\n'), ...parts.map((p) => p.join('\n'))].filter((x) => x.length).join('\n\n')}\n`;

function parseTable(text) {
  const t = lf(text);
  const name = unq((t.match(/^table (.+)$/m) || [])[1]);
  const columns = new Map();
  for (const m of t.matchAll(/^\tcolumn (.+)\n((?:\t\t.*\n?|\s*\n)*)/gm)) columns.set(unq(m[1]), (m[2].match(/dataType: (\S+)/) || [])[1] || '');
  const kusto = t.match(/AzureDataExplorer\.Contents\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/);
  return { name, columns, entityPartition: /^\tpartition .+ = entity\s*$/m.test(t), annotated: /annotation ONT_ItemKind/.test(t), kusto: kusto ? { uri: kusto[1], db: kusto[2], table: kusto[3] } : null };
}

function parseEntity(text) {
  const { head, parts } = blocks(text, T, ['property', 'additionalBackingTable', 'resourceLink', 'synonym', 'annotation']);
  const h = head.join('\n');
  const props = new Map();
  for (const p of parts) {
    const k = keywordLine(p, T);
    if (!k.startsWith(`${T}property `)) continue;
    const body = p.join('\n');
    props.set(unq(k.slice(`${T}property `.length)), { valueColumn: (body.match(/valueColumn: (.+)/) || [])[1]?.trim() || null });
  }
  return {
    name: unq((h.match(/^entity (.+)$/m) || [])[1]),
    backingTable: unq((h.match(/^\tbackingTable: (.+)$/m) || [])[1]),
    keyProperty: unq((h.match(/^\tkeyProperty: (.+)$/m) || [])[1]),
    head, parts, props,
  };
}

/** Insert annotation lines at the end of the table's partition block. */
function annotatePartition(text, annotationLines) {
  const lines = lf(text).replace(/\n+$/, '').split('\n');
  const start = lines.findIndex((l) => /^\tpartition .+ = entity\s*$/.test(l));
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(`${T}${T}`) || !lines[end].trim())) end++;
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, '', ...annotationLines.slice(0, -1), ...(end < lines.length ? [''] : []));
  return `${lines.join('\n')}\n`;
}

/**
 * Apply (or remove) live bindings and source annotations.
 * events: { queryUri, database: { id, name }, table, columns: [{ name, type, role, label }], workspace: { id, name } }
 * link: false removes the live bindings only. source: Direct Lake source item for the partition annotations.
 * dashboard: { id, name } linked from every bound entity type.
 */
export function applyLiveOntology(input, { events = null, link = true, source = null, dashboard = null, workspaceId = null } = {}) {
  const files = {};
  for (const [k, v] of Object.entries(input)) files[k] = typeof v === 'string' ? lf(v) : v;
  const tablePaths = Object.keys(files).filter((k) => /^tables\/.+\.tmdl$/.test(k));
  const entityPaths = Object.keys(files).filter((k) => /^entities\/.+\.tmdl$/.test(k));
  const tables = new Map(tablePaths.map((k) => [k, parseTable(files[k])]));

  // 1. Tag Direct Lake partitions with their source item.
  let annotated = 0;
  if (source?.id) {
    for (const [path, t] of tables) {
      if (!t.entityPartition || t.annotated) continue;
      files[path] = annotatePartition(files[path], ontSourceAnnotations(source));
      annotated++;
    }
  }
  if (!events) return { files, linked: [], removed: [], annotated };

  // 2. Earlier live tables: anything bound to the same events table (unless an entity's primary binding uses it).
  const primary = new Set(entityPaths.map((k) => parseEntity(files[k]).backingTable).filter(Boolean));
  const removed = new Set();
  for (const [path, t] of tables) {
    if (t.kusto && sameUri(t.kusto.uri, events.queryUri) && t.kusto.db.toLowerCase() === events.database.name.toLowerCase() && t.kusto.table.toLowerCase() === events.table.toLowerCase() && !primary.has(t.name)) {
      removed.add(t.name);
      delete files[path];
      tables.delete(path);
    }
  }
  const refsRemoved = (body) => [...body.matchAll(/(?:valueColumn|orderingColumn|fromColumn|toColumn|table): (.+)/g)].some((m) => removed.has(splitRef(m[1])?.table) || removed.has(unq(m[1])));
  const relFile = files['relationships.tmdl'];
  let relParts = relFile ? blocks(relFile, '', ['relationship']) : { head: [], parts: [] };
  relParts.parts = relParts.parts.filter((p) => !refsRemoved(p.join('\n')));
  const dashIds = new Set([dashboard?.id].filter(Boolean));

  // 3. Match entity keys to event columns.
  const evCols = new Map(events.columns.map((c) => [c.name.toLowerCase(), c]));
  const timeCol = events.columns.find((c) => c.role === 'time')?.name || 'EventTime';
  const tableByName = new Map([...tables.values()].map((t) => [t.name, t]));
  const usedTables = new Set([...tables.values()].map((t) => t.name.toLowerCase()));
  const linked = [];
  const newTables = [];
  for (const path of entityPaths) {
    const e = parseEntity(files[path]);
    // Drop earlier live properties, joins and dashboard links.
    e.parts = e.parts.filter((p) => {
      const k = keywordLine(p, T);
      const body = p.join('\n');
      if (k.startsWith(`${T}property `) || k.startsWith(`${T}additionalBackingTable`)) return !refsRemoved(body);
      if (k.startsWith(`${T}resourceLink`)) return ![...dashIds].some((id) => body.includes(id));
      return true;
    });
    let entityText = joinBlocks(e.head, e.parts);
    if (link && e.backingTable && e.keyProperty && !removed.has(e.backingTable)) {
      const keyRef = splitRef(e.props.get(e.keyProperty)?.valueColumn || '');
      const keyCol = keyRef?.column || e.keyProperty;
      const ev = evCols.get(keyCol.toLowerCase()) || evCols.get(e.keyProperty.toLowerCase());
      const keyType = tableByName.get(e.backingTable)?.columns.get(keyCol);
      if (ev && ev.role !== 'time' && (!keyType || keyType === tomType(ev.type))) {
        let tn = `${e.backingTable}_Live`.replace(/[^A-Za-z0-9_]/g, '_');
        if (!/^[A-Za-z_]/.test(tn)) tn = `T_${tn}`;
        while (usedTables.has(tn.toLowerCase())) tn += '2';
        usedTables.add(tn.toLowerCase());
        const rel = `rel_${tn}`;
        const tag = (...x) => stableUuid('ont-live', events.database.id, tn, ...x);

        const tl = [`table ${tn}`, `${T}lineageTag: ${tag('table')}`, ''];
        for (const c of events.columns) {
          tl.push(`${T}column ${quoteName(c.name)}`, `${T}${T}dataType: ${tomType(c.type)}`);
          if (tomType(c.type) === 'dateTime') tl.push(`${T}${T}formatString: General Date`);
          tl.push(`${T}${T}lineageTag: ${tag('column', c.name)}`, `${T}${T}sourceColumn: ${c.name}`, '');
        }
        tl.push(`${T}partition ${tn} = m`, `${T}${T}mode: directQuery`, `${T}${T}source =`,
          `${T}${T}${T}${T}let`, `${T}${T}${T}${T}  Source = AzureDataExplorer.Contents("${events.queryUri}", "${events.database.name}", "${events.table}")`, `${T}${T}${T}${T}in`, `${T}${T}${T}${T}  Source`, '',
          ...ontSourceAnnotations({ kind: 'KQLDatabase', id: events.database.id, name: events.database.name, workspaceId: events.workspace?.id, workspaceName: events.workspace?.name }));
        files[`tables/${tn}.tmdl`] = tl.join('\n');
        newTables.push(tn);
        relParts.parts.push([`relationship ${rel}`, `${T}fromColumn: ${tn}.${quoteName(ev.name)}`, `${T}toColumn: ${quoteName(e.backingTable)}.${quoteName(keyCol)}`]);

        const taken = new Set(e.parts.map((p) => keywordLine(p, T)).filter((k) => k.startsWith(`${T}property `)).map((k) => unq(k.slice(`${T}property `.length)).toLowerCase()));
        const props = [];
        const add = [];
        for (const c of events.columns.filter((x) => SERIES_ROLES.includes(x.role) && x.name !== ev.name)) {
          let pn = `Live${c.name.replace(/[^A-Za-z0-9_]/g, '')}`.slice(0, 26);
          while (taken.has(pn.toLowerCase())) pn = `${pn.slice(0, 25)}2`;
          taken.add(pn.toLowerCase());
          props.push(pn);
          add.push([`${T}/// Live ${String(c.label || c.name).toLowerCase()} per event, from ${events.database.name}.${events.table} (Eventhouse).`,
            `${T}property ${pn}`, `${T}${T}dataType: TimeSeries<${tomType(c.type)}>`, `${T}${T}lineageTag: ${tag('property', pn)}`, '',
            `${T}${T}backingConfiguration`, `${T}${T}${T}type: timeSeries`, `${T}${T}${T}valueColumn: ${tn}.${quoteName(c.name)}`, `${T}${T}${T}orderingColumn: ${tn}.${quoteName(timeCol)}`]);
        }
        add.push([`${T}additionalBackingTable`, `${T}${T}table: ${tn}`, `${T}${T}relationship: ${rel}`]);
        if (dashboard?.id && workspaceId) {
          add.push([`${T}/// Live dashboard: ${String(dashboard.name || 'Real-Time Dashboard').replace(/[\r\n]+/g, ' ')}.`, `${T}resourceLink`, `${T}${T}item`, `${T}${T}${T}workspaceId: ${workspaceId}`, `${T}${T}${T}itemId: ${dashboard.id}`]);
        }
        entityText = joinBlocks(e.head, [...e.parts, ...add]);
        linked.push({ entity: e.name, table: tn, keyColumn: keyCol, eventColumn: ev.name, properties: props });
      }
    }
    files[path] = entityText;
  }

  if (relParts.parts.length) files['relationships.tmdl'] = joinBlocks(relParts.head, relParts.parts);
  else delete files['relationships.tmdl'];

  if (typeof files['model.tmdl'] === 'string') {
    let lines = files['model.tmdl'].replace(/\n+$/, '').split('\n').filter((l) => !(l.startsWith('ref table ') && removed.has(unq(l.slice(10)))));
    if (newTables.length) {
      const last = lines.map((l) => l.startsWith('ref table ')).lastIndexOf(true);
      const at = last >= 0 ? last + 1 : Math.max(1, lines.findIndex((l) => l.startsWith('ref ')));
      lines.splice(at < 0 ? lines.length : at, 0, ...newTables.map((t) => `ref table ${t}`));
    }
    files['model.tmdl'] = `${lines.join('\n')}\n`;
  }
  return { files, linked, removed: [...removed], annotated };
}
