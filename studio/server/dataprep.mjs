// Data prep notebook: for a lakehouse data source, a Fabric Python notebook that renames, fixes, models, measures and
// charts the data (see generators/notebook.mjs). The notebook works everything out from the lakehouse when it runs;
// the studio only tells it which lakehouse to read and which to write, creates it in Fabric, runs it and shows the
// results.
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { DATA_DIR, sleep } from './config.mjs';
import * as F from './fabric.mjs';
import { getProject, updateProject, recordArtifact, logActivity, assertProjectTenant, fabricUrl } from './project.mjs';
import { buildDataNotebook, DATA_PREP_FOLDER } from './generators/notebook.mjs';
import { standardName } from './naming.mjs';

const CHART_DIR = join(DATA_DIR, 'data-prep');
const CHART_FILE = /^[\w.-]+\.png$/i;

/** The data source the notebook can be built for: the current lakehouse, or null with the reason. */
function lakehouseSource(p = getProject()) {
  const ms = p.modelSource;
  if (!p.workspace) return { error: 'Select a workspace first.' };
  if (!ms) return { error: 'Connect a data source first.' };
  if (ms.itemType !== 'Lakehouse') return { error: `The data prep notebook works on a lakehouse; the current data source is a ${ms.itemType}.` };
  return { source: { workspaceId: ms.workspaceId || p.workspace.id, lakehouseId: ms.itemId, name: ms.itemName } };
}

// Names follow the naming standard ([Domain]_LH_Curated_[Env], [Domain]_NB_DataPrep_[Env]). Another lakehouse source
// gets Curated2, DataPrep2… so each source keeps its own items.
const variant = (purpose, n) => (n === 1 ? purpose : `${purpose}${n}`);
const curatedName = (n = 1) => F.itemName('Lakehouse', standardName('Lakehouse', variant('Curated', n)), 'Curated');
const notebookName = (n = 1) => F.itemName('Notebook', standardName('Notebook', variant('DataPrep', n)));

/** Remember every item the data prep job creates (across data sources), so clean up can delete them all. */
function track(type, item, workspaceId, sourceId) {
  const list = getProject().dataPrepItems || [];
  if (!list.some((x) => x.id === item.id)) updateProject({ dataPrepItems: [...list, { type, id: item.id, name: item.name || item.displayName, workspaceId, sourceId }] });
}
function untrack(ids) {
  updateProject({ dataPrepItems: (getProject().dataPrepItems || []).filter((x) => !ids.includes(x.id)) });
}
const tracked = (id) => (getProject().dataPrepItems || []).find((x) => x.id === id);
const isTracked = (id) => Boolean(tracked(id));
/** A studio item that may be reused for this source (made for it, or before items recorded their source). */
const reusableFor = (id, sourceId) => { const t = tracked(id); return Boolean(t && (!t.sourceId || t.sourceId === sourceId)); };
/** The curated lakehouse name the next run would use for a source. */
function plannedCuratedName(sourceId) {
  const list = (getProject().dataPrepItems || []).filter((x) => x.type === 'Lakehouse');
  const mine = list.find((x) => x.sourceId === sourceId);
  if (mine) return mine.name;
  const others = list.filter((x) => x.sourceId && x.sourceId !== sourceId).map((x) => x.name.toLowerCase());
  for (let n = 1; ; n++) if (!others.includes(curatedName(n).toLowerCase())) return curatedName(n);
}

/** What the Data page shows: whether the notebook applies, what it reads and writes, and the last run. */
export function dataPrepState() {
  const p = getProject();
  const { source, error } = lakehouseSource(p);
  const dp = p.dataPrep || null;
  const charts = dp?.lastRun?.charts || [];
  return {
    available: Boolean(source),
    reason: error || null,
    source: source || null,
    plannedTarget: source ? { name: plannedCuratedName(source.lakehouseId), workspaceId: p.workspace.id } : null,
    current: Boolean(dp && source && dp.source?.lakehouseId === source.lakehouseId),
    dataPrep: dp ? {
      ...dp,
      notebook: dp.notebook ? { ...dp.notebook, url: fabricUrl('Notebook', dp.notebook.workspaceId, dp.notebook.id) } : null,
      target: dp.target ? { ...dp.target, url: fabricUrl('Lakehouse', dp.target.workspaceId, dp.target.id) } : null,
      lastRun: dp.lastRun ? { ...dp.lastRun, charts: charts.map((c) => ({ ...c, local: Boolean(c.file && existsSync(join(CHART_DIR, c.file))) })) } : null,
    } : null,
  };
}

/** A chart saved from the last run, for the Data page. */
export function dataPrepChart(file) {
  if (!CHART_FILE.test(file)) return null;
  const path = join(CHART_DIR, file);
  return existsSync(path) ? readFileSync(path) : null;
}

/**
 * Create (or update) the notebook for the current lakehouse and optionally run it.
 * target: 'new' writes to a curated lakehouse ([Domain]_LH_Curated_[Env]) in the project workspace (the source is left alone);
 * 'same' writes back to the source lakehouse with the Curated_ prefix.
 * Only items the studio created are reused or updated: a notebook or lakehouse of the same name that belongs to
 * someone else is left alone and the new one gets a numbered name.
 */
export async function runDataPrep(ctx, { run = true, target = 'new' } = {}) {
  await assertProjectTenant();
  const p = getProject();
  const { source, error } = lakehouseSource(p);
  if (error) throw new Error(error);
  const ws = p.workspace;
  const prev = p.dataPrep?.source?.lakehouseId === source.lakehouseId ? p.dataPrep : null;
  const items = await F.listItems(ws.id);
  // The items made for this source before – recorded with the source, or (older versions) named after it – are
  // reused whatever names the naming standard gives new ones now.
  const madeFor = (type, legacyName) => {
    const list = (getProject().dataPrepItems || []).filter((x) => x.type === type && items.some((i) => i.id === x.id));
    const t = list.find((x) => x.sourceId === source.lakehouseId) || list.find((x) => !x.sourceId && x.name?.toLowerCase() === legacyName.toLowerCase());
    return t ? items.find((i) => i.id === t.id) : null;
  };

  ctx.step('Prepare the lakehouse for the curated tables');
  let tgt;
  if (target === 'same') {
    tgt = { id: source.lakehouseId, name: source.name, workspaceId: source.workspaceId, created: false, same: true };
  } else {
    const ours = (i) => i?.type === 'Lakehouse' && isTracked(i.id);
    let lh = prev?.target && !prev.target.same ? items.find((i) => i.id === prev.target.id && ours(i)) : null;
    lh ||= madeFor('Lakehouse', F.itemName('Lakehouse', `${source.name}_Curated`, 'Curated'));
    for (let n = 1; !lh; n++) {
      const name = curatedName(n);
      const same = items.find((i) => i.type === 'Lakehouse' && i.displayName.toLowerCase() === name.toLowerCase());
      if (same && ours(same) && reusableFor(same.id, source.lakehouseId)) lh = same;
      else if (!same) {
        const made = await F.ensureLakehouse(ws.id, name, `Curated tables and charts from ${source.name}, written by the Fabric MCP Studio data prep notebook.`);
        recordArtifact({ type: 'Lakehouse', id: made.id, name, workspaceId: ws.id, note: 'Curated tables (data prep notebook)' });
        track('Lakehouse', { id: made.id, name }, ws.id, source.lakehouseId);
        lh = { ...made, displayName: name };
      }
    }
    tgt = { id: lh.id, name: lh.displayName, workspaceId: ws.id, created: true, same: false };
  }
  try { tgt.schema = (await F.getLakehouse(tgt.workspaceId, tgt.id))?.properties?.defaultSchema || null; } catch { tgt.schema = null; }
  ctx.log(tgt.same ? `Curated tables go back to ${tgt.name} with the Curated_ prefix` : `Curated tables go to ${tgt.name}${tgt.schema ? ` (schema ${tgt.schema})` : ''}`);
  ctx.progress(15);

  ctx.step('Generate the notebook');
  const title = `Data prep · ${source.name}`;
  const nb = buildDataNotebook({ title, source, target: { workspaceId: tgt.workspaceId, lakehouseId: tgt.id, name: tgt.name, schema: tgt.schema } });
  const definition = { format: 'ipynb', parts: [{ path: 'artifact.content.ipynb', payload: Buffer.from(JSON.stringify(nb), 'utf8').toString('base64'), payloadType: 'InlineBase64' }] };
  ctx.log(`${nb.cells.length} cells · reads every table in ${source.name} when it runs`);
  ctx.progress(25);

  ctx.step('Create the notebook in Fabric');
  const mine = (i) => i?.type === 'Notebook' && isTracked(i.id);
  let item = prev?.notebook?.id ? items.find((i) => i.id === prev.notebook.id && mine(i)) : null;
  item ||= madeFor('Notebook', `${source.name} data prep`.slice(0, 120));
  for (let n = 1; !item; n++) {
    const name = notebookName(n);
    const same = items.find((i) => i.type === 'Notebook' && i.displayName.toLowerCase() === name.toLowerCase());
    if (same && mine(same) && reusableFor(same.id, source.lakehouseId)) item = same;
    else if (!same) {
      const made = await F.createItem(ws.id, { name, type: 'Notebook', description: `Renames, fixes, models, measures and charts the data in ${source.name}. Generated by Fabric MCP Studio.`, definition });
      recordArtifact({ type: 'Notebook', id: made.id, name, workspaceId: ws.id, note: 'Data prep notebook (Python)' });
      track('Notebook', { id: made.id, name }, ws.id, source.lakehouseId);
      ctx.log(`Created notebook ${name}`);
      item = { ...made, displayName: name, created: true };
    }
  }
  if (!item.created) {
    await F.updateDefinition(ws.id, item.id, definition);
    ctx.log(`Updated notebook ${item.displayName}`);
  }
  const notebook = { id: item.id, name: item.displayName, workspaceId: ws.id };
  const base = { source, target: tgt, notebook, createdAt: prev?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  updateProject({ dataPrep: { ...base, lastRun: prev?.lastRun || null } });
  logActivity('data-prep.notebook', `Data prep notebook for ${source.name}`, { notebookId: item.id });
  ctx.progress(35);
  if (!run) return { notebook, target: tgt, ran: false };

  ctx.step('Run the notebook in Fabric');
  const started = new Date().toISOString();
  const r = await F.fabric('POST', `/workspaces/${ws.id}/items/${item.id}/jobs/instances?jobType=RunNotebook`, undefined, { wait: false, raw: true, signal: ctx.signal });
  if (!r?.location) throw new Error('Fabric did not start the notebook run.');
  const jobInstanceId = r.location.split('/').pop();
  const setRun = (lastRun) => updateProject({ dataPrep: { ...base, lastRun: { startedAt: started, jobInstanceId, ...lastRun } } });
  setRun({ status: 'InProgress' });
  let job;
  try {
    job = await waitNotebookRun(ctx, r.location, r.retryAfter);
  } catch (e) {
    // The studio stopped watching (cancelled, timed out or lost access): never leave the run looking "in progress".
    setRun({ status: ctx.signal.aborted ? 'Cancelled' : 'Unknown', endedAt: new Date().toISOString(), error: ctx.signal.aborted ? 'Cancelled in the studio.' : `${e.message} Select Check results to read its status again.` });
    throw e;
  }
  if (job.status !== 'Completed') {
    const message = job.failureReason?.message || `The notebook run ${String(job.status).toLowerCase()}.`;
    setRun({ status: job.status, endedAt: job.endTimeUtc || new Date().toISOString(), error: message });
    throw new Error(`The notebook run ${String(job.status).toLowerCase()}: ${message} Open the notebook in Fabric to see the cell that stopped.`);
  }

  ctx.step('Read the results');
  const endedAt = job.endTimeUtc || new Date().toISOString();
  let results;
  try {
    results = await readResults({ target: tgt, since: started, signal: ctx.signal });
  } catch (e) {
    setRun({ status: 'Completed', endedAt, summary: null, charts: [], warning: `The notebook ran, but its results couldn't be read: ${e.message}` });
    throw e;
  }
  setRun({ status: 'Completed', endedAt, ...results });
  const s = results.summary || {};
  ctx.log(results.warning || `${s.tables?.length ?? 0} curated tables · ${s.relationships?.length ?? 0} relationships · ${s.renames ?? 0} renames · ${Number(s.fixes || 0).toLocaleString()} fixes · ${s.kpis?.length ?? 0} KPIs · ${results.charts.length} charts`);
  return { notebook, target: tgt, ran: true, summary: results.summary, warning: results.warning || null };
}

/** Poll a notebook job instance until it ends; cancels it when the studio job is cancelled. */
async function waitNotebookRun(ctx, location, retryAfter) {
  const t0 = Date.now();
  let last = '';
  let errors = 0;
  let delay = Math.max(5, retryAfter || 10);
  for (;;) {
    if (ctx.signal.aborted) {
      try { await F.fabric('POST', `${location}/cancel`, undefined, { wait: false }); ctx.log('Asked Fabric to cancel the notebook run'); } catch { /* already ended */ }
      throw new Error('Cancelled');
    }
    if (Date.now() - t0 > 90 * 60 * 1000) throw new Error('The notebook run took more than 90 minutes. Open it in Fabric to check on it.');
    await sleep(delay * 1000);
    let j;
    try {
      j = await F.fabric('GET', location);
      errors = 0;
    } catch (e) {
      errors++;
      ctx.log(`Checking the run: ${e.message}`);
      // Signed out, no access any more, or the notebook was deleted: stop watching.
      if (e.code === 'AUTH_REQUIRED' || [401, 403].includes(e.status) || (e.status === 404 && Date.now() - t0 > 60000) || errors >= 6) {
        throw new Error(`The studio can't read the notebook run any more (${e.message}).`);
      }
      continue;
    }
    const status = j?.status || 'Unknown';
    const mins = Math.round((Date.now() - t0) / 6000) / 10;
    if (status !== last) { ctx.log(`Notebook run: ${status === 'NotStarted' ? 'starting the Python session' : status === 'InProgress' ? 'running' : status} (${mins} min)`); last = status; }
    // The run takes a few minutes; move the bar towards 90% without reaching it.
    ctx.progress(35 + 55 * (1 - Math.exp(-(Date.now() - t0) / 240000)));
    if (['Completed', 'Failed', 'Cancelled', 'Deduped'].includes(status)) return j;
    delay = Math.min(20, delay + 2);
  }
}

/**
 * Download the run summary and chart images the notebook saved in the target lakehouse. A summary from before `since`
 * belongs to an earlier run (this one stopped before writing its own), so it is ignored.
 */
async function readResults({ target, since, signal }) {
  const raw = await F.downloadOneLake(target.workspaceId, target.id, `Files/${DATA_PREP_FOLDER}/summary.json`, { signal });
  if (!raw) return { summary: null, charts: [], warning: 'The notebook finished but did not save a summary.' };
  const summary = JSON.parse(raw.toString('utf8'));
  // A minute of slack for clock differences between this computer and Fabric.
  if (since && Date.parse(summary.finished || 0) < Date.parse(since) - 60000) {
    return { summary: null, charts: [], warning: 'The summary in the lakehouse is from an earlier run.', stale: true };
  }
  rmSync(CHART_DIR, { recursive: true, force: true });
  mkdirSync(CHART_DIR, { recursive: true });
  const charts = [];
  for (const c of summary.charts || []) {
    if (c.file && CHART_FILE.test(c.file)) {
      try {
        const bytes = await F.downloadOneLake(target.workspaceId, target.id, `Files/${DATA_PREP_FOLDER}/charts/${c.file}`, { signal });
        if (bytes) writeFileSync(join(CHART_DIR, c.file), bytes);
      } catch { /* shown without the image */ }
    }
    charts.push({ file: c.file || null, html: c.html || null, title: c.title, insight: c.insight || '' });
  }
  return { summary: summarize(summary), charts };
}

/** The parts of the run summary the studio keeps (it lives in project.json). */
function summarize(s) {
  if (!s) return null;
  return {
    finished: s.finished, main: s.main, renames: s.renames || 0, fixes: s.fixes || 0, findings: s.findings || 0,
    tables: (s.tables || []).slice(0, 200), relationships: (s.relationships || []).slice(0, 200), outputs: s.outputs || [],
    kpis: (s.kpis || []).slice(0, 60), measures: (s.measures || []).slice(0, 50), skipped: (s.skipped || []).slice(0, 50),
  };
}

/**
 * Read the latest status and results again (e.g. after running the notebook in Fabric yourself). A summary newer than
 * the studio's last run counts as a successful run; otherwise the status comes from the Fabric job.
 */
export async function refreshDataPrep() {
  await assertProjectTenant();
  const dp = getProject().dataPrep;
  if (!dp?.notebook) throw new Error('Create the data prep notebook first.');
  const run = dp.lastRun || {};
  let jobInfo = null;
  if (run.jobInstanceId) {
    jobInfo = await F.fabric('GET', `/workspaces/${dp.notebook.workspaceId}/items/${dp.notebook.id}/jobs/instances/${run.jobInstanceId}`).catch(() => null);
    if (['InProgress', 'NotStarted'].includes(jobInfo?.status)) {
      updateProject({ dataPrep: { ...dp, lastRun: { ...run, status: 'InProgress', error: null } } });
      return dataPrepState();
    }
  }
  const results = await readResults({ target: dp.target, since: run.startedAt });
  if (results.summary) {
    updateProject({ dataPrep: { ...dp, lastRun: { ...run, status: 'Completed', endedAt: results.summary.finished, error: null, warning: null, ...results } } });
    return dataPrepState();
  }
  const status = jobInfo?.status || run.status || 'Unknown';
  const error = jobInfo?.failureReason?.message || (status === 'Completed' ? null : run.error || null);
  updateProject({ dataPrep: { ...dp, lastRun: { ...run, status, endedAt: jobInfo?.endTimeUtc || run.endedAt, error, warning: status === 'Completed' ? results.warning : run.warning || null, summary: null, charts: [] } } });
  return dataPrepState();
}

/** Forget the notebook (optionally deleting the notebook and curated lakehouse – only when the studio created them). */
export async function removeDataPrep({ deleteItems = false } = {}) {
  await assertProjectTenant();
  const dp = getProject().dataPrep;
  if (!dp) return { ok: true };
  if (deleteItems) {
    const ids = [];
    for (const it of [dp.notebook, dp.target?.same ? null : dp.target]) {
      if (!it?.id || !isTracked(it.id) || it.id === getProject().modelSource?.itemId) continue;
      await F.deleteItem(it.workspaceId, it.id).catch((e) => { if (e.status !== 404) throw e; });
      ids.push(it.id);
    }
    untrack(ids);
  }
  rmSync(CHART_DIR, { recursive: true, force: true });
  updateProject({ dataPrep: null });
  return { ok: true };
}

/** Forget charts on disk (clean up / new project). */
export function clearDataPrepFiles() {
  rmSync(CHART_DIR, { recursive: true, force: true });
}
