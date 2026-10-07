// Everything the project has built, what uses what, and removing an item – only when nothing uses it any more.
// Each artifact: { key, nodes (solution map parts), type, name, url, uses: [keys], removes (what Remove does) }.
// "Used by" is the reverse of uses, plus Fabric reports the studio didn't build on the semantic model.
import * as F from './fabric.mjs';
import { getProject, updateProject, setStep, logActivity, assertProjectTenant, fabricUrl, projectModels, modelContext, updateModelContext, otherSourcesUsing } from './project.mjs';
import { workspaceReports } from './powerbi.mjs';
import * as P from './pipelines.mjs';
import * as R from './reports/index.mjs';
import * as RT from './realtime/index.mjs';
import * as PL from './planning/index.mjs';
import * as DP from './dataprep.mjs';
import * as DA from './dataagent.mjs';
import * as WTF from './workspace-taskflow.mjs';

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
    // Items the studio made for this source that another data source of the workspace reads stay.
    const shared = created.filter((x) => otherSourcesUsing(x.id, p).length);
    const deleted = created.filter((x) => !shared.includes(x));
    add({
      key: 'source', nodes: ['source', 'data'], type: `Data source${ms ? ` · ${LABEL[ms.itemType] || ms.itemType}` : ''}`,
      name: ms?.itemName || p.source?.label || 'Data source', url: ms ? url(ms.itemType, ms.itemId, ms.workspaceId || ws) : null,
      uses: sourceIsCurated ? ['dataPrep'] : [],
      removes: `${deleted.length ? `Deletes ${deleted.map((x) => x.name).join(' and ')} and disconnects the data source` : 'Disconnects the data source – the item itself stays in Fabric'}${shared.length ? ` (${shared.map((x) => x.name).join(' and ')} stay${shared.length === 1 ? 's' : ''}: another data source of the workspace reads ${shared.length === 1 ? 'it' : 'them'})` : ''}`,
    });
  }
  // Studio items that once held the data but aren't the data source any more.
  if (oldLakehouse) add({ key: 'lakehouse', nodes: ['data'], type: 'Lakehouse', name: oldLakehouse.name, url: url('Lakehouse', oldLakehouse.id), removes: `Deletes ${oldLakehouse.name}` });
  if (oldSqlDb) add({ key: 'sqlDatabase', nodes: ['data'], type: 'SQL database', name: oldSqlDb.name, url: url('SQLDatabase', oldSqlDb.id), removes: `Deletes ${oldSqlDb.name}` });

  const dp = p.dataPrep;
  if (dp) {
    // The notebook reads its source lakehouse (the raw data, even when the curated lakehouse is the data source now).
    const src = dp.source?.lakehouseId;
    // A curated lakehouse another data source of the workspace reads stays when the notebook goes.
    const keepTarget = dp.target && !dp.target.same ? otherSourcesUsing(dp.target.id, p) : [];
    add({
      key: 'dataPrep', nodes: ['data'], type: 'Data prep notebook', name: dp.notebook?.name || 'Data prep notebook', url: url('Notebook', dp.notebook?.id, dp.notebook?.workspaceId),
      uses: src && !(sourceIsCurated && src === ms?.itemId) ? usesItem(src).filter((k) => k !== 'dataPrep') : [],
      removes: !dp.target || dp.target.same ? 'Deletes the notebook'
        : keepTarget.length ? `Deletes the notebook – the curated lakehouse ${dp.target.name} stays: ${keepTarget.map((u) => u.label).join(', ')} use${keepTarget.length === 1 ? 's' : ''} it`
          : `Deletes the notebook and the curated lakehouse ${dp.target.name}`,
    });
  }
  // A model or ontology reads the item it was built on (older projects didn't record it: the current source). Every
  // model in the project is listed; an existing model the user added is only taken out of the project, never deleted.
  const activeId = p.semanticModel?.id || null;
  for (const m of projectModels(p)) {
    const theirs = m.origin === 'existing';
    add({
      key: `model:${m.id}`, nodes: ['model'], type: theirs ? 'Semantic model (existing)' : 'Semantic model', name: m.name, url: url('SemanticModel', m.id, m.workspaceId || ws),
      uses: theirs ? [] : usesItem(m.sourceItemId), removes: theirs ? `Stops using ${m.name} in the studio – the model stays in Fabric` : `Deletes ${m.name}`,
      model: { id: m.id, origin: m.origin || 'studio', active: m.id === activeId, workspaceId: m.workspaceId || ws },
    });
  }
  const modelKey = (id) => (id || activeId ? `model:${id || activeId}` : null);
  if (p.ontology?.id) add({ key: 'ontology', nodes: ['ontology'], type: 'Ontology', name: p.ontology.name, url: url('Ontology', p.ontology.id), uses: usesItem(p.ontology.sourceItemId), removes: `Deletes ${p.ontology.name} and the graph and Eventhouse Fabric made for it` });
  for (const r of p.reports || []) {
    add({ key: `report:${r.id}`, nodes: ['reports'], type: 'Report', name: r.name, url: r.url || url('Report', r.id), uses: [modelKey(r.semanticModelId), ...(r.pages?.includes(PLAN_PAGE) && p.planning ? ['planning'] : [])].filter(Boolean), removes: `Deletes ${r.name}` });
  }
  if (p.orgApp?.id) add({ key: 'orgApp', nodes: ['orgapp'], type: 'Org app', name: p.orgApp.name, url: p.orgApp.url, uses: (p.orgApp.reports || []).filter((id) => (p.reports || []).some((r) => r.id === id)).map((id) => `report:${id}`), removes: `Deletes ${p.orgApp.name}` });
  if (p.planning) {
    const t = p.planning.target;
    const pm = projectModels(p).find((m) => m.id === p.planning.semanticModelId) || p.semanticModel;
    add({
      key: 'planning', nodes: ['planning'], type: 'Budget and forecast', name: `Plan ${p.planning.planYear}`, url: null, uses: [modelKey(pm?.id)].filter(Boolean),
      removes: `Takes the Plan table out of ${pm?.name || 'the model'} and deletes the plan values${t?.warehouse?.created ? ` (and the warehouse ${t.warehouse.name})` : ''}`,
    });
    const it = p.planning.planItem;
    if (it?.id) add({ key: 'planItem', nodes: ['planitem'], type: 'Fabric plan', name: it.name, url: it.url, uses: ['planning'], removes: `Deletes ${it.name} with its planning sheets` });
  }
  if (p.dataAgent?.id) add({ key: 'dataAgent', nodes: ['answers'], type: 'Fabric data agent', name: p.dataAgent.name, url: url('DataAgent', p.dataAgent.id, p.dataAgent.workspaceId), uses: [modelKey(p.dataAgent.semanticModelId)].filter(Boolean), removes: `Deletes ${p.dataAgent.name}` });
  // Data agents and org apps kept with the models that aren't active.
  for (const m of projectModels(p).filter((x) => x.id !== activeId)) {
    const c = modelContext(p, m.id);
    if (c.dataAgent?.id) add({ key: `dataAgent:${m.id}`, nodes: ['answers'], type: `Fabric data agent · ${m.name}`, name: c.dataAgent.name, url: url('DataAgent', c.dataAgent.id, c.dataAgent.workspaceId), uses: [`model:${m.id}`], removes: `Deletes ${c.dataAgent.name}` });
    if (c.orgApp?.id) add({ key: `orgApp:${m.id}`, nodes: ['orgapp'], type: `Org app · ${m.name}`, name: c.orgApp.name, url: c.orgApp.url, uses: (c.orgApp.reports || []).filter((id) => (p.reports || []).some((r) => r.id === id)).map((id) => `report:${id}`), removes: `Deletes ${c.orgApp.name}` });
  }
  if (p.teamsAgent) add({ key: 'teamsAgent', nodes: ['agent'], type: 'Microsoft 365 agent', name: 'Teams & Copilot agent', url: null, uses: [modelKey(), ...(p.teamsAgent.includeOntology && p.ontology ? ['ontology'] : [])].filter(Boolean), removes: 'Uninstalls the agent from Microsoft 365 and Teams' });

  const rt = p.realtime;
  if (rt?.eventhouse || rt?.eventstream) {
    add({ key: 'realtime', nodes: ['events', 'eventstream', 'eventhouse'], type: 'Live data', name: rt.eventhouse?.name || rt.eventstream?.name, url: url('Eventhouse', rt.eventhouse?.id), removes: `Stops the events and deletes ${[rt.eventstream?.name, rt.eventhouse?.name].filter(Boolean).join(' and ')}` });
    if (rt.dashboard?.id) add({ key: 'dashboard', nodes: ['dashboard'], type: 'Real-Time Dashboard', name: rt.dashboard.name, url: rt.dashboard.url || url('KQLDashboard', rt.dashboard.id), uses: ['realtime'], removes: `Deletes ${rt.dashboard.name}` });
    if (rt.alerts) add({ key: 'alerts', nodes: ['alerts'], type: 'Activator alerts', name: rt.alerts.name, url: rt.alerts.url || url('Reflex', rt.alerts.id), uses: ['realtime'], removes: `Deletes ${rt.alerts.name}` });
    if (rt.ontology && p.ontology) add({ key: 'liveOntology', nodes: ['ontology'], type: 'Live ontology properties', name: `Live properties in ${p.ontology.name}`, url: null, uses: ['realtime', 'ontology', ...(rt.ontology.dashboardLinked && rt.dashboard ? ['dashboard'] : [])], removes: `Takes the live time-series properties${rt.ontology.dashboardLinked ? ' and the dashboard links' : ''} out of ${p.ontology.name}` });
    if (rt.medallion) add({ key: 'medallion', nodes: ['eventhouse'], type: 'Medallion layers (live)', name: `Bronze › Silver › Gold on ${rt.eventhouse?.name || 'the Eventhouse'}`, url: null, uses: ['realtime'], removes: 'Deletes the Silver and Gold layers, their querysets, Gold semantic model, Silver lakehouse and task flow – the raw events stay' });
  }
  if (p.taskFlow?.id) add({ key: 'taskFlow', nodes: ['workspace'], type: 'Task flow', name: p.taskFlow.name, url: WTF.taskFlowUrl(ws), removes: p.taskFlow.mode === 'existing' ? `Takes the studio's items off the tasks of "${p.taskFlow.name}" – the task flow and its other items stay` : `Deletes the task flow "${p.taskFlow.name}" – the items stay` });
  return out;
}

/**
 * The artifacts with what uses each of them. With `external`, Fabric reports the studio didn't build on a semantic
 * model the studio built count as users too (so the model can't be deleted from under them).
 */
export async function projectArtifacts({ external = true } = {}) {
  const p = getProject();
  const list = artifactList(p);
  const others = new Map();     // model id -> reports the studio didn't build
  const failed = new Map();     // model id -> why its reports couldn't be read
  if (external && p.workspace) {
    const ours = new Set((p.reports || []).map((r) => r.id));
    const studioModels = list.filter((a) => a.model && a.model.origin !== 'existing');
    const byWs = new Map();
    for (const a of studioModels) {
      // If the reports can't be read, the model counts as used: never delete it from under reports nobody checked.
      if (!byWs.has(a.model.workspaceId)) byWs.set(a.model.workspaceId, workspaceReports(a.model.workspaceId).catch((e) => ({ error: e.message.split('\n')[0].slice(0, 160) })));
      const r = await byWs.get(a.model.workspaceId);
      if (r?.error) failed.set(a.model.id, r.error);
      else others.set(a.model.id, r.filter((x) => x.datasetId === a.model.id && !ours.has(x.id)));
    }
  }
  const byKey = new Map(list.map((a) => [a.key, a]));
  return list.map((a) => {
    const usedBy = list.filter((b) => b.uses.includes(a.key)).map((b) => ({ key: b.key, name: b.name, type: b.type }));
    if (a.model) {
      for (const r of others.get(a.model.id) || []) usedBy.push({ key: null, name: r.name, type: 'Report (not built by the studio)' });
      if (failed.has(a.model.id)) usedBy.push({ key: null, name: 'reports the studio couldn\'t check', type: `Power BI: ${failed.get(a.model.id)}` });
    }
    const { uses, model, ...rest } = a;
    return { ...rest, ...(model ? { model } : {}), uses: uses.filter((k) => byKey.has(k)), usedBy, removable: usedBy.length === 0 };
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
    case 'dataPrep': {
      const r = await DP.removeDataPrep({ deleteItems: true });
      for (const k of r.kept || []) ctx.log(`${k.name} stays – ${k.by.join(', ')} use${k.by.length === 1 ? 's' : ''} it`);
      break;
    }
    case 'model': {
      const id = a.key.slice('model:'.length);
      const m = (p.semanticModels || []).find((x) => x.id === id);
      if (!m) { ctx.log(`${a.name} is no longer in the project`); break; }
      if (m.origin === 'existing') ctx.log(`${m.name} stays in Fabric – the studio stops using it`);
      else await delItem(ctx, m.workspaceId || ws, m.id, m.name);
      // The active model: the next model (if any) becomes active. Another model: just leaves the list.
      if (m.id === p.semanticModel?.id) updateProject({ semanticModel: null, reportProposal: null, dataAgentProposal: null });
      else updateProject({ semanticModels: (p.semanticModels || []).filter((x) => x.id !== m.id) });
      R.resetProfileCache();
      const left = getProject().semanticModel;
      if (left) { setStep('model', 'done', left.name); ctx.log(`Active semantic model: ${left.name}`); } else setStep('model', 'todo', '');
      break;
    }
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
    case 'orgApp': {
      const modelId = a.key.split(':')[1];
      if (modelId) {
        const app = modelContext(p, modelId).orgApp;
        if (app?.id) await delItem(ctx, wsOfUrl(app.url) || ws, app.id, app.name);
        updateModelContext(modelId, { orgApp: null });
      } else { await delItem(ctx, wsOfUrl(p.orgApp.url) || ws, p.orgApp.id, p.orgApp.name); updateProject({ orgApp: null }); setStep('apps', 'todo', ''); }
      break;
    }
    case 'planning':
      // Without its semantic model there is no Plan table to take out; forget the plan (its values stay where they are).
      if ((p.semanticModels || []).some((m) => m.id === (p.planning.semanticModelId || p.semanticModel?.id))) await PL.removePlan({ deleteData: true, deleteItem: false });
      else { updateProject({ planning: null, planStore: null }); setStep('planning', 'todo', ''); ctx.log('The semantic model is gone, so only the plan settings were removed'); }
      break;
    case 'planItem': await delItem(ctx, wsOfUrl(p.planning.planItem.url) || ws, p.planning.planItem.id, p.planning.planItem.name); updateProject({ planning: { ...getProject().planning, planItem: null } }); break;
    case 'dataAgent': {
      const modelId = a.key.split(':')[1];
      if (modelId) {
        const ag = modelContext(p, modelId).dataAgent;
        if (ag?.id) await delItem(ctx, ag.workspaceId || ws, ag.id, ag.name);
        updateModelContext(modelId, { dataAgent: null, dataAgentProposal: null });
      } else await DA.removeDataAgent({ deleteItem: true });
      break;
    }
    case 'teamsAgent': await P.uninstallTeamsAgent(ctx); break;
    case 'realtime': await RT.removeRealtime({ deleteItems: true }); break;
    case 'dashboard': await RT.removeDashboard(); break;
    case 'alerts': await RT.removeAlerts({ keepItem: false }); break;
    case 'liveOntology': await RT.runLiveOntology(nestedCtx, { unlink: true }); break;
    case 'medallion': await RT.removeMedallion(nestedCtx, { deleteItems: true }); break;
    case 'taskFlow': await WTF.removeTaskFlow(); break;
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
