// Naming standard for everything the studio creates in Fabric: [Domain]_[Object]_[Purpose]_[Environment],
// for example Retail_SM_Sales_DEMO. The project keeps the business domain and what the environment is for; every
// job asks here for the names of the items it creates. Items that already exist keep their names.
import { getProject, updateProject, logActivity } from './project.mjs';

export const ENVIRONMENTS = [
  { code: 'DEMO', intent: 'Demo or showcase', hint: 'Show Fabric to customers or colleagues, usually with sample data.' },
  { code: 'POC', intent: 'Proof of concept', hint: 'Try the approach on real data before committing to it.' },
  { code: 'DEV', intent: 'Development', hint: 'Build and change things freely; nobody relies on the numbers yet.' },
  { code: 'TEST', intent: 'Testing', hint: 'Check data, numbers and security before a release.' },
  { code: 'UAT', intent: 'User acceptance', hint: 'Business users sign off on what goes live.' },
  { code: 'PROD', intent: 'Production', hint: 'People rely on the numbers; changes go through review.' },
  { code: 'TRN', intent: 'Training or workshop', hint: 'Hands-on learning; safe to reset at any time.' },
  { code: 'SBX', intent: 'Personal sandbox', hint: 'Your own experiments.' },
];

export const OBJECTS = [
  { type: 'Workspace', code: 'WS', label: 'Workspace' },
  { type: 'Lakehouse', code: 'LH', label: 'Lakehouse' },
  { type: 'Warehouse', code: 'WH', label: 'Warehouse' },
  { type: 'SQLDatabase', code: 'SQLDB', label: 'SQL database' },
  { type: 'MirroredDatabase', code: 'MDB', label: 'Mirrored database' },
  { type: 'Connection', code: 'CONN', label: 'Connection' },
  { type: 'Notebook', code: 'NB', label: 'Notebook' },
  { type: 'DataPipeline', code: 'PL', label: 'Pipeline' },
  { type: 'SemanticModel', code: 'SM', label: 'Semantic model' },
  { type: 'Report', code: 'RPT', label: 'Report' },
  { type: 'OrgApp', code: 'APP', label: 'Org app' },
  { type: 'Ontology', code: 'ONT', label: 'Ontology' },
  { type: 'DataAgent', code: 'DA', label: 'Data agent' },
  { type: 'Plan', code: 'PLAN', label: 'Plan' },
  { type: 'Eventhouse', code: 'EH', label: 'Eventhouse' },
  { type: 'KQLDatabase', code: 'KQLDB', label: 'KQL database' },
  { type: 'Eventstream', code: 'ES', label: 'Eventstream' },
  { type: 'KQLQueryset', code: 'KQS', label: 'KQL queryset' },
  { type: 'KQLDashboard', code: 'RTD', label: 'Real-Time Dashboard' },
  { type: 'Reflex', code: 'ACT', label: 'Activator' },
  { type: 'TaskFlow', code: 'TF', label: 'Task flow' },
];
const CODE = Object.fromEntries(OBJECTS.map((o) => [o.type, o.code]));
const CODES = new Set(OBJECTS.map((o) => o.code));
const ENV_CODES = new Set(ENVIRONMENTS.map((e) => e.code));

// Words that only repeat the object type, so "Sales report" becomes the purpose "Sales".
const NOISE = {
  Workspace: ['workspace'], Lakehouse: ['lakehouse'], Warehouse: ['warehouse'], SQLDatabase: ['sql', 'database', 'db'],
  MirroredDatabase: ['mirror', 'mirrored', 'database', 'db'], Connection: ['connection'], Notebook: ['notebook'],
  DataPipeline: ['pipeline'], SemanticModel: ['semantic', 'model'], Report: ['report'], OrgApp: ['app'], Ontology: ['ontology'],
  DataAgent: ['agent'], Plan: ['plan'], Eventhouse: ['eventhouse'], KQLDatabase: ['database', 'db'], Eventstream: ['eventstream'],
  KQLQueryset: ['queryset'], KQLDashboard: ['dashboard'], Reflex: ['activator'], TaskFlow: ['task', 'flow'],
};

export const PATTERN = '[Domain]_[Object]_[Purpose]_[Environment]';
const STANDARD = /^([A-Za-z][A-Za-z0-9]*)_([A-Za-z0-9]+)_([A-Za-z0-9]+)_([A-Za-z0-9]+)$/;

const words = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
/** "contoso retail-sales" -> "ContosoRetailSales"; keeps the capitals inside words (AdventureWorks, KPI). */
export const pascal = (s) => words(s).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

export function cleanDomain(s) {
  let d = pascal(s);
  if (d && !/^[A-Za-z]/.test(d)) d = `D${d}`;
  return d.slice(0, 24);
}
export const cleanEnvironment = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

/** The parts of a name that follows the standard (null otherwise). */
export function parseName(name) {
  const m = STANDARD.exec(String(name ?? '').trim());
  if (!m || !CODES.has(m[2].toUpperCase())) return null;
  return { domain: m[1], code: m[2].toUpperCase(), purpose: m[3], environment: m[4] };
}

/** The purpose part of a name: "Retail_SM_Sales_DEMO" -> "Sales"; with a type, words like "Model" are left out. */
export function purposeOf(name, type) {
  const p = parseName(name);
  if (p) return p.purpose;
  if (type && String(name ?? '').trim()) return parseName(standardize(type, name))?.purpose || pascal(name);
  return pascal(name);
}

function defaultDomain(p) {
  return parseName(p.workspace?.name)?.domain || 'Data';
}

/** The project's naming settings, with defaults filled in. configured is false until the user confirms them. */
export function namingOf(p = getProject()) {
  const n = p.naming || {};
  const domain = cleanDomain(n.domain) || defaultDomain(p);
  const environment = cleanEnvironment(n.environment) || parseName(p.workspace?.name)?.environment?.toUpperCase() || 'DEV';
  const env = ENVIRONMENTS.find((e) => e.code === environment);
  return {
    domain, environment, intent: n.intent || env?.intent || environment,
    configured: Boolean(n.domain && n.environment && !n.inferred),
    inferred: Boolean(n.inferred),
  };
}

/** A name that follows the standard for an item type and a purpose. */
export function standardName(type, purpose, p = getProject()) {
  const { domain, environment } = namingOf(p);
  const code = CODE[type] || cleanEnvironment(type).slice(0, 5) || 'ITEM';
  // Stay within the strictest Fabric limit (89 characters for lakehouses, eventhouses, plans…).
  const room = 86 - domain.length - code.length - environment.length;
  const pur = (pascal(purpose) || 'Main').slice(0, Math.max(8, Math.min(40, room)));
  return `${domain}_${code}_${pur}_${environment}`;
}

/** Bring any name to the standard: a full standard name of this type is kept, anything else becomes the purpose. */
export function standardize(type, given, fallbackPurpose = 'Main', p = getProject()) {
  const s = String(given ?? '').trim();
  if (!s) return standardName(type, fallbackPurpose, p);
  const parsed = parseName(s);
  if (parsed && parsed.code === CODE[type]) return s;
  if (parsed) return standardName(type, parsed.purpose, p);
  const { domain, environment } = namingOf(p);
  const drop = new Set([domain.toLowerCase(), environment.toLowerCase(), ...(NOISE[type] || [])]);
  // Codes are only dropped when written in capitals, so a word like "Act" stays.
  const kept = words(s).filter((w) => !drop.has(w.toLowerCase()) && !(w === w.toUpperCase() && (CODES.has(w) || ENV_CODES.has(w))));
  return standardName(type, pascal(kept.join(' ')) || fallbackPurpose, p);
}

/**
 * The name for an item the studio is about to create or update.
 * current: the name of the item the project already has (kept, so nothing is renamed or duplicated);
 * known: other existing names that may be passed back as they are (e.g. reports already built).
 */
export function itemNameFor(type, { name, current, known = [], purpose } = {}, p = getProject()) {
  const s = String(name ?? '').trim();
  if (!s) return current || standardName(type, purpose, p);
  const same = [current, ...known].filter(Boolean).find((k) => k.toLowerCase() === s.toLowerCase());
  return same || standardize(type, s, purpose, p);
}

/** The next name when Fabric still reserves one: Retail_PLAN_Budget_DEMO -> Retail_PLAN_Budget2_DEMO. */
export function numberedName(name, n) {
  const x = parseName(name);
  return x ? `${x.domain}_${x.code}_${x.purpose}${n}_${x.environment}` : `${name}_${n}`;
}

/** The purpose a data source gives its items: "Contoso Retail (sample)" -> ContosoRetail, a database -> its name. */
export function sourcePurpose(src) {
  if (!src) return '';
  if (src.kind === 'sample') return pascal(String(src.label || src.id || '').replace(/\(.*\)/g, ' ')).slice(0, 24);
  if (src.method === 'mirror') return pascal(src.database).slice(0, 24);
  return String(purposeOf(src.itemName || src.label, src.itemType) || '').slice(0, 24);
}

/**
 * The purpose for an item every data source can have once (Eventhouse "Live", plan "Budget"…). With one data source
 * in the workspace it is the purpose as it is; when the workspace has others, the source's name goes first
 * (ContosoRetailLive), so each source keeps its own items. `src` is the source being set up when it isn't active yet.
 */
export function scopedPurpose(purpose, p = getProject(), src = p.source) {
  const others = (p.sources || []).some((e) => e.state && e.key !== p.sourceKey);
  if (!others) return purpose;
  const sp = sourcePurpose(src);
  return sp && !pascal(purpose).toLowerCase().startsWith(sp.toLowerCase()) ? `${sp}${pascal(purpose)}` : purpose;
}

/**
 * A name of this type that no other data source of the workspace uses: their items are never updated from this
 * source (Retail_SM_Sales_DEMO -> Retail_SM_Sales2_DEMO when another source has Retail_SM_Sales_DEMO).
 */
export function freeAcrossSources(type, name, p = getProject()) {
  const taken = new Set();
  for (const e of p.sources || []) {
    if (!e.state || e.key === p.sourceKey) continue;
    const st = e.state;
    const names = {
      SemanticModel: (st.semanticModels || []).filter((m) => m.origin !== 'existing').map((m) => m.name),
      Report: (st.reports || []).map((r) => r.name),
      Ontology: [st.ontology?.name],
      Lakehouse: [st.lakehouse?.name, st.modelSource?.itemType === 'Lakehouse' ? st.modelSource.itemName : null],
    }[type] || [];
    for (const n of names) if (n) taken.add(n.toLowerCase());
  }
  if (!taken.has(String(name).toLowerCase())) return name;
  for (let n = 2; n < 100; n++) { const x = numberedName(name, n); if (!taken.has(x.toLowerCase())) return x; }
  return name;
}

/** Use these defaults until the user chooses (sample data, or a workspace that already follows the standard). */
export function suggestNaming({ domain, environment }) {
  const p = getProject();
  if (p.naming?.domain && !p.naming.inferred) return namingOf(p);
  const cur = p.naming || {};
  const naming = {
    domain: cleanDomain(cur.domain) || cleanDomain(domain) || undefined,
    environment: cleanEnvironment(cur.environment) || cleanEnvironment(environment) || undefined,
    inferred: true,
  };
  if (naming.domain || naming.environment) updateProject({ naming: { ...naming, intent: ENVIRONMENTS.find((e) => e.code === naming.environment)?.intent } });
  return namingOf();
}

/** Save the naming settings. environment accepts a code (DEV) or an intent ("Proof of concept"). */
export function setNaming({ domain, environment, intent } = {}) {
  const p = getProject();
  const cur = namingOf(p);
  const d = domain === undefined ? cur.domain : cleanDomain(domain);
  if (!d) throw new Error('Enter the business domain, for example Sales, Finance or Retail.');
  const raw = String(environment ?? intent ?? '').trim();
  const match = ENVIRONMENTS.find((e) => e.code === cleanEnvironment(raw) || e.intent.toLowerCase() === raw.toLowerCase())
    || ENVIRONMENTS.find((e) => raw && e.intent.toLowerCase().includes(raw.toLowerCase()));
  const env = match?.code || cleanEnvironment(raw) || cur.environment;
  if (!env) throw new Error('Choose what the environment is for.');
  const naming = { domain: d, environment: env, intent: match?.intent || (intent && String(intent).slice(0, 60)) || env, inferred: false, setAt: new Date().toISOString() };
  updateProject({ naming });
  logActivity('naming.set', `Naming standard ${d}_[Object]_[Purpose]_${env} (${naming.intent})`, { domain: d, environment: env });
  return namingState();
}

/** What the UI and Copilot show: the settings, the choices and example names. */
export function namingState(p = getProject()) {
  const n = namingOf(p);
  const ex = (type, purpose) => ({ type, label: OBJECTS.find((o) => o.type === type)?.label || type, name: standardName(type, purpose, p) });
  return {
    ...n,
    pattern: PATTERN,
    environments: ENVIRONMENTS,
    objects: OBJECTS,
    examples: [ex('Workspace', 'Analytics'), ex('Lakehouse', 'Raw'), ex('SemanticModel', 'Sales'), ex('Report', 'Executive'), ex('DataAgent', 'Sales')],
  };
}
