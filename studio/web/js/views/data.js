import { store, get, post, on } from '../api.js';
import { h, toast, busy, field, input, select, seg, fmtNum, $ } from '../ui.js';
import { app, copilotSlot } from '../app.js';

let tab = 'samples';
let selectedType = null;
let wiz = null;           // wizard state for database sources
let fabricState = { itemType: 'Lakehouse', workspaceId: '', itemId: '', tables: [], selected: new Set() };

export function renderData(el) {
  const p = store.project || {};
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
  return h('div', { class: 'card', style: { marginBottom: '14px' } },
    h('div', { class: 'row sp' },
      h('div', {}, h('div', { class: 'row' }, h('h2', {}, p.source?.label || ms.itemName), h('span', { class: 'pill ok' }, 'Connected')),
        h('div', { class: 'muted small' }, `${ms.itemType} · ${ms.itemName} · method: ${p.source?.method || 'in place'}`)),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: `https://app.fabric.microsoft.com/groups/${ms.workspaceId}`, target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗'),
        h('button', { class: 'btn ai', onclick: () => app.ask('Describe my data source: tables, row counts, keys and relationships. Then suggest a star schema.') }, '✦ Explain my data'),
        h('button', { class: 'btn pri', onclick: () => app.go('model') }, 'Next: semantic model →'))),
    h('dl', { class: 'kv mt' }, h('dt', {}, 'SQL endpoint'), h('dd', { class: 'mono small' }, ms.server), h('dt', {}, 'Database'), h('dd', {}, ms.database)));
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
  const [retail, aw] = store.catalog?.samples || [];
  const out = h('div', { class: 'grid g2' });

  const rJob = h('div', { class: 'mt' });
  const rBtn = h('button', { class: 'btn pri big', 'data-busy': 'Starting…' }, 'Load sample');
  rBtn.addEventListener('click', busy(rBtn, async () => {
    if (!requireWs()) return;
    const job = await post('/jobs/sample');
    watch(rJob, job, (j) => { if (j.status === 'succeeded') { toast('Sample data is ready', 'ok'); app.refresh(); } });
  }));
  out.append(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('div', { class: 'src', style: { cursor: 'default', border: 0, padding: 0 } }, h('div', { class: 'h' }, h('div', { class: 'ic' }, '🛍️'), retail.name))),
    h('p', { class: 'small' }, retail.tagline), h('div', { class: 'tiny muted' }, retail.details),
    h('div', { class: 'row mt' }, h('span', { class: 'pill brand' }, retail.lands), h('span', { class: 'pill' }, retail.needs), h('span', { class: 'pill' }, `~${retail.minutes} min`)),
    h('div', { class: 'row mt' }, rBtn, h('button', { class: 'btn ai', onclick: () => app.ask('Load the Contoso Retail sample data into my workspace, then tell me what tables were created.') }, '✦ Ask Copilot')),
    rJob));

  const awJob = h('div', { class: 'mt' });
  const awBtn = h('button', { class: 'btn pri big', 'data-busy': 'Starting…' }, 'Create in my workspace');
  awBtn.addEventListener('click', busy(awBtn, async () => {
    if (!requireWs()) return;
    const job = await post('/jobs/sample', { dataset: 'adventureworks' });
    watch(awJob, job, (j) => { if (j.status === 'succeeded') { toast('AdventureWorksDW2022 is ready', 'ok'); app.refresh(); } });
  }));
  out.append(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('div', { class: 'src', style: { cursor: 'default', border: 0, padding: 0 } }, h('div', { class: 'h' }, h('div', { class: 'ic' }, '🚲'), aw.name))),
    h('p', { class: 'small' }, aw.tagline), h('div', { class: 'tiny muted' }, aw.details),
    h('div', { class: 'row mt' }, h('span', { class: 'pill brand' }, aw.lands), h('span', { class: 'pill' }, aw.needs), h('span', { class: 'pill' }, `~${aw.minutes} min`)),
    h('ul', { class: 'pre tiny' },
      h('li', {}, 'Creates the SQL database AdventureWorksDW2022 in the project workspace and loads Microsoft\'s official AdventureWorksDW install kit (tables, keys, views and data).'),
      h('li', {}, 'Fabric replicates the tables to OneLake automatically; the semantic model and ontology use that replica.'),
      h('li', {}, 'Uses your Microsoft Entra sign-in. No Azure subscription, passwords or connections needed.')),
    h('div', { class: 'row mt' }, awBtn, h('button', { class: 'btn ai', onclick: () => app.ask('Create the AdventureWorksDW2022 sample in my workspace (studio_load_sample_data with dataset adventureworks), then describe the tables that were created.') }, '✦ Ask Copilot')),
    awJob));
  return out;
}
// ---------------- databases ----------------
function databases() {
  const types = (store.catalog?.sources || []).filter((s) => s.engine);
  const box = h('div');
  const cards = h('div', { class: 'srcs' });
  for (const t of types) {
    cards.append(h('div', { class: `src ${selectedType === t.id ? 'on' : ''}`, onclick: () => { selectedType = t.id; wiz = { step: 1, typeId: t.id, values: {}, auth: t.auth[0], tables: null, selected: new Set(), connectionId: '', connMode: t.connectionCredentials.includes('Basic') ? 'new' : 'existing' }; redraw(); } },
      h('div', { class: 'h' }, h('div', { class: 'ic' }, { sql: '🗄️', server: '🏢', pg: '🐘' }[t.icon] || '🗄️'), t.name),
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
      const j = await post('/jobs/mirror', { typeId: t.id, connectionId: w.connectionId, database: w.values.database, tables, name: name.value, sourceLabel: `${t.name} · ${w.values.database}` });
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
  const s = fabricState;
  const box = h('div', { class: 'col' });
  const wsSel = select([{ value: '', label: 'Loading workspaces…' }]);
  const items = h('div');
  const tablesBox = h('div');
  get('/fabric/workspaces').then((ws) => {
    wsSel.innerHTML = '';
    wsSel.append(h('option', { value: '' }, 'Choose the workspace that has your data'));
    for (const w of ws) wsSel.append(h('option', { value: w.id, selected: w.id === s.workspaceId || undefined }, w.name));
    if (s.workspaceId) loadItems();
  }).catch((e) => { wsSel.innerHTML = ''; wsSel.append(h('option', {}, e.message)); });
  const loadItems = async () => {
    s.workspaceId = wsSel.value;
    items.innerHTML = '';
    tablesBox.innerHTML = '';
    if (!s.workspaceId) return;
    items.append(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Loading items…'));
    try {
      const list = await get(`/sources/items?workspaceId=${s.workspaceId}&itemType=${s.itemType}`);
      items.innerHTML = '';
      if (!list.length) { items.append(h('div', { class: 'empty' }, `No ${s.itemType} items in this workspace.`)); return; }
      const grid = h('div', { class: 'srcs' });
      for (const it of list) grid.append(h('div', { class: `src ${s.itemId === it.id ? 'on' : ''}`, onclick: () => { s.itemId = it.id; s.itemName = it.name; loadItems().then(loadTables); } }, h('div', { class: 'h' }, h('div', { class: 'ic' }, { Lakehouse: '🏞️', Warehouse: '🏛️', MirroredDatabase: '🪞', SQLDatabase: '🗄️' }[s.itemType]), it.name), h('div', { class: 'meta' }, s.itemType)));
      items.append(grid);
    } catch (e) { items.innerHTML = ''; items.append(h('div', { class: 'banner err' }, e.message)); }
  };
  const loadTables = async () => {
    tablesBox.innerHTML = '';
    if (!s.itemId) return;
    tablesBox.append(h('div', { class: 'row muted mt' }, h('span', { class: 'spin' }), 'Reading tables from the SQL analytics endpoint…'));
    try {
      const r = await post('/sources/item-tables', { workspaceId: s.workspaceId, itemId: s.itemId, itemType: s.itemType });
      s.tables = r.tables;
      s.selected = new Set(r.tables.map((t) => `${t.schema}.${t.name}`));
      tablesBox.innerHTML = '';
      const job = h('div', { class: 'mt' });
      const inPlace = h('button', { class: 'btn pri', 'data-busy': 'Selecting…' }, 'Use in place');
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
      tablesBox.append(h('div', { class: 'banner ok mt' }, `${r.tables.length} tables in ${s.itemName} · ${r.endpoint.server}`), tablePicker(s.tables, s.selected),
        h('div', { class: 'row mt' }, inPlace, !['MirroredDatabase', 'SQLDatabase'].includes(s.itemType) ? shortcut : null),
        h('p', { class: 'tiny muted' }, 'Use in place builds the model directly on this item (it can live in another workspace). Shortcuts reference the selected tables from the project lakehouse without copying data.'),
        job);
    } catch (e) { tablesBox.innerHTML = ''; tablesBox.append(h('div', { class: 'banner err mt' }, e.message)); }
  };
  wsSel.addEventListener('change', () => { s.itemId = ''; loadItems(); });
  box.append(h('div', { class: 'row' },
    seg([{ value: 'Lakehouse', label: 'Lakehouse' }, { value: 'Warehouse', label: 'Warehouse' }, { value: 'MirroredDatabase', label: 'Mirrored database' }, { value: 'SQLDatabase', label: 'SQL database' }], s.itemType, (v) => { s.itemType = v; s.itemId = ''; loadItems(); }),
    h('div', { style: { flex: 1, minWidth: '260px' } }, wsSel)), items, tablesBox);
  if (s.itemId) setTimeout(loadTables, 0);
  return box;
}

export const _q = $;
