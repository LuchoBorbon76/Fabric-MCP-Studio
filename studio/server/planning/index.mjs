// Planning: budgets and forecasts on the project's semantic model, ready for Fabric planning (Fabric IQ).
// The studio derives a budget and a rolling forecast from the actuals, writes them next to the data, adds a "Plan" table
// with variance measures to the model, and creates the Fabric plan item where planners refine the numbers.
import * as F from '../fabric.mjs';
import { sleep } from '../config.mjs';
import { getProject, updateProject, setStep, recordArtifact, logActivity, fabricUrl } from '../project.mjs';
import { dax, refreshDataset, connectionSignInOk, setWorkspaceUser } from '../powerbi.mjs';
import { currentProfile, resetProfileCache } from '../reports/index.mjs';
import { previewPlan, typesOf, monthName, RUN_RATE } from './design.mjs';
import { applyPlanToModel, planMeasureNames, planCheckQuery } from './model.mjs';
import { planTarget, preparePlanStore, linkPlanTable, planStoreProblem, writePlanRows, waitForPlanRows, dropPlanTable, PLAN_SCHEMA, PLAN_TABLE } from './store.mjs';
import { itemNameFor, numberedName } from '../naming.mjs';

export { isPlanTable } from './store.mjs';
export const MODEL_TABLE = 'Plan';
export const planItemUrl = (ws, id) => `https://app.fabric.microsoft.com/groups/${ws}/plans/${id}`;
const PLAN_SCHEMA_URL = 'https://developer.microsoft.com/json-schemas/fabric/item/plan/definition/Definition/1.0.0/schema.json';
const tRef = (t) => `'${String(t).replace(/'/g, "''")}'`;
const cRef = (t, c) => `${tRef(t)}[${String(c).replace(/]/g, ']]')}]`;
const mRef = (m) => `[${String(m).replace(/]/g, ']]')}]`;

/**
 * The semantic model the plan is on: the one its Plan table was added to, or the active model while there is no plan.
 * A project can hold several models, but the plan values live next to the project's data, so there is one plan.
 */
export function planModelOf(p = getProject()) {
  if (p.planning?.semanticModelId) return (p.semanticModels || []).find((m) => m.id === p.planning.semanticModelId) || null;
  return p.semanticModel || null;
}

/** Why a new plan can't go on a model (null when it can): the Plan table reads the project's data source. */
export function planModelProblem(p, sm) {
  if (!sm) return null;
  if (sm.origin === 'existing') return `"${sm.name}" is an existing model you added to the project. Planning adds a Plan table next to the data the model reads, so it works on semantic models the studio built on the project's data – switch to one on the Semantic model page.`;
  if (sm.sourceItemId && p.modelSource?.itemId && sm.sourceItemId !== p.modelSource.itemId) return `"${sm.name}" reads another data source than the project's current one, so the plan values can't be added to it. Switch to a model built on ${p.modelSource.itemName}.`;
  return null;
}

// Planning works on the plan's model: the project as the functions below see it has that model as semanticModel.
function requireModel() {
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  const sm = planModelOf(p);
  if (!sm?.id) throw new Error(p.planning ? 'The semantic model the plan was built on is no longer in the project.' : 'Create the semantic model first – the plan is built on it.');
  return { ...p, semanticModel: sm };
}

/** Plan options from a request or a Copilot call (only known fields, typed). */
export function planOptions(b = {}) {
  const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  return {
    measure: b.measure ? String(b.measure) : undefined,
    dims: Array.isArray(b.dims) ? b.dims.map(String).slice(0, 2) : undefined,
    planYear: num(b.planYear), asOfMonth: num(b.asOfMonth), growthPct: num(b.growthPct),
    overrides: Array.isArray(b.overrides) ? b.overrides.slice(0, 300).map((o) => ({ key: String(o.key), growthPct: Number(o.growthPct) })).filter((o) => o.key && Number.isFinite(o.growthPct)) : undefined,
  };
}

/** What the UI and Copilot need about planning (no data rows). */
export function planningState() {
  const p = getProject();
  const pl = p.planning || null;
  const ms = p.modelSource;
  const sm = planModelOf(p);
  const modelProblem = pl ? null : planModelProblem(p, sm);
  return {
    available: Boolean(p.workspace && sm) && !modelProblem,
    writable: !planStoreProblem(ms) && !modelProblem,
    // Why the plan can't be built on this data source or model (shown on the Planning page and to Copilot), or null.
    problem: modelProblem || (ms ? planStoreProblem(ms) : null),
    // The model the plan is on, and whether that's another model than the active one.
    model: sm ? { id: sm.id, name: sm.name, active: sm.id === p.semanticModel?.id } : null,
    activeModel: p.semanticModel ? { id: p.semanticModel.id, name: p.semanticModel.name } : null,
    // Where the plan values go for this data source.
    store: ms?.itemType === 'Lakehouse' ? 'A planning warehouse in the project workspace, read by the lakehouse through a OneLake shortcut (a lakehouse SQL endpoint is read-only)' : ms?.itemType === 'SQLDatabase' ? 'A planning schema in the Fabric SQL database' : ms?.itemType === 'Warehouse' ? 'A planning schema in the warehouse' : null,
    source: ms ? { type: ms.itemType, name: ms.itemName } : null,
    plan: pl,
    links: pl && p.workspace ? {
      planItem: pl.planItem ? planItemUrl(p.workspace.id, pl.planItem.id) : null,
      model: fabricUrl('SemanticModel', sm?.workspaceId || p.workspace.id, sm?.id),
      newPlan: `https://app.fabric.microsoft.com/groups/${p.workspace.id}/list`,
    } : null,
    runRate: RUN_RATE,
  };
}

/** Preview a plan (no writes): defaults, totals, months and members. */
export async function planPreview(opts = {}) {
  const p = requireModel();
  // The profile is of the active model: use it only when the plan is on that model.
  const profile = p.semanticModel.id === getProject().semanticModel?.id ? await currentProfile().catch(() => null) : null;
  const out = await previewPlan(p.workspace.id, p.semanticModel.id, opts, { profile });
  const { rows, ...rest } = out;
  return { ...rest, rows: rows.length };
}

/** Columns of the plan table and how it relates to the model. */
function planSpec(design, names, source = { schema: PLAN_SCHEMA, table: PLAN_TABLE }) {
  const used = new Set(['scenario', 'planyear', 'monthnumber', 'periodstart', 'amount', 'closedperiod', 'updatedat']);
  const uniq = (n) => { let x = String(n).replace(/[^A-Za-z0-9_]/g, '') || 'Key'; let i = 2; while (used.has(x.toLowerCase())) x = `${n}${i++}`; used.add(x.toLowerCase()); return x; };
  const dt = typesOf(design.date.keyType);
  const keyCols = [{ name: uniq(design.date.key), ...dt }, ...design.dims.map((d) => ({ name: uniq(d.key), ...typesOf(d.keyType) }))];
  return {
    modelTable: MODEL_TABLE,
    source,
    keyCols,
    columns: [
      { name: 'Scenario', tom: 'string' }, { name: 'PlanYear', tom: 'int64' }, { name: 'MonthNumber', tom: 'int64' }, { name: 'PeriodStart', tom: 'dateTime' },
      ...keyCols.map((c) => ({ name: c.name, tom: c.tom })),
      { name: 'Amount', tom: 'decimal' }, { name: 'ClosedPeriod', tom: 'boolean' }, { name: 'UpdatedAt', tom: 'dateTime' },
    ],
    date: { table: design.date.table, key: design.date.key, column: keyCols[0].name },
    dateYear: { table: design.date.table, column: design.date.year },
    dims: design.dims.map((d, i) => ({ table: d.table, key: d.key, column: keyCols[i + 1].name, label: d.label, labelText: d.labelText })),
    measure: { name: design.measure.name, label: design.measure.label, formatString: design.measure.formatString },
    names,
    description: `Budget and forecast of ${design.measure.name} by month${design.dims.length ? `, ${design.dims.map((d) => d.labelText.toLowerCase()).join(' and ')}` : ''}. Written by Fabric MCP Studio; refine it in Fabric planning.`,
  };
}

async function readModelFiles(p) {
  const def = await F.getDefinition(p.workspace.id, p.semanticModel.id, 'TMDL');
  return Object.fromEntries((def?.parts || []).filter((x) => x.path !== '.platform').map((x) => [x.path, Buffer.from(x.payload, 'base64').toString('utf8')]));
}

/**
 * Build the plan: compute budget and forecast, write them next to the data, add the Plan table to the model and check
 * the numbers through the model. opts: { measure, dims, planYear, asOfMonth, growthPct, overrides }
 */
export async function runPlan(ctx, opts = {}) {
  const p = requireModel();
  if (!p.planning) { const why = planModelProblem(p, p.semanticModel); if (why) throw new Error(why); }
  const ws = p.workspace;
  const target = await planTarget(p);

  ctx.step('Read the model and the actuals');
  // The profile is of the active model: use it only when the plan is on that model.
  const profile = p.semanticModel.id === getProject().semanticModel?.id ? await currentProfile().catch(() => null) : null;
  const pv = await previewPlan(ws.id, p.semanticModel.id, opts, { profile });
  const d = pv.design;
  const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (!opts.planYear && pv.defaults.reason) ctx.log(pv.defaults.reason);
  ctx.log(`${d.measure.name} by month${d.dims.length ? ` × ${d.dims.map((x) => `${x.labelText} (${x.members})`).join(' × ')}` : ''} · plan year ${d.planYear} from ${d.baseYear}`);
  ctx.log(`Budget ${fmt(pv.totals.budget)} (${d.growthPct >= 0 ? '+' : ''}${d.growthPct}% on ${fmt(pv.totals.base)}${d.overrides.length ? `, ${d.overrides.length} member override${d.overrides.length === 1 ? '' : 's'}` : ''}) · forecast ${fmt(pv.totals.forecast)}${d.asOfMonth ? ` (actuals to ${monthName(d.asOfMonth)}, run rate ${pv.totals.runRate.toFixed(2)})` : ' (equals the budget until actuals arrive)'}`);
  ctx.progress(20);

  // Measures the plan table adds must not clash with the model's own measure names.
  let files = await readModelFiles(p);
  const existing = Object.entries(files).filter(([k, v]) => /^definition\/tables\//.test(k) && !new RegExp(`^table ${MODEL_TABLE}$`, 'm').test(v)).flatMap(([, v]) => [...v.matchAll(/^\tmeasure (.+?) =/gm)].map((m) => m[1].replace(/^'(.*)'$/, '$1')));
  const spec = planSpec(d, planMeasureNames(existing), target.source);

  ctx.step(`Write ${pv.rows.length} plan rows to ${target.label}`);
  const date = d.date;
  const mk = await dax(ws.id, p.semanticModel.id, `EVALUATE SUMMARIZECOLUMNS ( ${cRef(date.table, date.month)}, FILTER ( ALL ( ${cRef(date.table, date.year)} ), ${cRef(date.table, date.year)} = ${d.planYear} ), "k", MIN ( ${cRef(date.table, date.key)} )${date.column ? `, "d", MIN ( ${cRef(date.table, date.column)} )` : ''} )`);
  const monthKeys = new Map(mk.map((r) => [Number(r[date.month]), { key: r.k, date: r.d || `${d.planYear}-${String(r[date.month]).padStart(2, '0')}-01` }]));
  const missing = [...new Set(pv.rows.map((r) => r.month))].filter((m) => !monthKeys.has(m));
  if (missing.length) throw new Error(`The date table has no ${missing.map(monthName).join(', ')} ${d.planYear}.`);
  const keyCols = spec.keyCols.map((c) => ({ name: c.name, sql: c.sql }));
  await preparePlanStore(ctx, target);
  await writePlanRows(ctx, target, { planYear: d.planYear, rows: pv.rows, monthKeys, keyCols });
  ctx.log(`${pv.rows.length} rows in ${PLAN_SCHEMA}.${PLAN_TABLE} (Budget and Forecast for ${d.planYear})`);
  ctx.progress(40);
  if (target.kind === 'Lakehouse') {
    ctx.step(`Connect the plan values to ${target.lakehouse.name}`);
    await linkPlanTable(ctx, target);
  }

  if (target.replicated) {
    ctx.step('Wait for the plan to reach OneLake');
    await waitForPlanRows(ctx, target, { planYear: d.planYear, rows: pv.rows.length, total: pv.rows.reduce((a, r) => a + r.v, 0) });
    ctx.log('The SQL analytics endpoint has every plan row');
  }
  ctx.progress(60);

  ctx.step(`Add the ${MODEL_TABLE} table to ${p.semanticModel.name}`);
  files = applyPlanToModel(files, spec);
  await F.updateDefinition(ws.id, p.semanticModel.id, F.toParts(files));
  ctx.log(`${MODEL_TABLE} table with ${Object.keys(spec.names).length} measures (${Object.values(spec.names).join(', ')}) · related to ${[date.table, ...d.dims.map((x) => x.table)].join(', ')}`);
  const rf = await refreshDataset(ws.id, p.semanticModel.id, { signal: ctx.signal }).catch((e) => ({ status: 'Failed', error: e.message }));
  if (rf.status !== 'Completed') ctx.log(`Model refresh: ${rf.status}${rf.error ? ` – ${String(rf.error).slice(0, 200)}` : ''}`);
  ctx.progress(80);

  ctx.step('Check the plan through the model');
  let check = null;
  for (let i = 0; i < 6 && !check; i++) {
    try {
      const [r] = await dax(ws.id, p.semanticModel.id, planCheckQuery(spec, d.planYear));
      if (r && Math.abs(Number(r.budget) - pv.totals.budget) < 1) check = r;
      else if (i === 5) throw new Error(`The model shows a budget of ${fmt(r?.budget || 0)} instead of ${fmt(pv.totals.budget)}.`);
    } catch (e) { if (i === 5) throw e; }
    if (!check) await new Promise((res) => setTimeout(res, 10000));
  }
  ctx.log(`${d.planYear}: budget ${fmt(check.budget)} · forecast ${fmt(check.forecast)} · actual ${fmt(check.actual)} · variance to budget ${fmt(check.variance)}`);

  const prev = getProject().planning;
  const planning = {
    semanticModelId: p.semanticModel.id,
    measure: d.measure, date: d.date, dims: spec.dims, planYear: d.planYear, baseYear: d.baseYear, asOfMonth: d.asOfMonth, growthPct: d.growthPct, overrides: d.overrides,
    target: { kind: target.kind, label: target.label, table: `${target.source.schema}.${target.source.table}`, warehouse: target.warehouse || null, lakehouse: target.lakehouse || null, shortcut: target.shortcut || null },
    spec: { modelTable: spec.modelTable, source: spec.source, columns: spec.columns, date: spec.date, dateYear: spec.dateYear, dims: spec.dims, measure: spec.measure, names: spec.names, description: spec.description, keyCols: spec.keyCols },
    totals: { ...pv.totals, checked: { budget: Number(check.budget), forecast: Number(check.forecast), actual: Number(check.actual), variance: Number(check.variance) } },
    months: pv.months, members: pv.members.slice(0, 40),
    planItem: prev?.planItem || null,
    builtAt: new Date().toISOString(), createdAt: prev?.createdAt || new Date().toISOString(),
  };
  updateProject({ planning });
  resetProfileCache();
  setStep('planning', 'done', `${d.measure.name} ${d.planYear}`);
  logActivity('planning.build', `Plan ${d.planYear} for ${d.measure.name}: budget ${fmt(pv.totals.budget)}, forecast ${fmt(pv.totals.forecast)}`, {});
  return { planYear: d.planYear, budget: Number(check.budget), forecast: Number(check.forecast), actual: Number(check.actual), variance: Number(check.variance), rows: pv.rows.length, measures: Object.values(spec.names), table: `${PLAN_SCHEMA}.${PLAN_TABLE}` };
}

/** Re-apply the plan table to a freshly generated model definition (semantic model rebuilds keep the plan). */
export function reapplyPlan(files, p = getProject()) {
  if (!p.planning?.spec) return files;
  try { return applyPlanToModel(files, p.planning.spec); } catch { return files; }
}

/** Shared Power BI semantic model connections the plan can use (Fabric planning reads the model through one). */
export async function planConnections() {
  const p = requireModel();
  const list = (await F.listConnections().catch(() => [])).filter((c) => c.type === 'PowerBIDatasets' && c.connectivityType === 'ShareableCloud');
  const signIn = await Promise.all(list.map((c) => connectionSignInOk(c.gatewayId, c.id)));
  return { workspace: p.workspace.name, current: p.planning?.planItem?.connectionId || null, connections: list.map((c, i) => ({ id: c.id, name: c.name, credentialType: c.credentialType || null, signInOk: signIn[i] })) };
}

const PLAN_ROLES = ['Admin', 'Member', 'Contributor'];

/**
 * Who can open the model in a plan: the workspace's people and their roles. A plan reads the model as the person who
 * opens it, or as the account saved in its shared connection – either needs Contributor or higher in the workspace.
 */
export async function planAccess() {
  const p = requireModel();
  let r;
  try { r = await F.fabric('GET', `/workspaces/${p.workspace.id}/roleAssignments`); } catch (e) {
    return { workspace: p.workspace.name, canList: false, members: [], reason: `Only workspace Admins and Members can see who has access (${e.message.split('\n')[0].slice(0, 120)}).` };
  }
  const members = (r?.value || []).map((a) => ({
    name: a.principal?.displayName || a.principal?.id,
    account: a.principal?.userDetails?.userPrincipalName || a.principal?.servicePrincipalDetails?.aadAppId || a.principal?.groupDetails?.email || null,
    type: a.principal?.type, role: a.role, canPlan: PLAN_ROLES.includes(a.role),
  })).sort((a, b) => Number(b.canPlan) - Number(a.canPlan) || String(a.name).localeCompare(String(b.name)));
  return { workspace: p.workspace.name, canList: true, members };
}

/** Give a planner (or the account saved in a shared connection) Contributor access to the project workspace. */
export async function addPlanner({ email, role = 'Contributor' } = {}) {
  const p = requireModel();
  const e = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw Object.assign(new Error('Enter the person\'s email address (their Microsoft Entra sign-in).'), { status: 400 });
  if (!PLAN_ROLES.includes(role) || role === 'Admin') throw Object.assign(new Error('Planners get Contributor or Member.'), { status: 400 });
  const r = await setWorkspaceUser(p.workspace.id, e, role);
  logActivity('planning.access', `${e} ${r.added ? 'added to' : 'given'} ${role} in ${p.workspace.name} (can plan)`, { workspaceId: p.workspace.id });
  return { ...(await planAccess()), added: e };
}

/**
 * Create (or check) the Fabric plan item.
 * Fabric keeps a plan's semantic model and connection once the plan exists – later definition updates don't change
 * them. So a plan that points to a model that no longer exists, or that still uses a shared connection, is recreated
 * (only while it has no sheets, so no planner's work is lost).
 * Plans connect to the semantic model with the planner's own sign-in: in a planning sheet, Data › Add › the model ›
 * Connect. Microsoft deprecated the shared cloud connection flow for planning (it reads the model as the connection's
 * saved account and fails with SM_CONN_0001/0003 when that check fails), so the studio never binds one any more.
 * connection: undefined keeps the plan as it is; 'fabric' (or a connection ID, from older callers) recreates a plan that
 * uses a shared connection without one.
 */
export async function runPlanItem(ctx, { name, connection } = {}) {
  const p = requireModel();
  const ws = p.workspace;
  if (!p.planning) throw new Error('Build the plan first – the plan item uses its Budget and Forecast measures.');
  const itemName = F.itemName('Plan', itemNameFor('Plan', { name, current: p.planning.planItem?.name, purpose: 'Budget' }), 'Plan');
  ctx.step('Check the plan and the semantic model connections');
  const conns = (await F.listConnections().catch(() => [])).filter((c) => c.type === 'PowerBIDatasets' && c.connectivityType === 'ShareableCloud');
  if (connection && connection !== 'fabric') {
    ctx.log('Shared cloud connections are deprecated for planning: the plan connects with the planner\'s own sign-in instead');
    connection = 'fabric';
  }
  ctx.progress(25);

  let item = p.planning.planItem?.id ? await F.getItem(ws.id, p.planning.planItem.id).catch(() => null) : null;
  item ||= await F.findItem(ws.id, 'Plan', itemName);
  let existing = null;
  if (item) {
    // Never decide to delete or recreate a plan without reading its definition (and sheet count) first.
    let cur;
    try { cur = await F.getDefinition(ws.id, item.id); } catch (e) { throw new Error(`Couldn't read the plan "${item.displayName}" in Fabric (${e.message}). Nothing was changed – try again in a moment.`); }
    const json = cur?.parts?.find((x) => x.path === 'definition.json');
    if (!json) throw new Error(`The plan "${item.displayName}" has no readable definition, so the studio left it unchanged. Open it in Fabric to check it.`);
    existing = JSON.parse(Buffer.from(json.payload, 'base64').toString('utf8'));
  }
  const ref = existing?.semanticModelReference || null;
  const stale = Boolean(ref?.semanticModelId && (ref.semanticModelId !== p.semanticModel.id || ref.semanticModelWorkspaceId !== ws.id));
  const wanted = connection === undefined ? undefined : connection === 'fabric' ? null : connection;
  const changeConn = wanted !== undefined && (wanted || null) !== (ref?.connectionId || null);

  if (item && (stale || changeConn)) {
    const why = stale ? `it points to "${ref.semanticModelName}" (${ref.semanticModelWorkspaceName}), which is not the project's model any more` : 'Fabric keeps a plan\'s connection once the plan exists';
    const sheets = existing?.sheets?.length || 0;
    if (sheets) {
      throw new Error(`The plan "${item.displayName}" has ${sheets} sheet${sheets === 1 ? '' : 's'}, so the studio won't recreate it (${why}). In the plan, open a planning sheet and use Data › Add to connect ${p.semanticModel.name} with your own sign-in.`);
    }
    ctx.log(`Recreating the plan: ${why}. It has no sheets yet, so nothing is lost.`);
    await F.deleteItem(ws.id, item.id).catch((e) => { if (e.status !== 404) throw e; });
    updateProject({ planning: { ...getProject().planning, planItem: null } });
    item = null;
  }

  const connId = item ? ref?.connectionId || null : wanted ?? null;
  const conn = connId ? conns.find((c) => c.id === connId) || { id: connId, name: 'the connection chosen in Fabric' } : null;
  let boundModel = item ? ref?.semanticModelId || null : null;
  let finalName = item?.displayName || itemName;
  if (!item) {
    ctx.step(`Create the plan "${itemName}"`);
    const def = (n) => ({
      $schema: PLAN_SCHEMA_URL, workloadItemName: n, sheets: [], cube: { partitionRefIds: [] },
      ...(conn ? { semanticModelReference: { connectionId: conn.id, semanticModelId: p.semanticModel.id, semanticModelName: p.semanticModel.name, semanticModelWorkspaceId: ws.id, semanticModelWorkspaceName: ws.name, directLakeMode: false, directQueryMode: false, sourceType: 'WORKLOAD' } } : {}),
    });
    const create = (n) => F.createItem(ws.id, { name: n, type: 'Plan', description: `Budget and forecast planning on ${p.semanticModel.name}, prepared by Fabric MCP Studio.`, definition: F.toParts({ 'definition.json': def(n) }) });
    const nameTaken = (e) => e.status === 409 || /already in use|not available yet|NameAlreadyInUse|NotAvailableYet/i.test(e.message);
    for (let attempt = 1; ; attempt++) {
      try { item = await create(finalName); break; } catch (e) {
        if (!nameTaken(e) || attempt >= 8) throw e;
        // A deleted plan's name is released a few minutes later: wait a little, then use the next free name.
        if (attempt < 3) { ctx.log(`Waiting for Fabric to release the name "${finalName}"…`); await sleep(15000); } else finalName = F.itemName('Plan', numberedName(itemName, attempt - 1), 'Plan');
      }
    }
    if (finalName !== itemName) ctx.log(`Fabric hasn't released "${itemName}" yet, so the plan is called "${finalName}"`);
    recordArtifact({ type: 'Plan', id: item.id, name: finalName, workspaceId: ws.id, url: planItemUrl(ws.id, item.id) });
    boundModel = conn ? p.semanticModel.id : null;
    ctx.log(`Planners connect it to ${p.semanticModel.name} with their own sign-in: New Planning Sheet › Data › Add › ${p.semanticModel.name} › Connect (no shared connection)`);
    ctx.log('Fabric keeps the plan\'s settings in a shared SQL database in the workspace (__fabric_plan_sys)');
  } else {
    ctx.log(conn ? `The plan still uses the shared connection "${conn.name}", which Microsoft deprecated for planning – select Recreate without a connection` : `Planners connect it to ${p.semanticModel.name} with their own sign-in (planning sheet › Data › Add)`);
  }
  ctx.progress(90);
  const planItem = { id: item.id, name: finalName, url: planItemUrl(ws.id, item.id), semanticModelId: boundModel, connected: Boolean(conn), connectionId: conn?.id || null, connectionName: conn?.name || null, createdAt: item.id === p.planning.planItem?.id ? p.planning.planItem.createdAt : new Date().toISOString() };
  updateProject({ planning: { ...getProject().planning, planItem } });
  logActivity('planning.item', `Plan item "${finalName}" ${conn ? `still uses the deprecated shared connection "${conn.name}"` : `ready – planners connect ${p.semanticModel.name} with their own sign-in`}`, {});
  return planItem;
}

/** Plan vs actual for the plan year, overall and by the first planned dimension (UI KPIs and Copilot). */
export async function planSummary() {
  const p = requireModel();
  const pl = p.planning;
  if (!pl?.spec) throw new Error('Build the plan first (Planning tab).');
  const n = pl.spec.names;
  const yearFilter = `${cRef(pl.spec.dateYear.table, pl.spec.dateYear.column)} = ${pl.planYear}`;
  const ms = `"Budget", ${mRef(n.budget)}, "Forecast", ${mRef(n.forecast)}, "Actual", ${mRef(n.actual)}, "BudgetToDate", ${mRef(n.budgetToDate)}, "Variance", ${mRef(n.variance)}, "VariancePct", ${mRef(n.variancePct)}`;
  const [total] = await dax(p.workspace.id, p.semanticModel.id, `EVALUATE CALCULATETABLE ( ROW ( ${ms} ), ${yearFilter} )`);
  const d1 = pl.spec.dims[0];
  const by = d1 ? await dax(p.workspace.id, p.semanticModel.id, `EVALUATE CALCULATETABLE ( SUMMARIZECOLUMNS ( ${cRef(d1.table, d1.label)}, ${ms} ), ${yearFilter} ) ORDER BY [Budget] DESC`) : [];
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const row = (r) => ({ budget: num(r.Budget), forecast: num(r.Forecast), actual: num(r.Actual), budgetToDate: num(r.BudgetToDate), variance: num(r.Variance), variancePct: num(r.VariancePct) });
  return { planYear: pl.planYear, measure: pl.measure.name, dimension: d1?.labelText || null, total: row(total || {}), members: by.map((r) => ({ name: r[d1.label], ...row(r) })) };
}

/** Take the plan out of the model (and optionally delete its data and the plan item). */
export async function removePlan({ deleteData = false, deleteItem = false } = {}) {
  const p = requireModel();
  const pl = p.planning;
  if (!pl) return { ok: true };
  if (pl.spec) {
    const files = applyPlanToModel(await readModelFiles(p), pl.spec, { remove: true });
    await F.updateDefinition(p.workspace.id, p.semanticModel.id, F.toParts(files));
    await refreshDataset(p.workspace.id, p.semanticModel.id).catch(() => {});
  }
  if (deleteData) await dropPlanTable(await planTarget(p)).catch(() => {});
  if (deleteItem && pl.planItem?.id) await F.deleteItem(p.workspace.id, pl.planItem.id).catch(() => {});
  updateProject({ planning: null, ...(deleteData ? { planStore: null } : {}) });
  setStep('planning', 'todo', '');
  resetProfileCache();
  logActivity('planning.remove', `Plan ${pl.planYear} removed from ${p.semanticModel.name}`, {});
  return { ok: true };
}
