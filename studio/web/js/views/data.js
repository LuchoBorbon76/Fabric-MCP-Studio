import { store, get, post, del, on } from '../api.js';
import { h, toast, busy, field, input, select, seg, fmtNum, fmtDate, confirmDialog, $ } from '../ui.js';
import { app, copilotSlot } from '../app.js';
import { askCard } from '../prompts.js';
import { standardName, pascal } from '../naming.js';

const TOKEN = document.querySelector('meta[name="studio-token"]').content;
let tab = 'samples';
let selectedType = null;
let wiz = null;           // wizard state for database sources
let fabricState = { itemType: 'Lakehouse', workspaceId: '', itemId: '', tables: [], selected: new Set() };
let alignedTo;            // data source the tabs below were last filled from
let workspaceNames = null;
let prepOn = false;       // "also create a data prep notebook" when a lakehouse becomes the data source
let prepTarget = 'new';   // where the notebook writes: a new curated lakehouse, or the same lakehouse
// After a clean up or a new project, nothing picked from Fabric is still valid.
on('studio.reset', () => { selectedType = null; wiz = null; fabricState = { itemType: 'Lakehouse', workspaceId: '', itemId: '', tables: [], selected: new Set() }; alignedTo = undefined; workspaceNames = null; });

const ITEM_LABEL = { Lakehouse: 'Lakehouse', Warehouse: 'Warehouse', MirroredDatabase: 'Mirrored database', SQLDatabase: 'SQL database' };
const ITEM_ICON = { Lakehouse: '🏞️', Warehouse: '🏛️', MirroredDatabase: '🪞', SQLDatabase: '🗄️' };
const ITEM_PATH = { Lakehouse: 'lakehouses', Warehouse: 'warehouses', MirroredDatabase: 'mirroreddatabases', SQLDatabase: 'sqldatabases' };
const METHOD_LABEL = {
  files: 'Parquet files loaded into Lakehouse tables',
  'sql-database': 'Fabric SQL database, replicated to OneLake automatically',
  mirror: 'Fabric Mirroring (near real-time replication into OneLake)',
  'in-place': 'Used in place – no data copied',
  shortcut: 'OneLake shortcuts in the project lakehouse – no data copied',
};
const itemUrl = (type, ws, id) => `https://app.fabric.microsoft.com/groups/${ws}${ITEM_PATH[type] && id ? `/${ITEM_PATH[type]}/${id}` : ''}`;
const sourceKey = (p) => (p.modelSource ? [p.source?.kind, p.source?.method, p.source?.itemId, p.modelSource.itemId].join('|') : '');

/** The Fabric item that holds the current data – what you would pick under "Existing Fabric data". */
function originItem(p) {
  const ms = p.modelSource;
  const s = p.source || {};
  if (s.kind === 'fabric' && s.itemId) {
    const typeOf = (store.catalog?.sources || []).find((x) => x.id === s.type)?.itemType;
    const itemType = s.itemType || (ITEM_LABEL[s.type] ? s.type : typeOf) || ms.itemType;
    const itemName = s.itemName || (s.method === 'in-place' ? ms.itemName : (s.label || '').match(/· (.+) \(shortcuts\)$/)?.[1] || '');
    return { itemType, itemName, workspaceId: s.workspaceId || ms.workspaceId, itemId: s.itemId };
  }
  return { itemType: ms.itemType, itemName: ms.itemName, workspaceId: ms.workspaceId, itemId: ms.itemId };
}

const mirroredDatabaseName = (s) => s.database || (s.label || '').split(' · ').slice(1).join(' · ');

/** Open the tab that matches the connected source, with its details filled in (once per source, so user choices stick). */
function alignWithSource(p) {
  const key = sourceKey(p);
  if (key === alignedTo) return;
  alignedTo = key;
  if (!p.modelSource) return;
  const s = p.source || {};
  tab = s.kind === 'database' ? 'databases' : s.kind === 'fabric' ? 'fabric' : 'samples';
  const o = originItem(p);
  fabricState = { itemType: ITEM_LABEL[o.itemType] ? o.itemType : 'Lakehouse', workspaceId: o.workspaceId, itemId: o.itemId, itemName: o.itemName, tables: [], selected: new Set() };
  const t = s.kind === 'database' ? (store.catalog?.sources || []).find((x) => x.id === s.type) : null;
  if (t) { selectedType = t.id; wiz = newWizard(t, p); }
}

/** Wizard state for a database source – filled in from the project when that source is the one in use. */
function newWizard(t, p) {
  const s = p.modelSource && p.source?.kind === 'database' && p.source.type === t.id ? p.source : null;
  return {
    step: 1, typeId: t.id, auth: t.auth[0], tables: null, selected: new Set(),
    values: s ? { server: s.server || '', database: mirroredDatabaseName(s), ...(s.port ? { port: String(s.port) } : {}) } : {},
    connectionId: s?.connectionId || '', connectionName: s?.connectionName || '',
    connMode: s?.connectionId || !t.connectionCredentials.includes('Basic') ? 'existing' : 'new',
    mirrorName: s ? p.modelSource.itemName : undefined,
  };
}

function workspaceLabel(p, id) {
  if (id === p.workspace?.id) return h('span', {}, `${p.workspace.name} (project workspace)`);
  const el = h('span', { class: 'muted' }, '…');
  const set = () => { el.className = ''; el.textContent = workspaceNames?.get(id) || id; };
  if (workspaceNames) set();
  else get('/fabric/workspaces').then((ws) => { workspaceNames = new Map(ws.map((w) => [w.id, w.name])); set(); }).catch(() => set());
  return el;
}

export function renderData(el) {
  const p = store.project || {};
  alignWithSource(p);
  if (!p.workspace) {
    el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Select a workspace first. '), 'Data lands in the project workspace.'), h('button', { class: 'btn pri', onclick: () => app.go('workspace') }, 'Choose workspace')));
  }
  if (p.modelSource) el.append(currentSource(p));
  if (p.modelSource?.itemType === 'Lakehouse') el.append(dataPrepCard());
  if (p.modelSource) el.append(askCard({ title: 'Ask about your data', only: ['data'] }));

  const body = h('div');
  el.append(h('div', { class: 'card' },
    h('div', { class: 'row sp' },
      h('div', {}, h('h2', {}, p.modelSource ? 'Change the data source' : 'Bring in data'), h('p', { class: 'lead' }, 'Start from scratch with sample data, mirror your own databases, or reuse data that is already in Fabric.')),
      seg([{ value: 'samples', label: 'Sample data' }, { value: 'databases', label: 'Your databases' }, { value: 'fabric', label: 'Existing Fabric data' }], tab, (v) => { tab = v; draw(); })),
    body));
  const draw = () => { body.innerHTML = ''; body.append(tab === 'samples' ? samples() : tab === 'databases' ? databases() : fabricData()); };
  draw();
  el.append(copilotSlot());
}

function currentSource(p) {
  const ms = p.modelSource;
  const s = p.source || {};
  const o = originItem(p);
  const sample = s.kind === 'sample' ? (store.catalog?.samples || []).find((x) => x.id === s.id) : null;
  const dbType = s.kind === 'database' ? (store.catalog?.sources || []).find((x) => x.id === s.type) : null;
  const itemLabel = `${ITEM_LABEL[o.itemType] || o.itemType} · ${o.itemName || ms.itemName}`;

  const kv = h('dl', { class: 'kv mt' });
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') kv.append(h('dt', {}, k), h('dd', {}, v)); };
  add('Source', sample ? `Sample data · ${sample.name}` : dbType ? `${dbType.name} · ${[s.server, mirroredDatabaseName(s)].filter(Boolean).join(' / ')}` : itemLabel);
  add('How it lands', METHOD_LABEL[s.method] || METHOD_LABEL['in-place']);
  if (s.connectionId) add('Fabric connection', s.connectionName || h('span', { class: 'mono tiny' }, s.connectionId));
  add('Fabric item', h('a', { href: itemUrl(o.itemType, o.workspaceId, o.itemId), target: '_blank', rel: 'noopener' }, `${itemLabel} ↗`));
  add('Workspace', workspaceLabel(p, o.workspaceId));
  if (s.method === 'shortcut') add('Project lakehouse', h('a', { href: itemUrl('Lakehouse', ms.workspaceId, ms.itemId), target: '_blank', rel: 'noopener' }, `${ms.itemName} ↗`));
  add('SQL analytics endpoint', h('span', { class: 'mono small' }, ms.server));
  add('Database', ms.database);
  const stats = h('span', { class: 'muted' }, h('span', { class: 'spin' }), ' Reading tables from the SQL analytics endpoint…');
  add('Tables', stats);
  const data = p.steps?.data;
  if (data?.at) add('Connected', `${fmtDate(data.at)}${data.note ? ` · ${data.note}` : ''}`);

  const tablesBox = h('div');
  const mirrorBox = h('div', { class: 'mt' });
  const load = (refresh) => {
    get(`/model/describe${refresh ? '?refresh=1' : ''}`).then((d) => {
      const rows = d.tables.reduce((a, t) => a + (Number(t.rows) || 0), 0);
      stats.className = '';
      stats.textContent = `${d.tables.length} tables · ${fmtNum(rows)} rows · ${d.relationships.length} relationships`;
      tablesBox.innerHTML = '';
      if (!d.tables.length) { tablesBox.append(h('div', { class: 'banner warn mt' }, 'No tables yet. If the data was just loaded or mirrored, wait a minute and refresh.')); return; }
      const t = h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Table'), h('th', { class: 'num' }, 'Rows'), h('th', { class: 'num' }, 'Columns'), h('th', {}, 'Key')));
      for (const x of d.tables) {
        const k = x.columns.find((c) => c.isPk || c.isKey);
        t.append(h('tr', {}, h('td', {}, `${x.schema}.${x.name}`), h('td', { class: 'num' }, fmtNum(x.rows)), h('td', { class: 'num' }, x.columns.length), h('td', { class: 'mono tiny' }, k?.name || '–')));
      }
      tablesBox.append(h('details', { class: 'mt', open: true }, h('summary', { class: 'small' }, 'Tables, row counts and keys'), h('div', { class: 'scroll mt' }, t)));
    }).catch((e) => { stats.className = ''; stats.textContent = ''; stats.append(h('span', { class: 'pill err' }, 'Not readable'), ` ${e.message}`); });
    if (ms.itemType === 'MirroredDatabase') {
      get('/sources/current/mirroring').then((d) => { if (d.status || d.tables?.length) renderMirrorTables(mirrorBox, d); }).catch((e) => { mirrorBox.innerHTML = ''; mirrorBox.append(h('div', { class: 'banner warn mt' }, e.message)); });
    }
  };
  load(false);

  return h('div', { class: 'card', style: { marginBottom: '14px' } },
    h('div', { class: 'row sp' },
      h('div', {}, h('div', { class: 'row' }, h('h2', {}, s.kind === 'fabric' ? `${itemLabel}${s.method === 'shortcut' ? ' (shortcuts)' : ''}` : s.label || ms.itemName), h('span', { class: 'pill ok' }, 'Connected')),
        h('div', { class: 'muted small' }, `${ITEM_LABEL[ms.itemType] || ms.itemType} · ${ms.itemName} · ${METHOD_LABEL[s.method] || METHOD_LABEL['in-place']}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn', title: 'Read the tables and status again', onclick: () => { stats.className = 'muted'; stats.innerHTML = '<span class="spin"></span> Reading tables from the SQL analytics endpoint…'; load(true); } }, '↻ Refresh'),
        h('a', { class: 'btn', href: itemUrl(o.itemType, o.workspaceId, o.itemId), target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗'),
        h('button', { class: 'btn ai', onclick: () => app.ask('Describe my data source: tables, row counts, keys and relationships. Then suggest a star schema.') }, '✦ Explain my data'),
        h('button', { class: 'btn pri', onclick: () => app.go('model') }, 'Next: semantic model →'))),
    kv, tablesBox, mirrorBox);
}

/** One-line reminder in tabs that don't match the connected source. */
function inUseNote(p) {
  if (!p.modelSource) return null;
  return h('div', { class: 'banner mb' }, h('div', {}, h('b', {}, 'Current data source: '), `${p.source?.kind === 'fabric' ? `${ITEM_LABEL[originItem(p).itemType] || ''} · ${originItem(p).itemName}` : p.source?.label || p.modelSource.itemName}. `, 'Choosing a source here replaces it for the semantic model and ontology.'));
}

// ---------------- data prep notebook (lakehouse sources) ----------------
const PREP_WHAT = 'A Fabric Python notebook that finds every table in the lakehouse and works out from the data: clearer column names, logged data fixes, keys and relationships, measures with matching DAX, curated tables and charts. Nothing in it is specific to one dataset, so it can be run again as the data changes.';

/** The checkbox shown wherever a lakehouse becomes the data source. */
function prepOption() {
  const box = h('input', { type: 'checkbox', checked: prepOn || undefined });
  box.addEventListener('change', () => { prepOn = box.checked; });
  return h('label', { class: 'row small mt', style: { alignItems: 'flex-start', gap: '8px', cursor: 'pointer' }, title: PREP_WHAT }, box,
    h('span', {}, h('b', {}, 'Also create a data prep notebook (Python)'), h('span', { class: 'tiny muted', style: { display: 'block' } },
      'Renames columns, fixes data, finds relationships, adds measures and draws bar, pie, trend and other charts. Curated tables go to a new curated lakehouse; the source is never changed.')));
}

async function startDataPrep({ run = true, target = prepTarget } = {}) {
  const job = await post('/jobs/data-prep', { run, target });
  app.watchJob(job.id);
  toast(run ? 'Creating and running the data prep notebook – a few minutes' : 'Creating the data prep notebook', 'ok');
  return job;
}

const runningPrepJob = () => [...store.jobs.values()].find((j) => j.kind === 'data-prep' && j.status === 'running');
const chartUrl = (file, at) => `/api/data-prep/charts/${encodeURIComponent(file)}?t=${encodeURIComponent(TOKEN)}&v=${encodeURIComponent(at || '')}`;

function kpiValue(k) {
  const v = Number(k.value);
  if (String(k.format).endsWith('%')) return `${(v * 100).toFixed(1)}%`;
  return String(k.format).includes('.') ? v.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : Math.round(v).toLocaleString();
}

/** Data prep notebook for the current lakehouse: create and run it, then the curated tables, KPIs and charts. */
function dataPrepCard() {
  const card = h('div', { class: 'card', style: { marginBottom: '14px' } });
  let state = null;
  const offs = [];
  const alive = () => { if (card.isConnected || !state) return true; offs.forEach((f) => f()); return false; };
  const load = () => get('/data-prep').then((s) => { state = s; draw(); }).catch((e) => { card.innerHTML = ''; card.append(h('div', { class: 'banner err' }, e.message)); });
  offs.push(on('project.updated', () => { if (alive()) load(); }));
  offs.push(on('job', (e) => { if (e.job.kind === 'data-prep' && alive()) draw(); }));

  function draw() {
    card.innerHTML = '';
    const s = state;
    if (!s?.available) return;
    const dp = s.current ? s.dataPrep : null;
    const run = dp?.lastRun;
    const job = runningPrepJob();
    const pill = job ? h('span', { class: 'pill brand' }, 'Running…') : !dp ? h('span', { class: 'pill' }, 'Not created') : run?.status === 'Completed' ? h('span', { class: 'pill ok' }, 'Ran successfully') : run?.status && run.status !== 'InProgress' ? h('span', { class: 'pill err' }, `Last run ${String(run.status).toLowerCase()}`) : run?.status === 'InProgress' ? h('span', { class: 'pill brand' }, 'Running in Fabric') : h('span', { class: 'pill ok' }, 'Created');
    card.append(h('div', { class: 'row sp' },
      h('div', {}, h('div', { class: 'row' }, h('h2', {}, '📓 Data prep notebook'), pill), h('p', { class: 'lead', style: { maxWidth: '900px' } }, PREP_WHAT))));

    if (job) card.append(h('div', { class: 'mt' }, app.jobCard(job)));
    else if (!dp) card.append(createControls(s));
    else card.append(details(s, dp));
    if (dp && run?.status === 'Completed' && run.summary) card.append(results(run));
    else if (dp && run?.error && !job) card.append(h('div', { class: 'banner err mt' }, h('div', {}, h('b', {}, 'The last run stopped. '), run.error)));
    else if (dp && run?.warning && !job) card.append(h('div', { class: 'banner warn mt' }, h('div', {}, run.warning, ' Open the notebook in Fabric to see its output, then select Check results.')));
  }

  function createControls(s) {
    const runBox = h('input', { type: 'checkbox', checked: true });
    const hint = h('div', { class: 'tiny muted' });
    const setHint = () => { hint.textContent = prepTarget === 'same' ? `Back to ${s.source.name} with the Curated_ prefix; the source tables are never changed.` : `A new lakehouse in the project workspace; ${s.source.name} is never changed.`; };
    const targetSeg = seg([{ value: 'new', label: `New lakehouse ${s.plannedTarget.name}` }, { value: 'same', label: 'Same lakehouse (Curated_ tables)' }], prepTarget, (v) => { prepTarget = v; setHint(); });
    setHint();
    const btn = h('button', { class: 'btn pri', 'data-busy': 'Starting…' }, 'Create notebook');
    btn.addEventListener('click', busy(btn, async () => { await startDataPrep({ run: runBox.checked, target: prepTarget }); draw(); }));
    return h('div', { class: 'mt' },
      h('div', { class: 'small', style: { fontWeight: 600, marginBottom: '4px' } }, 'Write the curated tables to'), targetSeg, hint,
      h('label', { class: 'row small mt', style: { cursor: 'pointer' } }, runBox, 'Run it now (a few minutes in a Python session)'),
      h('div', { class: 'row mt' }, btn, h('button', { class: 'btn ai', onclick: () => app.ask('Create and run the data prep notebook for my lakehouse, then tell me what it renamed, fixed and found.') }, '✦ Ask Copilot')));
  }

  function details(s, dp) {
    const run = dp.lastRun;
    const kv = h('dl', { class: 'kv mt' });
    const add = (k, v) => { if (v) kv.append(h('dt', {}, k), h('dd', {}, v)); };
    add('Notebook', dp.notebook ? h('a', { href: dp.notebook.url, target: '_blank', rel: 'noopener' }, `${dp.notebook.name} ↗`) : null);
    add('Reads', `${dp.source.name} – every table, found when it runs`);
    add('Writes', dp.target ? h('a', { href: dp.target.url, target: '_blank', rel: 'noopener' }, `${dp.target.name}${dp.target.same ? ' (Curated_ tables)' : ''} ↗`) : null);
    add('Last run', run ? `${String(run.status)}${run.endedAt ? ` · ${fmtDate(run.endedAt)}` : run.startedAt ? ` · started ${fmtDate(run.startedAt)}` : ''}` : 'Not run yet');
    const again = h('button', { class: 'btn pri', 'data-busy': 'Starting…', title: 'Regenerates the notebook and runs it' }, run ? 'Run again' : 'Run now');
    again.addEventListener('click', busy(again, async () => { await startDataPrep({ run: true, target: dp.target?.same ? 'same' : 'new' }); draw(); }));
    const check = h('button', { class: 'btn', 'data-busy': 'Reading…', title: 'Read the results again, e.g. after running the notebook in Fabric yourself' }, '↻ Check results');
    check.addEventListener('click', busy(check, async () => { state = await post('/data-prep/refresh'); draw(); }));
    const useIt = dp.target && !dp.target.same && run?.status === 'Completed' ? h('button', { class: 'btn', 'data-busy': 'Switching…', title: 'Build the semantic model, ontology and reports on the curated tables' }, `Use ${dp.target.name} as the data source`) : null;
    useIt?.addEventListener('click', busy(useIt, async () => {
      await post('/sources/in-place', { workspaceId: dp.target.workspaceId, itemId: dp.target.id, itemType: 'Lakehouse' });
      toast(`Using ${dp.target.name}`, 'ok');
      await app.refresh();
    }));
    const remove = h('button', { class: 'btn ghost', 'data-busy': 'Removing…' }, 'Remove');
    remove.addEventListener('click', busy(remove, async () => {
      const what = dp.target?.created && !dp.target.same ? `the notebook ${dp.notebook.name} and the lakehouse ${dp.target.name} (with its curated tables)` : `the notebook ${dp.notebook.name}`;
      if (!await confirmDialog('Remove the data prep notebook?', `This deletes ${what} from Fabric. Your source data is not touched.`, 'Delete', true)) return;
      state = await del('/data-prep?delete=1').then(() => get('/data-prep'));
      draw();
    }));
    return h('div', {}, kv, h('div', { class: 'row mt' }, again, check, h('a', { class: 'btn', href: dp.notebook.url, target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗'), useIt,
      h('button', { class: 'btn ai', onclick: () => app.ask('Summarize the data prep notebook results: what it renamed and fixed, the relationships and KPIs it found, and what the charts show.') }, '✦ Explain the results'), remove));
  }

  function results(run) {
    const r = run.summary;
    const box = h('div', { class: 'mt' });
    const stat = (n, label) => h('div', { class: 'card', style: { padding: '10px 14px', minWidth: '120px' } }, h('div', { style: { fontSize: '22px', fontWeight: 700 } }, fmtNum(n)), h('div', { class: 'tiny muted' }, label));
    box.append(h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } },
      stat(r.tables.length, 'curated tables'), stat(r.relationships.length, 'relationships found'), stat(r.renames, 'columns renamed'),
      stat(r.fixes, 'values fixed'), stat(r.findings, 'kept for review'), stat(r.kpis.length, 'KPIs with DAX'), stat((run.charts || []).filter((c) => c.file).length, 'charts')));

    const charts = (run.charts || []).filter((c) => c.file && c.local);
    if (charts.length) {
      const grid = h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill,minmax(360px,1fr))', alignItems: 'start', marginTop: '12px' } });
      for (const c of charts) {
        grid.append(h('figure', { class: 'card', style: { margin: 0, padding: '10px' } },
          h('a', { href: chartUrl(c.file, run.endedAt), target: '_blank', rel: 'noopener', title: 'Open full size' }, h('img', { src: chartUrl(c.file, run.endedAt), alt: c.title, loading: 'lazy', style: { width: '100%', borderRadius: '6px', border: '1px solid var(--line)', background: '#fff' } })),
          h('figcaption', { class: 'small mt' }, h('b', {}, c.title), c.insight ? h('div', { class: 'tiny muted' }, c.insight) : null)));
      }
      box.append(h('h3', { class: 'mt' }, 'Charts'), grid);
    }

    if (r.kpis.length) {
      const multi = new Set(r.kpis.map((k) => k.table)).size > 1;
      const t = h('table', { class: 't' }, h('tr', {}, multi ? h('th', {}, 'Table') : null, h('th', {}, 'Measure'), h('th', { class: 'num' }, 'Value'), h('th', {}, 'DAX for your semantic model')));
      for (const k of r.kpis) t.append(h('tr', {}, multi ? h('td', {}, k.table) : null, h('td', {}, k.measure), h('td', { class: 'num' }, kpiValue(k)), h('td', { class: 'mono tiny' }, k.dax)));
      box.append(h('details', { class: 'mt', open: true }, h('summary', { class: 'small' }, multi ? `KPIs (${r.kpis.length})` : `KPIs on ${r.main}`), h('div', { class: 'scroll mt' }, t)));
    }
    const tt = h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Source table'), h('th', {}, 'Curated table'), h('th', {}, 'Role'), h('th', {}, 'Key'), h('th', { class: 'num' }, 'Rows'), h('th', { class: 'num' }, 'Columns'), h('th', { class: 'num' }, 'Renamed')));
    for (const x of r.tables) tt.append(h('tr', {}, h('td', {}, x.source), h('td', {}, x.table), h('td', {}, x.role), h('td', { class: 'mono tiny' }, x.key || '–'), h('td', { class: 'num' }, fmtNum(x.rows)), h('td', { class: 'num' }, x.columns), h('td', { class: 'num' }, x.renamed)));
    box.append(h('details', { class: 'mt' }, h('summary', { class: 'small' }, `Curated tables (${r.tables.length})${r.outputs?.length ? ` + ${r.outputs.join(', ')}` : ''}`), h('div', { class: 'scroll mt' }, tt)));
    if (r.relationships.length) {
      const rt = h('table', { class: 't' }, h('tr', {}, h('th', {}, 'From'), h('th', {}, 'Column'), h('th', {}, 'To'), h('th', {}, 'Key'), h('th', { class: 'num' }, 'Values found')));
      for (const x of r.relationships) rt.append(h('tr', {}, h('td', {}, x.from), h('td', { class: 'mono tiny' }, x.column), h('td', {}, x.to), h('td', { class: 'mono tiny' }, x.key), h('td', { class: 'num' }, `${Math.round(x.coverage * 100)}%`)));
      box.append(h('details', { class: 'mt' }, h('summary', { class: 'small' }, `Relationships found from the data (${r.relationships.length})`), h('div', { class: 'scroll mt' }, rt)));
    }
    if (r.skipped?.length) box.append(h('details', { class: 'mt' }, h('summary', { class: 'small muted' }, `Skipped (${r.skipped.length})`), h('ul', { class: 'tiny muted' }, r.skipped.map((x) => h('li', {}, x)))));
    return box;
  }

  load();
  return card;
}

// ---------------- job helper ----------------
function watch(container, job, onDone, onData) {
  const render = (j) => { container.innerHTML = ''; container.append(app.jobCard(j)); };
  render(job);
  app.watchJob(job.id);
  const off1 = on('job', (e) => {
    if (e.job.id !== job.id) return;
    render(e.job);
    if (e.job.status !== 'running') { off1(); off2(); onDone?.(e.job); }
  });
  const off2 = on('job.data', (e) => { if (e.jobId === job.id) onData?.(e.payload); });
}

function requireWs() {
  if (!store.project?.workspace) { toast('Select a workspace first.', 'err'); app.go('workspace'); return false; }
  return true;
}

// ---------------- samples ----------------
function samples() {
  const p = store.project || {};
  const [retail, aw] = store.catalog?.samples || [];
  const inUse = (id) => p.modelSource && p.source?.kind === 'sample' && p.source.id === id;
  const inUseBanner = (id) => (inUse(id) ? h('div', { class: 'banner ok mt' }, h('div', {}, h('b', {}, 'In use. '), `${ITEM_LABEL[p.modelSource.itemType] || p.modelSource.itemType} ${p.modelSource.itemName} in ${p.workspace?.name || 'the project workspace'} – tables, keys and row counts are shown above.`)) : null);
  const out = h('div', {}, p.modelSource && p.source?.kind !== 'sample' ? inUseNote(p) : null);
  const grid = h('div', { class: 'grid g2' });
  out.append(grid);

  const rJob = h('div', { class: 'mt' });
  const rBtn = h('button', { class: 'btn pri big', 'data-busy': 'Starting…', title: inUse(retail.id) ? 'Uploads the files and reloads the tables' : null }, inUse(retail.id) ? 'Load again' : 'Load sample');
  rBtn.addEventListener('click', busy(rBtn, async () => {
    if (!requireWs()) return;
    const withPrep = prepOn;
    const job = await post('/jobs/sample');
    watch(rJob, job, (j) => {
      if (j.status !== 'succeeded') return;
      toast('Sample data is ready', 'ok');
      app.refresh();
      if (withPrep) startDataPrep().catch((e) => toast(e.message, 'err'));
    });
  }));
  grid.append(h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('div', { class: 'src', style: { cursor: 'default', border: 0, padding: 0 } }, h('div', { class: 'h' }, h('div', { class: 'ic' }, '🛍️'), retail.name)), inUse(retail.id) ? h('span', { class: 'pill ok' }, 'In use') : null),
    h('p', { class: 'small' }, retail.tagline), h('div', { class: 'tiny muted' }, retail.details),
    h('div', { class: 'row mt' }, h('span', { class: 'pill brand' }, retail.lands), h('span', { class: 'pill' }, retail.needs), h('span', { class: 'pill' }, `~${retail.minutes} min`)),
    inUseBanner(retail.id),
    inUse(retail.id) ? null : prepOption(),
    h('div', { class: 'row mt' }, rBtn, h('button', { class: 'btn ai', onclick: () => app.ask('Load the Contoso Retail sample data into my workspace, then tell me what tables were created.') }, '✦ Ask Copilot')),
    rJob));

  const awJob = h('div', { class: 'mt' });
  const awBtn = h('button', { class: 'btn pri big', 'data-busy': 'Starting…', title: inUse(aw.id) ? 'Reuses the database when its data is complete and verified' : null }, inUse(aw.id) ? 'Check again' : 'Create in my workspace');
  awBtn.addEventListener('click', busy(awBtn, async () => {
    if (!requireWs()) return;
    const job = await post('/jobs/sample', { dataset: 'adventureworks' });
    watch(awJob, job, (j) => { if (j.status === 'succeeded') { toast('AdventureWorksDW2022 is ready', 'ok'); app.refresh(); } });
  }));
  grid.append(h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('div', { class: 'src', style: { cursor: 'default', border: 0, padding: 0 } }, h('div', { class: 'h' }, h('div', { class: 'ic' }, '🚲'), aw.name)), inUse(aw.id) ? h('span', { class: 'pill ok' }, 'In use') : null),
    h('p', { class: 'small' }, aw.tagline), h('div', { class: 'tiny muted' }, aw.details),
    h('div', { class: 'row mt' }, h('span', { class: 'pill brand' }, aw.lands), h('span', { class: 'pill' }, aw.needs), h('span', { class: 'pill' }, `~${aw.minutes} min`)),
    inUse(aw.id) ? null : h('ul', { class: 'pre tiny' },
      h('li', {}, 'Creates the SQL database AdventureWorksDW2022 in the project workspace and loads Microsoft\'s official AdventureWorksDW install kit (tables, keys, views and data).'),
      h('li', {}, 'Fabric replicates the tables to OneLake automatically; the semantic model and ontology use that replica.'),
      h('li', {}, 'Uses your Microsoft Entra sign-in. No Azure subscription, passwords or connections needed.')),
    inUseBanner(aw.id),
    h('div', { class: 'row mt' }, awBtn, h('button', { class: 'btn ai', onclick: () => app.ask('Create the AdventureWorksDW2022 sample in my workspace (studio_load_sample_data with dataset adventureworks), then describe the tables that were created.') }, '✦ Ask Copilot')),
    awJob));
  return out;
}
// ---------------- databases ----------------
function databases() {
  const p = store.project || {};
  const types = (store.catalog?.sources || []).filter((s) => s.engine);
  const mirrored = p.modelSource && p.source?.kind === 'database' ? p.source : null;
  const box = h('div');
  if (p.modelSource && !mirrored) box.append(inUseNote(p));
  if (mirrored) {
    const t = types.find((x) => x.id === mirrored.type);
    box.append(h('div', { class: 'banner ok mb' }, h('div', {}, h('b', {}, 'In use. '), `${t?.name || 'Your database'} ${mirroredDatabaseName(mirrored)} is mirrored into ${p.modelSource.itemName}. Its details are filled in below; the live replication status is shown above.`)));
  }
  const cards = h('div', { class: 'srcs' });
  for (const t of types) {
    cards.append(h('div', { class: `src ${selectedType === t.id ? 'on' : ''}`, onclick: () => { if (selectedType === t.id) return; selectedType = t.id; wiz = newWizard(t, p); redraw(); } },
      h('div', { class: 'h' }, h('div', { class: 'ic' }, { sql: '🗄️', server: '🏢', pg: '🐘' }[t.icon] || '🗄️'), t.name, mirrored?.type === t.id ? h('span', { class: 'pill ok', style: { marginLeft: 'auto' } }, 'In use') : null),
      h('div', { class: 'meta' }, `${t.group} · Fabric Mirroring${t.gateway ? ' · on-premises data gateway' : ''}`)));
  }
  const redraw = () => { box.innerHTML = ''; box.append(databases()); };
  box.append(cards);
  if (selectedType && wiz) box.append(wizard(types.find((t) => t.id === selectedType), redraw));
  else box.append(h('p', { class: 'small muted mt' }, 'Pick a source. Credentials are sent straight to Microsoft Fabric to create a connection – they are never shared with the AI.'));
  return box;
}

function wizard(t, redraw) {
  const w = wiz;
  const el = h('div', { class: 'wizard' });
  const steps = ['Source', 'Fabric connection', 'Mirror'];
  el.append(h('div', { class: 'wsteps' }, steps.map((s, i) => h('span', { class: w.step === i + 1 ? 'on' : w.step > i + 1 ? 'done' : '' }, `${i + 1}. ${s}`))));

  if (w.step === 1) {
    const inputs = {};
    const fields = t.fields.map((f) => { inputs[f.id] = input({ placeholder: f.placeholder, value: w.values[f.id] || '' }); return field(f.label + (f.required ? ' *' : ''), inputs[f.id]); });
    const read = () => { for (const f of t.fields) w.values[f.id] = inputs[f.id].value.trim(); };
    const authBox = h('div');
    const drawAuth = () => {
      authBox.innerHTML = '';
      const a = w.auth;
      w.creds = w.creds || {};
      const c = w.creds;
      const mk = (k, label, type = 'text', ph = '') => { const i = input({ type, placeholder: ph, value: c[k] || '' }); i.addEventListener('input', () => { c[k] = i.value; }); return field(label, i); };
      if (a === 'Basic') authBox.append(h('div', { class: 'formgrid' }, mk('username', 'Login'), mk('password', 'Password', 'password')));
      else if (a === 'Windows') authBox.append(h('div', { class: 'formgrid' }, mk('domain', 'Domain'), mk('username', 'User'), mk('password', 'Password', 'password')));
      else if (a === 'ServicePrincipal') authBox.append(h('div', { class: 'formgrid' }, mk('tenantId', 'Tenant ID'), mk('clientId', 'Client ID'), mk('clientSecret', 'Client secret', 'password')));
      else authBox.append(h('div', {}, h('p', { class: 'tiny muted' }, t.engine === 'postgres' ? 'Uses your Microsoft Entra sign-in. Enter the Entra user or group name configured on the server as login if it differs from your account.' : 'Uses your Microsoft Entra sign-in.'), t.engine === 'postgres' ? h('div', { class: 'formgrid' }, mk('username', 'Entra login (optional)')) : null));
    };
    drawAuth();
    const result = h('div', { class: 'mt' });
    const authOf = () => ({ type: w.auth, ...(w.creds || {}) });
    const testBtn = h('button', { class: 'btn', 'data-busy': 'Connecting…' }, 'Test connection');
    testBtn.addEventListener('click', busy(testBtn, async () => {
      read();
      const r = await post('/sources/test', { typeId: t.id, ...w.values, auth: authOf() });
      result.innerHTML = '';
      result.append(h('div', { class: 'banner ok' }, h('div', {}, h('b', {}, 'Connected. '), `${r.version} · database ${r.database} · ${r.tables} tables`)));
    }));
    const discBtn = h('button', { class: 'btn', 'data-busy': 'Reading schema…' }, 'Discover tables');
    discBtn.addEventListener('click', busy(discBtn, async () => {
      read();
      const d = await post('/sources/discover', { typeId: t.id, ...w.values, auth: authOf() });
      w.tables = d.tables;
      w.relationships = d.relationships;
      w.selected = new Set(d.tables.map((x) => `${x.schema}.${x.name}`));
      result.innerHTML = '';
      result.append(h('div', { class: 'banner ok' }, `${d.tables.length} tables · ${d.relationships.length} relationships (${d.relationships[0]?.source || 'none'})`), tablePicker(w.tables, w.selected));
    }));
    if (w.tables) result.append(tablePicker(w.tables, w.selected));
    const next = h('button', { class: 'btn pri', onclick: () => { read(); if (!w.values.server || !w.values.database) { toast('Server and database are required.', 'err'); return; } w.step = 2; redraw(); } }, 'Next →');
    el.append(
      h('div', { class: 'grid g2' },
        h('div', { class: 'col' }, h('h3', {}, t.name), h('div', { class: 'formgrid' }, fields),
          h('div', { class: 'hr' }),
          h('div', { class: 'row sp' }, h('b', { class: 'small' }, 'Optional: test from this computer'), seg(t.auth.map((a) => ({ value: a, label: { Entra: 'Entra ID', Basic: 'SQL login', ServicePrincipal: 'Service principal', Windows: 'Windows' }[a] || a })), w.auth, (v) => { w.auth = v; drawAuth(); })),
          authBox, h('div', { class: 'row' }, testBtn, discBtn), h('p', { class: 'tiny muted' }, 'Testing needs network access from this computer. Fabric connects separately (cloud or gateway).')),
        h('div', { class: 'col' }, h('h3', {}, 'Before you start'), h('ul', { class: 'pre' }, t.prerequisites.map((x) => h('li', {}, x))), h('a', { href: t.docs, target: '_blank', rel: 'noopener', class: 'small' }, 'Mirroring documentation ↗'))),
      result,
      h('div', { class: 'row mt' }, next));
  }

  if (w.step === 2) {
    const allowNew = t.connectionCredentials.filter((c) => c !== 'Existing');
    const body = h('div');
    const drawConn = () => {
      body.innerHTML = '';
      if (w.connMode === 'existing') {
        const list = h('div', { class: 'scroll' }, h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading connections…'));
        const load = async () => {
          try {
            const [conns, gws] = await Promise.all([get('/fabric/connections'), get('/fabric/gateways')]);
            const gwName = new Map(gws.map((g) => [g.id, g.name]));
            const rows = conns.filter((c) => c.type === t.connectionType);
            list.innerHTML = '';
            if (!rows.length) { list.append(h('div', { class: 'empty' }, `No ${t.connectionType} connections yet.`)); return; }
            const tbl = h('table', { class: 't' }, h('tr', {}, h('th', {}, ''), h('th', {}, 'Connection'), h('th', {}, 'Path'), h('th', {}, 'Type')));
            for (const c of rows) {
              const r = h('input', { type: 'radio', name: 'conn', checked: w.connectionId === c.id || undefined });
              r.addEventListener('change', () => { w.connectionId = c.id; w.connectionName = c.name; });
              tbl.append(h('tr', {}, h('td', {}, r), h('td', {}, h('b', {}, c.name)), h('td', { class: 'mono tiny' }, c.path || ''), h('td', {}, c.gatewayId ? h('span', { class: 'pill' }, `Gateway: ${gwName.get(c.gatewayId) || 'on-premises'}`) : h('span', { class: 'pill brand' }, c.connectivityType || 'Cloud'))));
            }
            list.append(tbl);
          } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'banner err' }, e.message)); }
        };
        load();
        body.append(h('div', {}, list, h('div', { class: 'row mt' },
          h('button', { class: 'btn', onclick: load }, '↻ Refresh'),
          h('a', { class: 'btn', href: 'https://app.fabric.microsoft.com/groups/me/gateways', target: '_blank', rel: 'noopener' }, 'Manage connections and gateways in Fabric ↗')),
          t.gateway ? h('p', { class: 'tiny muted' }, 'On-premises sources use an on-premises data gateway. Create the connection in Fabric (your gateway encrypts the credentials), then select it here.') : null));
      } else {
        w.cred = w.cred || { type: allowNew[0] };
        const c = w.cred;
        const credBox = h('div');
        const drawCred = () => {
          credBox.innerHTML = '';
          const mk = (k, label, type = 'text') => { const i = input({ type, value: c[k] || '' }); i.addEventListener('input', () => { c[k] = i.value; }); return field(label, i); };
          if (c.type === 'Basic') credBox.append(h('div', { class: 'formgrid' }, mk('username', 'Login'), mk('password', 'Password', 'password')));
          if (c.type === 'ServicePrincipal') credBox.append(h('div', { class: 'formgrid' }, mk('tenantId', 'Tenant ID'), mk('clientId', 'Client ID'), mk('clientSecret', 'Client secret', 'password')));
          if (c.type === 'WorkspaceIdentity') credBox.append(h('p', { class: 'small muted' }, 'Uses the workspace identity (no secrets). Provision it in Workspace settings › Workspace identity, then grant it access in the database: CREATE USER [<workspace name>] FROM EXTERNAL PROVIDER; ALTER ROLE db_owner ADD MEMBER [<workspace name>];'));
        };
        drawCred();
        const name = input({ value: standardName('Connection', `${pascal(w.values.database)}${pascal(String(w.values.server || '').split('.')[0])}`) });
        const cbtn = h('button', { class: 'btn pri', 'data-busy': 'Creating connection…' }, 'Create connection');
        cbtn.addEventListener('click', busy(cbtn, async () => {
          const r = await post('/sources/connection', { typeId: t.id, server: w.values.server, database: w.values.database, port: w.values.port, credential: c, name: name.value });
          w.connectionId = r.id; w.connectionName = r.name;
          c.password = ''; c.clientSecret = '';
          toast('Fabric connection created', 'ok');
          w.step = 3; redraw();
        }));
        body.append(h('div', { class: 'col' },
          field('Connection name', name),
          field('Authentication', seg(allowNew.map((x) => ({ value: x, label: { Basic: 'SQL login', ServicePrincipal: 'Service principal', WorkspaceIdentity: 'Workspace identity' }[x] || x })), c.type, (v) => { c.type = v; drawCred(); })),
          credBox,
          h('p', { class: 'tiny muted' }, 'Fabric tests the connection when it is created. Microsoft Entra (OAuth) connections must be created in Fabric because they need an interactive sign-in – use "Existing connection" for those.'),
          h('div', { class: 'row' }, cbtn)));
      }
    };
    drawConn();
    el.append(
      h('div', { class: 'row sp' }, h('h3', {}, `Fabric connection to ${w.values.server}`), seg([...(allowNew.length ? [{ value: 'new', label: 'Create new' }] : []), { value: 'existing', label: 'Use existing' }], w.connMode, (v) => { w.connMode = v; drawConn(); })),
      body,
      h('div', { class: 'row mt' }, h('button', { class: 'btn', onclick: () => { w.step = 1; redraw(); } }, '← Back'), h('button', { class: 'btn pri', onclick: () => { if (!w.connectionId) { toast('Select or create a connection.', 'err'); return; } w.step = 3; redraw(); } }, 'Next →')));
  }

  if (w.step === 3) {
    const name = input({ value: w.mirrorName || standardName('MirroredDatabase', w.values.database || 'Database') });
    const job = h('div', { class: 'mt' });
    const live = h('div', { class: 'mt' });
    const btn = h('button', { class: 'btn pri big', 'data-busy': 'Starting…' }, 'Start mirroring');
    btn.addEventListener('click', busy(btn, async () => {
      if (!requireWs()) return;
      w.mirrorName = name.value;
      const tables = w.tables && w.selected.size !== w.tables.length ? [...w.selected].map((k) => { const [schema, ...n] = k.split('.'); return { schema, name: n.join('.') }; }) : [];
      const j = await post('/jobs/mirror', { typeId: t.id, connectionId: w.connectionId, connectionName: w.connectionName || undefined, server: w.values.server, port: w.values.port || undefined, database: w.values.database, tables, name: name.value, sourceLabel: `${t.name} · ${w.values.database}` });
      watch(job, j, (done) => { if (done.status === 'succeeded') { toast('Mirroring is running', 'ok'); app.refresh(); } }, (d) => renderMirrorTables(live, d));
    }));
    el.append(
      h('h3', {}, 'Mirror into Fabric'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Source'), h('dd', {}, `${t.name} · ${w.values.server} / ${w.values.database}`), h('dt', {}, 'Connection'), h('dd', {}, w.connectionName || w.connectionId), h('dt', {}, 'Tables'), h('dd', {}, w.tables ? `${w.selected.size} of ${w.tables.length} selected` : 'All tables (new tables are added automatically)')),
      h('div', { class: 'formgrid mt' }, field('Mirrored database name', name, 'Letters, numbers and underscores')),
      h('div', { class: 'row mt' }, h('button', { class: 'btn', onclick: () => { w.step = 2; redraw(); } }, '← Back'), btn,
        h('button', { class: 'btn ai', onclick: () => app.ask(`Mirror the ${t.name} database "${w.values.database}" into my workspace using Fabric connection ${w.connectionId}, then describe the mirrored tables.`) }, '✦ Ask Copilot to do it')),
      job, live);
  }
  return el;
}

function tablePicker(tables, selected) {
  const all = h('input', { type: 'checkbox', checked: selected.size === tables.length || undefined });
  const t = h('table', { class: 't' }, h('tr', {}, h('th', {}, all), h('th', {}, 'Table'), h('th', { class: 'num' }, 'Rows'), h('th', { class: 'num' }, 'Columns')));
  const boxes = [];
  for (const x of tables) {
    const key = `${x.schema}.${x.name}`;
    const cb = h('input', { type: 'checkbox', checked: selected.has(key) || undefined });
    cb.addEventListener('change', () => { if (cb.checked) selected.add(key); else selected.delete(key); all.checked = selected.size === tables.length; });
    boxes.push([cb, key]);
    t.append(h('tr', {}, h('td', {}, cb), h('td', {}, key), h('td', { class: 'num' }, fmtNum(x.rows)), h('td', { class: 'num' }, Array.isArray(x.columns) ? x.columns.length : fmtNum(x.columns))));
  }
  all.addEventListener('change', () => { for (const [cb, key] of boxes) { cb.checked = all.checked; if (all.checked) selected.add(key); else selected.delete(key); } });
  return h('div', { class: 'scroll mt' }, t);
}

function renderMirrorTables(el, d) {
  if (d?.kind !== 'mirroring') return;
  el.innerHTML = '';
  const t = h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Table'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Rows replicated'), h('th', {}, 'Last sync')));
  for (const x of d.tables || []) {
    const ok = x.status === 'Replicating';
    t.append(h('tr', {}, h('td', {}, `${x.sourceSchemaName}.${x.sourceTableName}`), h('td', {}, h('span', { class: `pill ${ok ? 'ok' : /fail|error/i.test(x.status) ? 'err' : ''}` }, x.status)), h('td', { class: 'num' }, fmtNum(x.metrics?.processedRows)), h('td', { class: 'muted' }, x.metrics?.lastSyncDateTime ? new Date(x.metrics.lastSyncDateTime).toLocaleTimeString() : '–')));
  }
  el.append(h('div', { class: 'row sp' }, h('h3', {}, 'Live mirroring status'), h('span', { class: 'pill brand' }, d.status || '…')), h('div', { class: 'scroll' }, t));
}

// ---------------- existing Fabric data ----------------
function fabricData() {
  const p = store.project || {};
  const s = fabricState;
  const origin = p.modelSource ? originItem(p) : null;
  const isCurrent = (id) => origin?.itemId === id;
  const box = h('div', { class: 'col' });
  const note = h('div');
  const wsSel = select([{ value: '', label: 'Loading workspaces…' }]);
  const items = h('div');
  const tablesBox = h('div');
  let seq = 0;
  const drawNote = () => { note.innerHTML = ''; if (origin && origin.itemType !== s.itemType) note.append(inUseNote(p)); };
  get('/fabric/workspaces').then((ws) => {
    workspaceNames = new Map(ws.map((w) => [w.id, w.name]));
    wsSel.innerHTML = '';
    wsSel.append(h('option', { value: '' }, 'Choose the workspace that has your data'));
    for (const w of ws) wsSel.append(h('option', { value: w.id, selected: w.id === s.workspaceId || undefined }, w.name));
    if (s.workspaceId) loadItems(false);
  }).catch((e) => { wsSel.innerHTML = ''; wsSel.append(h('option', {}, e.message)); });
  const loadItems = async (clearTables = true) => {
    s.workspaceId = wsSel.value;
    items.innerHTML = '';
    if (clearTables) { seq++; tablesBox.innerHTML = ''; }
    drawNote();
    if (!s.workspaceId) return;
    items.append(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Loading items…'));
    try {
      const list = await get(`/sources/items?workspaceId=${s.workspaceId}&itemType=${s.itemType}`);
      items.innerHTML = '';
      if (!list.length) { items.append(h('div', { class: 'empty' }, `No ${ITEM_LABEL[s.itemType] || s.itemType} items in this workspace.`)); return; }
      const grid = h('div', { class: 'srcs' });
      for (const it of list) {
        if (it.id === s.itemId) s.itemName = it.name;
        const card = h('div', { class: `src ${s.itemId === it.id ? 'on' : ''}` },
          h('div', { class: 'h' }, h('div', { class: 'ic' }, ITEM_ICON[s.itemType]), it.name, isCurrent(it.id) ? h('span', { class: 'pill ok', style: { marginLeft: 'auto' } }, 'In use') : null),
          h('div', { class: 'meta' }, ITEM_LABEL[s.itemType] || s.itemType));
        card.addEventListener('click', () => {
          if (s.itemId === it.id) return;
          s.itemId = it.id; s.itemName = it.name;
          grid.querySelectorAll('.src.on').forEach((x) => x.classList.remove('on'));
          card.classList.add('on');
          loadTables();
        });
        grid.append(card);
      }
      items.append(grid);
    } catch (e) { items.innerHTML = ''; items.append(h('div', { class: 'banner err' }, e.message)); }
  };
  const readTables = async () => {
    // The item in use: reuse the schema the studio already read (fast, cached); other items: read their endpoint.
    const ms = p.modelSource;
    if (ms && s.itemId === ms.itemId) {
      const d = await get('/model/describe');
      return { endpoint: { server: ms.server }, tables: d.tables.map((t) => ({ schema: t.schema, name: t.name, rows: t.rows, columns: t.columns.length })) };
    }
    return post('/sources/item-tables', { workspaceId: s.workspaceId, itemId: s.itemId, itemType: s.itemType });
  };
  const loadTables = async () => {
    const my = ++seq;
    tablesBox.innerHTML = '';
    if (!s.itemId) return;
    tablesBox.append(h('div', { class: 'row muted mt' }, h('span', { class: 'spin' }), 'Reading tables from the SQL analytics endpoint…'));
    try {
      const r = await readTables();
      if (my !== seq) return;
      s.tables = r.tables;
      s.selected = new Set(r.tables.map((t) => `${t.schema}.${t.name}`));
      tablesBox.innerHTML = '';
      const current = isCurrent(s.itemId);
      const inUse = current && p.source?.method !== 'shortcut';
      const job = h('div', { class: 'mt' });
      const inPlace = h('button', { class: 'btn pri', 'data-busy': 'Selecting…', disabled: inUse || undefined }, inUse ? '✓ In use' : 'Use in place');
      const isLakehouse = s.itemType === 'Lakehouse';
      inPlace.addEventListener('click', busy(inPlace, async () => {
        if (!requireWs()) return;
        const withPrep = prepOn && isLakehouse;
        await post('/sources/in-place', { workspaceId: s.workspaceId, itemId: s.itemId, itemType: s.itemType });
        toast(`Using ${s.itemName}`, 'ok');
        await app.refresh();
        // With the notebook, stay here: its progress and results show at the top of this page.
        if (withPrep) { await startDataPrep(); window.scrollTo({ top: 0, behavior: 'smooth' }); } else app.go('model');
      }));
      const shortcut = h('button', { class: 'btn', 'data-busy': 'Starting…' }, 'Create shortcuts in my project lakehouse');
      shortcut.addEventListener('click', busy(shortcut, async () => {
        if (!requireWs()) return;
        const tables = [...s.selected].map((k) => { const [schema, ...n] = k.split('.'); return { schema, name: n.join('.') }; });
        if (!tables.length) throw new Error('Select at least one table.');
        const withPrep = prepOn && isLakehouse;
        const j = await post('/jobs/shortcuts', { sourceWorkspaceId: s.workspaceId, sourceItemId: s.itemId, sourceItemType: s.itemType, tables });
        watch(job, j, (done) => {
          if (done.status !== 'succeeded') return;
          toast('Shortcuts created', 'ok');
          app.refresh();
          if (withPrep) startDataPrep().catch((e) => toast(e.message, 'err'));
        });
      }));
      tablesBox.append(
        h('div', { class: 'banner ok mt' }, h('div', {}, current ? h('b', {}, `In use${p.source?.method === 'shortcut' ? ' (OneLake shortcuts)' : ''}. `) : null, `${r.tables.length} tables in ${s.itemName} · ${r.endpoint.server}`)),
        tablePicker(s.tables, s.selected),
        isLakehouse && !inUse ? prepOption() : null,
        h('div', { class: 'row mt' }, inPlace, !['MirroredDatabase', 'SQLDatabase'].includes(s.itemType) ? shortcut : null),
        h('p', { class: 'tiny muted' }, inUse
          ? 'This item is your current data source. Pick another item to use it in place instead, or keep this one and continue with the semantic model.'
          : 'Use in place builds the model directly on this item (it can live in another workspace). Shortcuts reference the selected tables from the project lakehouse without copying data.'),
        job);
    } catch (e) { if (my === seq) { tablesBox.innerHTML = ''; tablesBox.append(h('div', { class: 'banner err mt' }, e.message)); } }
  };
  wsSel.addEventListener('change', () => { s.itemId = ''; loadItems(); });
  drawNote();
  box.append(note, h('div', { class: 'row' },
    seg(Object.entries(ITEM_LABEL).map(([value, label]) => ({ value, label })), s.itemType, (v) => { s.itemType = v; s.itemId = ''; loadItems(); }),
    h('div', { style: { flex: 1, minWidth: '260px' } }, wsSel)), items, tablesBox);
  if (s.itemId) setTimeout(loadTables, 0);
  return box;
}

export const _q = $;
