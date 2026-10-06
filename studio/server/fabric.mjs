// Microsoft Fabric REST API client: retries, long-running operations, pagination and domain helpers.
import { getToken, SCOPES } from './auth.mjs';
import { sleep } from './config.mjs';

const API = 'https://api.fabric.microsoft.com/v1';
const ONELAKE = 'https://onelake.dfs.fabric.microsoft.com';

export class FabricError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

/**
 * Fabric validation errors ("… Issues: [{"Code","Message","JsonPath",…}]") in plain words: one sentence per kind of
 * issue, with what else it applies to. Other messages are returned as they are; the raw response stays in .body.
 */
export function plainFabricMessage(msg) {
  const s = String(msg ?? '');
  const m = s.match(/^([\s\S]*?)\s*Issues:\s*(\[[\s\S]*\])\s*\.?\s*$/);
  if (!m) return s;
  let issues;
  try { issues = JSON.parse(m[2]); } catch { return s; }
  if (!Array.isArray(issues) || !issues.length) return s;
  const groups = new Map();
  for (const i of issues) {
    const text = String(i?.Message || i?.message || i?.Code || i?.code || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const code = i?.Code || i?.code || text;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(text);
  }
  const firstSentence = (t) => (t.match(/^[\s\S]*?[.!?](?=\s|$)/) || [t])[0];
  const parts = [...groups.values()].map((texts) => {
    const more = texts.slice(1).map((t) => (t.match(/'([^']+)'/) || [])[1]).filter(Boolean);
    const extra = texts.length > 1 ? ` ${texts.length - 1} more like it${more.length ? ` (${[...new Set(more)].slice(0, 8).join(', ')})` : ''}.` : '';
    return `${firstSentence(texts[0])}${extra}`;
  });
  const head = m[1].replace(/\s*for artifact [0-9a-f-]{36}/i, '').replace(/[.:\s]+$/, '');
  return `${head}: ${parts.join(' ')}`;
}

export async function fabric(method, path, body, { raw = false, signal, lroTimeoutMs = 15 * 60 * 1000, wait = true } = {}) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const token = await getToken(SCOPES.fabric);
    const res = await fetch(url, {
      method,
      signal,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 6) {
        const wait = Number(res.headers.get('retry-after')) || Math.min(60, 5 * attempt);
        await sleep(wait * 1000);
        continue;
      }
    }
    if (res.status === 202) {
      // Job instances report their own status; the caller polls the location itself.
      if (!wait) return { status: 202, location: res.headers.get('location'), retryAfter: Number(res.headers.get('retry-after')) || null };
      const result = await waitOperation(res, { signal, timeoutMs: lroTimeoutMs });
      return raw ? { status: 202, body: result } : result;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      const msg = plainFabricMessage(json?.message || json?.error?.message || text || res.statusText);
      throw new FabricError(`${method} ${path} failed (${res.status}): ${msg}`, res.status, json);
    }
    return raw ? { status: res.status, body: json, headers: res.headers } : json;
  }
  throw new FabricError(`${method} ${path} failed after retries`, 0);
}

async function waitOperation(res, { signal, timeoutMs }) {
  let location = res.headers.get('location');
  const opId = res.headers.get('x-ms-operation-id');
  if (!location && opId) location = `${API}/operations/${opId}`;
  if (!location) return null;
  let delay = Number(res.headers.get('retry-after')) || 3;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Cancelled');
    await sleep(delay * 1000);
    const token = await getToken(SCOPES.fabric);
    const poll = await fetch(location, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (poll.status === 429) { delay = Number(poll.headers.get('retry-after')) || 10; continue; }
    const text = await poll.text();
    let state = {};
    try { state = text ? JSON.parse(text) : {}; } catch { state = {}; }
    if (!poll.ok) throw new FabricError(`Operation polling failed (${poll.status}): ${text}`, poll.status, state);
    const status = state.status || 'Succeeded';
    if (status === 'Succeeded' || status === 'Completed') {
      if (/\/operations\/[^/]+$/.test(location)) {
        try {
          const r = await fetch(`${location}/result`, { headers: { Authorization: `Bearer ${token}` } });
          if (r.ok) { const t = await r.text(); if (t) return JSON.parse(t); }
        } catch { /* no result body */ }
      }
      return state;
    }
    if (status === 'Failed' || status === 'Cancelled') {
      throw new FabricError(`Operation ${status}: ${plainFabricMessage(state.error?.message || text)}`, 0, state);
    }
    delay = Math.min(15, delay + 2);
  }
  throw new FabricError('Timed out waiting for the Fabric operation', 0);
}

export async function collection(path, { max = 5000 } = {}) {
  const out = [];
  let next = path;
  while (next && out.length < max) {
    const page = await fabric('GET', next);
    if (Array.isArray(page?.value)) out.push(...page.value);
    else if (Array.isArray(page?.data)) out.push(...page.data);
    next = page?.continuationUri || null;
  }
  return out;
}

// ---------------- workspaces & capacities ----------------

export const listCapacities = () => collection('/capacities');
export const listWorkspaces = () => collection('/workspaces');
export const getWorkspace = (id) => fabric('GET', `/workspaces/${id}`);

export async function createWorkspace({ name, capacityId, description }) {
  return fabric('POST', '/workspaces', { displayName: name, capacityId: capacityId || undefined, description });
}

export const assignCapacity = (workspaceId, capacityId) => fabric('POST', `/workspaces/${workspaceId}/assignToCapacity`, { capacityId });
export const deleteWorkspace = (id) => fabric('DELETE', `/workspaces/${id}`);

export async function findWorkspace(name) {
  return (await listWorkspaces()).find((w) => w.displayName.toLowerCase() === name.toLowerCase()) || null;
}

// ---------------- items ----------------

export const listItems = (workspaceId, type) => collection(`/workspaces/${workspaceId}/items${type ? `?type=${type}` : ''}`);
export const getItem = (workspaceId, id) => fabric('GET', `/workspaces/${workspaceId}/items/${id}`);
export const deleteItem = (workspaceId, id) => fabric('DELETE', `/workspaces/${workspaceId}/items/${id}`);

export async function findItem(workspaceId, type, name) {
  return (await listItems(workspaceId, type)).find((i) => i.displayName.toLowerCase() === name.toLowerCase()) || null;
}

// Item types whose display names only allow letters, numbers and underscores (and must start with a letter).
const STRICT_NAME_TYPES = new Set(['Lakehouse', 'Ontology', 'MirroredDatabase', 'Eventhouse', 'KQLDatabase', 'Eventstream', 'Reflex', 'Plan']);

export function itemName(type, name, fallback = 'Item') {
  if (!STRICT_NAME_TYPES.has(type)) return String(name || fallback).trim().slice(0, 256);
  let n = String(name || fallback).trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[A-Za-z]/.test(n)) n = `${fallback.replace(/[^A-Za-z0-9_]/g, '') || 'Item'}_${n}`;
  return n.slice(0, 89);
}

export async function createItem(workspaceId, { name, type, description, definition }) {
  const created = await fabric('POST', `/workspaces/${workspaceId}/items`, { displayName: name, type, description, definition });
  if (created?.id) return created;
  return findItem(workspaceId, type, name);
}

// updateMetadata=True only when the definition carries a .platform file (otherwise Fabric rejects the update).
export const updateDefinition = (workspaceId, id, definition) => {
  const withPlatform = definition?.parts?.some((p) => p.path === '.platform');
  return fabric('POST', `/workspaces/${workspaceId}/items/${id}/updateDefinition${withPlatform ? '?updateMetadata=True' : ''}`, { definition });
};

export async function getDefinition(workspaceId, id, format) {
  const r = await fabric('POST', `/workspaces/${workspaceId}/items/${id}/getDefinition${format ? `?format=${format}` : ''}`);
  return r?.definition || r;
}

export function toParts(files) {
  return {
    parts: Object.entries(files).map(([path, content]) => ({
      path,
      payload: (Buffer.isBuffer(content) ? content : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')).toString('base64'),
      payloadType: 'InlineBase64',
    })),
  };
}

export function platformFile(type, displayName, logicalId) {
  return {
    $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
    metadata: { type, displayName },
    config: { version: '2.0', logicalId },
  };
}

// ---------------- lakehouse, warehouse, SQL endpoints ----------------

export async function ensureLakehouse(workspaceId, name, description) {
  let lh = await findItem(workspaceId, 'Lakehouse', name);
  let created = false;
  if (!lh) {
    lh = await fabric('POST', `/workspaces/${workspaceId}/lakehouses`, { displayName: name, description });
    if (!lh?.id) lh = await findItem(workspaceId, 'Lakehouse', name);
    created = true;
  }
  return { ...lh, created };
}

export async function waitSqlEndpoint(workspaceId, itemId, itemType = 'Lakehouse', { timeoutMs = 6 * 60 * 1000, signal } = {}) {
  if (itemType === 'SQLDatabase') return sqlDatabaseEndpoint(workspaceId, itemId, { timeoutMs, signal });
  const seg = { Lakehouse: 'lakehouses', MirroredDatabase: 'mirroredDatabases', Warehouse: 'warehouses' }[itemType];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Cancelled');
    const d = await fabric('GET', `/workspaces/${workspaceId}/${seg}/${itemId}`);
    if (itemType === 'Warehouse') {
      if (d?.properties?.connectionString) return { server: d.properties.connectionString, endpointId: itemId, database: d.displayName };
    } else {
      const p = d?.properties?.sqlEndpointProperties;
      if (p && (p.provisioningStatus === 'Success' || (p.id && p.connectionString && !p.provisioningStatus))) {
        return { server: p.connectionString, endpointId: p.id, database: d.displayName };
      }
    }
    await sleep(6000);
  }
  throw new FabricError('SQL analytics endpoint was not ready in time. Try again in a minute.', 0);
}

// ---------------- SQL database ----------------

export async function createSqlDatabase(workspaceId, { name, description }) {
  const created = await fabric('POST', `/workspaces/${workspaceId}/sqlDatabases`, { displayName: name, description });
  if (created?.id) return created;
  return findItem(workspaceId, 'SQLDatabase', name);
}

export const getSqlDatabase = (workspaceId, id) => fabric('GET', `/workspaces/${workspaceId}/sqlDatabases/${id}`);

/** The SQL analytics endpoint of a Fabric SQL database (its OneLake replica), once Fabric has provisioned it. */
export async function sqlDatabaseEndpoint(workspaceId, sqlDatabaseId, { timeoutMs = 6 * 60 * 1000, signal } = {}) {
  const db = await getSqlDatabase(workspaceId, sqlDatabaseId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Cancelled');
    const ep = (await listItems(workspaceId, 'SQLEndpoint')).find((i) => i.displayName === db.displayName);
    if (ep) {
      const cs = await fabric('GET', `/workspaces/${workspaceId}/sqlEndpoints/${ep.id}/connectionString`).catch(() => null);
      if (cs?.connectionString) return { server: cs.connectionString, endpointId: ep.id, database: db.displayName };
    }
    await sleep(6000);
  }
  throw new FabricError('The SQL analytics endpoint of the SQL database was not ready in time. Try again in a minute.', 0);
}

export async function refreshSqlEndpoint(workspaceId, sqlEndpointId) {
  try { return await fabric('POST', `/workspaces/${workspaceId}/sqlEndpoints/${sqlEndpointId}/refreshMetadata`, {}); }
  catch (e) { return { warning: e.message }; }
}

export async function loadTable(workspaceId, lakehouseId, table, relativePath, format = 'Parquet', { signal } = {}) {
  const body = {
    relativePath, pathType: 'File', mode: 'Overwrite', recursive: false,
    formatOptions: format === 'Csv' ? { format: 'Csv', header: true, delimiter: ',' } : { format: 'Parquet' },
  };
  return fabric('POST', `/workspaces/${workspaceId}/lakehouses/${lakehouseId}/tables/${table}/load`, body, { signal });
}

export async function listLakehouseTables(workspaceId, lakehouseId) {
  try { return await collection(`/workspaces/${workspaceId}/lakehouses/${lakehouseId}/tables`); }
  catch { return []; }
}

export async function createShortcut(workspaceId, itemId, { path = 'Tables', name, target }) {
  return fabric('POST', `/workspaces/${workspaceId}/items/${itemId}/shortcuts?shortcutConflictPolicy=CreateOrOverwrite`, { path, name, target });
}

// ---------------- OneLake (DFS) ----------------

/** True when a folder or file exists in an item's OneLake storage (e.g. "Tables/MyTable/_delta_log"). */
export async function oneLakePathExists(workspaceId, itemId, path) {
  const token = await getToken(SCOPES.storage);
  const res = await fetch(`${ONELAKE}/${workspaceId}/${itemId}/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}`, 'x-ms-version': '2023-11-03' } });
  return res.ok;
}

export async function uploadOneLake(workspaceId, itemId, remotePath, bytes, { signal } = {}) {
  const token = await getToken(SCOPES.storage);
  const base = `${ONELAKE}/${workspaceId}/${itemId}/${remotePath.split('/').map(encodeURIComponent).join('/')}`;
  const h = { Authorization: `Bearer ${token}`, 'x-ms-version': '2023-11-03' };
  const call = async (url, init) => {
    const r = await fetch(url, { ...init, signal, headers: { ...h, ...(init.headers || {}) } });
    if (!r.ok) throw new FabricError(`OneLake ${init.method} failed (${r.status}): ${await r.text()}`, r.status);
  };
  await call(`${base}?resource=file`, { method: 'PUT' });
  await call(`${base}?action=append&position=0`, { method: 'PATCH', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
  await call(`${base}?action=flush&position=${bytes.length}`, { method: 'PATCH' });
}

/** A file from an item's OneLake storage, or null when it doesn't exist. */
export async function downloadOneLake(workspaceId, itemId, remotePath, { signal } = {}) {
  const token = await getToken(SCOPES.storage);
  const res = await fetch(`${ONELAKE}/${workspaceId}/${itemId}/${remotePath.split('/').map(encodeURIComponent).join('/')}`, { signal, headers: { Authorization: `Bearer ${token}`, 'x-ms-version': '2023-11-03' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new FabricError(`OneLake read failed (${res.status}): ${await res.text()}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

export const getLakehouse = (workspaceId, id) => fabric('GET', `/workspaces/${workspaceId}/lakehouses/${id}`);

// ---------------- connections, gateways, mirroring ----------------

export async function listConnections() {
  const all = await collection('/connections');
  return all.map((c) => ({
    id: c.id,
    name: c.displayName,
    type: c.connectionDetails?.type,
    path: c.connectionDetails?.path,
    connectivityType: c.connectivityType,
    gatewayId: c.gatewayId || null,
    credentialType: c.credentialDetails?.credentialType,
  }));
}

export async function listGateways() {
  try {
    const all = await collection('/gateways');
    return all.map((g) => ({ id: g.id, name: g.displayName || g.id, type: g.type, version: g.version, members: g.numberOfMemberGateways }));
  } catch { return []; }
}

export async function createCloudConnection({ name, connectionType, server, database, credential }) {
  const methods = { SQL: 'Sql', AzurePostgreSQL: 'AzurePostgreSQL.Database', PostgreSQL: 'PostgreSql' };
  const parameters = [{ dataType: 'Text', name: 'server', value: server }];
  if (database) parameters.push({ dataType: 'Text', name: 'database', value: database });
  let credentials;
  if (credential.type === 'Basic') credentials = { credentialType: 'Basic', username: credential.username, password: credential.password };
  else if (credential.type === 'ServicePrincipal') {
    credentials = { credentialType: 'ServicePrincipal', servicePrincipalClientId: credential.clientId, servicePrincipalSecret: credential.clientSecret, tenantId: credential.tenantId };
  } else if (credential.type === 'WorkspaceIdentity') credentials = { credentialType: 'WorkspaceIdentity' };
  else throw new Error(`Credential type ${credential.type} can't be created through the API. Create the connection in Fabric (Settings > Manage connections and gateways) and select it.`);
  return fabric('POST', '/connections', {
    connectivityType: 'ShareableCloud',
    displayName: name,
    connectionDetails: { type: connectionType, creationMethod: methods[connectionType] || connectionType, parameters },
    privacyLevel: 'Organizational',
    credentialDetails: { singleSignOnType: 'None', connectionEncryption: 'Encrypted', skipTestConnection: false, credentials },
  });
}

export const provisionWorkspaceIdentity = (workspaceId) => fabric('POST', `/workspaces/${workspaceId}/provisionIdentity`);

export async function createMirroredDatabase(workspaceId, { name, sourceType, connectionId, database, tables = [], defaultSchema = 'dbo' }) {
  const mirroring = {
    properties: {
      source: { type: sourceType, typeProperties: { connection: connectionId, ...(database ? { database } : {}) } },
      target: { type: 'MountedRelationalDatabase', typeProperties: { defaultSchema, format: 'Delta' } },
      ...(tables.length ? { mountedTables: tables.map((t) => ({ source: { typeProperties: { schemaName: t.schema || 'dbo', tableName: t.name } } })) } : {}),
    },
  };
  const definition = toParts({ 'mirroring.json': mirroring });
  return createItem(workspaceId, { name, type: 'MirroredDatabase', description: `Mirrored from ${sourceType} by Fabric MCP Studio`, definition });
}

export const startMirroring = (ws, id) => fabric('POST', `/workspaces/${ws}/mirroredDatabases/${id}/startMirroring`);
export const stopMirroring = (ws, id) => fabric('POST', `/workspaces/${ws}/mirroredDatabases/${id}/stopMirroring`);
export const mirroringStatus = (ws, id) => fabric('POST', `/workspaces/${ws}/mirroredDatabases/${id}/getMirroringStatus`);
export async function tablesMirroringStatus(ws, id) {
  const r = await fabric('POST', `/workspaces/${ws}/mirroredDatabases/${id}/getTablesMirroringStatus`);
  return r?.data || [];
}
