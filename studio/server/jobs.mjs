// Long-running jobs with step progress streamed to the UI.
import { join } from 'node:path';
import { DATA_DIR, newId, readJson, writeJson } from './config.mjs';
import { emit } from './events.mjs';
import { logActivity } from './project.mjs';

const jobs = new Map();

// Running jobs are recorded on disk so a job cut off by a restart (shut down, closed window, reboot) is reported
// as interrupted the next time the studio starts, instead of silently disappearing.
const RUNNING_FILE = join(DATA_DIR, 'running-jobs.json');
let saveTimer = null;
function saveRunning() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const running = [...jobs.values()].filter((j) => j.status === 'running').map(publicJob);
    try { writeJson(RUNNING_FILE, running); } catch { /* read-only data folder */ }
  }, 500);
}

for (const j of readJson(RUNNING_FILE, []) || []) {
  if (!j?.id || jobs.has(j.id)) continue;
  const job = {
    ...j,
    status: 'interrupted',
    endedAt: new Date().toISOString(),
    error: 'Fabric MCP Studio was stopped while this job was running. Run it again to finish – completed work is reused.',
    steps: (j.steps || []).map((s) => (s.status === 'running' ? { ...s, status: 'failed' } : s)),
  };
  jobs.set(job.id, job);
  logActivity('job.interrupted', j.title, { jobId: j.id, jobKind: j.kind });
}
try { writeJson(RUNNING_FILE, []); } catch { /* ignore */ }

export function listJobs() {
  return [...jobs.values()].map(publicJob).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function getJob(id) {
  const j = jobs.get(id);
  return j ? publicJob(j) : null;
}

function publicJob(j) {
  const { controller, ...rest } = j;
  return rest;
}

/** Write the running-jobs record now (used just before the process exits). */
export function flushRunningJobs() {
  clearTimeout(saveTimer);
  const running = [...jobs.values()].filter((j) => j.status === 'running').map(publicJob);
  try { writeJson(RUNNING_FILE, running); } catch { /* ignore */ }
}

/**
 * Start a job. `fn(ctx)` receives { step, log, progress, signal, setResult }.
 * Returns the job immediately; completion is streamed via 'job' events.
 */
export function startJob(kind, title, fn, { meta = {} } = {}) {
  const job = {
    id: newId(), kind, title, meta,
    status: 'running', progress: 2, steps: [], logLines: [],
    startedAt: new Date().toISOString(), endedAt: null, result: null, error: null,
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  const push = () => { emit('job', { job: publicJob(job) }); saveRunning(); };

  const ctx = {
    signal: job.controller.signal,
    step(label) {
      for (const s of job.steps) if (s.status === 'running') s.status = 'done';
      job.steps.push({ label, status: 'running', at: new Date().toISOString() });
      push();
    },
    log(line) {
      job.logLines.push(`${new Date().toLocaleTimeString()}  ${line}`);
      if (job.logLines.length > 400) job.logLines.shift();
      push();
    },
    progress(pct) { job.progress = Math.max(job.progress, Math.min(99, Math.round(pct))); push(); },
    setResult(r) { job.result = r; },
    data(payload) { emit('job.data', { jobId: job.id, payload }); },
  };

  push();
  logActivity('job.start', title, { jobId: job.id, jobKind: kind });

  (async () => {
    try {
      const r = await fn(ctx);
      if (r !== undefined) job.result = r;
      for (const s of job.steps) if (s.status === 'running') s.status = 'done';
      job.status = 'succeeded';
      job.progress = 100;
      logActivity('job.done', title, { jobId: job.id });
    } catch (e) {
      for (const s of job.steps) if (s.status === 'running') s.status = 'failed';
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = e?.message || String(e);
      ctx.log(`ERROR: ${job.error}`);
      logActivity('job.failed', title, { jobId: job.id, error: job.error });
    } finally {
      job.endedAt = new Date().toISOString();
      push();
    }
  })();

  return publicJob(job);
}

export function cancelJob(id) {
  const j = jobs.get(id);
  if (j && j.status === 'running') j.controller.abort();
  return Boolean(j);
}

/** Await a job's completion (used by agent tools so the model sees the outcome). */
export function waitForJob(id, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolveP, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      const j = jobs.get(id);
      if (!j) { clearInterval(t); reject(new Error('Job not found')); return; }
      if (j.status !== 'running') { clearInterval(t); resolveP(publicJob(j)); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error('Timed out waiting for job')); }
    }, 1000);
  });
}
