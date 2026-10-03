// Fabric MCP Studio - local web server (127.0.0.1 only). No framework: node:http + SSE + static files.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { WEB_ROOT, DATA_DIR, VERSION, getSettings, saveSettings, publicSettings, readJson, writeJson, shortHash } from './config.mjs';
import { addClient, emit } from './events.mjs';
import * as auth from './auth.mjs';
import * as F from './fabric.mjs';
import * as A from './agent.mjs';
import * as P from './pipelines.mjs';
import * as R from './reports/index.mjs';
import * as APPS from './reports/apps.mjs';
import { catalog } from './sources.mjs';
import { getProject, updateProject, resetProject, getActivity, clearActivity, logActivity, assertProjectTenant } from './project.mjs';
import { startJob, listJobs, getJob, cancelJob, flushRunningJobs } from './jobs.mjs';
import { health } from './health.mjs';
import { presetSummary } from './presets.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const TOKEN = randomBytes(24).toString('hex');
let PORT = Number(opt('--port', process.env.STUDIO_PORT || 4870));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid port "${opt('--port', process.env.STUDIO_PORT)}". Use a number between 1 and 65535, for example --port 4870.`);
  process.exit(2);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };

if (flag('--check')) {
  const h = await health();
  for (const c of h.checks) console.log(`${c.status.padEnd(5)} ${c.label.padEnd(36)} ${c.detail}${c.fix ? `  → ${c.fix}` : ''}`);
  await A.stopAgent();
  process.exit(h.ready ? 0 : 1);
}

// ---------------- single instance ----------------
// Launching again (desktop shortcut, Start-Studio.cmd) opens the copy that is already running for this data folder.

const INSTANCE = shortHash(DATA_DIR.toLowerCase());
const RUNTIME_FILE = join(DATA_DIR, 'runtime.json');

async function runningInstanceUrl() {
  const ports = new Set([Number(readJson(RUNTIME_FILE, {}).port) || 0, PORT].filter(Boolean));
  for (const p of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(1500) });
      if (r.headers.get('x-studio-instance') === INSTANCE) return `http://127.0.0.1:${p}/`;
    } catch { /* not running */ }
  }
  return null;
}

if (!flag('--new-instance')) {
  const url = await runningInstanceUrl();
  if (url) {
    console.log(`\n  Fabric MCP Studio is already running at ${url}\n`);
    if (!flag('--no-open')) openBrowser(url);
    process.exit(0);
  }
}

// ---------------- helpers ----------------

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 5 * 1024 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 }); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(WEB_ROOT, decodeURIComponent(p)));
  if (!file.startsWith(WEB_ROOT) || !existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'Not found');
  let content = readFileSync(file);
  if (file.endsWith('index.html')) content = Buffer.from(content.toString('utf8').replace('__STUDIO_TOKEN__', TOKEN).replace(/__STUDIO_VERSION__/g, VERSION));
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Studio-Instance': INSTANCE });
  res.end(content);
}

// ---------------- routes ----------------

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const rx = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, rx, keys, handler });
};

route('GET', '/api/bootstrap', async () => {
  const me = await auth.whoAmI();
  const p = getProject();
  return { version: VERSION, user: me, settings: publicSettings(), provider: A.providerSummary(), providers: A.PROVIDERS, project: p, preset: presetSummary(p), catalog: catalog(), jobs: listJobs().slice(0, 20), chats: A.listChats(), approvals: A.pendingApprovals(), platform: process.platform };
});
route('GET', '/api/health', () => health());

route('POST', '/api/auth/signin', async (_, b) => { const me = await auth.signIn(b.mode || 'browser'); await A.restartClient(); emit('auth', { user: me }); return me; });
route('POST', '/api/auth/signout', async () => { auth.signOut(); await A.restartClient(); emit('auth', { user: { signedIn: false } }); return { ok: true }; });

route('GET', '/api/settings', () => publicSettings());
route('PATCH', '/api/settings', async (_, b) => {
  const allowed = {};
  for (const k of ['theme', 'approvalMode', 'mcp', 'azure']) if (b[k] !== undefined) allowed[k] = b[k];
  saveSettings(allowed);
  if (b.mcp || b.azure) await A.restartClient();
  if (b.azure) auth.signOut();
  return publicSettings();
});

route('GET', '/api/providers', () => ({ providers: A.PROVIDERS, current: A.providerSummary(), settings: publicSettings().provider }));
route('PUT', '/api/providers', async (_, b) => {
  const s = getSettings();
  const cur = s.provider;
  const config = { ...(cur.id === b.id ? cur.config : {}), ...(b.config || {}) };
  if (b.config && b.config.apiKey === '') delete config.apiKey;
  s.provider = { id: b.id || cur.id, model: b.model ?? (cur.id === b.id ? cur.model : ''), reasoningEffort: b.reasoningEffort ?? '', config };
  saveSettings({});
  logActivity('provider.change', `AI provider set to ${A.providerSummary().name}`, { provider: A.providerSummary() });
  emit('provider', { provider: A.providerSummary() });
  return { current: A.providerSummary(), settings: publicSettings().provider };
});
route('POST', '/api/providers/test', () => A.testProvider());
route('GET', '/api/copilot/status', () => A.copilotStatus());
route('GET', '/api/copilot/models', () => A.listModels());
route('POST', '/api/copilot/token', async (_, b) => { A.setGitHubToken(String(b.token || '').trim()); return A.copilotStatus(); });
route('POST', '/api/copilot/login', () => startJob('github-login', 'Sign in to GitHub', (ctx) => new Promise((resolveP, reject) => {
  ctx.step('Follow the browser prompt and enter the one-time code shown below');
  const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'], { shell: process.platform === 'win32', windowsHide: true });
  const onData = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => ctx.log(l));
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.stdin.write('\n');
  child.on('error', () => reject(new Error('GitHub CLI (gh) not found. Install it from https://cli.github.com or paste a token in Settings.')));
  child.on('exit', async (code) => { if (code === 0) { await A.restartClient(); resolveP({ ok: true }); } else reject(new Error(`gh auth login exited with ${code}`)); });
})));

route('GET', '/api/chats', () => A.listChats());
route('POST', '/api/chats', () => A.createChat());
route('GET', '/api/chats/:id', (p) => A.chatHistory(p.id) || Promise.reject(Object.assign(new Error('Chat not found'), { status: 404 })));
route('POST', '/api/chats/:id/messages', (p, b) => A.sendMessage(p.id, String(b.prompt || '').slice(0, 20000)));
route('POST', '/api/chats/:id/abort', (p) => A.abortChat(p.id));
route('DELETE', '/api/chats/:id', (p) => A.deleteChat(p.id));
route('GET', '/api/approvals', () => A.pendingApprovals());
route('POST', '/api/approvals/:id', (p, b) => ({ ok: A.resolveApproval(p.id, b.decision) }));

route('GET', '/api/fabric/capacities', async () => (await F.listCapacities()).map((c) => ({ id: c.id, name: c.displayName, sku: c.sku, region: c.region, state: c.state })));
route('GET', '/api/fabric/workspaces', async () => (await F.listWorkspaces()).filter((w) => w.type !== 'Personal').map((w) => ({ id: w.id, name: w.displayName, capacityId: w.capacityId || null, type: w.type, description: w.description || '' })));
route('GET', '/api/fabric/workspaces/:id/items', async (p, _, q) => (await F.listItems(p.id, q.get('type') || undefined)).map((i) => ({ id: i.id, name: i.displayName, type: i.type })));
route('GET', '/api/fabric/connections', () => F.listConnections());
route('GET', '/api/fabric/gateways', () => F.listGateways());

route('GET', '/api/project', () => getProject());
route('GET', '/api/preset', () => presetSummary(getProject()));
route('PATCH', '/api/project', (_, b) => { const patch = {}; for (const k of ['name', 'glossary']) if (b[k] !== undefined) patch[k] = b[k]; return updateProject(patch); });
route('POST', '/api/project/reset', () => { clearActivity(); return resetProject(); });
route('POST', '/api/project/workspace', (_, b) => P.selectWorkspace(b));

route('GET', '/api/sources/catalog', () => catalog());
route('POST', '/api/sources/test', (_, b) => P.testSource(b));
route('POST', '/api/sources/discover', (_, b) => P.discoverSource(b));
route('POST', '/api/sources/connection', (_, b) => P.createConnection(b));
route('GET', '/api/sources/items', (_, __, q) => P.listSourceItems(q.get('workspaceId'), q.get('itemType')));
route('POST', '/api/sources/item-tables', (_, b) => P.listTablesOfItem(b));
route('POST', '/api/sources/in-place', (_, b) => P.useInPlace(b));
route('GET', '/api/sources/current/mirroring', () => P.currentMirroringStatus());

route('GET', '/api/model/describe', (_, __, q) => P.describeModelSource({ refresh: q.get('refresh') === '1' }));
route('GET', '/api/ontology/preview', () => P.ontologyPreview());

route('POST', '/api/jobs/sample', (_, b) => (b?.dataset === 'adventureworks'
  ? startJob('sample', 'Create AdventureWorksDW2022 in a Fabric SQL database', (ctx) => P.runSampleAdventureWorks(ctx))
  : startJob('sample', 'Load Contoso Retail sample', (ctx) => P.runSampleRetail(ctx))));
route('POST', '/api/jobs/mirror', (_, b) => startJob('mirror', `Mirror ${b.database}`, (ctx) => P.runMirror(ctx, b)));
route('POST', '/api/jobs/shortcuts', (_, b) => startJob('shortcut', 'Create OneLake shortcuts', (ctx) => P.runShortcuts(ctx, b)));
route('POST', '/api/jobs/semantic-model', (_, b) => startJob('semantic-model', `Create semantic model ${b.name || ''}`.trim(), (ctx) => P.runSemanticModel(ctx, b)));
route('POST', '/api/jobs/ontology', (_, b) => startJob('ontology', `Deploy ontology ${b.name || ''}`.trim(), (ctx) => P.runOntology(ctx, b)));
route('POST', '/api/jobs/teams-agent', (_, b) => startJob('teams-agent', b.dryRun ? 'Validate Teams agent package' : 'Install Teams agent', (ctx) => P.runTeamsAgent(ctx, b)));
route('POST', '/api/jobs/report', (_, b) => startJob('report', `Build Power BI report ${b.name || ''}`.trim(), (ctx) => R.runReport(ctx, { name: b.name, theme: b.theme, pages: Array.isArray(b.pages) ? b.pages : undefined, proposalId: b.proposalId })));
route('GET', '/api/reports/catalog', () => R.reportsCatalog());
route('GET', '/api/reports/profile', (_, __, q) => R.currentProfile({ refresh: q.get('refresh') === '1' }));
route('GET', '/api/reports/recommendations', (_, __, q) => R.currentRecommendations({ refresh: q.get('refresh') === '1' }));
route('POST', '/api/jobs/org-app', (_, b) => startJob('org-app', `Create org app ${b.name || ''}`.trim(), (ctx) => APPS.runOrgApp(ctx, { name: b.name, theme: b.theme, reportIds: Array.isArray(b.reportIds) ? b.reportIds : undefined, title: b.title, body: b.body })));
route('DELETE', '/api/reports/:id', (p, _, q) => R.removeReport(p.id, { deleteItem: q.get('delete') === '1' }));
route('POST', '/api/jobs/teardown', (_, b) => startJob('teardown', 'Clean up demo resources', (ctx) => P.runTeardown(ctx, b)));
route('GET', '/api/jobs', () => listJobs());
route('GET', '/api/jobs/:id', (p) => getJob(p.id));
route('POST', '/api/jobs/:id/cancel', (p) => ({ ok: cancelJob(p.id) }));

route('GET', '/api/activity', () => getActivity());
route('GET', '/api/export', () => ({ exportedAt: new Date().toISOString(), version: VERSION, project: getProject(), activity: getActivity() }));

route('POST', '/api/shutdown', () => {
  const running = listJobs().filter((j) => j.status === 'running');
  for (const j of running) cancelJob(j.id);
  setTimeout(async () => { await A.stopAgent(); process.exit(0); }, running.length ? 1500 : 300);
  return { ok: true, cancelled: running.length };
});

// ---------------- server ----------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  try {
    if (pathname === '/api/events') {
      if (url.searchParams.get('t') !== TOKEN) return send(res, 401, { error: 'Unauthorized' });
      return addClient(res);
    }
    // Report previews load in an <iframe>/<img>, which can't send headers: the token comes as a query parameter.
    const pv = pathname.match(/^\/api\/reports\/([0-9a-f-]{36})\/preview$/i);
    if (pv && req.method === 'GET') {
      if (url.searchParams.get('t') !== TOKEN) return send(res, 401, { error: 'Unauthorized' });
      const file = R.reportPreview(pv[1]);
      if (!file) return send(res, 404, { error: 'No preview yet' });
      res.writeHead(200, { 'Content-Type': file.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
      return res.end(file.bytes);
    }
    if (pathname.startsWith('/api/')) {
      if (req.headers['x-studio-token'] !== TOKEN) return send(res, 401, { error: 'Unauthorized' });
      const r = routes.find((x) => x.method === req.method && x.rx.test(pathname));
      if (!r) return send(res, 404, { error: 'Not found' });
      const m = pathname.match(r.rx);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const b = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await body(req) : {};
      // Jobs change Fabric; never run them against a project that lives in another tenant.
      if (req.method === 'POST' && pathname.startsWith('/api/jobs/') && !pathname.endsWith('/cancel')) await assertProjectTenant();
      const result = await r.handler(params, b, url.searchParams);
      return send(res, 200, result ?? { ok: true });
    }
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  } catch (e) {
    const status = e.status || (e.code === 'AUTH_REQUIRED' ? 401 : 500);
    if (status >= 500) console.error(`[${req.method} ${pathname}]`, e.message);
    return send(res, status, { error: e.message || String(e), code: e.code || null });
  }
});

function listen(port, attempts = 10) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempts > 0) listen(port + 1, attempts - 1);
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    PORT = port;
    const url = `http://127.0.0.1:${port}/`;
    try { writeJson(RUNTIME_FILE, { pid: process.pid, port, url, startedAt: new Date().toISOString() }); } catch { /* read-only data folder */ }
    console.log(`\n  Fabric MCP Studio ${VERSION} is running at ${url}\n  Press Ctrl+C to stop.\n`);
    if (!flag('--no-open')) openBrowser(url);
  });
}

process.on('exit', () => {
  flushRunningJobs();
  try { if (readJson(RUNTIME_FILE, {}).pid === process.pid) rmSync(RUNTIME_FILE, { force: true }); } catch { /* ignore */ }
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* ignore */ }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => { await A.stopAgent(); process.exit(0); });
listen(PORT);
