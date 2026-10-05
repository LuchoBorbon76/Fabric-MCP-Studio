// Your own report templates: Power BI templates (.pbit), reports (.pbix), zipped Power BI projects (PBIR or
// PBIR-Legacy), report layouts (report.json) and Power BI themes (.json). Report templates are rebound to the project
// semantic model – fields are checked against it and matched by name where the template used other names – and
// themes join the theme list of the report designer.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, readJson, writeJson, newId } from '../config.mjs';
import { dax } from '../powerbi.mjs';
import { getProject, assertProjectTenant } from '../project.mjs';
import { pascal } from '../naming.mjs';
import { openZip, isZip, decodeText } from './zip.mjs';
import { setUploadedThemes, themeFromPowerBi } from './themes.mjs';
import { requireModel, reportNameFor, deployReport } from './index.mjs';

const DIR = join(DATA_DIR, 'report-templates');
export const MAX_UPLOAD = 300 * 1024 * 1024;
const MAX_PARTS_BYTES = 80 * 1024 * 1024;
const MAX_PART = 40 * 1024 * 1024;
export const ACCEPT = ['.pbit', '.pbix', '.zip', '.json'];

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const metaFile = (id) => join(DIR, `${id}.json`);
const partsFile = (id) => join(DIR, `${id}.parts.json`);
const validId = (id) => /^[0-9a-f-]{36}$/i.test(String(id));

// ---------------- library ----------------

/** Every uploaded template, newest first (without the files). */
export function listTemplates() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => /^[0-9a-f-]{36}\.json$/i.test(f))
    .map((f) => readJson(join(DIR, f), null)).filter(Boolean)
    .map(({ themeJson, ...meta }) => meta)
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
}

export function getTemplate(id) {
  if (!validId(id)) return null;
  const meta = readJson(metaFile(id), null);
  if (!meta) return null;
  const { themeJson, ...rest } = meta;
  return rest;
}

function syncThemes() {
  if (!existsSync(DIR)) { setUploadedThemes([]); return; }
  const themes = readdirSync(DIR).filter((f) => /^[0-9a-f-]{36}\.json$/i.test(f))
    .map((f) => readJson(join(DIR, f), null)).filter((m) => m?.kind === 'theme' && m.themeJson)
    .sort((a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt)))
    .map((m) => themeFromPowerBi(m.themeJson, { id: m.themeId, name: m.name }));
  setUploadedThemes(themes);
}
syncThemes();

export function removeTemplate(id) {
  if (!validId(id) || !existsSync(metaFile(id))) throw fail('That template isn\'t in your library.', 404);
  rmSync(metaFile(id), { force: true });
  rmSync(partsFile(id), { force: true });
  syncThemes();
  return { ok: true };
}

const baseName = (fileName) => String(fileName || 'Template').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').trim() || 'Template';

/** Read an uploaded file, keep what a report or theme needs, and add it to the library. */
export function importTemplate(fileName, bytes) {
  const ext = (String(fileName).match(/\.[^.]+$/)?.[0] || '').toLowerCase();
  if (!bytes?.length) throw fail('The file is empty.');
  if (!ACCEPT.includes(ext)) throw fail(`Upload a Power BI template (.pbit), report (.pbix), project (.zip) or theme (.json) – "${ext || fileName}" isn't supported.`);
  let found;
  if (ext === '.json') found = fromJson(fileName, bytes);
  else {
    if (!isZip(bytes)) throw fail(`${fileName} isn't a ${ext} file (it isn't a ZIP package).`);
    found = ext === '.zip' ? fromProjectZip(bytes) : fromPowerBiFile(bytes, ext);
  }
  const id = newId();
  const meta = { id, name: found.name || baseName(fileName), fileName: String(fileName).split(/[\\/]/).pop(), source: ext.slice(1), size: bytes.length, uploadedAt: new Date().toISOString() };
  if (found.kind === 'theme') {
    writeJson(metaFile(id), { ...meta, kind: 'theme', themeId: `upl-${id.slice(0, 8)}`, colors: themeFromPowerBi(found.json, { id: 'x', name: 'x' }).dataColors.slice(0, 6), notes: found.notes || [], themeJson: found.json });
    syncThemes();
    return getTemplate(id);
  }
  const summary = summarize(found.format, found.parts);
  if (!summary.pages.length) throw fail('The report in this file has no pages.');
  // A file called report.json or layout.json says nothing: name the template after its first page.
  if (/^(report|layout|definition|template)$/i.test(meta.name)) meta.name = summary.pages[0] || meta.name;
  const stored = Object.fromEntries(Object.entries(found.parts).map(([k, v]) => [k, v.toString('base64')]));
  writeJson(partsFile(id), stored);
  writeJson(metaFile(id), { ...meta, kind: 'report', name: meta.name, format: found.format, ...summary, notes: [...(found.notes || []), ...summary.notes] });
  return getTemplate(id);
}

// ---------------- reading the uploaded file ----------------

const isThemeJson = (j) => j && typeof j === 'object' && !Array.isArray(j) && !Array.isArray(j.sections) && ['dataColors', 'visualStyles', 'textClasses', 'background', 'foreground', 'tableAccent'].some((k) => k in j);

function fromJson(fileName, bytes) {
  let j;
  try { j = JSON.parse(decodeText(bytes)); } catch { throw fail(`${fileName} isn't valid JSON.`); }
  if (Array.isArray(j?.sections)) return { kind: 'report', format: 'PBIR-Legacy', parts: { 'report.json': Buffer.from(JSON.stringify(j), 'utf8') }, notes: ['Only the layout was uploaded: images and custom themes it refers to aren\'t included. Upload a .pbit or a zipped project to keep them.'] };
  if (isThemeJson(j)) return { kind: 'theme', name: String(j.name || '').trim() || baseName(fileName), json: j };
  throw fail(`${fileName} isn't a Power BI theme or report layout (report.json).`);
}

const KEEP = (rel) => rel === 'report.json' || rel.startsWith('definition/') || rel.startsWith('StaticResources/') || rel.startsWith('CustomVisuals/');

function collect(zip, pairs) {
  const parts = {};
  let total = 0;
  const tooBig = () => fail(`The report files are larger than ${MAX_PARTS_BYTES / 1048576} MB.`);
  for (const [entry, rel] of pairs) {
    if (rel.split('/').some((s) => s === '..' || s === '')) continue;
    const size = zip.size(entry);
    if (size > MAX_PART) throw fail(`${rel} is larger than ${MAX_PART / 1048576} MB.`);
    if (total + size > MAX_PARTS_BYTES) throw tooBig();
    const buf = zip.read(entry, { maxBytes: MAX_PART });
    // Count what was really read, not what the archive declares.
    total += buf.length;
    if (buf.length > MAX_PART || total > MAX_PARTS_BYTES) throw tooBig();
    parts[rel] = buf;
  }
  return parts;
}

/** .pbit and .pbix: the report lives under Report/ (Report/Layout for PBIR-Legacy, Report/definition/ for PBIR). */
function fromPowerBiFile(bytes, ext) {
  const zip = openZip(bytes);
  const pbir = zip.names.some((n) => n.startsWith('Report/definition/'));
  const pairs = [];
  for (const n of zip.names) {
    if (!n.startsWith('Report/')) continue;
    const rel = n.slice('Report/'.length);
    if (rel === 'Layout') { if (!pbir) pairs.push([n, 'report.json']); continue; }
    if (KEEP(rel) && rel !== 'report.json') pairs.push([n, rel]);
  }
  if (!pairs.some(([, r]) => r === 'report.json' || r === 'definition/report.json')) throw fail(`No report found in this ${ext} file.`);
  const parts = collect(zip, pairs);
  if (parts['report.json']) parts['report.json'] = Buffer.from(decodeText(parts['report.json']), 'utf8');
  return { kind: 'report', format: pbir ? 'PBIR' : 'PBIR-Legacy', parts, notes: [] };
}

/** The first Power BI theme in a ZIP: likely theme files first, with a cap on how much is read. */
function findTheme(zip, names) {
  const json = names.filter((n) => n.toLowerCase().endsWith('.json') && zip.size(n) < 2 * 1024 * 1024);
  const likely = (n) => (/theme/i.test(n) ? 0 : /StaticResources\//i.test(n) ? 1 : 2);
  let read = 0;
  for (const n of json.sort((a, b) => likely(a) - likely(b)).slice(0, 200)) {
    read += zip.size(n);
    if (read > 20 * 1024 * 1024) break;
    try {
      const j = JSON.parse(decodeText(zip.read(n, { maxBytes: 2 * 1024 * 1024 })));
      if (isThemeJson(j)) return [n, j];
    } catch { /* not JSON – keep looking */ }
  }
  return null;
}

/** A zipped Power BI project (the .Report folder, or a folder that contains one) – or a zipped .pbit/.pbix. */
function fromProjectZip(bytes) {
  const zip = openZip(bytes);
  const names = zip.names.filter((n) => !n.startsWith('__MACOSX/'));
  const roots = [];
  for (const n of names) {
    let root = null;
    if (/(^|\/)definition\.pbir$/i.test(n)) root = n.slice(0, n.length - 'definition.pbir'.length);
    else if (/(^|\/)definition\/report\.json$/i.test(n)) root = n.slice(0, n.length - 'definition/report.json'.length);
    else if (/(^|\/)report\.json$/i.test(n) && !/(^|\/)definition\/report\.json$/i.test(n)) root = n.slice(0, n.length - 'report.json'.length);
    if (root !== null && !roots.includes(root)) roots.push(root);
  }
  const usable = roots.filter((r) => names.some((n) => n === `${r}report.json` || n === `${r}definition/report.json`));
  if (!usable.length) {
    const inner = names.filter((n) => /\.(pbit|pbix)$/i.test(n));
    if (inner.length) {
      const found = fromPowerBiFile(zip.read(inner[0], { maxBytes: MAX_UPLOAD }), inner[0].slice(-5).toLowerCase());
      if (inner.length > 1) found.notes.push(`The ZIP has ${inner.length} Power BI files; the studio used ${inner[0].split('/').pop()}. Upload the others one at a time.`);
      return { ...found, name: baseName(inner[0]) };
    }
    const theme = findTheme(zip, names);
    if (theme) return { kind: 'theme', name: String(theme[1].name || '').trim() || baseName(theme[0]), json: theme[1] };
    throw fail('No Power BI report found in the ZIP. Zip the project\'s .Report folder (with definition.pbir and report.json or definition/), or a .pbit/.pbix file.');
  }
  usable.sort((a, b) => a.length - b.length);
  const root = usable[0];
  const pbir = names.includes(`${root}definition/report.json`);
  const pairs = names.filter((n) => n.startsWith(root)).map((n) => [n, n.slice(root.length)])
    .filter(([, rel]) => KEEP(rel) && !(pbir && rel === 'report.json'));
  const parts = collect(zip, pairs);
  if (parts['report.json']) parts['report.json'] = Buffer.from(decodeText(parts['report.json']), 'utf8');
  const notes = usable.length > 1 ? [`The ZIP has ${usable.length} reports; the studio used ${root.replace(/\/$/, '') || 'the top folder'}. Upload the others one at a time.`] : [];
  const folder = root.replace(/\/$/, '').split('/').pop();
  return { kind: 'report', format: pbir ? 'PBIR' : 'PBIR-Legacy', parts, notes, name: folder ? folder.replace(/\.Report$/i, '') : undefined };
}

// ---------------- field references ----------------

// Legacy layouts keep visual settings, filters and queries as JSON inside strings.
const JSON_STRINGS = new Set(['config', 'filters', 'query', 'dataTransforms']);
const REF_KINDS = { Column: 'column', Measure: 'measure', Hierarchy: 'hierarchy', PropertyVariationSource: 'hierarchy' };

/**
 * Walk a report JSON tree and call visit(ref) for every field reference ({ kind, entity, prop, extension }).
 * When map is given ({ entity(name) -> name|null, ref(ref) -> { entity, prop }|null }) the references are rewritten
 * in place: table renames go to the query's From list, fields that moved to another table get their own From entry.
 * Returns true when something changed.
 */
function walk(node, { visit, map } = {}, scope = new Map()) {
  let changed = false;
  if (Array.isArray(node)) {
    for (const x of node) changed = walk(x, { visit, map }, scope) || changed;
    return changed;
  }
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.From)) {
    scope = new Map(scope);
    for (const f of node.From) {
      if (!f || typeof f.Name !== 'string' || typeof f.Entity !== 'string') continue;
      scope.set(f.Name, { entity: f.Entity, schema: f.Schema, from: node.From, item: f });
      const to = map?.entity(f.Entity, f.Schema === 'extension');
      if (to && to !== f.Entity) { f.Entity = to; changed = true; }
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && JSON_STRINGS.has(k) && /^\s*[[{]/.test(v)) {
      let parsed;
      try { parsed = JSON.parse(v); } catch { continue; }
      if (walk(parsed, { visit, map }, scope)) { node[k] = JSON.stringify(parsed); changed = true; }
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && REF_KINDS[k] && v.Expression?.SourceRef) changed = ref(v, k, scope, { visit, map }) || changed;
    if (v && typeof v === 'object') changed = walk(v, { visit, map }, scope) || changed;
  }
  // A From entry nothing uses any more (its fields moved to other tables) must not point at a table the model lacks.
  if (map?.known && Array.isArray(node.From)) {
    const used = new Set();
    const scan = (x) => {
      if (Array.isArray(x)) { x.forEach(scan); return; }
      if (!x || typeof x !== 'object') return;
      if (x.SourceRef && typeof x.SourceRef.Source === 'string') used.add(x.SourceRef.Source);
      for (const [k, v] of Object.entries(x)) if (k !== 'From' || v !== node.From) scan(v);
    };
    scan(node);
    for (let i = node.From.length - 1; i >= 0; i -= 1) {
      const f = node.From[i];
      if (f && typeof f.Entity === 'string' && f.Schema !== 'extension' && !used.has(f.Name) && !map.known(f.Entity)) { node.From.splice(i, 1); changed = true; }
    }
  }
  return changed;
}

function ref(v, key, scope, { visit, map }) {
  const kind = REF_KINDS[key];
  const sr = v.Expression.SourceRef;
  const propKey = key === 'Hierarchy' ? 'Hierarchy' : 'Property';
  const prop = v[propKey];
  const alias = typeof sr.Source === 'string' ? scope.get(sr.Source) : null;
  const entity = alias ? alias.entity : sr.Entity;
  if (typeof entity !== 'string' || typeof prop !== 'string') return false;
  const r = { kind, entity, prop, extension: (sr.Schema || alias?.schema) === 'extension', variation: key === 'PropertyVariationSource' };
  visit?.(r);
  if (!map) return false;
  const to = map.ref(r);
  if (!to) return false;
  let changed = false;
  if (to.prop && to.prop !== prop) { v[propKey] = to.prop; changed = true; }
  if (to.entity && to.entity !== entity) {
    if (alias) {
      if (alias.item.Entity !== to.entity) {
        let f = alias.from.find((x) => x?.Entity === to.entity && (x.Schema || null) === (alias.item.Schema || null));
        if (!f) {
          const base = to.entity.replace(/[^A-Za-z]/g, '').slice(0, 1).toLowerCase() || 't';
          let name = base;
          for (let i = 1; alias.from.some((x) => x?.Name === name); i += 1) name = `${base}${i}`;
          f = { Name: name, Entity: to.entity, Type: alias.item.Type ?? 0 };
          alias.from.push(f);
          scope.set(name, { entity: to.entity, schema: undefined, from: alias.from, item: f });
        }
        sr.Source = f.Name;
        changed = true;
      }
    } else if (sr.Entity !== to.entity) { sr.Entity = to.entity; changed = true; }
  }
  return changed;
}

// ---------------- the report inside a template ----------------

const jsonPart = (buf) => { try { return JSON.parse(decodeText(buf)); } catch { return null; } };

/** Pages and visuals of a template, each visual with the field references it uses. */
function readReport(format, parts) {
  const pages = [];
  const units = [];
  const extensions = new Set();
  const extMeasures = [];
  const addExtensions = (entities) => {
    for (const t of entities || []) for (const m of t.measures || []) {
      extensions.add(`${t.name}|${m.name}`);
      extMeasures.push({ table: t.name, name: m.name, expression: typeof m.expression === 'string' ? m.expression : '' });
    }
  };
  if (format === 'PBIR-Legacy') {
    const layout = jsonPart(parts['report.json']);
    if (!layout) throw fail('The report layout (report.json) isn\'t valid JSON.');
    const cfg = typeof layout.config === 'string' ? (() => { try { return JSON.parse(layout.config); } catch { return {}; } })() : (layout.config || {});
    for (const e of cfg.modelExtensions || []) addExtensions(e.entities);
    for (const s of layout.sections || []) {
      pages.push(String(s.displayName || s.name || `Page ${pages.length + 1}`));
      for (const vc of s.visualContainers || []) {
        let c = {};
        try { c = JSON.parse(vc.config || '{}'); } catch { /* keep going */ }
        if (!c.singleVisual) continue;
        units.push({ page: pages[pages.length - 1], type: c.singleVisual.visualType || 'visual', node: vc });
      }
    }
    units.push({ page: null, type: null, node: { filters: layout.filters, sections: (layout.sections || []).map((s) => ({ filters: s.filters, config: s.config })), config: layout.config } });
  } else {
    const order = jsonPart(parts['definition/pages/pages.json'])?.pageOrder || [];
    const pageNames = new Map();
    for (const [path, buf] of Object.entries(parts)) {
      const m = path.match(/^definition\/pages\/([^/]+)\/page\.json$/);
      if (m) pageNames.set(m[1], String(jsonPart(buf)?.displayName || m[1]));
    }
    const ids = [...order.filter((id) => pageNames.has(id)), ...[...pageNames.keys()].filter((id) => !order.includes(id))];
    for (const id of ids) pages.push(pageNames.get(id));
    const ext = jsonPart(parts['definition/reportExtensions.json'] || Buffer.alloc(0));
    addExtensions(ext?.entities);
    for (const [path, buf] of Object.entries(parts)) {
      if (!path.startsWith('definition/') || !path.endsWith('.json')) continue;
      const m = path.match(/^definition\/pages\/([^/]+)\/visuals\/[^/]+\/visual\.json$/);
      const node = jsonPart(buf);
      if (!node) continue;
      if (m && node.visual) units.push({ page: pageNames.get(m[1]) || m[1], type: node.visual.visualType || 'visual', node });
      else units.push({ page: null, type: null, node });
    }
  }
  return { pages, units, extensions, extMeasures };
}

const refKey = (r) => `${r.dax ? 'dax:' : ''}${r.kind}|${r.entity}|${r.prop}`;

// ---------------- report-level measures (DAX) ----------------

/**
 * References in a DAX expression (outside strings and comments) with their positions: Table[Name] and [Name] (name set),
 * and tables on their own – 'Quoted Table' always, an unquoted word only when it isn't a function call (quoted: false;
 * callers keep those only when the word is a known table).
 */
function daxRefs(expr) {
  const s = String(expr || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      i += 1;
      while (i < s.length) { if (s[i] === '"') { if (s[i + 1] === '"') { i += 2; continue; } i += 1; break; } i += 1; }
      continue;
    }
    if ((ch === '/' && s[i + 1] === '/') || (ch === '-' && s[i + 1] === '-')) { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (ch === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    const start = i;
    let table = null;
    if (ch === "'") {
      let j = i + 1;
      let name = '';
      while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { name += "'"; j += 2; continue; } break; } name += s[j]; j += 1; }
      if (s[j + 1] !== '[') { out.push({ table: name, name: null, quoted: true, start, end: j + 1 }); i = j + 1; continue; }
      table = name;
      i = j + 1;
    } else if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[\w.]/.test(s[i - 1]))) {
      let j = i;
      while (j < s.length && /\w/.test(s[j])) j += 1;
      if (s[j] !== '[') {
        let k = j;
        while (k < s.length && /\s/.test(s[k])) k += 1;
        if (s[k] !== '(') out.push({ table: s.slice(i, j), name: null, quoted: false, start, end: j });
        i = j;
        continue;
      }
      table = s.slice(i, j);
      i = j;
    }
    if (s[i] !== '[') { i += 1; continue; }
    let j = i + 1;
    let name = '';
    while (j < s.length) { if (s[j] === ']') { if (s[j + 1] === ']') { name += ']'; j += 2; continue; } break; } name += s[j]; j += 1; }
    out.push({ table, name, start, end: j + 1 });
    i = j + 1;
  }
  return out;
}

const daxRef = (x) => (x.name === null
  ? { kind: 'table', entity: x.table, prop: '', dax: true }
  : x.table === null ? { kind: 'measure', entity: '', prop: x.name, dax: true } : { kind: 'column', entity: x.table, prop: x.name, dax: true });

/**
 * The references of a DAX expression as template refs: Table[Name] as a column (or measure), [Name] as a measure (or
 * column), and tables used on their own (ALL(Sales), COUNTROWS('Sales')). Unquoted words count as tables only when
 * isTable says so – DAX doesn't let a variable share a table's name.
 */
const daxFieldRefs = (expr, isTable) => daxRefs(expr).filter((x) => x.name !== null || x.quoted || isTable(x.table)).map(daxRef);

const daxQuote = (t) => `'${String(t).replace(/'/g, "''")}'`;
const daxName = (n) => `[${String(n).replace(/]/g, ']]')}]`;

/** Rewrite the references of a report-level measure to the model's tables and fields. */
function rewriteDax(expr, plan) {
  const tableTo = (e) => {
    const key = [...plan.entityMap.keys()].find((k) => k.toLowerCase() === String(e).toLowerCase());
    const to = key === undefined ? null : plan.entityMap.get(key);
    return to && to !== e ? to : null;
  };
  let out = '';
  let last = 0;
  for (const x of daxRefs(expr)) {
    let rep = null;
    if (x.name === null) {
      if (!x.quoted && !plan.tableKnown(x.table)) continue;
      const to = tableTo(x.table);
      if (to) rep = daxQuote(to);
    } else {
      const res = plan.result.get(refKey(daxRef(x)));
      if (res?.to) rep = res.to.entity ? `${daxQuote(res.to.entity)}${daxName(res.to.prop)}` : daxName(res.to.prop);
      else if (x.table !== null && tableTo(x.table)) rep = `${daxQuote(tableTo(x.table))}${daxName(x.name)}`;
    }
    if (rep === null) continue;
    out += expr.slice(last, x.start) + rep;
    last = x.end;
  }
  return out + expr.slice(last);
}
function summarize(format, parts) {
  const { pages, units, extensions } = readReport(format, parts);
  const refs = new Map();
  const types = {};
  let visuals = 0;
  for (const u of units) {
    if (u.type) { visuals += 1; types[u.type] = (types[u.type] || 0) + 1; }
    walk(u.node, { visit: (r) => { if (!refs.has(refKey(r))) refs.set(refKey(r), r); } });
  }
  const list = [...refs.values()];
  const customVisuals = [...new Set(Object.keys(parts).filter((p) => p.startsWith('CustomVisuals/')).map((p) => p.split('/')[1]))];
  const images = Object.keys(parts).filter((p) => p.startsWith('StaticResources/RegisteredResources/') && /\.(png|jpe?g|gif|svg|bmp|webp)$/i.test(p)).length;
  const notes = [];
  if (list.some((r) => r.variation)) notes.push('Some visuals use Power BI\'s automatic date hierarchy. Direct Lake models don\'t have it: use your date table\'s columns in those visuals.');
  return {
    pages, visuals, visualTypes: types, images, customVisuals,
    tables: [...new Set(list.filter((r) => !r.extension).map((r) => r.entity))].sort(),
    fields: { measures: list.filter((r) => r.kind === 'measure').length, columns: list.filter((r) => r.kind === 'column').length, hierarchies: list.filter((r) => r.kind === 'hierarchy').length, reportMeasures: extensions.size },
    notes,
  };
}

// ---------------- matching to the semantic model ----------------

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const normTable = (s) => norm(s).replace(/^(dim|fact|fct|tbl|vw)(?=.)/, '').replace(/(?<=.)(dim|fact|fct|tbl)$/, '').replace(/s$/, '');
const fieldText = (e, p) => (p === '' ? String(e) : `${e || ''}[${p}]`);

async function modelFields(workspaceId, datasetId) {
  const [tables, columns, measures] = await Promise.all([
    dax(workspaceId, datasetId, 'EVALUATE SELECTCOLUMNS(INFO.VIEW.TABLES(), "Name", [Name])'),
    dax(workspaceId, datasetId, 'EVALUATE SELECTCOLUMNS(INFO.VIEW.COLUMNS(), "Table", [Table], "Name", [Name], "Type", [Type])'),
    dax(workspaceId, datasetId, 'EVALUATE SELECTCOLUMNS(INFO.VIEW.MEASURES(), "Table", [Table], "Name", [Name])'),
  ]);
  return {
    tables: tables.map((t) => t.Name),
    columns: columns.filter((c) => c.Type !== 'RowNumber' && !/^RowNumber-/.test(c.Name)).map((c) => ({ table: c.Table, name: c.Name })),
    measures: measures.map((m) => ({ table: m.Table, name: m.Name })),
  };
}

/**
 * Decide where each field of the template lives in the model: same name, same name written differently, or the only
 * field with that name in another table. Returns the plan (entity and field mappings) and a readable result.
 */
function matchFields(refs, model, extensions, extHosts = new Map()) {
  const tableByLower = new Map(model.tables.map((t) => [t.toLowerCase(), t]));
  const colsOf = new Map();
  for (const c of model.columns) {
    if (!colsOf.has(c.table)) colsOf.set(c.table, []);
    colsOf.get(c.table).push(c.name);
  }
  const findIn = (list, name) => list.find((x) => x === name) || list.find((x) => x.toLowerCase() === name.toLowerCase()) || list.find((x) => norm(x) === norm(name)) || null;
  const measureByName = (name) => {
    const exact = model.measures.filter((m) => m.name.toLowerCase() === name.toLowerCase());
    if (exact.length) return exact.find((m) => m.name === name) || exact[0];
    const loose = model.measures.filter((m) => norm(m.name) === norm(name));
    return loose.length === 1 ? loose[0] : null;
  };
  const columnAnywhere = (name) => {
    const hits = model.columns.filter((c) => norm(c.name) === norm(name));
    return hits.length === 1 ? hits[0] : null;
  };

  const entityMap = new Map();
  const mappedTable = (e) => {
    if (entityMap.has(e)) return entityMap.get(e);
    const key = [...entityMap.keys()].find((k) => k.toLowerCase() === String(e).toLowerCase());
    return key === undefined ? null : entityMap.get(key);
  };
  const byEntity = new Map();
  for (const r of refs) {
    if (r.extension || !r.entity) continue;
    if (!byEntity.has(r.entity)) byEntity.set(r.entity, []);
    byEntity.get(r.entity).push(r);
  }
  // Tables that only hold report-level measures still have to exist in the model.
  const extEntities = new Set([...extensions].map((k) => k.slice(0, k.indexOf('|'))).filter(Boolean));
  for (const e of extEntities) if (!byEntity.has(e)) byEntity.set(e, []);
  for (const [e, list] of byEntity) {
    let t = tableByLower.get(e.toLowerCase()) || null;
    if (!t) {
      const same = model.tables.filter((x) => normTable(x) === normTable(e));
      if (same.length === 1) [t] = same;
    }
    if (!t) {
      // Vote: tables that have the entity's columns, and the tables its measures live in.
      const votes = new Map();
      const counted = list.filter((r) => r.kind === 'column' || r.kind === 'measure');
      for (const r of counted) {
        const homes = r.kind === 'measure'
          ? [measureByName(r.prop)?.table].filter(Boolean)
          : [...colsOf].filter(([, names]) => findIn(names, r.prop)).map(([table]) => table);
        for (const table of homes) votes.set(table, (votes.get(table) || 0) + 1);
      }
      const like = (x) => (normTable(x).includes(normTable(e)) || normTable(e).includes(normTable(x)) ? 1 : 0);
      const ranked = [...votes].sort((a, b) => b[1] - a[1] || like(b[0]) - like(a[0]));
      const [best, next] = ranked;
      const tied = next && next[1] === best[1] && like(next[0]) === like(best[0]);
      if (best && !tied && best[1] >= (like(best[0]) ? 1 : Math.max(1, Math.ceil(counted.length / 2)))) [t] = best;
    }
    entityMap.set(e, t);
  }

  const extNames = new Set([...extensions].map((k) => k.slice(k.indexOf('|') + 1).toLowerCase()));
  const resolve = () => {
    const result = new Map();
    for (const r of refs) {
      const key = refKey(r);
      const t = entityMap.get(r.entity) || null;
      if (r.kind === 'table') {
        const to = mappedTable(r.entity) || tableByLower.get(r.entity.toLowerCase()) || null;
        result.set(key, !to ? { status: 'missing' } : to === r.entity ? { status: 'ok' } : { status: 'mapped', to: { entity: to, prop: '' } });
        continue;
      }
      if (r.extension || extensions.has(`${r.entity}|${r.prop}`) || (r.dax && !r.entity && extNames.has(r.prop.toLowerCase()))) {
        result.set(key, { status: 'report', to: t && t !== r.entity ? { entity: t, prop: r.prop } : null });
        continue;
      }
      if (r.kind === 'measure') {
        const m = measureByName(r.prop);
        if (r.dax && !r.entity) {
          // [Name] in DAX: a measure, or a column of the table being iterated.
          const c = m ? null : columnAnywhere(r.prop);
          const name = m?.name || c?.name;
          result.set(key, !name ? { status: 'missing' } : name === r.prop ? { status: 'ok' } : { status: 'mapped', to: { entity: null, prop: name } });
        } else if (!m) result.set(key, { status: 'missing' });
        else result.set(key, m.table === r.entity && m.name === r.prop ? { status: 'ok' } : { status: 'mapped', to: { entity: m.table, prop: m.name } });
        continue;
      }
      if (r.kind === 'hierarchy') {
        result.set(key, t ? { status: 'unchecked', to: t !== r.entity ? { entity: t, prop: r.prop } : null } : { status: 'missing' });
        continue;
      }
      const inT = t ? findIn(colsOf.get(t) || [], r.prop) : null;
      if (inT) result.set(key, t === r.entity && inT === r.prop ? { status: 'ok' } : { status: 'mapped', to: { entity: t, prop: inT } });
      else {
        const c = columnAnywhere(r.prop);
        // Table[Measure] is valid DAX too.
        const m = !c && r.dax ? measureByName(r.prop) : null;
        const to = c ? { entity: c.table, prop: c.name } : m ? { entity: m.table, prop: m.name } : null;
        result.set(key, !to ? { status: 'missing' } : to.entity === r.entity && to.prop === r.prop ? { status: 'ok' } : { status: 'mapped', to });
      }
    }
    return result;
  };
  let result = resolve();

  // Report-level measures need a host table in the model. One the model doesn't have (a "Key Measures" table, say)
  // moves to the table their DAX uses most, or else the model's largest table.
  let moved = false;
  for (const e of extEntities) {
    if (entityMap.get(e)) continue;
    const tally = new Map();
    for (const r of extHosts.get(e) || []) {
      const res = result.get(refKey(r));
      const to = res?.to?.entity || (res?.status === 'ok' && r.entity ? tableByLower.get(r.entity.toLowerCase()) : null);
      if (to) tally.set(to, (tally.get(to) || 0) + 1);
    }
    const host = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] || [...colsOf].sort((a, b) => b[1].length - a[1].length)[0]?.[0] || model.tables[0] || null;
    if (host) { entityMap.set(e, host); moved = true; }
  }
  if (moved) result = resolve();
  return { entityMap, result };
}
/** Check a template against the project semantic model (read-only). */
export async function checkTemplate(id) {
  const { plan, ...result } = await analyze(id);
  return result;
}

async function analyze(id) {
  const meta = getTemplate(id);
  if (!meta) throw fail('That template isn\'t in your library.', 404);
  if (meta.kind !== 'report') throw fail('Themes don\'t need a check – pick it in the Theme list.');
  await assertProjectTenant();
  const p = requireModel();
  const parts = loadParts(id);
  const { units, extensions, extMeasures } = readReport(meta.format, parts);
  const model = await modelFields(p.workspace.id, p.semanticModel.id);
  const refs = new Map();
  const perVisual = [];
  for (const u of units) {
    const keys = new Set();
    walk(u.node, { visit: (r) => { refs.set(refKey(r), r); keys.add(refKey(r)); } });
    if (u.type) perVisual.push({ page: u.page, type: u.type, keys });
  }
  // Report-level measures: the fields and tables their DAX uses must be in the model too.
  const known = new Set([...[...refs.values()].map((r) => r.entity), ...[...extensions].map((k) => k.slice(0, k.indexOf('|'))), ...extMeasures.flatMap((m) => daxRefs(m.expression).filter((x) => x.table !== null && (x.name !== null || x.quoted)).map((x) => x.table)), ...model.tables].filter(Boolean).map((x) => x.toLowerCase()));
  const isTable = (name) => known.has(String(name).toLowerCase());
  const usedBy = new Map();
  const extHosts = new Map();
  const extDeps = extMeasures.map((m) => {
    const deps = daxFieldRefs(m.expression, isTable);
    if (!extHosts.has(m.table)) extHosts.set(m.table, []);
    extHosts.get(m.table).push(...deps);
    return { m, keys: deps.map((r) => { const k = refKey(r); refs.set(k, r); if (!usedBy.has(k)) usedBy.set(k, m.name); return k; }) };
  });
  const { entityMap, result } = matchFields([...refs.values()], model, extensions, extHosts);
  for (const { m, keys } of extDeps) {
    if (!keys.some((k) => result.get(k)?.status === 'missing')) continue;
    for (const [k, r] of refs) if (!r.dax && r.kind === 'measure' && r.prop === m.name && r.entity === m.table) result.set(k, { ...result.get(k), status: 'missing', broken: true });
  }
  const list = [...refs.entries()].map(([key, r]) => ({ ...r, ...result.get(key), key }));
  const missingKeys = new Set(list.filter((x) => x.status === 'missing').map((x) => x.key));
  const checked = list.filter((x) => x.status !== 'unchecked');
  const good = checked.filter((x) => x.status !== 'missing').length;
  return {
    template: { id: meta.id, name: meta.name },
    model: p.semanticModel.name,
    total: list.length,
    found: list.filter((x) => x.status === 'ok' || x.status === 'report').length,
    coverage: checked.length ? Math.round((good / checked.length) * 100) : 100,
    mapped: list.filter((x) => x.status === 'mapped').map((x) => ({ kind: x.kind, from: fieldText(x.entity, x.prop), to: fieldText(x.to.entity, x.to.prop) })),
    missing: list.filter((x) => x.status === 'missing').map((x) => ({ kind: x.broken ? 'report measure' : x.kind, field: fieldText(x.entity, x.prop), ...(x.dax ? { via: usedBy.get(x.key) } : {}) })),
    unchecked: list.filter((x) => x.status === 'unchecked').map((x) => ({ kind: x.kind, field: fieldText(x.entity, x.prop) })),
    tables: [...entityMap].filter(([e, t]) => t && t !== e).map(([from, to]) => ({ from, to })),
    visuals: perVisual.length,
    visualsAffected: perVisual.filter((v) => [...v.keys].some((k) => missingKeys.has(k))).length,
    pagesAffected: [...new Set(perVisual.filter((v) => [...v.keys].some((k) => missingKeys.has(k))).map((v) => v.page))],
    plan: { entityMap, result, tables: new Set(model.tables), tableKnown: isTable },
  };
}

function loadParts(id) {
  const stored = readJson(partsFile(id), null);
  if (!stored) throw fail('The template\'s files are missing – upload it again.', 404);
  return Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
}

/** The template's files, rebound to the project semantic model with its fields matched to the model. */
function rebind(meta, parts, plan, semanticModelId) {
  const map = {
    entity: (e) => plan.entityMap.get(e) || null,
    known: (e) => plan.tables.has(e),
    ref: (r) => plan.result.get(refKey(r))?.to || (plan.entityMap.get(r.entity) && plan.entityMap.get(r.entity) !== r.entity ? { entity: plan.entityMap.get(r.entity), prop: r.prop } : null),
  };
  const renameExtensions = (entities) => {
    let changed = false;
    for (const t of entities || []) {
      const to = plan.entityMap.get(t.name);
      if (to && to !== t.name) { t.name = to; changed = true; }
      if (typeof t.extends === 'string' && plan.entityMap.get(t.extends) && plan.entityMap.get(t.extends) !== t.extends) { t.extends = plan.entityMap.get(t.extends); changed = true; }
      for (const m of t.measures || []) {
        if (typeof m.expression !== 'string') continue;
        const x = rewriteDax(m.expression, plan);
        if (x !== m.expression) { m.expression = x; changed = true; }
      }
    }
    // Two report tables that now point at the same model table become one.
    for (let i = (entities || []).length - 1; i > 0; i -= 1) {
      const first = entities.findIndex((t) => t.name === entities[i].name);
      if (first < i) { entities[first].measures = [...(entities[first].measures || []), ...(entities[i].measures || [])]; entities.splice(i, 1); changed = true; }
    }
    return changed;
  };
  const files = {};
  for (const [path, buf] of Object.entries(parts)) {
    const isJson = path === 'report.json' || (path.startsWith('definition/') && path.endsWith('.json'));
    if (!isJson) { files[path] = buf; continue; }
    const node = jsonPart(buf);
    if (!node) { files[path] = buf; continue; }
    walk(node, { map });
    if (path === 'report.json' && typeof node.config === 'string') {
      try {
        const cfg = JSON.parse(node.config);
        if ((cfg.modelExtensions || []).map((e) => renameExtensions(e.entities)).some(Boolean)) node.config = JSON.stringify(cfg);
      } catch { /* leave the config as it is */ }
    }
    if (path === 'definition/reportExtensions.json') renameExtensions(node.entities);
    files[path] = node;
  }
  files['definition.pbir'] = { $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json', version: '4.0', datasetReference: { byConnection: { connectionString: `semanticmodelid=${semanticModelId}` } } };
  return files;
}

/** Build a report from an uploaded template on the project semantic model and deploy it. */
export async function runTemplateReport(ctx, { id, name, preview = true } = {}) {
  const meta = getTemplate(id);
  if (!meta) throw fail('That template isn\'t in your library – upload it again.', 404);
  if (meta.kind !== 'report') throw fail('This is a theme: pick it in the designer\'s Theme list and build a report.');
  const p = requireModel();
  ctx.step(`Match the template's fields to ${p.semanticModel.name}`);
  const check = await analyze(id);
  ctx.log(`${meta.pages.length} page${meta.pages.length === 1 ? '' : 's'} · ${meta.visuals} visuals · ${check.total} fields: ${check.found} found, ${check.mapped.length} matched by name, ${check.missing.length} not in the model`);
  for (const t of check.tables) ctx.log(`Table ${t.from} → ${t.to}`);
  for (const m of check.mapped.slice(0, 25)) ctx.log(`${m.from} → ${m.to}`);
  if (check.mapped.length > 25) ctx.log(`…and ${check.mapped.length - 25} more matched by name`);
  if (check.missing.length) ctx.log(`Not in the model: ${check.missing.slice(0, 12).map((m) => m.field).join(', ')}${check.missing.length > 12 ? ` and ${check.missing.length - 12} more` : ''}. ${check.visualsAffected} visual${check.visualsAffected === 1 ? '' : 's'} will show an error until you pick other fields in Power BI.`);
  for (const n of meta.notes || []) ctx.log(n);
  ctx.progress(30);

  const reportName = reportNameFor(p, name, pascal(meta.name) || 'Template');
  const files = rebind(meta, loadParts(id), check.plan, p.semanticModel.id);
  ctx.log(`${Object.keys(files).length} definition parts (${meta.format})`);
  ctx.progress(40);
  let deployed;
  try {
    deployed = await deployReport(ctx, {
      reportName, files, preview,
      description: `Power BI report from the template ${meta.name}, built by Fabric MCP Studio on ${p.semanticModel.name}.`,
      entry: { theme: null, pages: meta.pages, template: { id: meta.id, name: meta.name } },
    });
  } catch (e) {
    // Private custom visuals can't always be imported: try again without them.
    const cv = Object.keys(files).filter((k) => k.startsWith('CustomVisuals/'));
    if (!cv.length || !/customvisual|definition|part|path/i.test(e.message)) throw e;
    ctx.log(`Fabric didn't accept the template's private custom visuals (${e.message.split('\n')[0]}). Deploying without them – visuals that use them show an error.`);
    for (const k of cv) delete files[k];
    deployed = await deployReport(ctx, {
      reportName, files, preview,
      description: `Power BI report from the template ${meta.name}, built by Fabric MCP Studio on ${p.semanticModel.name}.`,
      entry: { theme: null, pages: meta.pages, template: { id: meta.id, name: meta.name } },
    });
  }
  const { entry } = deployed;
  return { id: entry.id, name: reportName, url: entry.url, pages: entry.pages, fields: { found: check.found, mapped: check.mapped.length, missing: check.missing.map((m) => m.field) } };
}

/** What the library holds, in words Copilot can use. */
export function describeTemplates() {
  return listTemplates().map((t) => (t.kind === 'theme'
    ? { id: t.id, kind: 'theme', name: t.name, themeId: t.themeId, use: `theme "${t.themeId}" in studio_create_report / studio_propose_report` }
    : { id: t.id, kind: 'report', name: t.name, source: t.source, format: t.format, pages: t.pages, visuals: t.visuals, tables: t.tables, notes: t.notes }));
}

