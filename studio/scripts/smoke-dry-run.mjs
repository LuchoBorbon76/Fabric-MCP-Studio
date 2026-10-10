#!/usr/bin/env node
// Starts Fabric MCP Studio in safe demo mode and checks the highest-value UI/API paths without touching Fabric.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.STUDIO_SMOKE_PORT || 4896);
const dataDir = mkdtempSync(join(tmpdir(), 'fms-smoke-'));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/main.mjs', '--no-open', '--port', String(port)], {
  cwd: root,
  env: { ...process.env, STUDIO_DATA_DIR: dataDir, STUDIO_DEMO: '1', STUDIO_DEVELOPER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady() {
  for (let i = 0; i < 45; i++) {
    try {
      const r = await fetch(base);
      if (r.ok) return await r.text();
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error(`Smoke server did not start.\n${log}`);
}

const checks = [];
function record(name, ok, note = '') {
  checks.push({ name, ok, note });
  if (!ok) console.error(`FAIL ${name}: ${note}`);
}

try {
  const html = await waitReady();
  const token = html.match(/name="studio-token" content="([^"]+)"/)?.[1];
  if (!token) throw new Error('No studio token in index page.');
  const api = async (path, init = {}) => {
    const r = await fetch(`${base}/api${path}`, { ...init, headers: { 'x-studio-token': token, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, ok: r.ok, body };
  };
  const expect = async (name, path, test) => {
    const r = await api(path);
    record(name, test(r), `${r.status} ${JSON.stringify(r.body).slice(0, 240)}`);
    return r.body;
  };

  const boot = await expect('bootstrap demo', '/bootstrap', (r) => r.ok && r.body?.demoMode && r.body?.project?.workspace);
  await expect('health', '/health', (r) => r.ok && r.body?.ready);
  await expect('providers', '/providers', (r) => r.ok && r.body?.providers?.length >= 4);
  await expect('fabric capacities are mocked', '/fabric/capacities', (r) => r.ok && r.body?.[0]?.id === 'demo-capacity');
  await expect('data sources', '/sources/workspace', (r) => r.ok && r.body?.items?.length);
  await expect('models', '/models', (r) => r.ok && r.body?.models?.length);
  await expect('reports profile', '/reports/profile', (r) => r.ok && r.body?.tables?.length);
  await expect('costs', '/costs', (r) => r.ok && r.body?.summary?.recommendations?.length);
  await expect('diagnostics', '/diagnostics', (r) => r.ok && r.body?.app?.version && r.body?.project);
  const blocked = await api('/jobs/report', { method: 'POST', body: JSON.stringify({ name: 'ShouldNotRun' }) });
  record('demo write blocked', blocked.status === 403 && blocked.body?.code === 'DEMO_MODE', `${blocked.status} ${JSON.stringify(blocked.body)}`);

  const failed = checks.filter((x) => !x.ok);
  console.table(checks.map((x) => ({ ok: x.ok ? 'OK' : 'FAIL', name: x.name, note: x.note })));
  if (failed.length) process.exitCode = 1;
  else console.log(`Smoke dry run passed for Fabric MCP Studio ${boot.version || ''} (${checks.length} checks).`);
} finally {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
