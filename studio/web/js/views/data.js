import { store, get, post, on } from '../api.js';
import { h, toast, busy, field, input, select, seg, fmtNum, fmtDate, $ } from '../ui.js';
import { app, copilotSlot } from '../app.js';

let tab = 'samples';
let selectedType = null;
let wiz = null;           // wizard state for database sources
let fabricState = { itemType: 'Lakehouse', workspaceId: '', itemId: '', tables: [], selected: new Set() };
let alignedTo;            // data source the tabs below were last filled from
let workspaceNames = null;

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
    const job = await post('/jobs/sample');
    watch(rJob, job, (j) => { if (j.status === 'succeeded') { toast('Sample data is ready', 'ok'); app.refresh(); } });
  }));
  grid.append(h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('div', { class: 'src', style: { cursor: 'default', border: 0, padding: 0 } }, h('div', { class: 'h' }, h('div', { class: 'ic' }, '🛍️'), retail.name)), inUse(retail.id) ? h('span', { class: 'pill ok' }, 'In use') : null),
    h('p', { class: 'small' }, retail.tagline), h('div', { class: 'tiny muted' }, retail.details),
    h('div', { class: 'row mt' }, h('span', { class: 'pill brand' }, retail.lands), h('span', { class: 'pill' }, retail.needs), h('span', { class: 'pill' }, `~${retail.minutes} min`)),
    inUseBanner(retail.id),
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
        const name = input({ value: `${t.name} - ${w.values.server}/${w.values.database}`.slice(0, 100) });
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
    const name = input({ value: w.mirrorName || `Mirror_${(w.values.database || 'db').replace(/[^A-Za-z0-9_]/g, '_')}` });
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
      inPlace.addEventListener('click', busy(inPlace, async () => {
        if (!requireWs()) return;
        await post('/sources/in-place', { workspaceId: s.workspaceId, itemId: s.itemId, itemType: s.itemType });
        toast(`Using ${s.itemName}`, 'ok');
        await app.refresh();
        app.go('model');
      }));
      const shortcut = h('button', { class: 'btn', 'data-busy': 'Starting…' }, 'Create shortcuts in my project lakehouse');
      shortcut.addEventListener('click', busy(shortcut, async () => {
        if (!requireWs()) return;
        const tables = [...s.selected].map((k) => { const [schema, ...n] = k.split('.'); return { schema, name: n.join('.') }; });
        if (!tables.length) throw new Error('Select at least one table.');
        const j = await post('/jobs/shortcuts', { sourceWorkspaceId: s.workspaceId, sourceItemId: s.itemId, sourceItemType: s.itemType, tables });
        watch(job, j, (done) => { if (done.status === 'succeeded') { toast('Shortcuts created', 'ok'); app.refresh(); } });
      }));
      tablesBox.append(
        h('div', { class: 'banner ok mt' }, h('div', {}, current ? h('b', {}, `In use${p.source?.method === 'shortcut' ? ' (OneLake shortcuts)' : ''}. `) : null, `${r.tables.length} tables in ${s.itemName} · ${r.endpoint.server}`)),
        tablePicker(s.tables, s.selected),
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
