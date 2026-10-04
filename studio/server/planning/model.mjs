// Semantic model patch for planning: adds (or removes) a Direct Lake "Plan" table over the plan values written next to
// the data, related to the date table and the planned dimensions, with budget, forecast and variance measures.
// Works on a TMDL files map ({ path: text }) so it applies to generated models and to models read back from Fabric.
import { stableUuid } from '../config.mjs';
import { quoteName } from '../generators/tmdl.mjs';

const T = '\t';
const TABLE_FILE = /^definition\/tables\/.+\.tmdl$/;
const lf = (s) => String(s).replace(/\r\n/g, '\n');
const unq = (s) => { const t = String(s || '').trim(); return /^'.*'$/.test(t) ? t.slice(1, -1).replace(/''/g, "'") : t; };
const fileSafe = (name) => String(name).replace(/[\\/:*?"<>|]/g, '_');
const tRef = (t) => `'${String(t).replace(/'/g, "''")}'`;
const cRef = (t, c) => `${tRef(t)}[${String(c).replace(/]/g, ']]')}]`;
const mRef = (m) => `[${String(m).replace(/]/g, ']]')}]`;

/** Measure names the plan table adds (renamed when the model already uses a name). */
export function planMeasureNames(existing = []) {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const pick = (n) => (taken.has(n.toLowerCase()) ? `Plan ${n}` : n);
  return {
    actual: pick('Actual'), budget: pick('Budget'), forecast: pick('Forecast'), budgetToDate: pick('Budget to Date'),
    variance: pick('Variance to Budget'), variancePct: pick('Variance to Budget %'), attainment: pick('Budget Attainment %'),
    fcVsBudget: pick('Forecast vs Budget'), fcVsBudgetPct: pick('Forecast vs Budget %'),
  };
}

const tableNameOf = (text) => unq((lf(text).match(/^table (.+)$/m) || [])[1]);
const refTable = (ref) => { const r = String(ref).trim(); return r.startsWith("'") ? unq(r.slice(0, r.lastIndexOf("'.") + 1)) : r.split('.')[0]; };

/**
 * Apply the plan table to a model definition.
 * plan: { modelTable, source: { schema, table }, columns: [{ name, tom }], date: { table, key, column },
 *         dims: [{ table, key, column }], measure: { name, label, formatString }, names (planMeasureNames), description }
 * remove: true takes the plan table, its relationships and refs out again.
 */
export function applyPlanToModel(input, plan, { remove = false } = {}) {
  const files = {};
  for (const [k, v] of Object.entries(input)) files[k] = typeof v === 'string' ? lf(v) : v;
  const modelTable = plan.modelTable;
  const existingPath = Object.keys(files).find((k) => TABLE_FILE.test(k) && tableNameOf(files[k]) === modelTable);
  const tablePath = existingPath || `definition/tables/${fileSafe(modelTable)}.tmdl`;
  const exprSource = findExpressionSource(files, existingPath);
  if (existingPath) delete files[existingPath];

  // Relationships: drop every relationship touching the plan table, then add ours.
  const relFile = files['definition/relationships.tmdl'] || '';
  const rels = relFile.replace(/\n+$/, '').split(/\n(?=relationship )/).filter((b) => b.trim());
  const keep = rels.filter((b) => ![...b.matchAll(/(?:fromColumn|toColumn): (.+)/g)].some((m) => refTable(m[1]) === modelTable));

  let modelText = files['definition/model.tmdl'] || '';
  modelText = modelText.split('\n').filter((l) => !(l.startsWith('ref table ') && unq(l.slice(10)) === modelTable)).join('\n');

  if (!remove) {
    if (!exprSource) throw new Error('The semantic model has no Direct Lake source expression to add the plan table to.');
    files[tablePath] = planTableTmdl(plan, exprSource);
    const tag = (...p) => stableUuid('plan-rel', modelTable, ...p);
    keep.push([`relationship ${tag('date', plan.date.table, plan.date.key)}`, `${T}fromColumn: ${quoteName(modelTable)}.${quoteName(plan.date.column)}`, `${T}toColumn: ${quoteName(plan.date.table)}.${quoteName(plan.date.key)}`].join('\n'));
    for (const d of plan.dims) keep.push([`relationship ${tag('dim', d.table, d.key)}`, `${T}fromColumn: ${quoteName(modelTable)}.${quoteName(d.column)}`, `${T}toColumn: ${quoteName(d.table)}.${quoteName(d.key)}`].join('\n'));
    const lines = modelText.replace(/\n+$/, '').split('\n');
    const last = lines.map((l) => l.startsWith('ref table ')).lastIndexOf(true);
    lines.splice(last >= 0 ? last + 1 : lines.length, 0, `ref table ${quoteName(modelTable)}`);
    modelText = lines.join('\n');
  }
  files['definition/model.tmdl'] = `${modelText.replace(/\n+$/, '')}\n`;
  if (keep.length) files['definition/relationships.tmdl'] = `${keep.map((b) => b.replace(/\n+$/, '')).join('\n\n')}\n`;
  else delete files['definition/relationships.tmdl'];
  return files;
}

/** The Direct Lake expression the model's tables use (ignoring the plan table itself). */
export function findExpressionSource(files, skipPath = null) {
  for (const [k, v] of Object.entries(files)) {
    if (!TABLE_FILE.test(k) || k === skipPath) continue;
    const m = lf(v).match(/\n\t\t\texpressionSource: (.+)/);
    if (m) return m[1].trim();
  }
  const e = lf(files['definition/expressions.tmdl'] || '').match(/^expression (.+?) =/m);
  return e ? quoteName(unq(e[1])) : null;
}

function planTableTmdl(plan, exprSource) {
  const tn = plan.modelTable;
  const tag = (...p) => stableUuid('plan', tn, ...p);
  const n = plan.names;
  const fmt = plan.measure.formatString || '#,0';
  const pct = '0.0%;-0.0%;0.0%';
  const amount = cRef(tn, 'Amount');
  const scen = cRef(tn, 'Scenario');
  const closed = cRef(tn, 'ClosedPeriod');
  const measures = [
    [n.actual, mRef(plan.measure.name), fmt, `Actual ${plan.measure.label || plan.measure.name} (same as ${plan.measure.name}).`],
    [n.budget, `CALCULATE ( SUM ( ${amount} ), KEEPFILTERS ( ${scen} = "Budget" ) )`, fmt, 'Budget for the plan year, by month.'],
    [n.forecast, `CALCULATE ( SUM ( ${amount} ), KEEPFILTERS ( ${scen} = "Forecast" ) )`, fmt, 'Latest forecast: actuals for closed months, projection for the rest of the year.'],
    [n.budgetToDate, `CALCULATE ( ${mRef(n.budget)}, KEEPFILTERS ( ${closed} = TRUE () ) )`, fmt, 'Budget for the months that already have actuals.'],
    [n.variance, `IF ( NOT ISBLANK ( ${mRef(n.budgetToDate)} ), ${mRef(n.actual)} - ${mRef(n.budgetToDate)} )`, fmt, 'Actual minus budget for the months that have actuals. Positive is ahead of plan.'],
    [n.variancePct, `DIVIDE ( ${mRef(n.variance)}, ${mRef(n.budgetToDate)} )`, pct, 'Variance to budget as a share of the budget to date.'],
    [n.attainment, `DIVIDE ( ${mRef(n.actual)}, ${mRef(n.budget)} )`, pct, 'Actual as a share of the full-year budget.'],
    [n.fcVsBudget, `${mRef(n.forecast)} - ${mRef(n.budget)}`, fmt, 'Forecast minus budget: the expected gap at year end.'],
    [n.fcVsBudgetPct, `DIVIDE ( ${mRef(n.fcVsBudget)}, ${mRef(n.budget)} )`, pct, 'Forecast versus budget as a share of the budget.'],
  ];
  const lines = [`/// ${String(plan.description || 'Budget and forecast written by Fabric MCP Studio.').replace(/[\r\n]+/g, ' ')}`, `table ${quoteName(tn)}`, `${T}lineageTag: ${tag('table')}`, ''];
  for (const [name, expr, f, desc] of measures) {
    lines.push(`${T}/// ${desc}`, `${T}measure ${quoteName(name)} = ${expr}`, `${T}${T}formatString: ${f}`, `${T}${T}displayFolder: Plan`, `${T}${T}lineageTag: ${tag('measure', name)}`, '');
  }
  for (const c of plan.columns) {
    lines.push(`${T}column ${quoteName(c.name)}`, `${T}${T}dataType: ${c.tom}`);
    if (c.name !== 'Scenario') lines.push(`${T}${T}isHidden`);
    if (c.tom === 'int64') lines.push(`${T}${T}formatString: 0`);
    if (c.tom === 'dateTime') lines.push(`${T}${T}formatString: General Date`);
    lines.push(`${T}${T}lineageTag: ${tag('column', c.name)}`, `${T}${T}summarizeBy: none`, `${T}${T}sourceColumn: ${c.name}`, '', `${T}${T}annotation SummarizationSetBy = Automatic`, '');
  }
  lines.push(`${T}partition ${quoteName(tn)} = entity`, `${T}${T}mode: directLake`, `${T}${T}source`, `${T}${T}${T}entityName: ${plan.source.table}`, `${T}${T}${T}schemaName: ${plan.source.schema}`, `${T}${T}${T}expressionSource: ${exprSource}`, '');
  return lines.join('\n');
}

/** DAX that totals the plan for a year (used to verify the model after deployment). */
export function planCheckQuery(plan, year) {
  const n = plan.names;
  return `EVALUATE CALCULATETABLE ( ROW ( "budget", ${mRef(n.budget)}, "forecast", ${mRef(n.forecast)}, "actual", ${mRef(n.actual)}, "variance", ${mRef(n.variance)}, "budgetToDate", ${mRef(n.budgetToDate)} ), ${cRef(plan.dateYear.table, plan.dateYear.column)} = ${Number(year)} )`;
}
