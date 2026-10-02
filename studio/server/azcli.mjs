// Run Azure CLI without a shell (safe argument quoting, including passwords with special characters).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

let resolved = null;

function resolveAz() {
  if (resolved) return resolved;
  if (process.platform !== 'win32') { resolved = { cmd: 'az', pre: [] }; return resolved; }
  const w = spawnSync('where.exe', ['az.cmd'], { encoding: 'utf8', windowsHide: true });
  const azCmd = (w.stdout || '').split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith('az.cmd'))?.trim();
  if (azCmd) {
    const py = join(dirname(azCmd), '..', 'python.exe');
    if (existsSync(py)) { resolved = { cmd: py, pre: ['-IBm', 'azure.cli'] }; return resolved; }
  }
  resolved = { cmd: 'cmd.exe', pre: ['/d', '/s', '/c', 'az'] };
  return resolved;
}

export function azAvailable() {
  const { cmd, pre } = resolveAz();
  const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return r.status === 0;
}

/** Run az and resolve with parsed JSON (or text). `onLine` receives a sanitized command echo. */
export function runAz(args, { json = true, signal, onCommand, stdio } = {}) {
  return new Promise((resolveP, reject) => {
    const { cmd, pre } = resolveAz();
    const full = [...pre, ...args, '--only-show-errors', ...(json ? ['-o', 'json'] : [])];
    onCommand?.(`az ${args.map((a, i) => (/password|secret/i.test(args[i - 1] || '') ? '********' : a)).join(' ')}`);
    const child = spawn(cmd, full, { windowsHide: true, stdio: stdio || 'pipe' });
    let out = '';
    let err = '';
    child.stdout?.on('data', (b) => { out += b; });
    child.stderr?.on('data', (b) => { err += b; });
    signal?.addEventListener('abort', () => child.kill());
    child.on('error', () => reject(new Error('Azure CLI (az) not found. Install it from https://aka.ms/installazurecli.')));
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `az exited with code ${code}`));
      if (!json) return resolveP(out.trim());
      try { resolveP(out.trim() ? JSON.parse(out) : null); } catch { resolveP(out.trim()); }
    });
  });
}
