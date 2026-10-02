// Readiness checks shown on the Home and Settings tabs.
import { spawnSync } from 'node:child_process';
import { getToken, whoAmI, SCOPES } from './auth.mjs';
import { listCapacities } from './fabric.mjs';
import { copilotStatus, providerSummary, MCP_ENDPOINTS } from './agent.mjs';
import { getSettings } from './config.mjs';

async function probeMcp(url, token, extraHeaders = {}) {
  const started = Date.now();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...extraHeaders };
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fabric-mcp-studio', version: '1' } } };
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(init), signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ok: false, status: r.status, error: r.status === 403 ? 'Forbidden – check the tenant setting or your permissions' : `HTTP ${r.status}`, ms: Date.now() - started };
    const sid = r.headers.get('mcp-session-id');
    const h2 = { ...headers, 'MCP-Protocol-Version': '2025-06-18', ...(sid ? { 'Mcp-Session-Id': sid } : {}) };
    await fetch(url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).catch(() => {});
    const t = await fetch(url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), signal: AbortSignal.timeout(20000) });
    let text = await t.text();
    if (/^\s*(event|data):/m.test(text)) text = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
    const tools = JSON.parse(text)?.result?.tools || [];
    return { ok: true, tools: tools.length, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'Timed out' : e.message, ms: Date.now() - started };
  }
}

function tool(cmd, args) {
  try {
    const isWin = process.platform === 'win32';
    const r = isWin
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', [cmd, ...args].join(' ')], { encoding: 'utf8', timeout: 20000, windowsHide: true })
      : spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) return null;
    return (r.stdout || r.stderr || '').trim().split('\n')[0].trim();
  } catch { return null; }
}

export async function health() {
  const checks = [];
  const add = (id, label, status, detail, fix = '') => checks.push({ id, label, status, detail, fix });

  add('node', 'Node.js', 'ok', process.version);

  const me = await whoAmI();
  if (me.signedIn) add('azure', 'Microsoft Entra sign-in', 'ok', `${me.upn || me.name} · tenant ${me.tenantDomain || me.tenantId}`);
  else add('azure', 'Microsoft Entra sign-in', 'error', 'Not signed in', 'Select Sign in (top right) or run az login.');

  let fabricToken = null;
  if (me.signedIn) {
    try {
      fabricToken = await getToken(SCOPES.fabric);
      const caps = await listCapacities();
      const active = caps.filter((c) => c.state === 'Active');
      const paid = active.filter((c) => /^(F\d+|P\d|A\d|EM\d)$/i.test(c.sku));
      const trial = active.filter((c) => /^FT/i.test(c.sku));
      if (!active.length) add('capacity', 'Fabric capacity', 'error', 'No active capacity available to you', 'Start a Fabric trial or ask an admin for capacity access.');
      else add('capacity', 'Fabric capacity', paid.length ? 'ok' : 'warn', `${active.length} active · ${paid.length} paid · ${trial.length} trial`, paid.length ? '' : 'Everything works on a trial; Ontology MCP questions (ask_ontology) answer reliably only on a paid F2+ or P1+ capacity.');
    } catch (e) {
      add('capacity', 'Fabric API', 'error', e.message.slice(0, 160), 'Check that Microsoft Fabric is enabled for your tenant.');
    }
  }

  const cs = await copilotStatus();
  const prov = providerSummary();
  if (prov.id === 'github') {
    add('copilot', 'GitHub Copilot', cs.isAuthenticated ? 'ok' : 'error', cs.isAuthenticated ? cs.statusMessage || cs.login : (cs.statusMessage || 'Not signed in'), cs.isAuthenticated ? '' : 'Settings › AI provider › Sign in to GitHub, or choose another provider.');
  } else {
    add('copilot', 'AI provider', 'ok', `${prov.name} · ${prov.model || 'model not set'}`, 'Use Settings › AI provider › Test.');
  }

  if (fabricToken) {
    const s = getSettings().mcp;
    const probes = [];
    if (s['fabric-core']) probes.push(['fabric-core', 'Fabric Core MCP', MCP_ENDPOINTS['fabric-core'], {}]);
    if (s['powerbi-authoring'] === 'hosted') probes.push(['powerbi-authoring', 'Power BI Authoring MCP', MCP_ENDPOINTS['powerbi-authoring'], {}]);
    if (s['fabric-iq']) probes.push(['fabric-iq', 'Fabric IQ MCP', MCP_ENDPOINTS['fabric-iq'], { 'X-Variants': 'Fabric.Routing.FabricIQ.V1' }]);
    const results = await Promise.all(probes.map(([, , url, h]) => probeMcp(url, fabricToken, h)));
    probes.forEach(([id, label], i) => {
      const r = results[i];
      const fix = id === 'powerbi-authoring' ? 'Fabric admin: enable "Users can use the Power BI Model Context Protocol server endpoint".' : 'Check network access to api.fabric.microsoft.com.';
      add(`mcp-${id}`, label, r.ok ? 'ok' : 'error', r.ok ? `${r.tools} tools · ${r.ms} ms` : r.error, r.ok ? '' : fix);
    });
    if (s['fabric-local']) {
      const npx = tool('npx', ['--version']);
      add('mcp-fabric-local', 'Fabric MCP (local)', npx ? 'ok' : 'warn', npx ? `runs with npx ${npx}` : 'npx not found', npx ? '' : 'Install Node.js LTS (includes npx) or turn the local server off in Settings.');
    }
  }

  const az = tool('az', ['--version']);
  add('az', 'Azure CLI (optional)', az ? 'ok' : 'info', az ? az.replace(/\s+/g, ' ') : 'Not installed – browser sign-in is used instead', az ? '' : 'Needed only for the AdventureWorksLT sample provisioning.');
  if (process.platform === 'win32') {
    const atk = tool('atk', ['--version']);
    add('atk', 'Microsoft 365 Agents Toolkit (optional)', atk ? 'ok' : 'info', atk ? `atk ${atk}` : 'Installed automatically when you install the Teams agent', '');
  }
  return { at: new Date().toISOString(), checks, ready: !checks.some((c) => c.status === 'error') };
}
