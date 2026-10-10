// Diagnostics bundle: read-only, redacted state that a user can share when troubleshooting.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { BUILD, DATA_DIR, DEMO_MODE, RELEASES, STUDIO_ROOT, VERSION, publicSettings } from './config.mjs';
import { getProject, getActivity } from './project.mjs';
import { listJobs } from './jobs.mjs';
import { cachedReadiness } from './readiness.mjs';
import { health } from './health.mjs';

const SECRET_KEYS = /token|secret|password|api.?key|connection.?string|sharedaccess|authorization/i;
const TOKENISH = /\b(gho|ghp|github_pat|sk-[\w-]*|sk-or-[\w-]*|eyJ[\w-]*|[A-Za-z0-9_\-.]{32,})\b/g;

function redact(value, key = '') {
  if (SECRET_KEYS.test(key)) return value ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  if (typeof value === 'string') return value.replace(TOKENISH, (m) => (m.length >= 20 ? '[redacted]' : m));
  return value;
}

const tail = (file, max = 120) => {
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).slice(-max).map((x) => redact(x));
};

function projectSummary(p = getProject()) {
  return redact({
    id: p.id, name: p.name, tenant: p.tenant,
    workspace: p.workspace ? { id: p.workspace.id, name: p.workspace.name, capacityId: p.workspace.capacityId, created: p.workspace.created } : null,
    source: p.source ? { kind: p.source.kind, method: p.source.method, label: p.source.label, itemType: p.source.itemType, itemName: p.source.itemName, workspaceId: p.source.workspaceId } : null,
    modelSource: p.modelSource ? { itemType: p.modelSource.itemType, itemName: p.modelSource.itemName, workspaceId: p.modelSource.workspaceId } : null,
    semanticModel: p.semanticModel ? { id: p.semanticModel.id, name: p.semanticModel.name, origin: p.semanticModel.origin, workspaceId: p.semanticModel.workspaceId } : null,
    counts: {
      sources: (p.sources || []).length,
      models: (p.semanticModels || []).length,
      reports: (p.reports || []).length,
      dataPrepItems: (p.dataPrepItems || []).length,
      hasOntology: Boolean(p.ontology),
      hasRealtime: Boolean(p.realtime),
      hasPlanning: Boolean(p.planning),
      hasTaskFlow: Boolean(p.taskFlow),
    },
    steps: p.steps || {},
  });
}

export async function diagnosticsBundle() {
  const h = DEMO_MODE
    ? { at: new Date().toISOString(), ready: true, checks: [{ id: 'demo', label: 'Safe demo mode', status: 'ok', detail: 'No Fabric calls are made.' }] }
    : await health().catch((e) => ({ error: e.message }));
  const activity = getActivity();
  return {
    generatedAt: new Date().toISOString(),
    app: { name: 'Fabric MCP Studio', version: VERSION, build: BUILD, demoMode: DEMO_MODE, root: STUDIO_ROOT, dataDir: DATA_DIR },
    system: { platform: process.platform, node: process.version, os: `${os.type()} ${os.release()}`, arch: os.arch() },
    release: { improvements: RELEASES.improvements, fixes: RELEASES.fixes, latest: RELEASES.changes.slice(0, 8) },
    settings: redact(publicSettings()),
    project: projectSummary(),
    jobs: listJobs().slice(0, 25),
    health: h,
    readiness: cachedReadiness(),
    activity: {
      artifacts: (activity.artifacts || []).slice(0, 100).map((a) => redact(a)),
      recent: (activity.log || []).slice(0, 80).map((x) => redact(x)),
    },
    logs: {
      studio: tail('studio.log'),
      previous: tail('studio.prev.log', 80),
      restart: tail('studio.restart.log', 80),
    },
  };
}
