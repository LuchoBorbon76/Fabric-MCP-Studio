// Fabric workspace task flows: the visual flow above a workspace's item list, with items assigned to each task.
// There is no public REST API for task flows; this uses the same Power BI metadata endpoints the Fabric portal uses
// (signed-in user's Power BI token, the tenant's home cluster). Only task flows the studio created are changed.
import { randomUUID } from 'node:crypto';
import { getToken, SCOPES, currentIdentity } from './auth.mjs';
import { sleep } from './config.mjs';

export class TaskFlowError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Task types the portal understands (Fabric's task flow categories).
export const TASK_TYPES = ['general', 'get data', 'mirror data', 'store data', 'prepare data', 'analyze and train data', 'track data', 'visualize', 'distribute data', 'develop data'];

// Public item type → artifact type used in task assignments (read from the portal's definitions when possible).
const FALLBACK_TYPES = {
  Eventstream: 'EventStream', Eventhouse: 'KustoEventHouse', KQLDatabase: 'KustoDatabase', KQLQueryset: 'KustoQueryWorkbench',
  KQLDashboard: 'KustoDashboard', Reflex: 'ReflexProject', SemanticModel: 'Model', Report: 'Report', Ontology: 'Ontology',
  Lakehouse: 'Lakehouse', Warehouse: 'Warehouse', SQLDatabase: 'SQLDbNative', MirroredDatabase: 'MountedRelationalDatabase',
  Notebook: 'SynapseNotebook', OrgApp: 'OrgApp', Plan: 'Planning', GraphModel: 'GraphIndex', DataPipeline: 'Pipeline',
};

let cluster = { tenant: null, url: null };
let typeMap = { tenant: null, map: null };

async function token() { return getToken(SCOPES.powerbi); }

/** The tenant's Power BI home cluster (the portal's metadata endpoints live there). */
async function clusterUrl() {
  const tenant = currentIdentity()?.tenantId || 'default';
  if (cluster.tenant === tenant && cluster.url) return cluster.url;
  const r = await call('GET', 'https://api.powerbi.com/powerbi/globalservice/v201606/clusterdetails');
  if (!r?.clusterUrl) throw new TaskFlowError('Could not find the Power BI cluster for your tenant.', 500);
  cluster = { tenant, url: String(r.clusterUrl).replace(/\/+$/, '') };
  return cluster.url;
}

async function call(method, url, body, { etag, raw = false } = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`, Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json;charset=UTF-8' } : {}),
        ...(etag ? { 'If-Match': etag } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(2000 * attempt); continue; }
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = j?.error?.message || j?.error?.code || j?.message || text; } catch { /* plain text */ }
      throw new TaskFlowError(`Task flow request failed (${res.status}): ${String(msg || res.statusText).slice(0, 300)}`, res.status);
    }
    if (raw) return { status: res.status, etag: res.headers.get('etag'), text };
    return text ? JSON.parse(text) : null;
  }
  throw new TaskFlowError('Task flow request failed after retries', 0);
}

/** Map of public item types (Eventstream, KQLDatabase…) to the artifact types used in task assignments. */
export async function artifactTypes() {
  const tenant = currentIdentity()?.tenantId || 'default';
  if (typeMap.tenant === tenant && typeMap.map) return typeMap.map;
  const map = { ...FALLBACK_TYPES };
  try {
    const defs = await call('GET', `${await clusterUrl()}/metadata/artifacts/definitions`);
    for (const d of Array.isArray(defs) ? defs : []) {
      const pub = d?.publicFacingArtifactName;
      // Prefer the fallback's choice where a public name has several artifact types (e.g. Warehouse).
      if (pub && d.artifactType && !(pub in FALLBACK_TYPES && FALLBACK_TYPES[pub] !== d.artifactType && defs.some((x) => x.artifactType === FALLBACK_TYPES[pub]))) map[pub] = d.artifactType;
    }
  } catch { /* the fallback covers what the studio creates */ }
  typeMap = { tenant, map };
  return map;
}

const base = async (workspaceId) => `${await clusterUrl()}/metadata/workspaces/${workspaceId}`;

/**
 * The portal's own ids for the workspace's items: objectId → { id, type, typeName }. Power BI items (semantic models,
 * reports) are assigned to tasks by these legacy ids, e.g. a semantic model as { artifactType: 'dataset', '3:<id>' }.
 */
export async function portalIds(workspaceId) {
  const url = `${await clusterUrl()}/metadata/relations/folder/${workspaceId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json', 'x-consuming-feature': 'ListView' } });
  if (!res.ok) throw new TaskFlowError(`Could not read the workspace items (${res.status}).`, res.status);
  const j = await res.json();
  return new Map((j?.artifacts || []).filter((a) => a.objectId).map((a) => [a.objectId.toLowerCase(), { id: a.id, type: a.type, typeName: a.typeName }]));
}

// Power BI item types assigned by their legacy id (artifact type code → task item type).
const LEGACY = { SemanticModel: { code: 3, artifactType: 'dataset' }, Report: { code: 2, artifactType: 'report' } };

/** All task flow canvases in the workspace: [{ id, etag, name, description, tasks, edges }]. */
export async function listTaskFlows(workspaceId) {
  const r = await call('GET', `${await base(workspaceId)}/taskflow202602`);
  return (Array.isArray(r) ? r : r?.taskFlows || []).map((x) => ({ ...x.taskFlow, taskFlowId: x.taskFlow?.id || null, id: x.resourceId, etag: x.etag }));
}

export async function getTaskFlow(workspaceId, id) {
  return (await listTaskFlows(workspaceId)).find((t) => t.id === id) || null;
}

/**
 * Create or replace a task flow canvas. `flow` is { name, description, tasks, edges } (see buildTaskFlow); with `id`
 * the existing canvas is updated (if it still exists), otherwise a new canvas is added next to the user's own.
 */
export async function saveTaskFlow(workspaceId, flow, { id } = {}) {
  const url = await base(workspaceId);
  const body = { name: flow.name, description: flow.description, tasks: flow.tasks, edges: flow.edges };
  const current = id ? await getTaskFlow(workspaceId, id) : null;
  if (current) {
    await call('PUT', `${url}/taskflow202512/${current.id}`, { ...body, id: current.taskFlowId || flow.id || randomUUID() }, { etag: current.etag });
    return { id: current.id, created: false };
  }
  const flowId = flow.id || randomUUID();
  await call('POST', `${url}/taskflow202512`, { ...body, id: flowId });
  // The response is the flow itself; its resource id comes from the list.
  const all = await listTaskFlows(workspaceId);
  const made = all.find((t) => t.taskFlowId === flowId) || all.filter((t) => t.name === flow.name).pop();
  if (!made) throw new TaskFlowError('The task flow was created but could not be read back.', 500);
  return { id: made.id, created: true };
}

export async function deleteTaskFlow(workspaceId, id) {
  const current = await getTaskFlow(workspaceId, id);
  if (!current) return false;
  await call('DELETE', `${await base(workspaceId)}/taskflow202512/${current.id}`, undefined, { etag: current.etag, raw: true });
  return true;
}

/**
 * Build a task flow from a simple description:
 *   tasks: [{ key, name, type, description, x, y, items: [{ type: <public item type>, id }] }]
 *   edges: [[fromKey, toKey]]
 * Task ids are stable per key and flow so updates keep the same tasks. With `workspaceId`, semantic models and reports
 * are also referenced by their portal ids, which is how the portal shows them on the task.
 */
export async function buildTaskFlow({ name, description, tasks, edges }, { idOf = () => randomUUID(), workspaceId } = {}) {
  const types = await artifactTypes();
  const needLegacy = tasks.some((t) => (t.items || []).some((i) => i?.id && LEGACY[i.type]));
  const legacy = needLegacy && workspaceId ? await portalIds(workspaceId).catch(() => new Map()) : new Map();
  const ids = Object.fromEntries(tasks.map((t) => [t.key, idOf('task', t.key)]));
  return {
    id: idOf('flow'),
    name: String(name).slice(0, 100),
    description: String(description || '').slice(0, 1000),
    tasks: tasks.map((t) => {
      if (!TASK_TYPES.includes(t.type)) throw new TaskFlowError(`Unknown task type "${t.type}".`, 400);
      return {
        id: ids[t.key], name: String(t.name).slice(0, 100), type: t.type, description: String(t.description || '').slice(0, 1000), loc: `${t.x} ${t.y}`,
        items: (t.items || []).filter((i) => i?.id).flatMap((i) => {
          const artifactType = types[i.type] || i.type;
          const out = [{ artifactType, artifactUniqueId: `${artifactType}:${i.id}`, artifactObjectId: i.id }];
          const l = LEGACY[i.type] && legacy.get(String(i.id).toLowerCase());
          if (l?.id) out.push({ artifactType: LEGACY[i.type].artifactType, artifactUniqueId: `${l.type ?? LEGACY[i.type].code}:${l.id}` });
          return out;
        }),
      };
    }),
    edges: edges.filter(([a, b]) => ids[a] && ids[b]).map(([a, b]) => ({ id: idOf('edge', a, b), source: ids[a], target: ids[b], fromPort: 'right', toPort: 'left' })),
  };
}
