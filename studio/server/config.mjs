// Paths, settings and small shared helpers.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

export const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(STUDIO_ROOT, '..');
export const WEB_ROOT = join(STUDIO_ROOT, 'web');
export const DATA_DIR = process.env.STUDIO_DATA_DIR ? resolve(process.env.STUDIO_DATA_DIR) : join(STUDIO_ROOT, 'data');
export const COPILOT_HOME = join(DATA_DIR, 'copilot-home');
export const VERSION = JSON.parse(readFileSync(join(STUDIO_ROOT, 'package.json'), 'utf8')).version;

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

export function getSettings() {
  if (!settingsCache) {
    const saved = readJson(SETTINGS_FILE, {});
    settingsCache = deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
  }
  return settingsCache;
}

// Secrets (API keys) are never persisted; they live in memory or come from environment variables.
const SECRET_KEYS = new Set(['apiKey', 'clientSecret', 'password']);

export function saveSettings(patch) {
  const next = deepMerge(getSettings(), patch);
  settingsCache = next;
  writeJson(SETTINGS_FILE, stripSecrets(next));
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
