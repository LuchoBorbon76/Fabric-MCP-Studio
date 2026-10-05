// What is built on a semantic model in Fabric – reports, data agents – and the data it reads. Found when an existing
// model is added (or on request) so the map shows the whole picture. Read only: the studio never changes or deletes
// these items, they stay the user's. A project without data takes the model's data in place (nothing is copied).
import * as F from './fabric.mjs';
import { workspaceReports } from './powerbi.mjs';
import { decodeText } from './reports/zip.mjs';
import { reportUrl } from './reports/index.mjs';
import { getProject, updateProject, logActivity, assertProjectTenant, projectModels, modelWorkspaceId, fabricUrl } from './project.mjs';
import { startJob, listJobs } from './jobs.mjs';
import { modelSourceItems } from './modelcheck.mjs';
import { adoptModelSource } from './pipelines.mjs';

// Reading a data agent's definition takes Fabric about 20 seconds: a few at a time, and not without end.
const AGENTS_AT_ONCE = 4;
const MAX_AGENTS = 30;
const firstLine = (e) => String(e?.message || e).split('\n')[0].slice(0, 200);

async function inBatches(list, n, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(...await Promise.all(list.slice(i, i + n).map(fn)));
  return out;
}

/** Power BI reports (in the given workspaces) whose dataset is the model. */
async function reportsOn(model, workspaces, notes) {
  const found = [];
  for (const ws of workspaces) {
    let list;
    try { list = await workspaceReports(ws); } catch (e) { notes.push(`Reports couldn't be listed in a workspace (${firstLine(e)}).`); continue; }
    for (const r of list) {
      if (r.datasetId !== model.id || found.some((x) => x.id === r.id)) continue;
      const url = r.type === 'PaginatedReport' ? `https://app.powerbi.com/groups/${ws}/rdlreports/${r.id}` : reportUrl(ws, r.id);
      found.push({ id: r.id, name: r.name, workspaceId: ws, type: r.type, url });
    }
  }
  return found;
}

/** Fabric data agents (in the given workspaces) that answer from the model: their definition names the model's id. */
async function agentsOn(model, workspaces, notes, ctx) {
  const items = [];
  for (const ws of workspaces) {
    try { for (const it of await F.listItems(ws, 'DataAgent')) items.push({ ...it, workspaceId: ws }); } catch (e) { notes.push(`Data agents couldn't be listed in a workspace (${firstLine(e)}).`); }
  }
  if (!items.length) return [];
  if (items.length > MAX_AGENTS) notes.push(`Only the first ${MAX_AGENTS} of ${items.length} data agents were checked.`);
  const list = items.slice(0, MAX_AGENTS);
  ctx?.log?.(`Reading ${list.length} data agent${list.length === 1 ? '' : 's'} (about 20 seconds each, ${AGENTS_AT_ONCE} at a time)`);
  const id = model.id.toLowerCase();
  let unreadable = 0;
  const hits = await inBatches(list, AGENTS_AT_ONCE, async (it) => {
    if (ctx?.signal?.aborted) return null;
    let parts;
    try { parts = (await F.getDefinition(it.workspaceId, it.id))?.parts || []; } catch { unreadable++; return null; }
    const uses = parts.some((p) => /datasource\.json$/i.test(p.path) && decodeText(Buffer.from(p.payload || '', 'base64')).toLowerCase().includes(id));
    if (!uses) return null;
    const published = parts.some((p) => /Files\/Config\/publish_info\.json$/i.test(p.path));
    return { id: it.id, name: it.displayName, workspaceId: it.workspaceId, published, url: fabricUrl('DataAgent', it.workspaceId, it.id) };
  });
  if (unreadable) notes.push(`${unreadable} data agent${unreadable === 1 ? '' : 's'} couldn't be read (reading one needs Contributor access to it).`);
  return hits.filter(Boolean);
}

/** Change a project model's entry (the active one through semanticModel, so it stays in step). */
function patchModel(id, patch) {
  const p = getProject();
  const m = (p.semanticModels || []).find((x) => x.id === id);
  if (!m) return false;
  if (p.semanticModel?.id === id) updateProject({ semanticModel: { ...p.semanticModel, ...patch } });
  else updateProject({ semanticModels: p.semanticModels.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  return true;
}

/**
 * Job: find the reports and data agents built on a project model (the active one by default) and the data it reads, and
 * show them on the map. With `adopt`, a project without data takes the model's data in place.
 */
export async function runModelLinks(ctx, { id, adopt = true } = {}) {
  await assertProjectTenant();
  const p = getProject();
  const m = id ? projectModels(p).find((x) => x.id === id) : p.semanticModel;
  if (!m) throw Object.assign(new Error(id ? 'That semantic model isn\'t in the project.' : 'There is no semantic model yet.'), { status: 404 });
  const ws = modelWorkspaceId(p, m);
  const workspaces = [...new Set([ws, p.workspace?.id].filter(Boolean))];
  const notes = [];
  ctx.step(`Find what is built on ${m.name}`);
  ctx.progress(10);
  // The studio's own models know their data; an existing model's comes from its definition.
  const sourcesP = m.origin === 'existing'
    ? modelSourceItems(ws, m.id).catch((e) => { notes.push(`The model's data couldn't be read from its definition (${firstLine(e)}).`); return null; })
    : Promise.resolve(null);
  const [reports, agents, sources] = await Promise.all([reportsOn(m, workspaces, notes), agentsOn(m, workspaces, notes, ctx), sourcesP]);
  if (ctx.signal?.aborted) throw new Error('Cancelled');
  ctx.progress(80);
  const prev = m.linked || {};
  const linked = { reports, agents, sources: sources ?? prev.sources ?? [], at: new Date().toISOString(), notes };
  if (!patchModel(m.id, { linked })) {
    ctx.log('The semantic model is no longer in the project (another data source or workspace is active): nothing was saved.');
    return { model: m.name, reports: reports.length, agents: agents.length, saved: false };
  }
  ctx.log(`${reports.length} report${reports.length === 1 ? '' : 's'}${reports.length ? `: ${reports.map((r) => r.name).join(', ')}` : ''}`);
  ctx.log(`${agents.length} data agent${agents.length === 1 ? '' : 's'}${agents.length ? `: ${agents.map((a) => a.name).join(', ')}` : ''}`);
  if (linked.sources.length) ctx.log(`Reads ${linked.sources.map((s) => `${s.name} (${s.type})`).join(', ')}`);
  for (const n of notes) ctx.log(n);

  let adopted = null;
  if (adopt && linked.sources.length === 1 && getProject().semanticModel?.id === m.id) {
    const s = linked.sources[0];
    ctx.step(`Use ${s.name} as the data source`);
    try {
      if (await adoptModelSource({ workspaceId: s.workspaceId, itemId: s.id, itemType: s.type, modelId: m.id }, ctx)) {
        adopted = s;
        ctx.log(`Data source: ${s.name}, used in place (nothing is copied)`);
      }
    } catch (e) { ctx.log(`${s.name} couldn't be used as the data source (${firstLine(e)}). Connect it on the Data page.`); }
  }
  ctx.progress(100);
  const what = [reports.length ? `${reports.length} report${reports.length === 1 ? '' : 's'}` : null, agents.length ? `${agents.length} data agent${agents.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
  logActivity('model.links', `${m.name}: ${what || 'no reports or data agents'} found in Fabric${adopted ? `; data source ${adopted.name}` : ''}`, { semanticModelId: m.id });
  return { model: m.name, reports: reports.length, agents: agents.length, sources: linked.sources.map((s) => s.name), adopted: adopted?.name || null, notes };
}

/** Start looking at a model (or return the search already running for it). */
export function startModelLinks(id) {
  const running = listJobs().find((j) => j.kind === 'model-links' && j.status === 'running' && j.meta?.modelId === id);
  if (running) return running;
  const name = getProject().semanticModels?.find((m) => m.id === id)?.name;
  return startJob('model-links', `Find what is built on ${name || 'the semantic model'}`, (ctx) => runModelLinks(ctx, { id }), { meta: { modelId: id } });
}

/** An existing model that hasn't been looked at yet: look in the background. Returns the job id, or null. */
export function ensureModelLinks(id) {
  const m = getProject().semanticModels?.find((x) => x.id === id);
  if (!m || m.origin !== 'existing' || m.linked?.at) return null;
  return startModelLinks(id).id;
}
