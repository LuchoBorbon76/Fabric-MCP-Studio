// Eventhouse (KQL) client: management commands and queries against a KQL database, with the signed-in user's token.
import { getToken } from '../auth.mjs';
import { sleep } from '../config.mjs';

export class KustoError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Run a KQL query (or a management command when `mgmt`) and return the first table as row objects. */
export async function kusto(clusterUri, database, csl, { mgmt = false, signal, timeoutMs = 60000 } = {}) {
  const uri = String(clusterUri || '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+\.kusto\.fabric\.microsoft\.com$/i.test(uri) && !/^https:\/\/[^/]+\.kusto\.windows\.net$/i.test(uri)) {
    throw new KustoError(`Not an Eventhouse query URI: ${uri}`, 400);
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    const token = await getToken(`${uri}/.default`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetch(`${uri}/v1/rest/${mgmt ? 'mgmt' : 'query'}`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json', 'x-ms-app': 'FabricMCPStudio' },
        body: JSON.stringify({ db: database, csl }),
      });
    } catch (e) {
      if (signal?.aborted) throw new Error('Cancelled');
      if (attempt < 4) { await sleep(2000 * attempt); continue; }
      throw new KustoError(`Eventhouse request failed: ${e.message}`, 0);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(3000 * attempt); continue; }
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = j?.error?.['@message'] || j?.error?.message || text; } catch { /* plain text */ }
      throw new KustoError(`Eventhouse ${mgmt ? 'command' : 'query'} failed (${res.status}): ${String(msg).split('\n')[0].slice(0, 400)}`, res.status);
    }
    const json = JSON.parse(text);
    const table = json?.Tables?.[0];
    if (!table) return [];
    return table.Rows.map((row) => Object.fromEntries(table.Columns.map((c, i) => [c.ColumnName, row[i]])));
  }
  throw new KustoError('Eventhouse request failed after retries', 0);
}

/**
 * Run an `async` management command (e.g. `.set-or-append async`, `.create async materialized-view`) and wait for its
 * operation to finish. Commands that return no operation id (nothing to do) resolve at once.
 */
export async function kustoOperation(clusterUri, database, csl, { signal, label = 'Eventhouse operation', timeoutMs = 15 * 60 * 1000, onWait } = {}) {
  const rows = await kusto(clusterUri, database, csl, { mgmt: true, signal });
  const id = rows[0]?.OperationId;
  if (!id) return null;
  const started = Date.now();
  for (let i = 0; ; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const [op] = await kusto(clusterUri, database, `.show operations ${id}`, { mgmt: true, signal }).catch(() => []);
    const state = String(op?.State || '');
    if (/^(Completed|Succeeded)$/i.test(state)) return op;
    if (/Failed|Abandoned|Cancel|BadInput|Throttled|Skipped/i.test(state)) throw new KustoError(`${label} ${state.toLowerCase()}: ${String(op?.Status || '').split('\n')[0].slice(0, 300)}`, 500);
    if (Date.now() - started > timeoutMs) throw new KustoError(`${label} is still running. Check again in a few minutes.`, 504);
    if (i && i % 10 === 0) onWait?.(Math.round((Date.now() - started) / 1000));
    await sleep(3000);
  }
}

/** Same KQL column type (getschema reports System.Int32, int, long, real…). */
export function sameKqlType(a, b) {
  const norm = (t) => String(t).toLowerCase().replace(/^system\./, '').replace('int32', 'int').replace('int64', 'long').replace('double', 'real').replace('boolean', 'bool').replace('sbyte', 'bool');
  return norm(a) === norm(b);
}

/** Read-only KQL for Copilot and the UI: one query, no management commands. */
export function assertReadOnlyKql(csl) {
  const text = String(csl || '').trim();
  if (!text) throw new KustoError('Write a KQL query.', 400);
  if (text.startsWith('.') || /(^|[\n;|])\s*\.[a-z-]+/i.test(text) || /\b(evaluate\s+python|evaluate\s+r\b|externaldata)\b/i.test(text)) {
    throw new KustoError('Only read-only KQL queries are allowed here (no management commands or external data).', 400);
  }
  return text;
}

/** KQL string literal. */
export const kqlString = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;

/** KQL identifier, bracket-quoted when it isn't a plain name. */
export const kqlName = (s) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(s)) ? String(s) : `['${String(s).replace(/'/g, "\\'")}']`);
