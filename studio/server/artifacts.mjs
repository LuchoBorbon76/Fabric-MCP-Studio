// Everything the project has built, what uses what, and removing an item – only when nothing uses it any more.
// Each artifact: { key, nodes (solution map parts), type, name, url, uses: [keys], removes (what Remove does) }.
// "Used by" is the reverse of uses, plus Fabric reports the studio didn't build on the semantic model.
import * as F from './fabric.mjs';
import { getProject, updateProject, setStep, logActivity, assertProjectTenant, fabricUrl } from './project.mjs';
import { workspaceReports } from './powerbi.mjs';
import * as P from './pipelines.mjs';
import * as R from './reports/index.mjs';
import * as RT from './realtime/index.mjs';
import * as PL from './planning/index.mjs';
import * as DP from './dataprep.mjs';
import * as DA from './dataagent.mjs';
import * as MF from './medallion-flow.mjs';

const PLAN_PAGE = 'Plan vs actual';
const LABEL = { Lakehouse: 'Lakehouse', Warehouse: 'Warehouse', SQLDatabase: 'SQL database', MirroredDatabase: 'Mirrored database' };
const gone = (e) => e?.status === 404 || /not\s*found|ItemNotFound|EntityNotFound/i.test(e?.message || '');
const del = async (workspaceId, id) => { try { await F.deleteItem(workspaceId, id); return true; } catch (e) { if (gone(e)) return false; throw e; } };

/** The project's artifacts with what each one uses. */
function artifactList(p = getProject()) {
  const ws = p.workspace?.id;
  const out = [];
  const add = (a) => out.push({ uses: [], ...a });
  const url = (type, id, wsId = ws) => (id ? fabricUrl(type, wsId, id) : null);
  const ms = p.modelSource;
  const curated = new Set((p.dataPrepItems || []).filter((x) => x.type === 'Lakehouse').map((x) => x.id));
  const sourceIsCurated = Boolean(ms && curated.has(ms.itemId));
  const oldLakehouse = p.lakehouse?.id && p.lakehouse.id !== ms?.itemId ? p.lakehouse : null;
  const oldSqlDb = p.sqlDatabase?.id && p.sqlDatabase.id !== ms?.itemId ? p.sqlDatabase : null;
  // The artifact that holds a data item: the current data source, or a studio item that held the data before.
  const holder = (itemId) => {
    if (!itemId) return ms ? 'source' : null;
    if (ms && itemId === ms.itemId) return 'source';
    if (oldLakehouse && itemId === oldLakehouse.id) return 'lakehouse';
    if (oldSqlDb && itemId === oldSqlDb.id) return 'sqlDatabase';
    if (curated.has(itemId) && p.dataPrep?.target?.id === itemId) return 'dataPrep';
    return null;
  };
  const usesItem = (itemId) => { const k = holder(itemId); return k ? [k] : []; };

  if (p.source || ms) {
    const created = P.dataSourceItems(p);
    add({
      key: 'source', nodes: ['source', 'data'], type: `Data source${ms ? ` · ${LABEL[ms.itemType] || ms.itemType}` : ''}`,
      name: ms?.itemName || p.source?.label || 'Data source', url: ms ? url(ms.itemType, ms.itemId, ms.workspaceId || ws) : null,
      uses: sourceIsCurated ? ['dataPrep'] : [],
      removes: created.length ? `Deletes ${created.map((x) => x.name).join(' and ')} and disconnects the data source` : 'Disconnects the data source – the item itself stays in Fabric',
    });
  }
  // Studio items that once held the data but aren't the data source any more.
  if (oldLakehouse) add({ key: 'lakehouse', nodes: ['data'], type: 'Lakehouse', name: oldLakehouse.name, url: url('Lakehouse', oldLakehouse.id), removes: `Deletes ${oldLakehouse.name}` });
  if (oldSqlDb) add({ key: 'sqlDatabase', nodes: ['data'], type: 'SQL database', name: oldSqlDb.name, url: url('SQLDatabase', oldSqlDb.id), removes: `Deletes ${oldSqlDb.name}` });

  const dp = p.dataPrep;
  if (dp) {
    // The notebook reads its source lakehouse (the raw data, even when the curated lakehouse is the data source now).
    const src = dp.source?.lakehouseId;
    add({
      key: 'dataPrep', nodes: ['data'], type: 'Data prep notebook', name: dp.notebook?.name || 'Data prep notebook', url: url('Notebook', dp.notebook?.id, dp.notebook?.workspaceId),
      uses: src && !(sourceIsCurated && src === ms?.itemId) ? usesItem(src).filter((k) => k !== 'dataPrep') : [],
      removes: `Deletes the notebook${dp.target && !dp.target.same ? ` and the curated lakehouse ${dp.target.name}` : ''}`,
    });
  }
  // A model or ontology reads the item it was built on (older projects didn't record it: the current source).
  if (p.semanticModel?.id) add({ key: 'model', nodes: ['model'], type: 'Semantic model', name: p.semanticModel.name, url: url('SemanticModel', p.semanticModel.id), uses: usesItem(p.semanticModel.sourceItemId), removes: `Deletes ${p.semanticModel.name}` });
  if (p.ontology?.id) add({ key: 'ontology', nodes: ['ontology'], type: 'Ontology', name: p.ontology.name, url: url('Ontology', p.ontology.id), uses: usesItem(p.ontology.sourceItemId), removes: `Deletes ${p.ontology.name} and the graph and Eventhouse Fabric made for it` });
  for (const r of p.reports || []) {
    add({ key: `report:${r.id}`, nodes: ['reports'], type: 'Report', name: r.name, url: r.url || url('Report', r.id), uses: [...(p.semanticModel ? ['model'] : []), ...(r.pages?.includes(PLAN_PAGE) && p.planning ? ['planning'] : [])], removes: `Deletes ${r.name}` });
  }
  if (p.orgApp?.id) add({ key: 'orgApp', nodes: ['orgapp'], type: 'Org app', name: p.orgApp.name, url: p.orgApp.url, uses: (p.orgApp.reports || []).filter((id) => (p.reports || []).some((r) => r.id === id)).map((id) => `report:${id}`), removes: `Deletes ${p.orgApp.name}` });
  if (p.planning) {
    const t = p.planning.target;
    add({
      key: 'planning', nodes: ['planning'], type: 'Budget and forecast', name: `Plan ${p.planning.planYear}`, url: null, uses: p.semanticModel ? ['model'] : [],
      removes: `Takes the Plan table out of ${p.semanticModel?.name || 'the model'} and deletes the plan values${t?.warehouse?.created ? ` (and the warehouse ${t.warehouse.name})` : ''}`,
    });
    const it = p.planning.planItem;
    if (it?.id) add({ key: 'planItem', nodes: ['planitem'], type: 'Fabric plan', name: it.name, url: it.url, uses: ['planning'], removes: `Deletes ${it.name} with its planning sheets` });
  }
  if (p.dataAgent?.id) add({ key: 'dataAgent', nodes: ['answers'], type: 'Fabric data agent', name: p.dataAgent.name, url: url('DataAgent', p.dataAgent.id, p.dataAgent.workspaceId), uses: p.semanticModel ? ['model'] : [], removes: `Deletes ${p.dataAgent.name}` });
  if (p.teamsAgent) add({ key: 'teamsAgent', nodes: ['agent'], type: 'Microsoft 365 agent', name: 'Teams & Copilot agent', url: null, uses: [...(p.semanticModel ? ['model'] : []), ...(p.teamsAgent.includeOntology && p.ontology ? ['ontology'] : [])], removes: 'Uninstalls the agent from Microsoft 365 and Teams' });

  const rt = p.realtime;
  if (rt?.eventhouse || rt?.eventstream) {
    add({ key: 'realtime', nodes: ['events', 'eventstream', 'eventhouse'], type: 'Live data', name: rt.eventhouse?.name || rt.eventstream?.name, url: url('Eventhouse', rt.eventhouse?.id), removes: `Stops the events and deletes ${[rt.eventstream?.name, rt.eventhouse?.name].filter(Boolean).join(' and ')}` });
    if (rt.dashboard?.id) add({ key: 'dashboard', nodes: ['dashboard'], type: 'Real-Time Dashboard', name: rt.dashboard.name, url: rt.dashboard.url || url('KQLDashboard', rt.dashboard.id), uses: ['realtime'], removes: `Deletes ${rt.dashboard.name}` });
    if (rt.alerts) add({ key: 'alerts', nodes: ['alerts'], type: 'Activator alerts', name: rt.alerts.name, url: rt.alerts.url || url('Reflex', rt.alerts.id), uses: ['realtime'], removes: `Deletes ${rt.alerts.name}` });
    if (rt.ontology && p.ontology) add({ key: 'liveOntology', nodes: ['ontology'], type: 'Live ontology properties', name: `Live properties in ${p.ontology.name}`, url: null, uses: ['realtime', 'ontology', ...(rt.ontology.dashboardLinked && rt.dashboard ? ['dashboard'] : [])], removes: `Takes the live time-series properties${rt.ontology.dashboardLinked ? ' and the dashboard links' : ''} out of ${p.ontology.name}` });
    if (rt.medallion) add({ key: 'medallion', nodes: ['eventhouse'], type: 'Medallion layers (live)', name: `Bronze › Silver › Gold on ${rt.eventhouse?.name || 'the Eventhouse'}`, url: null, uses: ['realtime'], removes: 'Deletes the Silver and Gold layers, their querysets, Gold semantic model, Silver lakehouse and task flow – the raw events stay' });
  }
  if (p.medallionFlow?.id) add({ key: 'medallionFlow', nodes: ['workspace'], type: 'Task flow', name: p.medallionFlow.name, url: MF.taskFlowUrl(ws), removes: `Deletes the task flow "${p.medallionFlow.name}" – the items stay` });
  return out;
}

/**
 * The artifacts with what uses each of them. With `external`, Fabric reports the studio didn't build on the semantic
 * model count as users too (so the model can't be removed from under them).
 */
export async function projectArtifacts({ external = true } = {}) {
  const p = getProject();
  const list = artifactList(p);
  let others = [];
  let checkFailed = null;
  if (external && p.workspace && p.semanticModel?.id) {
    const ours = new Set((p.reports || []).map((r) => r.id));
    // If the reports can't be read, the model counts as used: never delete it from under reports nobody checked.
    try { others = (await workspaceReports(p.workspace.id)).filter((r) => r.datasetId === p.semanticModel.id && !ours.has(r.id)); }
    catch (e) { checkFailed = e.message.split('\n')[0].slice(0, 160); }
  }
  const byKey = new Map(list.map((a) => [a.key, a]));
  return list.map((a) => {
    const usedBy = list.filter((b) => b.uses.includes(a.key)).map((b) => ({ key: b.key, name: b.name, type: b.type }));
    if (a.key === 'model') {
      for (const r of others) usedBy.push({ key: null, name: r.name, type: 'Report (not built by the studio)' });
      if (checkFailed) usedBy.push({ key: null, name: 'reports the studio couldn\'t check', type: `Power BI: ${checkFailed}` });
    }
    const { uses, ...rest } = a;
    return { ...rest, uses: uses.filter((k) => byKey.has(k)), usedBy, removable: usedBy.length === 0 };
  });
}

/** Delete a Fabric item; says so when it was already gone (deleted in Fabric, or left in a previous workspace). */
async function delItem(ctx, workspaceId, id, name) {
  if (!workspaceId) { ctx.log(`${name}: no workspace to delete it from – the studio stops tracking it`); return; }
  if (await del(workspaceId, id)) ctx.log(`Deleted ${name}`);
  else ctx.log(`${name} wasn't found in the workspace (already deleted, or in a workspace used before) – the studio stops tracking it`);
}
const wsOfUrl = (u) => /\/groups\/([0-9a-f-]{36})/i.exec(String(u || ''))?.[1] || null;

async function removeOne(ctx, a, p) {
  const ws = p.workspace?.id;
  const nestedCtx = { step: (s) => ctx.log(s), log: (l) => ctx.log(`  ${l}`), progress() {}, signal: ctx.signal };
  switch (a.key.split(':')[0]) {
    case 'source': await P.removeDataSource(ctx); break;
    case 'lakehouse': await delItem(ctx, ws, p.lakehouse.id, p.lakehouse.name); updateProject({ lakehouse: null }); break;
    case 'sqlDatabase': await delItem(ctx, ws, p.sqlDatabase.id, p.sqlDatabase.name); updateProject({ sqlDatabase: null }); break;
    case 'dataPrep': await DP.removeDataPrep({ deleteItems: true }); break;
    case 'model':
      await delItem(ctx, ws, p.semanticModel.id, p.semanticModel.name);
      updateProject({ semanticModel: null, reportProposal: null, dataAgentProposal: null });
      R.resetProfileCache();
      setStep('model', 'todo', '');
      break;
    case 'ontology':
      await delItem(ctx, ws, p.ontology.id, p.ontology.name);
      if (ws) await P.deleteOntologyCompanions(ws, p.ontology.id, ctx.log);
      updateProject({ ontology: null });
      setStep('ontology', 'todo', '');
      break;
    case 'report': {
      const id = a.key.slice('report:'.length);
      const r = (p.reports || []).find((x) => x.id === id);
      await delItem(ctx, wsOfUrl(r?.url) || ws, id, r?.name || a.name);
      await R.removeReport(id, { deleteItem: false });
      break;
    }
    case 'orgApp': await delItem(ctx, wsOfUrl(p.orgApp.url) || ws, p.orgApp.id, p.orgApp.name); updateProject({ orgApp: null }); setStep('apps', 'todo', ''); break;
    case 'planning':
      // Without the semantic model there is no Plan table to take out; forget the plan (its values stay where they are).
      if (p.semanticModel?.id) await PL.removePlan({ deleteData: true, deleteItem: false });
      else { updateProject({ planning: null, planStore: null }); setStep('planning', 'todo', ''); ctx.log('The semantic model is gone, so only the plan settings were removed'); }
      break;
    case 'planItem': await delItem(ctx, wsOfUrl(p.planning.planItem.url) || ws, p.planning.planItem.id, p.planning.planItem.name); updateProject({ planning: { ...getProject().planning, planItem: null } }); break;
    case 'dataAgent': await DA.removeDataAgent({ deleteItem: true }); break;
    case 'teamsAgent': await P.uninstallTeamsAgent(ctx); break;
    case 'realtime': await RT.removeRealtime({ deleteItems: true }); break;
    case 'dashboard': await RT.removeDashboard(); break;
    case 'alerts': await RT.removeAlerts({ keepItem: false }); break;
    case 'liveOntology': await RT.runLiveOntology(nestedCtx, { unlink: true }); break;
    case 'medallion': await RT.removeMedallion(nestedCtx, { deleteItems: true }); break;
    case 'medallionFlow': await MF.removeMedallionTaskFlow(); break;
    default: throw new Error(`Unknown item "${a.key}".`);
  }
}

/** Order keys so an item comes before what it uses (an org app before its reports, reports before the model…). */
function usersFirst(keys, list) {
  const byKey = new Map(list.map((a) => [a.key, a]));
  const left = new Set(keys);
  const out = [];
  while (left.size) {
    // Next: an item no remaining item uses.
    const next = [...left].find((k) => ![...left].some((o) => o !== k && byKey.get(o)?.uses.includes(k))) || [...left][0];
    out.push(next);
    left.delete(next);
  }
  return out;
}

/**
 * Remove artifacts – users before what they use, whatever order they were given in. Each one is checked again just
 * before it goes: an item something still uses isn't removed, and the run stops there.
 */
export async function removeArtifacts(ctx, keys = []) {
  await assertProjectTenant();
  const asked = [...new Set(keys.map(String).filter(Boolean))];
  if (!asked.length) throw new Error('Choose what to remove.');
  const want = usersFirst(asked, await projectArtifacts({ external: false }));
  const done = [];
  for (const [i, key] of want.entries()) {
    const list = await projectArtifacts();
    const a = list.find((x) => x.key === key);
    if (!a) { ctx.log(`${key} is already gone`); continue; }
    if (a.usedBy.length) throw new Error(`${a.name} is used by ${a.usedBy.map((b) => `${b.name} (${b.type})`).join(', ')}. Remove ${a.usedBy.length === 1 ? 'it' : 'them'} first.`);
    ctx.step(`Remove ${a.name}`);
    await removeOne(ctx, a, getProject());
    logActivity('artifact.remove', `Removed ${a.type} "${a.name}"`, { key });
    ctx.log(`✓ ${a.name} removed`);
    done.push(a.name);
    ctx.progress(((i + 1) / want.length) * 95);
  }
  return { removed: done };
}
