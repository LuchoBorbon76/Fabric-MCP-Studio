// Paths, settings and small shared helpers.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(STUDIO_ROOT, '..');
export const WEB_ROOT = join(STUDIO_ROOT, 'web');
export const DATA_DIR = process.env.STUDIO_DATA_DIR ? resolve(process.env.STUDIO_DATA_DIR) : join(STUDIO_ROOT, 'data');
export const COPILOT_HOME = join(DATA_DIR, 'copilot-home');

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
// Outside developer mode a saved GitHub Copilot provider is replaced in memory only: what was saved stays on disk until
// the user picks another provider, so turning developer mode back on restores it.
let providerSwap = null; // { replacement, saved }

export function getSettings() {
  if (!settingsCache) {
    const saved = readJson(SETTINGS_FILE, {});
    settingsCache = deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
    // Outside developer mode GitHub Copilot isn't offered: start with Azure AI Foundry / Azure OpenAI (Entra sign-in).
    if (settingsCache.provider?.id === 'github' && !isDeveloper()) {
      const replacement = { id: 'azure-openai', model: '', reasoningEffort: '', config: { authMode: 'entra' } };
      providerSwap = { replacement, saved: settingsCache.provider };
      settingsCache.provider = replacement;
    }
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
