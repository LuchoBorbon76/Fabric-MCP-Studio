// Business rules for the rules dashboard: each ontology rule (statement in plain English) with the measures that show
// it – from the sample preset, from model measures in a "Business rules" display folder, or matched by name. Measures
// missing from the semantic model become report-level measures in the generated report.
import { presetFor } from '../presets.mjs';
import { dax } from '../powerbi.mjs';

const words = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'rule', 'rules'].includes(w));
const humanRule = (name) => String(name).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/**
 * Rules for the dashboard: [{ name, label, statement, metrics: [{ ref, type, kind, extension }] }] and the report-level
 * measures to add ({ table, name, dataType, expression, formatString, displayFolder, description }).
 */
export function ruleSet(profile, project) {
  const preset = presetFor(project);
  const statements = new Map();
  for (const r of preset?.ontology?.rules || []) statements.set(r.name, r.statement);
  for (const r of project.ontology?.ruleDetails || []) statements.set(r.name, r.statement);
  const names = project.ontology?.rules?.length ? project.ontology.rules : [...statements.keys()];
  const inModel = new Map(profile.measures.map((m) => [`${m.table}|${m.name}`.toLowerCase(), m]));
  const presetMeasures = new Map((preset?.measures || []).map((m) => [`${m.table}|${m.name}`.toLowerCase(), m]));
  const extensions = [];
  const rules = [];
  const used = new Set();

  const metricFor = (spec) => {
    const key = `${spec.table}|${spec.name}`.toLowerCase();
    const existing = inModel.get(key);
    if (existing) { used.add(key); return { ref: { kind: 'measure', table: existing.table, name: existing.name, label: spec.label || existing.name }, type: spec.type, kind: spec.kind }; }
    if (!profile.tables?.includes(spec.table)) return null;
    const def = spec.expression ? spec : presetMeasures.get(key);
    if (!def?.expression) return null;
    extensions.push({ table: spec.table, name: spec.name, dataType: spec.dataType || (spec.type === 'amount' ? 'Decimal' : 'Integer'), expression: def.expression, formatString: spec.formatString || def.formatString || '#,0', displayFolder: 'Business rules', description: def.description || spec.label || '' });
    return { ref: { kind: 'measure', table: spec.table, name: spec.name, label: spec.label || spec.name, extension: true }, type: spec.type, kind: spec.kind };
  };

  for (const name of names) {
    const specs = preset?.ruleMetrics?.[name] || [];
    let metrics = specs.map(metricFor).filter(Boolean);
    if (!metrics.length) {
      // No preset mapping: a model measure in a "Business rules" folder, or one whose name shares the rule's key words.
      const w = words(name);
      const candidates = profile.measures.filter((m) => !used.has(`${m.table}|${m.name}`.toLowerCase()));
      const score = (m) => words(m.name).filter((x) => w.includes(x)).length + (/rule/i.test(m.displayFolder) ? 1 : 0);
      const best = candidates.map((m) => [m, score(m)]).filter(([, s]) => s >= 2).sort((a, b) => b[1] - a[1])[0];
      if (best) { used.add(`${best[0].table}|${best[0].name}`.toLowerCase()); metrics = [{ ref: best[0], type: best[0].percent ? 'ratio' : 'count', kind: 'violation' }]; }
    }
    rules.push({ name, label: humanRule(name), statement: statements.get(name) || '', metrics });
  }
  // Rule measures in the model that no ontology rule claimed (for example rules written only in the glossary).
  for (const m of profile.measures.filter((x) => /rule/i.test(x.displayFolder) && !used.has(`${x.table}|${x.name}`.toLowerCase()))) {
    rules.push({ name: m.name, label: m.name, statement: m.description || '', metrics: [{ ref: m, type: m.percent ? 'ratio' : 'count', kind: 'violation' }] });
  }
  return { rules: rules.filter((r) => r.metrics.length || r.statement), extensions, source: project.ontology?.name || (preset ? 'sample glossary' : 'semantic model') };
}

/** Current values of the rule measures (report-level ones defined inline), for recommendations and the UI. */
export async function ruleValues(workspaceId, datasetId, set) {
  const metrics = set.rules.flatMap((r) => r.metrics.map((m) => ({ rule: r.name, ...m })));
  if (!metrics.length) return [];
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const define = set.extensions.map((e) => `MEASURE ${q(e.table)}[${e.name.replace(/]/g, ']]')}] = ${e.expression}`).join('\n');
  const query = `${define ? `DEFINE\n${define}\n` : ''}EVALUATE ROW(${metrics.map((m, i) => `"v${i}", [${m.ref.name.replace(/]/g, ']]')}]`).join(', ')})`;
  const row = (await dax(workspaceId, datasetId, query))[0] || {};
  return metrics.map((m, i) => ({ rule: m.rule, label: m.ref.label, type: m.type, kind: m.kind, value: row[`v${i}`] ?? null }));
}
