// Planning: budgets and forecasts on the project's semantic model, ready for Fabric planning (Fabric IQ).
// The studio derives a budget and a rolling forecast from the actuals, writes them next to the data, adds a "Plan" table
// with variance measures to the model, and creates the Fabric plan item where planners refine the numbers.
import * as F from '../fabric.mjs';
import { getProject, updateProject, setStep, recordArtifact, logActivity, fabricUrl } from '../project.mjs';
import { dax, refreshDataset } from '../powerbi.mjs';
import { currentProfile, resetProfileCache } from '../reports/index.mjs';
import { previewPlan, typesOf, monthName, RUN_RATE } from './design.mjs';
import { applyPlanToModel, planMeasureNames, planCheckQuery } from './model.mjs';
import { planTarget, writePlanRows, waitForPlanRows, dropPlanTable, PLAN_SCHEMA, PLAN_TABLE } from './store.mjs';

export { isPlanTable } from './store.mjs';
export const MODEL_TABLE = 'Plan';
export const planItemUrl = (ws, id) => `https://app.fabric.microsoft.com/groups/${ws}/plans/${id}`;
const PLAN_SCHEMA_URL = 'https://developer.microsoft.com/json-schemas/fabric/item/plan/definition/Definition/1.0.0/schema.json';
const tRef = (t) => `'${String(t).replace(/'/g, "''")}'`;
const cRef = (t, c) => `${tRef(t)}[${String(c).replace(/]/g, ']]')}]`;
const mRef = (m) => `[${String(m).replace(/]/g, ']]')}]`;

function requireModel() {
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  if (!p.semanticModel?.id) throw new Error('Create the semantic model first – the plan is built on it.');
  return p;
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
  return {
    available: Boolean(p.workspace && p.semanticModel),
    writable: ['SQLDatabase', 'Warehouse'].includes(ms?.itemType),
    source: ms ? { type: ms.itemType, name: ms.itemName } : null,
    plan: pl,
    links: pl && p.workspace ? {
      planItem: pl.planItem ? planItemUrl(p.workspace.id, pl.planItem.id) : null,
      model: fabricUrl('SemanticModel', p.workspace.id, p.semanticModel?.id),
      newPlan: `https://app.fabric.microsoft.com/groups/${p.workspace.id}/list`,
    } : null,
    runRate: RUN_RATE,
  };
}

/** Preview a plan (no writes): defaults, totals, months and members. */
export async function planPreview(opts = {}) {
  const p = requireModel();
  const profile = await currentProfile().catch(() => null);
  const out = await previewPlan(p.workspace.id, p.semanticModel.id, opts, { profile });
  const { rows, ...rest } = out;
  return { ...rest, rows: rows.length };
}

/** Columns of the plan table and how it relates to the model. */
function planSpec(design, names) {
  const used = new Set(['scenario', 'planyear', 'monthnumber', 'periodstart', 'amount', 'closedperiod', 'updatedat']);
  const uniq = (n) => { let x = String(n).replace(/[^A-Za-z0-9_]/g, '') || 'Key'; let i = 2; while (used.has(x.toLowerCase())) x = `${n}${i++}`; used.add(x.toLowerCase()); return x; };
  const dt = typesOf(design.date.keyType);
  const keyCols = [{ name: uniq(design.date.key), ...dt }, ...design.dims.map((d) => ({ name: uniq(d.key), ...typesOf(d.keyType) }))];
  return {
    modelTable: MODEL_TABLE,
    source: { schema: PLAN_SCHEMA, table: PLAN_TABLE },
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
  const ws = p.workspace;
  const target = await planTarget(p);

  ctx.step('Read the model and the actuals');
  const profile = await currentProfile().catch(() => null);
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
  const spec = planSpec(d, planMeasureNames(existing));

  ctx.step(`Write ${pv.rows.length} plan rows to ${target.label}`);
  const date = d.date;
  const mk = await dax(ws.id, p.semanticModel.id, `EVALUATE SUMMARIZECOLUMNS ( ${cRef(date.table, date.month)}, FILTER ( ALL ( ${cRef(date.table, date.year)} ), ${cRef(date.table, date.year)} = ${d.planYear} ), "k", MIN ( ${cRef(date.table, date.key)} )${date.column ? `, "d", MIN ( ${cRef(date.table, date.column)} )` : ''} )`);
  const monthKeys = new Map(mk.map((r) => [Number(r[date.month]), { key: r.k, date: r.d || `${d.planYear}-${String(r[date.month]).padStart(2, '0')}-01` }]));
  const missing = [...new Set(pv.rows.map((r) => r.month))].filter((m) => !monthKeys.has(m));
  if (missing.length) throw new Error(`The date table has no ${missing.map(monthName).join(', ')} ${d.planYear}.`);
  const keyCols = spec.keyCols.map((c) => ({ name: c.name, sql: c.sql }));
  await writePlanRows(ctx, target, { planYear: d.planYear, rows: pv.rows, monthKeys, keyCols });
  ctx.log(`${pv.rows.length} rows in ${PLAN_SCHEMA}.${PLAN_TABLE} (Budget and Forecast for ${d.planYear})`);
  ctx.progress(40);

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
    measure: d.measure, date: d.date, dims: spec.dims, planYear: d.planYear, baseYear: d.baseYear, asOfMonth: d.asOfMonth, growthPct: d.growthPct, overrides: d.overrides,
    target: { kind: target.kind, label: target.label, table: `${PLAN_SCHEMA}.${PLAN_TABLE}` },
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

/**
 * Create (or update) the Fabric plan item. When a Power BI semantic model connection (shared cloud connection) exists,
 * the plan is connected to the model right away; otherwise Fabric asks for the connection when the plan opens.
 */
export async function runPlanItem(ctx, { name } = {}) {
  const p = requireModel();
  const ws = p.workspace;
  if (!p.planning) throw new Error('Build the plan first – the plan item uses its Budget and Forecast measures.');
  const itemName = F.itemName('Plan', name || p.planning.planItem?.name || `${p.semanticModel.name}_Plan`, 'Plan');
  ctx.step('Look for a semantic model connection');
  const conns = (await F.listConnections().catch(() => [])).filter((c) => c.type === 'PowerBIDatasets' && c.connectivityType === 'ShareableCloud');
  const conn = conns[0] || null;
  ctx.log(conn ? `Using the connection "${conn.name}"` : 'No shared semantic model connection yet – you choose or create one when the plan opens');
  ctx.progress(25);

  const def = {
    $schema: PLAN_SCHEMA_URL, workloadItemName: itemName, sheets: [], cube: { partitionRefIds: [] },
    ...(conn ? { semanticModelReference: { connectionId: conn.id, semanticModelId: p.semanticModel.id, semanticModelName: p.semanticModel.name, semanticModelWorkspaceId: ws.id, semanticModelWorkspaceName: ws.name, directLakeMode: false, directQueryMode: false, sourceType: 'WORKLOAD' } } : {}),
  };
  ctx.step(`${p.planning.planItem ? 'Update' : 'Create'} the plan "${itemName}"`);
  let item = p.planning.planItem?.id ? await F.getItem(ws.id, p.planning.planItem.id).catch(() => null) : null;
  item ||= await F.findItem(ws.id, 'Plan', itemName);
  if (item) {
    const cur = await F.getDefinition(ws.id, item.id).catch(() => null);
    const json = cur?.parts?.find((x) => x.path === 'definition.json');
    const existing = json ? JSON.parse(Buffer.from(json.payload, 'base64').toString('utf8')) : null;
    if (conn && existing?.semanticModelReference?.semanticModelId !== p.semanticModel.id) {
      await F.updateDefinition(ws.id, item.id, F.toParts({ 'definition.json': { ...(existing || {}), ...def, sheets: existing?.sheets || [] } }));
      ctx.log(`Connected the plan to ${p.semanticModel.name}`);
    } else ctx.log('The plan already exists');
  } else {
    item = await F.createItem(ws.id, { name: itemName, type: 'Plan', description: `Budget and forecast planning on ${p.semanticModel.name}, prepared by Fabric MCP Studio.`, definition: F.toParts({ 'definition.json': def }) });
    recordArtifact({ type: 'Plan', id: item.id, name: itemName, workspaceId: ws.id, url: planItemUrl(ws.id, item.id) });
    ctx.log('Fabric also keeps the plan\'s settings in a shared SQL database in the workspace (__fabric_plan_sys)');
  }
  const planItem = { id: item.id, name: itemName, url: planItemUrl(ws.id, item.id), connected: Boolean(conn), connectionName: conn?.name || null, createdAt: p.planning.planItem?.createdAt || new Date().toISOString() };
  updateProject({ planning: { ...getProject().planning, planItem } });
  logActivity('planning.item', `Plan item "${itemName}" ${conn ? `connected to ${p.semanticModel.name}` : 'created'}`, {});
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
  updateProject({ planning: null });
  setStep('planning', 'todo', '');
  resetProfileCache();
  logActivity('planning.remove', `Plan ${pl.planYear} removed from ${p.semanticModel.name}`, {});
  return { ok: true };
}
