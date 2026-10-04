// Plan design and calculation: reads the semantic model (measure, date table, dimensions) and the actuals with DAX,
// proposes sensible defaults (plan year, base year, growth, forecast cut-off) and computes budget and forecast rows by
// month and dimension members. Pure calculation – nothing is written here.
import { dax, modelMetadata } from '../powerbi.mjs';
import { dateInfo, isPercent, columnLabel } from '../reports/profile.mjs';

const tRef = (t) => `'${String(t).replace(/'/g, "''")}'`;
const cRef = (t, c) => `${tRef(t)}[${String(c).replace(/]/g, ']]')}]`;
const mRef = (m) => `[${String(m).replace(/]/g, ']]')}]`;
const round2 = (n) => Math.round(n * 100) / 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthName = (m) => MONTHS[m - 1] || '';
export const RUN_RATE = { min: 0.8, max: 1.25 };
const MAX_MEMBERS = 300;
const MAX_COMBOS = 3000;

/** TOM / SQL types for a model column data type (INFO.VIEW.COLUMNS DataType). */
export function typesOf(dataType) {
  const t = String(dataType || '').toLowerCase();
  if (/int|whole/.test(t)) return { tom: 'int64', sql: 'bigint', kind: 'number' };
  if (/date/.test(t)) return { tom: 'dateTime', sql: 'date', kind: 'date' };
  if (/bool/.test(t)) return { tom: 'boolean', sql: 'bit', kind: 'bool' };
  if (/decimal|double|number|currency/.test(t)) return { tom: 'double', sql: 'float', kind: 'number' };
  return { tom: 'string', sql: 'nvarchar(400)', kind: 'text' };
}

/** All columns (including hidden keys) of some tables, with their data types. */
async function columnsOf(ws, sm, tables) {
  if (!tables.length) return [];
  const list = tables.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(', ');
  const rows = await dax(ws, sm, `EVALUATE SELECTCOLUMNS ( FILTER ( INFO.VIEW.COLUMNS (), [Table] IN { ${list} } ), "Table", [Table], "Name", [Name], "DataType", [DataType], "IsHidden", [IsHidden] )`);
  return rows.map((r) => ({ table: r.Table, name: r.Name, dataType: r.DataType, hidden: Boolean(r.IsHidden) }));
}

/**
 * What can be planned in the model: measures, the date table (with month and key), and dimension tables reachable
 * from the measures' tables (key + a readable label column).
 */
export async function planningModel(ws, sm) {
  const meta = await modelMetadata(ws, sm);
  const date = dateInfo(meta);
  const measures = meta.measures.filter((m) => m.table !== 'Plan' && !isPercent(m) && !/(\bPY\b|prior|last year|YoY|growth|variance|ytd|average|avg|count|margin %)/i.test(m.name))
    .map((m) => ({ table: m.table, name: m.name, formatString: m.formatString, label: m.name }));
  if (!date?.year || !date?.monthNum) {
    return { meta, date: null, measures, dims: [], issue: 'Planning needs a date table with a year and a month number column, related to your facts.' };
  }
  const dateRel = meta.relationships.filter((r) => r.active && r.toTable === date.table);
  const dateKey = dateRel[0]?.toColumn;
  if (!dateKey) return { meta, date: null, measures, dims: [], issue: `The date table ${date.table} isn't related to any fact table.` };
  const oneSide = [...new Set(meta.relationships.filter((r) => r.active && r.toTable !== date.table).map((r) => r.toTable))];
  const cols = await columnsOf(ws, sm, [date.table, ...oneSide]);
  const keyType = (table, name) => cols.find((c) => c.table === table && c.name === name)?.dataType;
  const dims = [];
  for (const table of oneSide) {
    const key = meta.relationships.find((r) => r.active && r.toTable === table)?.toColumn;
    const text = meta.columns.filter((c) => c.table === table && c.dataType === 'Text' && !/(key|id|code|alternate|description|phone|email|address|url|image)/i.test(c.name) && !/^(spanish|french|german|chinese|arabic|hebrew|thai|japanese|turkish)/i.test(c.name));
    if (!key || !text.length) continue;
    dims.push({ table, key, keyType: keyType(table, key) || 'Integer', columns: text.map((c) => ({ name: c.name, label: columnLabel(c.name) })) });
  }
  return {
    meta, measures, dims,
    date: { table: date.table, year: date.year.name, month: date.monthNum.name, monthName: date.monthName?.sortBy ? date.monthName.name : null, key: dateKey, keyType: keyType(date.table, dateKey) || 'Integer', column: date.date?.name || null },
  };
}

/** Pick the most readable label column of a dimension: the most detailed text column (one value per key, if any). */
async function labelColumn(ws, sm, dim) {
  const cols = dim.columns.slice(0, 20);
  const row = (await dax(ws, sm, `EVALUATE ROW ( "k", COUNTROWS ( VALUES ( ${cRef(dim.table, dim.key)} ) ), ${cols.map((c, i) => `"c${i}", COUNTROWS ( VALUES ( ${cRef(dim.table, c.name)} ) )`).join(', ')} )`))[0] || {};
  const k = Number(row.k) || 0;
  const scored = cols.map((c, i) => ({ ...c, n: Number(row[`c${i}`]) || 0 })).filter((c) => c.n > 1);
  const pref = (c) => (/name$|region|territory|category|segment|country|store|channel/i.test(c.name) ? 1 : 0);
  scored.sort((a, b) => (Math.abs(k - a.n) - Math.abs(k - b.n)) || (pref(b) - pref(a)));
  return { keys: k, label: scored[0] || cols[0] };
}

/**
 * Resolve a plan design from the user's choices and the model, and read what the defaults need.
 * opts: { measure, dims: [table], planYear, asOfMonth, growthPct, overrides: [{ key, growthPct }] }
 */
export async function resolveDesign(ws, sm, opts = {}, { profile } = {}) {
  const pm = await planningModel(ws, sm);
  if (pm.issue) throw new Error(pm.issue);
  const measure = pm.measures.find((m) => m.name === opts.measure) || pm.measures.find((m) => m.name === profile?.primary?.name) || pm.measures[0];
  if (!measure) throw new Error('The semantic model has no measure to plan. Add a sales or amount measure first.');
  // Default dimensions: the ones the report profile found (share + breakdown), else the first two.
  const wanted = (opts.dims?.length ? opts.dims : [profile?.share?.table, profile?.breakdown?.table].filter(Boolean)).filter((t, i, a) => a.indexOf(t) === i);
  let dims = wanted.map((t) => pm.dims.find((d) => d.table === t)).filter(Boolean).slice(0, 2);
  if (!dims.length) dims = pm.dims.slice(0, 1);
  const out = [];
  for (const d of dims) {
    const { keys, label } = await labelColumn(ws, sm, d);
    if (keys > MAX_MEMBERS) throw new Error(`${d.table} has ${keys} members – too detailed to plan. Pick a higher-level dimension (for example a region or category).`);
    out.push({ table: d.table, key: d.key, keyType: d.keyType, label: label.name, labelText: columnLabel(label.name), members: keys });
  }
  return { pm, measure, date: pm.date, dims: out, opts };
}

/** Actuals by year, month and dimension keys (one DAX query), for the years asked. */
async function actuals(ws, sm, design, years) {
  const d = design.date;
  const groups = [cRef(d.table, d.year), cRef(d.table, d.month), ...design.dims.map((x) => cRef(x.table, x.key))].join(', ');
  const yearFilter = `FILTER ( ALL ( ${cRef(d.table, d.year)} ), ${cRef(d.table, d.year)} IN { ${years.join(', ')} } )`;
  const rows = await dax(ws, sm, `EVALUATE SUMMARIZECOLUMNS ( ${groups}, ${yearFilter}, "v", ${mRef(design.measure.name)} )`);
  return rows.map((r) => ({ year: Number(r[d.year]), month: Number(r[d.month]), keys: design.dims.map((x) => r[x.key]), v: Number(r.v) || 0 })).filter((r) => r.v && r.keys.every((k) => k !== null && k !== undefined && k !== ''));
}

/** Years with actuals and how many months each has; which years the date table covers. */
async function yearsInfo(ws, sm, design) {
  const d = design.date;
  const rows = await dax(ws, sm, `EVALUATE SUMMARIZECOLUMNS ( ${cRef(d.table, d.year)}, ${cRef(d.table, d.month)}, "v", ${mRef(design.measure.name)} )`);
  const byYear = new Map();
  for (const r of rows) {
    const y = Number(r[d.year]);
    if (!byYear.has(y)) byYear.set(y, new Map());
    if (Number(r.v)) byYear.get(y).set(Number(r[d.month]), Number(r.v));
  }
  const cover = (await dax(ws, sm, `EVALUATE SUMMARIZECOLUMNS ( ${cRef(d.table, d.year)}, "n", COUNTROWS ( ${tRef(d.table)} ) )`)).map((r) => Number(r[d.year])).sort((a, b) => a - b);
  const years = [...byYear.keys()].sort((a, b) => a - b).map((y) => ({ year: y, months: [...byYear.get(y).keys()].sort((a, b) => a - b), total: [...byYear.get(y).values()].reduce((a, b) => a + b, 0), byMonth: byYear.get(y) }));
  return { years, covered: cover };
}

/** Default plan year, cut-off and growth from the actuals. */
export function defaults({ years, covered }) {
  const full = years.filter((y) => y.months.length === 12);
  const isFull = (y) => full.some((f) => f.year === y);
  const latest = years[years.length - 1];
  const prev = latest && years.find((y) => y.year === latest.year - 1);
  let planYear = null;
  let asOfMonth = 0;
  let reason = '';
  if (latest && latest.months.length < 12 && prev && isFull(prev.year)) {
    const same = latest.months.reduce((a, m) => a + (prev.byMonth.get(m) || 0), 0);
    const ratio = same ? latest.total / same : 0;
    if (ratio >= 0.5) {
      planYear = latest.year; asOfMonth = latest.months[latest.months.length - 1];
      reason = `${latest.year} is in progress (${latest.months.length} months of actuals): budget from ${prev.year}, forecast from ${monthName(asOfMonth)} on.`;
    }
  }
  if (!planYear && latest && isFull(latest.year) && covered.includes(latest.year + 1)) {
    planYear = latest.year + 1; asOfMonth = 0;
    reason = `${latest.year} is the last full year: budget ${planYear} from it. The forecast equals the budget until actuals arrive.`;
  }
  if (!planYear) {
    const candidates = full.filter((y) => isFull(y.year - 1));
    const pick = candidates[candidates.length - 1];
    if (pick) {
      planYear = pick.year; asOfMonth = 6;
      reason = `The latest data is incomplete, so the plan covers ${pick.year} (budget from ${pick.year - 1}) – every month has actuals to compare, with a mid-year forecast as of June.`;
    }
  }
  if (!planYear) return { planYear: null, reason: 'Planning needs at least one full year of actuals as the baseline.' };
  const base = years.find((y) => y.year === planYear - 1);
  const before = years.find((y) => y.year === planYear - 2);
  let growthPct = 5;
  if (base && before && isFull(before.year) && before.total) {
    growthPct = Math.round(Math.min(25, Math.max(-10, ((base.total - before.total) / before.total) * 100)));
  }
  const candidates = covered.filter((y) => isFull(y - 1));
  return { planYear, baseYear: planYear - 1, asOfMonth, growthPct, reason, candidates };
}

const comboKey = (keys) => keys.map((k) => String(k)).join('|');

/**
 * Budget and forecast rows for the plan year.
 * Budget = base-year actual × (1 + growth) per month and combination (growth per first-dimension member if overridden).
 * Forecast = actuals for months up to the cut-off; budget × run rate (actual ÷ budget so far, per first-dimension member,
 * kept between 0.8 and 1.25) for the rest.
 */
export function computePlan({ base, current, planYear, asOfMonth, growthPct, overrides = [] }) {
  const growth = new Map(overrides.filter((o) => o.growthPct !== '' && o.growthPct !== null && o.growthPct !== undefined && Number.isFinite(Number(o.growthPct))).map((o) => [String(o.key), Number(o.growthPct)]));
  const g = (keys) => 1 + (growth.has(String(keys[0])) ? growth.get(String(keys[0])) : Number(growthPct) || 0) / 100;
  const budget = new Map();
  for (const r of base) {
    const k = `${r.month}#${comboKey(r.keys)}`;
    budget.set(k, { month: r.month, keys: r.keys, v: round2(r.v * g(r.keys)) });
  }
  const actual = new Map(current.map((r) => [`${r.month}#${comboKey(r.keys)}`, r]));
  const lastActual = current.reduce((a, r) => Math.max(a, r.month), 0);
  const cut = Math.min(Number(asOfMonth) || 0, lastActual);
  // Run rate per first-dimension member, from the months up to the cut-off.
  const sums = new Map();
  const add = (m, key, field, v) => { const s = sums.get(key) || { a: 0, b: 0 }; s[field] += v; sums.set(key, s); };
  for (const b of budget.values()) if (b.month <= cut) add(b.month, String(b.keys[0]), 'b', b.v);
  for (const a of current) if (a.month <= cut) add(a.month, String(a.keys[0]), 'a', a.v);
  const all = [...sums.values()].reduce((x, s) => ({ a: x.a + s.a, b: x.b + s.b }), { a: 0, b: 0 });
  const overall = cut && all.b ? Math.min(RUN_RATE.max, Math.max(RUN_RATE.min, all.a / all.b)) : 1;
  const rate = (key) => { const s = sums.get(String(key)); return cut && s?.b ? Math.min(RUN_RATE.max, Math.max(RUN_RATE.min, s.a / s.b)) : overall; };
  const forecast = new Map();
  for (const [k, b] of budget) if (b.month > cut) forecast.set(k, { month: b.month, keys: b.keys, v: round2(b.v * rate(b.keys[0])) });
  for (const [k, a] of actual) if (a.month <= cut) forecast.set(k, { month: a.month, keys: a.keys, v: round2(a.v) });
  const closed = (m) => m <= lastActual;
  const rows = [
    ...[...budget.values()].map((r) => ({ scenario: 'Budget', ...r, closed: closed(r.month) })),
    ...[...forecast.values()].map((r) => ({ scenario: 'Forecast', ...r, closed: closed(r.month) })),
  ];
  if (rows.length > MAX_COMBOS * 2) throw new Error(`The plan would have ${rows.length} rows – pick higher-level dimensions.`);
  return { rows, lastActual, cut, runRate: overall, planYear };
}

/** Everything the UI and Copilot need to review a plan before it is written. */
export async function previewPlan(ws, sm, opts = {}, { profile } = {}) {
  const design = await resolveDesign(ws, sm, opts, { profile });
  const info = await yearsInfo(ws, sm, design);
  const def = defaults(info);
  const planYear = Number(opts.planYear) || def.planYear;
  if (!planYear) throw new Error(def.reason);
  const baseInfo = info.years.find((y) => y.year === planYear - 1);
  if (!baseInfo || baseInfo.months.length < 12) throw new Error(`${planYear - 1} doesn't have 12 months of actuals to base the ${planYear} budget on. Pick another plan year.`);
  if (!info.covered.includes(planYear)) throw new Error(`The date table has no dates in ${planYear}. Extend the date table, or pick an earlier plan year.`);
  const growthPct = opts.growthPct === undefined || opts.growthPct === null || opts.growthPct === '' ? def.growthPct : Number(opts.growthPct);
  const asOfMonth = opts.asOfMonth === undefined || opts.asOfMonth === null || opts.asOfMonth === '' ? (planYear === def.planYear ? def.asOfMonth : (info.years.find((y) => y.year === planYear)?.months.slice(-1)[0] || 0)) : Number(opts.asOfMonth);
  const rows = await actuals(ws, sm, design, [planYear - 1, planYear]);
  const base = rows.filter((r) => r.year === planYear - 1);
  const current = rows.filter((r) => r.year === planYear);
  const overrides = Array.isArray(opts.overrides) ? opts.overrides : [];
  const plan = computePlan({ base, current, planYear, asOfMonth, growthPct, overrides });

  // Members of the first dimension with names, for overrides and the summary table.
  const d1 = design.dims[0];
  const names = new Map();
  if (d1) {
    const m = await dax(ws, sm, `EVALUATE SUMMARIZECOLUMNS ( ${cRef(d1.table, d1.key)}, ${cRef(d1.table, d1.label)} )`);
    for (const r of m) names.set(String(r[d1.key]), r[d1.label]);
  }
  const sum = (list) => round2(list.reduce((a, r) => a + r.v, 0));
  const byMember = new Map();
  const bump = (key, field, v) => { const k = String(key); const x = byMember.get(k) || { key: k, name: names.get(k) ?? k, base: 0, budget: 0, actual: 0, forecast: 0 }; x[field] += v; byMember.set(k, x); };
  for (const r of base) bump(r.keys[0], 'base', r.v);
  for (const r of current) bump(r.keys[0], 'actual', r.v);
  for (const r of plan.rows) bump(r.keys[0], r.scenario === 'Budget' ? 'budget' : 'forecast', r.v);
  const months = Array.from({ length: 12 }, (_, i) => i + 1).map((m) => ({
    month: m, label: monthName(m),
    base: sum(base.filter((r) => r.month === m)), budget: sum(plan.rows.filter((r) => r.scenario === 'Budget' && r.month === m)),
    actual: sum(current.filter((r) => r.month === m)), forecast: sum(plan.rows.filter((r) => r.scenario === 'Forecast' && r.month === m)),
  }));
  const budgetToDate = sum(plan.rows.filter((r) => r.scenario === 'Budget' && r.closed));
  const actualToDate = sum(current);
  return {
    design: {
      measure: design.measure, date: design.date, dims: design.dims,
      planYear, baseYear: planYear - 1, asOfMonth: plan.cut, growthPct, overrides: overrides.filter((o) => names.has(String(o.key)) || !d1).map((o) => ({ key: String(o.key), name: names.get(String(o.key)) ?? String(o.key), growthPct: Number(o.growthPct) })),
    },
    defaults: def,
    availableYears: def.candidates || [],
    measures: design.pm.measures.map((m) => m.name),
    dimensions: design.pm.dims.map((d) => ({ table: d.table, key: d.key })),
    totals: {
      base: sum(base), budget: sum(plan.rows.filter((r) => r.scenario === 'Budget')), forecast: sum(plan.rows.filter((r) => r.scenario === 'Forecast')),
      actualToDate, budgetToDate, varianceToDate: round2(actualToDate - budgetToDate), variancePct: budgetToDate ? (actualToDate - budgetToDate) / budgetToDate : null,
      lastActualMonth: plan.lastActual, runRate: plan.runRate, rows: plan.rows.length,
    },
    months,
    members: [...byMember.values()].map((x) => ({ ...x, base: round2(x.base), budget: round2(x.budget), actual: round2(x.actual), forecast: round2(x.forecast), growthPct: overrides.find((o) => String(o.key) === x.key)?.growthPct ?? null })).sort((a, b) => b.budget - a.budget),
    rows: plan.rows,
  };
}
