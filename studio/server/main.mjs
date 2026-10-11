// Fabric MCP Studio - local web server (127.0.0.1 only). No framework: node:http + SSE + static files.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, rmSync, openSync, closeSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { WEB_ROOT, DATA_DIR, STUDIO_ROOT, VERSION, BUILD, RELEASES, DEMO_MODE, getSettings, saveSettings, publicSettings, readJson, writeJson, shortHash, isDeveloper, pendingUpdate } from './config.mjs';
import { addClient, emit } from './events.mjs';
import * as auth from './auth.mjs';
import * as F from './fabric.mjs';
import * as A from './agent.mjs';
import * as P from './pipelines.mjs';
import * as R from './reports/index.mjs';
import * as APPS from './reports/apps.mjs';
import * as TPL from './reports/library.mjs';
import * as RT from './realtime/index.mjs';
import * as PL from './planning/index.mjs';
import * as DP from './dataprep.mjs';
import * as DA from './dataagent.mjs';
import * as N from './naming.mjs';
import { promptSuggestions } from './prompts.mjs';
import { readiness, cachedReadiness, resetReadiness, prerequisiteFixes, assertModuleReady, assertLiveEventsAllowed } from './readiness.mjs';
import { catalog } from './sources.mjs';
import { getProject, updateProject, resetProject, getActivity, clearActivity, logActivity, assertProjectTenant, projectModels, modelWorkspaceId } from './project.mjs';
import { startJob, listJobs, getJob, cancelJob, flushRunningJobs, onJobSucceeded, plainError } from './jobs.mjs';
import * as WTF from './workspace-taskflow.mjs';
import * as MODELS from './models.mjs';
import * as MC from './modelcheck.mjs';
import * as LINKS from './modellinks.mjs';
import * as ARTS from './artifacts.mjs';
import * as COST from './costs.mjs';
import { health } from './health.mjs';
import { presetSummary } from './presets.mjs';
import { diagnosticsBundle } from './diagnostics.mjs';
import { demoApi } from './demo.mjs';


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
  let blocked = 0;
  if (h.checks.some((c) => c.id === 'azure' && c.status === 'ok')) {
    const r = await readiness().catch(() => null);
    if (r) {
      for (const c of r.checks) console.log(`${c.status.padEnd(5)} ${c.label.padEnd(36)} ${c.detail}${c.fix ? `  → ${c.fix}` : ''}`);
      console.log('\nWhat can run:');
      for (const m of Object.values(r.modules)) {
        const why = m.reasons.find((x) => x.status === 'error') || m.reasons.find((x) => x.status === 'warn');
        console.log(`  ${({ ready: 'ready  ', limited: 'limited', blocked: 'BLOCKED' })[m.status]} ${m.label.padEnd(16)} ${why ? why.text : ''}`);
      }
      blocked = Object.values(r.modules).filter((m) => m.status === 'blocked').length;
    }
  }
  await A.stopAgent();
  process.exit(h.ready && !blocked ? 0 : 1);
}

// ---------------- single instance ----------------
// Launching again (desktop shortcut, Start-Studio.cmd) opens the copy that is already running for this data folder.

const INSTANCE = shortHash(DATA_DIR.toLowerCase());
const RUNTIME_FILE = join(DATA_DIR, 'runtime.json');

// Started by "Restart" in the app: tell the copy that started this one that it runs (it stops only then, so a copy
// that can't start never leaves the studio down), then wait until it has stopped and freed its port. The ready file
// carries the restart attempt, so a slow copy from an earlier attempt can't stop the studio for a later one.
const restartOf = Number(opt('--restart-of', 0));
const restartAttempt = String(opt('--restart-token', '') || '').replace(/[^\w-]/g, '');
if (restartOf) {
  try { writeFileSync(join(DATA_DIR, `restart-${restartOf}${restartAttempt ? `-${restartAttempt}` : ''}.ready`), String(process.pid)); } catch { /* read-only data folder */ }
  let gone = false;
  for (let i = 0; i < 400 && !gone; i++) {
    try { process.kill(restartOf, 0); } catch { gone = true; break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  // Still running after a minute: it kept the port (the restart was cancelled) – never start a second copy next to it.
  if (!gone) { console.error(`The studio that started this copy (process ${restartOf}) is still running; this copy stops.`); process.exit(1); }
}

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

async function rawBody(req, max) {
  const tooLarge = () => Object.assign(new Error(`The file is larger than ${Math.round(max / 1048576)} MB. For a large .pbix, save it as a Power BI template in Power BI Desktop (File › Export › Power BI template): the template leaves the data out.`), { status: 413 });
  if (Number(req.headers['content-length']) > max) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw tooLarge(); chunks.push(c); }
  return Buffer.concat(chunks);
}
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(WEB_ROOT, decodeURIComponent(p)));
  if (!file.startsWith(WEB_ROOT) || !existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'Not found');
  let content = readFileSync(file);
  if (file.endsWith('index.html')) content = Buffer.from(content.toString('utf8').replace('__STUDIO_TOKEN__', TOKEN).replace(/__STUDIO_VERSION__/g, VERSION).replace(/__STUDIO_BUILD__/g, BUILD ? `build ${BUILD.commit} · ${BUILD.date}` : 'build –'));
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
  return { version: VERSION, build: BUILD, update: pendingUpdate(), user: me, settings: publicSettings(), provider: A.providerSummary(), providers: A.visibleProviders(), project: p, preset: presetSummary(p), naming: N.namingState(p), catalog: catalog(), jobs: listJobs().slice(0, 20), chats: A.listChats(), approvals: A.pendingApprovals(), realtime: RT.realtimeState(), planning: PL.planningState(), readiness: cachedReadiness(), platform: process.platform, demoMode: DEMO_MODE };
});
route('GET', '/api/update', () => ({ version: VERSION, update: pendingUpdate() }));
route('GET', '/api/health', () => health());
route('GET', '/api/about', () => ({ version: VERSION, build: BUILD, improvements: RELEASES.improvements, fixes: RELEASES.fixes, changes: RELEASES.changes }));
route('GET', '/api/diagnostics', () => diagnosticsBundle());
// The disclaimer is shown until it is acknowledged once per installation (and again when its text changes).
route('POST', '/api/disclaimer/accept', (_, b) => {
  const version = Number(b.version) || 1;
  saveSettings({ disclaimer: { version, acceptedAt: new Date().toISOString(), studioVersion: VERSION } });
  logActivity('disclaimer.accept', `Disclaimer acknowledged (v${version})`, {});
  return publicSettings();
});

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

const providerMemory = new Map();
route('GET', '/api/providers', () => ({ providers: A.visibleProviders(), current: A.providerSummary(), settings: publicSettings().provider }));
route('PUT', '/api/providers', async (_, b) => {
  if (b.id && !A.visibleProviders().some((x) => x.id === b.id)) {
    const dev = A.PROVIDERS.find((x) => x.id === b.id && x.developer);
    throw Object.assign(new Error(dev ? `${dev.name} is only available in developer mode. Choose Azure AI Foundry / Azure OpenAI or another provider.` : `Unknown AI provider "${b.id}".`), { status: 400 });
  }
  const s = getSettings();
  const cur = s.provider;
  if (cur.id) {
    const remembered = providerMemory.get(cur.id) || {};
    providerMemory.set(cur.id, {
      model: cur.model || remembered.model || '',
      reasoningEffort: cur.reasoningEffort || remembered.reasoningEffort || '',
      config: { ...(remembered.config || {}), ...(cur.config || {}) },
    });
  }
  const id = b.id || cur.id;
  const prior = providerMemory.get(id) || {};
  const config = { ...(cur.id === id ? cur.config : prior.config || {}), ...(b.config || {}) };
  if (b.config && b.config.apiKey === '') delete config.apiKey;
  const model = b.model ?? (cur.id === id ? cur.model : prior.model || '');
  const reasoningEffort = b.reasoningEffort ?? (cur.id === id ? cur.reasoningEffort || '' : prior.reasoningEffort || '');
  s.provider = { id, model, reasoningEffort, config };
  providerMemory.set(id, { model, reasoningEffort, config });
  saveSettings({});
  logActivity('provider.change', `AI provider set to ${A.providerSummary().name}`, { provider: A.providerSummary() });
  emit('provider', { provider: A.providerSummary() });
  return { current: A.providerSummary(), settings: publicSettings().provider };
});
route('POST', '/api/providers/test', () => A.testProvider());
route('GET', '/api/copilot/status', () => copilotStatusWithGh());
route('GET', '/api/copilot/models', () => A.listModels());
// OpenRouter's tool-capable models, for the Settings picker before OpenRouter is saved as the provider.
route('GET', '/api/openrouter/models', (_, __, q) => {
  if (!isDeveloper()) throw Object.assign(new Error('OpenRouter is only available in developer mode.'), { status: 403 });
  return A.listOpenRouterModels({ refresh: q.get('refresh') === '1' });
});
// GitHub sign-in is for developer mode only.
const developerOnly = () => { if (!isDeveloper()) throw Object.assign(new Error('GitHub Copilot is only available in developer mode.'), { status: 403 }); };
const GH_ENV_TOKENS = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_ENTERPRISE_TOKEN', 'COPILOT_GITHUB_TOKEN']);
const withoutGhEnvTokens = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !GH_ENV_TOKENS.has(k.toUpperCase())));
function runGh(args, ctx, { input = false, log = true } = {}) {
  return new Promise((resolveP, reject) => {
    const lines = [];
    const child = spawn('gh', args, { windowsHide: true, env: withoutGhEnvTokens() });
    const abort = () => { try { child.kill(); } catch { /* ignore */ } };
    ctx?.signal?.addEventListener('abort', abort, { once: true });
    const onData = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => {
      lines.push(l);
      if (log && !/^\s*-\s*Token:/i.test(l)) ctx?.log?.(l);
    });
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    if (input) child.stdin.end('\n'); else child.stdin.end();
    child.on('error', () => reject(new Error('GitHub CLI (gh) not found. Install it from https://cli.github.com or paste a token in Settings.')));
    child.on('exit', (code) => { ctx?.signal?.removeEventListener('abort', abort); resolveP({ code, lines, aborted: Boolean(ctx?.signal?.aborted) }); });
  });
}

function runGhBrowserLogin(ctx, label = 'GitHub sign-in') {
  return new Promise((resolveP, reject) => {
    const args = ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'];
    const lines = [];
    let codeShown = false;
    let urlOpened = false;
    let done = false;
    const child = spawn('gh', args, { windowsHide: true, env: withoutGhEnvTokens() });
    const abort = () => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error(`${label} was cancelled.`));
    };
    ctx.signal?.addEventListener('abort', abort, { once: true });
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(pulse);
      ctx.signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error(`${label} timed out. Start it again, complete the GitHub browser/device-code page, or paste a token in Settings.`));
    }, 10 * 60 * 1000);
    const started = Date.now();
    const pulse = setInterval(() => {
      const waited = Math.floor((Date.now() - started) / 1000);
      ctx.progress(Math.min(82, 45 + Math.floor(waited / 12)));
      if (waited && waited % 60 === 0) ctx.log(`Still waiting for GitHub browser sign-in (${Math.floor(waited / 60)} minute${waited >= 120 ? 's' : ''})…`);
    }, 5000);
    const onLine = (line) => {
      lines.push(line);
      if (!/^\s*-\s*Token:/i.test(line)) ctx.log(line);
      const code = line.match(/one-time code:\s*([A-Z0-9-]+)/i)?.[1];
      if (code && !codeShown) {
        codeShown = true;
        ctx.step(`GitHub sign-in: enter code ${code}`);
        ctx.progress(45);
      }
      const url = line.match(/https:\/\/github\.com\/login\/device/i)?.[0];
      if (url && !urlOpened) {
        urlOpened = true;
        openBrowser(url);
        ctx.log(`Opened ${url}. If it did not open, copy the URL and enter the code shown above.`);
      }
    };
    const onData = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(onLine);
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.stdin.end('\n');
    child.on('error', () => finish(reject, new Error('GitHub CLI (gh) not found. Install it from https://cli.github.com or paste a token in Settings.')));
    child.on('exit', (exitCode) => finish(resolveP, { code: exitCode, lines }));
  });
}

function activeGhLogin(lines) {
  const text = lines.join('\n').trim();
  try {
    const host = JSON.parse(text.replace(/""/g, '"'))?.hosts?.['github.com'] || [];
    return (host.find((x) => x.active) || host[0])?.login || '';
  } catch {
    return (text.match(/"?login"?\s*:\s*"([^"]+)/i) || text.match(/account\s+([^\s()]+)/i) || [])[1] || '';
  }
}

async function loadCopilotFromGh(ctx) {
  const token = await runGh(['auth', 'token', '--hostname', 'github.com'], ctx, { log: false });
  const value = token.lines.join('').trim();
  if (token.code !== 0 || !value) throw new Error('GitHub CLI is signed in, but it could not return a token. Use Switch GitHub account, or paste a token in Settings.');
  await A.setGitHubToken(value);
  return A.copilotStatus();
}

route('POST', '/api/copilot/token', async (_, b) => { developerOnly(); await A.setGitHubToken(String(b.token || '').trim()); return A.copilotStatus(); });
const runningGitHubLogin = () => listJobs().find((j) => j.kind === 'github-login' && j.status === 'running');
async function copilotStatusWithGh(ctx = null) {
  const s = await A.copilotStatus();
  if (s.isAuthenticated || getSettings().provider.id !== 'github' || !isDeveloper()) return s;
  const current = await runGh(['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'], ctx, { log: false });
  if (current.code !== 0 || !activeGhLogin(current.lines)) return s;
  try { return await loadCopilotFromGh(ctx || { log: () => {} }); } catch { return s; }
}
route('POST', '/api/copilot/login', () => developerOnly() || runningGitHubLogin() || startJob('github-login', 'Sign in to GitHub', async (ctx) => {
  ctx.step('Check the GitHub CLI sign-in');
  const current = await runGh(['auth', 'status', '--hostname', 'github.com'], ctx);
  if (current.code === 0) {
    ctx.log('GitHub CLI is already signed in. Checking Copilot access…');
    const s = await copilotStatusWithGh(ctx);
    if (s.isAuthenticated) return { ok: true, alreadySignedIn: true };
    throw new Error(`${s.statusMessage || 'GitHub is signed in, but Copilot access was not accepted.'} If this account has a Copilot seat, paste a token with Copilot access or sign out with "gh auth logout --hostname github.com" and sign in again.`);
  }

  ctx.step('Open GitHub in the browser');
  ctx.progress(35);
  const login = await runGhBrowserLogin(ctx, 'GitHub sign-in');
  if (login.code !== 0) {
    const detail = login.lines.slice(-4).join(' ').trim();
    throw new Error(`GitHub CLI sign-in did not finish${detail ? `: ${detail}` : ` (exit ${login.code})`}. Try again, or paste a token in Settings.`);
  }
  const s = await loadCopilotFromGh(ctx);
  if (!s.isAuthenticated) throw new Error(`${s.statusMessage || 'GitHub sign-in finished, but Copilot access was not accepted.'} Choose another provider or paste a token with Copilot access.`);
  return { ok: true };
}));
route('POST', '/api/copilot/switch', () => developerOnly() || runningGitHubLogin() || startJob('github-login', 'Switch GitHub account', async (ctx) => {
  ctx.step('Sign out of the current GitHub CLI account');
  A.setGitHubToken('');
  const current = await runGh(['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'], ctx, { log: false });
  const login = current.code === 0 ? activeGhLogin(current.lines) : '';
  if (login) {
    ctx.log(`Signing out ${login} from GitHub CLI on this computer…`);
    const out = await runGh(['auth', 'logout', '--hostname', 'github.com', '--user', login], ctx);
    if (out.code !== 0) throw new Error(`GitHub CLI couldn't sign out ${login}. ${out.lines.slice(-3).join(' ') || `Exit ${out.code}`}`);
  } else {
    ctx.log('No active GitHub CLI account was found; continuing to sign in.');
  }

  ctx.step('Open GitHub in the browser for the new account');
  ctx.progress(35);
  const next = await runGhBrowserLogin(ctx, 'GitHub account switch');
  if (next.code !== 0) {
    const detail = next.lines.slice(-4).join(' ').trim();
    throw new Error(`GitHub CLI sign-in did not finish${detail ? `: ${detail}` : ` (exit ${next.code})`}. Try again, or paste a token in Settings.`);
  }
  const s = await loadCopilotFromGh(ctx);
  if (!s.isAuthenticated) throw new Error(`${s.statusMessage || 'GitHub sign-in finished, but Copilot access was not accepted.'} Choose another provider or paste a token with Copilot access.`);
  return { ok: true, switched: true };
}));

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
route('POST', '/api/project/reset', () => { clearActivity(); DP.clearDataPrepFiles(); return resetProject(); });
route('POST', '/api/project/workspace', (_, b) => P.selectWorkspace(b));
// Naming standard [Domain]_[Object]_[Purpose]_[Environment]: what the environment is for and the business domain.
route('GET', '/api/naming', () => N.namingState());
route('PUT', '/api/naming', (_, b) => N.setNaming({ domain: b.domain, environment: b.environment, intent: b.intent }));

route('GET', '/api/sources/catalog', () => catalog());
route('POST', '/api/sources/test', (_, b) => P.testSource(b));
route('POST', '/api/sources/discover', (_, b) => P.discoverSource(b));
route('POST', '/api/sources/connection', (_, b) => P.createConnection(b));
route('GET', '/api/sources/items', (_, __, q) => P.listSourceItems(q.get('workspaceId'), q.get('itemType')));
route('POST', '/api/sources/item-tables', (_, b) => P.listTablesOfItem(b));
route('POST', '/api/sources/in-place', (_, b) => P.useInPlace(b));
// Data sources of the workspace: each keeps what was built from it; switching changes nothing in Fabric.
route('GET', '/api/sources/contexts', () => P.sourcesState());
route('GET', '/api/sources/workspace', (_, __, q) => P.workspaceDataSources({ workspaceId: q.get('workspaceId') || undefined }));
route('POST', '/api/sources/switch', (_, b) => P.switchSource(String(b.key || '')));
route('GET', '/api/sources/current/mirroring', () => P.currentMirroringStatus());

route('GET', '/api/model/describe', (_, __, q) => P.describeModelSource({ refresh: q.get('refresh') === '1' }));
route('GET', '/api/ontology/preview', () => P.ontologyPreview());
route('GET', '/api/data-prep', () => DP.dataPrepState());
route('GET', '/api/prompts', () => promptSuggestions());
route('GET', '/api/data-agent', () => DA.dataAgentState());
route('POST', '/api/jobs/data-agent', (_, b) => startJob('data-agent', `${getProject().dataAgent?.id ? 'Update' : 'Create'} the Fabric data agent`, (ctx) => DA.runDataAgent(ctx, { name: b.name, instructions: b.instructions, description: b.description, publish: b.publish !== false, proposalId: b.proposalId })));
route('DELETE', '/api/data-agent', (_, __, q) => DA.removeDataAgent({ deleteItem: q.get('delete') === '1' }));
route('POST', '/api/jobs/data-prep', (_, b) => startJob('data-prep', b.run === false ? 'Create the data prep notebook' : 'Create and run the data prep notebook', (ctx) => DP.runDataPrep(ctx, { run: b.run !== false, target: b.target === 'same' ? 'same' : 'new' })));
route('POST', '/api/data-prep/refresh', () => DP.refreshDataPrep());
route('DELETE', '/api/data-prep', (_, __, q) => DP.removeDataPrep({ deleteItems: q.get('delete') === '1' }));

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
route('GET', '/api/report-templates', () => ({ templates: TPL.listTemplates(), accept: TPL.ACCEPT }));
route('GET', '/api/report-templates/:id/check', (p) => TPL.checkTemplate(p.id));
route('DELETE', '/api/report-templates/:id', (p) => TPL.removeTemplate(p.id));
route('POST', '/api/jobs/report-template', (_, b) => startJob('report-template', `Build Power BI report from template ${TPL.getTemplate(b.id)?.name || ''}`.trim(), (ctx) => TPL.runTemplateReport(ctx, { id: b.id, name: b.name })));
route('GET', '/api/reports/profile', (_, __, q) => R.currentProfile({ refresh: q.get('refresh') === '1' }));
route('GET', '/api/reports/recommendations', (_, __, q) => R.currentRecommendations({ refresh: q.get('refresh') === '1' }));
route('POST', '/api/jobs/org-app', (_, b) => startJob('org-app', `Create org app ${b.name || ''}`.trim(), (ctx) => APPS.runOrgApp(ctx, { name: b.name, theme: b.theme, reportIds: Array.isArray(b.reportIds) ? b.reportIds : undefined, title: b.title, body: b.body })));
route('GET', '/api/realtime', () => RT.realtimeState());
route('GET', '/api/realtime/summary', (_, __, q) => RT.liveSummary({ minutes: Math.min(1440, Math.max(1, Number(q.get('minutes')) || 15)) }));
route('POST', '/api/realtime/query', (_, b) => RT.liveQuery(String(b.kql || ''), { maxRows: Math.min(500, Number(b.maxRows) || 50) }));
route('POST', '/api/jobs/realtime-setup', (_, b) => startJob('realtime', 'Set up live data (Eventhouse + Eventstream)', (ctx) => RT.runRealtimeSetup(ctx, { name: b.name })));
route('POST', '/api/jobs/realtime-dashboard', (_, b) => startJob('realtime-dashboard', `Build Real-Time Dashboard ${b.name || ''}`.trim(), (ctx) => RT.runRealtimeDashboard(ctx, { name: b.name, refreshSeconds: b.refreshSeconds })));
route('POST', '/api/realtime/simulator/start', async (_, b) => { await assertProjectTenant(); await assertLiveEventsAllowed(); return RT.startLiveEvents({ rate: b.rate, ruleBreakPct: b.ruleBreakPct, dataIssuePct: b.dataIssuePct, minutes: b.minutes, backfillMinutes: b.backfillMinutes }); });
route('PATCH', '/api/realtime/simulator', (_, b) => RT.updateLiveEvents({ rate: b.rate, ruleBreakPct: b.ruleBreakPct, dataIssuePct: b.dataIssuePct }));
route('POST', '/api/realtime/simulator/stop', () => RT.stopLiveEvents());
route('GET', '/api/realtime/endpoint', (_, __, q) => RT.endpointInfo({ withKey: q.get('key') === '1' }));
route('DELETE', '/api/realtime', async (_, __, q) => { if (q.get('delete') === '1') await assertProjectTenant(); return RT.removeRealtime({ deleteItems: q.get('delete') === '1' }); });
route('POST', '/api/jobs/realtime-ontology', (_, b) => startJob('realtime-ontology', b.unlink ? 'Remove live properties from the ontology' : 'Bind live events to the ontology', (ctx) => RT.runLiveOntology(ctx, { unlink: Boolean(b.unlink) })));
route('POST', '/api/jobs/realtime-alerts', (_, b) => startJob('realtime-alerts', 'Set up Activator alerts on rule breaks', (ctx) => RT.runRealtimeAlerts(ctx, { channel: b.channel, recipients: b.recipients, rules: Array.isArray(b.rules) ? b.rules : undefined, minAmount: b.minAmount })));
route('DELETE', '/api/realtime/alerts', async (_, __, q) => { await assertProjectTenant(); return RT.removeAlerts({ keepItem: q.get('keep') === '1' }); });
route('GET', '/api/realtime/medallion', (_, __, q) => RT.medallionHealth({ minutes: Math.min(1440, Math.max(1, Number(q.get('minutes')) || 15)) }));
route('POST', '/api/realtime/medallion/preview', (_, b) => RT.medallionPreview(b));
route('POST', '/api/jobs/medallion', (_, b) => startJob('medallion', 'Apply the medallion layers (Bronze, Silver, Gold)', (ctx) => RT.runMedallion(ctx, { bronzeDays: b.bronzeDays, silverDays: b.silverDays, goldDays: b.goldDays, oneLake: b.oneLake })));
route('POST', '/api/jobs/medallion-remove', (_, b) => startJob('medallion-remove', 'Remove the medallion layers', (ctx) => RT.removeMedallion(ctx, { deleteItems: b.deleteItems !== false })));
route('POST', '/api/realtime/taskflow/sync', async () => { await assertProjectTenant(); return (await RT.syncTaskFlow()) || { ok: false, error: RT.realtimeState().setup?.medallion?.taskFlowError || 'Apply the medallion layers first.' }; });
// Task flow moves from the UI or Copilot: { itemId: taskKey | '' } (an empty task keeps the item off the flow).
const cleanOverrides = (o) => (o && typeof o === 'object' && !Array.isArray(o)
  ? Object.fromEntries(Object.entries(o).slice(0, 300).filter(([k, v]) => /^[0-9a-z-]{8,64}$/i.test(k) && typeof v === 'string' && v.length <= 120))
  : undefined);
// Workspace task flows: Fabric's predesigned flows or a task flow already in the workspace, with the project's items
// assigned to their tasks.
route('GET', '/api/taskflow', (_, __, q) => WTF.taskFlowState({ choice: q.get('choice') || undefined, fresh: q.get('refresh') === '1' }));
route('POST', '/api/taskflow/preview', (_, b) => WTF.taskFlowState({ choice: b.choice, overrides: cleanOverrides(b.overrides) }));
route('POST', '/api/jobs/taskflow', (_, b) => startJob('taskflow', 'Apply the task flow', (ctx) => WTF.runTaskFlow(ctx, { choice: b.choice, overrides: cleanOverrides(b.overrides) })));
route('DELETE', '/api/taskflow', () => WTF.removeTaskFlow());
// Semantic models: the project's models (one active), existing models in any workspace, adding and switching.
route('GET', '/api/models', () => MODELS.modelsState());
route('GET', '/api/models/available', (_, __, q) => MODELS.availableModels(q.get('workspaceId') || undefined));
route('GET', '/api/models/measures', async (_, __, q) => {
  const { modelMetadata } = await import('./powerbi.mjs');
  const id = q.get('id') || getProject().semanticModel?.id;
  const p = getProject();
  const m = id ? projectModels(p).find((x) => x.id === id) : p.semanticModel;
  if (!m) throw Object.assign(new Error('There is no semantic model yet.'), { status: 404 });
  const meta = await modelMetadata(modelWorkspaceId(p, m), m.id);
  return { model: { id: m.id, name: m.name }, measures: meta.measures.map((x) => ({ table: x.table, name: x.name, expression: x.expression, displayFolder: x.displayFolder, formatString: x.formatString, description: x.description })) };
});
// An existing model that becomes active brings what is built on it to the map (looked for in the background, once).
route('POST', '/api/models/active', async (_, b) => { const s = await MODELS.useModel(String(b.id || '')); WTF.syncTaskFlow().catch(() => {}); return { ...s, linksJob: LINKS.ensureModelLinks(s.active) }; });
route('POST', '/api/models/existing', async (_, b) => { const s = await MODELS.addExistingModel({ workspaceId: b.workspaceId ? String(b.workspaceId) : undefined, id: String(b.id || '') }); WTF.syncTaskFlow().catch(() => {}); return { ...s, linksJob: LINKS.ensureModelLinks(s.active) }; });
route('POST', '/api/models/refresh', (_, b) => MODELS.refreshModelInfo(b.id ? String(b.id) : undefined));
route('POST', '/api/jobs/model-links', (_, b) => {
  const id = b.id ? String(b.id) : getProject().semanticModel?.id;
  if (!id) throw Object.assign(new Error('There is no semantic model yet.'), { status: 400 });
  return LINKS.startModelLinks(id);
});
// Check a model's relationships against the data it reads, and remove exact duplicate rows in a warehouse.
route('GET', '/api/models/check', (_, __, q) => MC.checkModel({ id: q.get('id') || undefined, fresh: q.get('fresh') === '1' }));
route('POST', '/api/jobs/model-fix', (_, b) => startJob('model-fix', 'Remove duplicate rows the semantic model can\'t use', (ctx) => MC.runFixDuplicates(ctx, { id: b.id ? String(b.id) : undefined, tables: Array.isArray(b.tables) ? b.tables.map(String) : undefined })));
route('POST', '/api/jobs/model-reload', (_, b) => startJob('model-reload', 'Reload the semantic model with the current data', (ctx) => MC.runReloadModel(ctx, { id: b.id ? String(b.id) : undefined })));
route('POST', '/api/jobs/model-hide-keys', (_, b) => startJob('model-fix', 'Hide relationship keys in the semantic model', (ctx) => MC.runHideRelationshipKeys(ctx, { id: b.id ? String(b.id) : undefined })));
// Everything the project built, what uses what, and removing items nothing uses any more.
route('GET', '/api/artifacts', () => ARTS.projectArtifacts());
route('POST', '/api/jobs/remove', (_, b) => {
  const keys = (Array.isArray(b.keys) ? b.keys : [b.key]).filter(Boolean).map(String).slice(0, 50);
  if (!keys.length) throw Object.assign(new Error('Choose what to remove.'), { status: 400 });
  return startJob('remove', keys.length === 1 ? `Remove ${b.name || keys[0]}` : `Remove ${keys.length} items`, (ctx) => ARTS.removeArtifacts(ctx, keys));
});
onJobSucceeded((j) => { if (WTF.SYNC_KINDS.has(j.kind)) WTF.syncTaskFlow().catch(() => {}); });
route('GET', '/api/planning', () => PL.planningState());
route('GET', '/api/readiness', (_, __, q) => readiness({ refresh: q.get('refresh') === '1' }));
route('GET', '/api/readiness/fixes', (_, __, q) => prerequisiteFixes({ refresh: q.get('refresh') === '1' }));
route('POST', '/api/planning/preview', (_, b) => PL.planPreview(PL.planOptions(b)));
route('GET', '/api/planning/summary', () => PL.planSummary());
route('POST', '/api/jobs/planning', (_, b) => startJob('planning', 'Build the budget and forecast', (ctx) => PL.runPlan(ctx, PL.planOptions(b))));
route('POST', '/api/jobs/plan-item', (_, b) => startJob('plan-item', b.connection ? 'Change the Fabric plan connection' : 'Create the Fabric plan', (ctx) => PL.runPlanItem(ctx, { name: b.name, connection: typeof b.connection === 'string' && b.connection ? b.connection : undefined })));
route('GET', '/api/planning/connections', () => PL.planConnections());
// Who can open the model in a plan (workspace roles), and giving a planner Contributor access.
route('GET', '/api/planning/access', () => PL.planAccess());
route('POST', '/api/planning/access', async (_, b) => { await assertProjectTenant(); return PL.addPlanner({ email: b.email, role: b.role || 'Contributor' }); });
route('DELETE', '/api/planning', async (_, __, q) => { await assertProjectTenant(); return PL.removePlan({ deleteData: q.get('data') === '1', deleteItem: q.get('item') === '1' }); });
route('DELETE', '/api/reports/:id', (p, _, q) => R.removeReport(p.id, { deleteItem: q.get('delete') === '1' }));
route('GET', '/api/teardown/plan', (_, __, q) => P.teardownPlan({ deleteWorkspace: q.get('workspace') === '1' }));
// Deleting is only started with the workspace name typed in the confirmation, never by a stray request.
route('POST', '/api/jobs/teardown', (_, b) => {
  const ws = getProject().workspace;
  if (!ws) throw Object.assign(new Error('There is no workspace to clean up.'), { status: 400 });
  if (String(b.confirm ?? '').trim() !== ws.name) throw Object.assign(new Error(`Type the workspace name "${ws.name}" to confirm the clean up.`), { status: 400, code: 'CONFIRM_REQUIRED' });
  return startJob('teardown', 'Clean up demo resources', async (ctx) => { try { return await P.runTeardown(ctx, b); } finally { resetReadiness(); } });
});
route('GET', '/api/jobs', () => listJobs());
route('GET', '/api/jobs/:id', (p) => getJob(p.id));
route('POST', '/api/jobs/:id/cancel', (p) => ({ ok: cancelJob(p.id) }));

route('GET', '/api/activity', () => getActivity());
route('GET', '/api/costs', (_, __, q) => COST.costState({ capacityId: q.get('capacityId') || undefined }));
route('GET', '/api/export', () => ({ exportedAt: new Date().toISOString(), version: VERSION, project: getProject(), activity: getActivity() }));

route('POST', '/api/shutdown', () => {
  const running = listJobs().filter((j) => j.status === 'running');
  for (const j of running) cancelJob(j.id);
  RT.stopLiveEvents();
  setTimeout(async () => { await A.stopAgent(); process.exit(0); }, running.length ? 1500 : 300);
  return { ok: true, cancelled: running.length };
});

// Restart with the code on disk (after an update): a new copy takes over this port once this one has stopped. Its
// output goes to data\studio.log (or studio.restart.log, see restartLog). Running jobs would be cut off, so they have
// to finish first.
route('POST', '/api/restart', async () => {
  const running = listJobs().filter((j) => j.status === 'running');
  if (running.length) throw Object.assign(new Error(`"${running[0].title}"${running.length > 1 ? ` and ${running.length - 1} more` : ''} ${running.length > 1 ? 'are' : 'is'} still running. Wait for ${running.length > 1 ? 'them' : 'it'} to finish (or stop ${running.length > 1 ? 'them' : 'it'}), then restart.`), { status: 409, code: 'JOBS_RUNNING' });
  const keep = [];
  for (let i = 0; i < args.length; i++) {
    if (['--port', '--restart-of', '--restart-token'].includes(args[i])) { i++; continue; }
    if (args[i] !== '--no-open') keep.push(args[i]);
  }
  const attempt = randomBytes(6).toString('hex');
  const serverArgs = [fileURLToPath(import.meta.url), ...keep, '--no-open', '--port', String(PORT), '--restart-of', String(process.pid), '--restart-token', attempt];
  const ready = join(DATA_DIR, `restart-${process.pid}-${attempt}.ready`);
  rmSync(ready, { force: true });
  const log = restartLog();
  if (process.platform === 'win32') await startHidden(serverArgs, log);
  else {
    let out = 'ignore';
    try { out = openSync(log, 'a'); } catch { /* read-only data folder */ }
    spawn(process.execPath, serverArgs, { cwd: STUDIO_ROOT, env: process.env, detached: true, stdio: ['ignore', out, out] }).unref();
  }
  // Stop only once the new copy has loaded (its code and modules work); otherwise keep running and say why.
  const t0 = Date.now();
  while (!existsSync(ready) && Date.now() - t0 < 45000) await new Promise((r) => setTimeout(r, 250));
  if (!existsSync(ready)) {
    logActivity('studio.restart', 'The new copy of Fabric MCP Studio didn\'t start, so this one keeps running', {});
    throw Object.assign(new Error(`The new copy of the studio didn't start within 45 seconds, so this one keeps running. See ${log}, or shut the studio down and start it again from the desktop shortcut.`), { status: 500, code: 'RESTART_FAILED' });
  }
  rmSync(ready, { force: true });
  logActivity('studio.restart', `Restarting Fabric MCP Studio${pendingUpdate() ? ` to update from ${VERSION} to ${pendingUpdate().onDisk}` : ''}`, {});
  RT.stopLiveEvents();
  setTimeout(async () => { await A.stopAgent(); process.exit(0); }, 300);
  return { ok: true };
});

/**
 * The log the new copy writes to. On Windows the console that runs this copy (the desktop icon's, or an earlier
 * restart's) keeps its log locked until this copy stops – a second redirect to it fails and the new copy never starts.
 * The new copy takes whichever of studio.log and studio.restart.log is free, so the two take turns.
 */
function restartLog() {
  for (const name of ['studio.log', 'studio.restart.log']) {
    const file = join(DATA_DIR, name);
    try { closeSync(openSync(file, 'a')); return file; } catch { /* in use by the running copy */ }
  }
  return join(DATA_DIR, `studio.${process.pid}.log`);
}

/**
 * Windows: start the new copy in a hidden console, like the desktop shortcut does. A detached process has no console
 * at all, and then every console program it runs (the Azure CLI, the Copilot runtime's tools) opens a window of its
 * own. A small launcher in the data folder runs it; PowerShell starts that launcher hidden. PowerShell itself must not
 * be detached (it then can't start a hidden window); what it starts outlives this process. Waits until it has.
 */
function startHidden(serverArgs, log) {
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  const pct = (s) => s.replace(/%/g, '%%');
  const launcher = join(DATA_DIR, 'restart-studio.cmd');
  // cmd.exe reads a batch file in the console's code page: switch it to UTF-8 first, so paths such as C:\Users\José
  // survive. The file itself is written as UTF-8.
  writeFileSync(launcher, [
    '@echo off',
    'chcp 65001 >nul',
    `cd /d ${pct(q(STUDIO_ROOT))}`,
    `${pct(q(process.execPath))} ${serverArgs.map((a) => pct(q(a))).join(' ')} >> ${pct(q(log))} 2>&1`,
    '',
  ].join('\r\n'));
  const ps = `Start-Process -FilePath '${launcher.replace(/'/g, "''")}' -WindowStyle Hidden`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { cwd: STUDIO_ROOT, env: process.env, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(resolve, 20000);
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(`The studio couldn't restart itself (${e.message}). Shut it down and start it again.`), { status: 500 })); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`The studio couldn't restart itself (PowerShell exited with ${code}). Shut it down and start it again.`), { status: 500 }));
    });
  });
}

// ---------------- server ----------------

// Only this computer's own names for the studio: a web page whose name was rebound to 127.0.0.1 (DNS rebinding) sends
// its own name in Host and never gets the page (with the token) or the API.
const ownHosts = () => new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...(PORT === 80 ? ['127.0.0.1', 'localhost'] : [])]);
const ownOrigin = (origin) => { try { return ownHosts().has(new URL(origin).host.toLowerCase()); } catch { return false; } };

const server = createServer(async (req, res) => {
  if (!ownHosts().has(String(req.headers.host || '').toLowerCase())) return send(res, 403, `Forbidden: open the studio at http://127.0.0.1:${PORT}/`);
  // Changes come only from the studio's own pages (every API call needs the token as well).
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && !ownOrigin(req.headers.origin)) return send(res, 403, { error: 'Forbidden' });
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
    const dpc = pathname.match(/^\/api\/data-prep\/charts\/([\w.-]+\.png)$/i);
    if (dpc && req.method === 'GET') {
      if (url.searchParams.get('t') !== TOKEN) return send(res, 401, { error: 'Unauthorized' });
      const bytes = DP.dataPrepChart(dpc[1]);
      if (!bytes) return send(res, 404, { error: 'No chart' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(bytes);
    }
    if (DEMO_MODE && pathname.startsWith('/api/')) {
      if (req.headers['x-studio-token'] !== TOKEN) return send(res, 401, { error: 'Unauthorized' });
      const demo = demoApi(req.method, pathname, url.searchParams);
      if (demo) return send(res, demo.status, demo.body);
      if (!['GET', 'HEAD'].includes(req.method)) return send(res, 403, { error: 'Safe demo mode is read-only. Start the studio without STUDIO_DEMO=1 to make changes in Fabric.', code: 'DEMO_MODE' });
    }
    // Template uploads are raw bytes (a .pbix can be large), not JSON.
    if (pathname === '/api/report-templates/upload' && req.method === 'POST') {
      if (req.headers['x-studio-token'] !== TOKEN) return send(res, 401, { error: 'Unauthorized' });
      const bytes = await rawBody(req, TPL.MAX_UPLOAD);
      return send(res, 200, TPL.importTemplate(String(url.searchParams.get('name') || ''), bytes));
    }    if (pathname.startsWith('/api/')) {
      if (req.headers['x-studio-token'] !== TOKEN) return send(res, 401, { error: 'Unauthorized' });
      const r = routes.find((x) => x.method === req.method && x.rx.test(pathname));
      if (!r) return send(res, 404, { error: 'Not found', code: 'NO_ROUTE' });
      const m = pathname.match(r.rx);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const b = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await body(req) : {};
      // Jobs change Fabric; never run them against a project that lives in another tenant, or for a module that can't run.
      if (req.method === 'POST' && pathname.startsWith('/api/jobs/') && !pathname.endsWith('/cancel')) {
        await assertProjectTenant();
        await assertModuleReady(pathname.split('/')[3]);
      }
      const result = await r.handler(params, b, url.searchParams);
      return send(res, 200, result ?? { ok: true });
    }
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  } catch (e) {
    const status = e.status || (e.code === 'AUTH_REQUIRED' ? 401 : 500);
    if (status >= 500) console.error(`[${req.method} ${pathname}]`, e.message);
    // Fabric's answer in plain words (as for jobs); the request line and raw JSON stay in the server log.
    return send(res, status, { error: plainError(e.message || String(e)), code: e.code || null });
  }
});

function listen(port, attempts = 10) {
  server.once('error', (e) => {
    // A copy started by Restart takes over the studio's own port or stops: on another port it would be a second studio
    // on the same data folder (another restart's copy got the port first).
    if (e.code === 'EADDRINUSE' && restartOf) { console.error(`Port ${port} is taken – another copy of the studio is already running there; this copy stops.`); process.exit(1); }
    if (e.code === 'EADDRINUSE' && attempts > 0) listen(port + 1, attempts - 1);
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    PORT = port;
    const url = `http://127.0.0.1:${port}/`;
    try { writeJson(RUNTIME_FILE, { pid: process.pid, port, url, startedAt: new Date().toISOString() }); } catch { /* read-only data folder */ }
    // Ready files left by restarts that timed out.
    try { for (const f of readdirSync(DATA_DIR)) if (/^restart-\d+(-[\w-]+)?\.ready$/.test(f) && Date.now() - statSync(join(DATA_DIR, f)).mtimeMs > 5 * 60 * 1000) rmSync(join(DATA_DIR, f), { force: true }); } catch { /* ignore */ }
    console.log(`\n  Fabric MCP Studio ${VERSION}${BUILD ? ` (build ${BUILD.commit})` : ''} is running at ${url}\n  Sample app provided as is - not an official Microsoft product or supported service.\n  Press Ctrl+C to stop.\n`);
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
