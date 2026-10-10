// Paths, settings and small shared helpers.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(STUDIO_ROOT, '..');
export const WEB_ROOT = join(STUDIO_ROOT, 'web');
export const DATA_DIR = process.env.STUDIO_DATA_DIR ? resolve(process.env.STUDIO_DATA_DIR) : join(STUDIO_ROOT, 'data');
export const COPILOT_HOME = join(DATA_DIR, 'copilot-home');
export const DEMO_MODE = /^(1|true|yes|on)$/i.test(String(process.env.STUDIO_DEMO || ''));

/**
 * Version from the release history (releases.json): 1.<improvements>.<fixes>. Each change also gets the version it
 * brought the studio to. Falls back to package.json when the history can't be read.
 */
function releaseHistory() {
  try {
    const { changes = [] } = JSON.parse(readFileSync(join(STUDIO_ROOT, 'releases.json'), 'utf8'));
    let improvements = 0;
    let fixes = 0;
    const list = changes.map((c) => {
      if (c.type === 'improvement') improvements++;
      else if (c.type === 'fix') fixes++;
      return { ...c, version: `1.${improvements}.${fixes}` };
    });
    return { version: `1.${improvements}.${fixes}`, improvements, fixes, changes: list.reverse() };
  } catch {
    return { version: JSON.parse(readFileSync(join(STUDIO_ROOT, 'package.json'), 'utf8')).version, improvements: 0, fixes: 0, changes: [] };
  }
}

/** The git commit the studio runs from (a copy without git has none). */
function gitBuild() {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%h|%cs'], { cwd: STUDIO_ROOT, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
    const [commit, date] = out.split('|');
    return commit ? { commit, date } : null;
  } catch { return null; }
}

export const RELEASES = releaseHistory();
export const VERSION = RELEASES.version;
export const BUILD = gitBuild();

// The server's code is read once, at start; the pages are read from disk on every request. After an update (git pull,
// a copy from another computer) the pages are new and the server is old until it restarts. Copies can keep their
// original times, so any change to the files counts – not only newer ones – and so does another version.
const serverFiles = (dir, out = new Map()) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) serverFiles(p, out);
    else if (/\.(mjs|js|json|md)$/i.test(e.name)) out.set(p, statSync(p).mtimeMs);
  }
  return out;
};
const codeAt = () => { try { const m = serverFiles(join(STUDIO_ROOT, 'server')); m.set('releases', statSync(join(STUDIO_ROOT, 'releases.json')).mtimeMs); return m; } catch { return null; } };
const STARTED_CODE = codeAt();
let updateCheck = { at: 0, value: null };

/** A newer version on disk than the one running: { running, onDisk } (checked at most every 15 seconds), else null. */
export function pendingUpdate() {
  if (Date.now() - updateCheck.at < 15000) return updateCheck.value;
  const now = codeAt();
  const onDisk = releaseHistory().version;
  const changed = onDisk !== VERSION || Boolean(STARTED_CODE && now && (now.size !== STARTED_CODE.size || [...now].some(([p, t]) => STARTED_CODE.get(p) !== t)));
  updateCheck = { at: Date.now(), value: changed ? { running: VERSION, onDisk } : null };
  return updateCheck.value;
}

for (const d of [DATA_DIR, COPILOT_HOME]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

export function writeJson(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  // On Windows a virus scanner or indexer can hold the file for a moment: retry briefly instead of failing the job.
  for (let attempt = 1; ; attempt++) {
    try { renameSync(tmp, path); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

/**
 * Developer mode: GitHub Copilot (sign-in with GitHub, Copilot models) is for the people who build the studio, not for
 * business users. Turn it on with the STUDIO_DEVELOPER=1 environment variable or an empty "developer" file in the
 * studio's data folder. Everyone else uses Azure AI Foundry / Azure OpenAI, OpenAI, Anthropic or a local model.
 */
export function isDeveloper() {
  return /^(1|true|yes|on)$/i.test(String(process.env.STUDIO_DEVELOPER || '')) || existsSync(join(DATA_DIR, 'developer'));
}

export const DEFAULT_SETTINGS = {
  theme: '',
  approvalMode: 'ask',              // ask | auto | readonly
  provider: { id: 'github', model: 'auto', reasoningEffort: '', config: {} },
  mcp: {
    'fabric-core': true,
    'powerbi-authoring': 'hosted',    // hosted | local | off
    'fabric-iq': true,
    'fabric-local': true,
    'fabric-ontology': true,
  },
  azure: { tenantId: '', authMode: 'auto' },  // auto | azure-cli | browser
};

let settingsCache = null;
// Providers for developer mode only (the people who build the studio). Outside developer mode a saved one is replaced
// in memory only: what was saved stays on disk until the user picks another provider, so turning developer mode back
// on restores it.
export const DEVELOPER_PROVIDERS = new Set(['github', 'openrouter']);
let providerSwap = null; // { replacement, saved }

export function getSettings() {
  if (!settingsCache) {
    const saved = readJson(SETTINGS_FILE, {});
    settingsCache = deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
  }
  // Outside developer mode GitHub Copilot and OpenRouter aren't offered: Azure AI Foundry / Azure OpenAI (Entra
  // sign-in) is used instead. Checked on every read, because developer mode can be turned on or off while the studio
  // runs (the data\developer file or STUDIO_DEVELOPER): the saved choice comes back when developer mode does.
  const dev = isDeveloper();
  if (!dev && DEVELOPER_PROVIDERS.has(settingsCache.provider?.id)) {
    const replacement = { id: 'azure-openai', model: '', reasoningEffort: '', config: { authMode: 'entra' } };
    providerSwap = { replacement, saved: settingsCache.provider };
    settingsCache.provider = replacement;
  } else if (dev && providerSwap && settingsCache.provider === providerSwap.replacement) {
    settingsCache.provider = providerSwap.saved;
    providerSwap = null;
  }
  return settingsCache;
}

// Secrets (API keys) are never persisted; they live in memory or come from environment variables.
const SECRET_KEYS = new Set(['apiKey', 'clientSecret', 'password']);

export function saveSettings(patch) {
  const next = deepMerge(getSettings(), patch);
  settingsCache = next;
  const disk = stripSecrets(next);
  // The in-memory replacement of a GitHub provider is never written; a provider the user picks is.
  if (providerSwap && next.provider === providerSwap.replacement && !patch?.provider) disk.provider = stripSecrets(providerSwap.saved);
  writeJson(SETTINGS_FILE, disk);
  return next;
}

function stripSecrets(obj) {
  if (Array.isArray(obj)) return obj.map(stripSecrets);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (!SECRET_KEYS.has(k)) out[k] = stripSecrets(v);
    return out;
  }
  return obj;
}

export function publicSettings() {
  const s = stripSecrets(getSettings());
  const cfg = getSettings().provider.config || {};
  s.provider.hasApiKey = Boolean(cfg.apiKey || envApiKey(getSettings().provider.id));
  s.developer = isDeveloper();
  return s;
}

export function envApiKey(providerId) {
  return {
    'azure-openai': process.env.AZURE_OPENAI_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    local: process.env.LOCAL_LLM_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  }[providerId] || '';
}

export function deepMerge(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      target[k] = deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export const newId = () => randomUUID();
export const shortHash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A dropped or refused connection (Wi-Fi, VPN, proxy, a service resetting the connection) – not an answer from the service.
const NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED']);
// The request never left this computer, so any call can be sent again without doing anything twice.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT']);
const netCode = (e) => e?.cause?.code || e?.code || '';
export const isNetworkError = (e) => e?.code === 'NETWORK' || (e instanceof TypeError && /fetch failed/i.test(e.message)) || NET_CODES.has(netCode(e));

/**
 * fetch that tries again when the connection drops. Reads (and calls marked repeatable) are sent again on any dropped
 * connection; changes only when the request never left this computer, so nothing is made twice. When it keeps failing,
 * the error says it was the connection (code NETWORK) – not the user's access.
 */
export async function netFetch(url, init = {}, { tries = 4, repeatable = false } = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (init.signal?.aborted || !isNetworkError(e)) throw e;
      const again = repeatable || method === 'GET' || method === 'HEAD' || NOT_SENT.has(netCode(e));
      if (!again || attempt >= tries) {
        let host = 'the service';
        try { host = new URL(url).host; } catch { /* keep the generic name */ }
        const code = netCode(e);
        throw Object.assign(new Error(`The connection to ${host} dropped${code ? ` (${code})` : ''}${attempt > 1 ? ` ${attempt} times` : ''} – a network, VPN or proxy problem, not your access. Try again in a moment.`), { code: 'NETWORK', status: 503, cause: e });
      }
      await sleep(Math.min(8, 2 ** attempt) * 1000);
    }
  }
}

export function stableUuid(...parts) {
  const h = createHash('sha1').update(parts.join('/')).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export function truncate(s, n = 4000) {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  if (!t) return '';
  return t.length > n ? `${t.slice(0, n)}… (${t.length - n} more chars)` : t;
}
