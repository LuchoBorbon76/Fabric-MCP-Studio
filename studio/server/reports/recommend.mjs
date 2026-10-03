// Recommendations for the Reports & apps step: which reports to build, for whom, with which pages and theme, and why.
// Grounded in the model profile (KPIs, channels, time, segments, insights), the ontology and the reports already built.

function reasonsFor(profile, focus) {
  const r = [];
  const p = profile;
  const growth = p.insights.find((i) => i.kind === 'growth');
  const share = p.insights.find((i) => i.kind === 'share');
  const partial = p.insights.find((i) => i.kind === 'partial');
  if (focus === 'executive') {
    r.push(`${p.kpis.length} headline KPIs: ${p.kpis.map((k) => k.label).join(', ')}.`);
    if (growth) r.push(growth.text);
    if (p.channels.length > 1) r.push(`Compares ${p.channels.map((c) => c.label).join(' and ')} side by side.`);
    if (share) r.push(share.text);
  }
  if (focus === 'scorecard') {
    const seg = p.share || p.breakdown;
    if (seg && p.time) r.push(`${seg.label} × year scorecard over ${p.time.fullYears.length || p.time.years.length} years.`);
    const ratio = p.kpis.find((k) => k.percent);
    if (ratio) r.push(`Tracks ${ratio.label} by year – ratios hide in totals.`);
    if (p.breakdown) r.push(`Ranks ${p.breakdown.label.toLowerCase()} on every KPI with data bars.`);
    if (p.hierarchy.length) r.push(`Drill path ${p.hierarchy.map((x) => x.label).join(' › ')} to find the drivers.`);
  }
  if (partial && p.time) r.push(`Uses full years only (${p.time.fullYears.join(', ')}) so comparisons are fair.`);
  return r.slice(0, 4);
}

/**
 * Recommended deliverables for the current project.
 * Returns [{ id, kind: 'report' | 'rules-dashboard' | 'app', title, audience, theme, pages, name, reasons[], built, available, note }]
 */
export function recommendations(profile, project, { rules = null, values = [] } = {}) {
  const model = project.semanticModel?.name || profile.model.name || 'Semantic model';
  const built = new Map((project.reports || []).map((r) => [r.name.toLowerCase(), r]));
  const out = [];
  const hasTime = Boolean(profile.time);
  const hasSegments = Boolean(profile.share || profile.breakdown);

  const exec = { id: 'executive-report', kind: 'report', title: 'Executive report', audience: 'Leadership', theme: 'executive', pages: ['executive', 'drivers', 'scorecard'].filter((x) => x !== 'scorecard' || (hasTime && hasSegments)), name: `${model} – Executive report` };
  exec.reasons = reasonsFor(profile, 'executive');
  out.push(exec);

  if (rules?.rules.some((r) => r.metrics.length)) {
    const fmt = (v) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
    const breaks = values.filter((v) => v.kind === 'violation' && Number(v.value)).slice(0, 3);
    const dash = {
      id: 'rules-dashboard', kind: 'report', title: 'Business rules dashboard', audience: 'Operations and governance', theme: 'slate', pages: ['rules'],
      name: `${model} – Business rules`,
      reasons: [
        `${rules.rules.length} rules from ${rules.source}, each explained in plain English next to its live count.`,
        ...breaks.map((v) => `${v.label}: ${fmt(v.value)} right now.`),
        rules.extensions.length ? `${rules.extensions.length} rule measure${rules.extensions.length === 1 ? ' is' : 's are'} added to the report, so no model change is needed.` : 'Every rule uses a measure from your semantic model.',
      ].slice(0, 4),
    };
    out.push(dash);
  }

  if (hasSegments && hasTime) {
    const ops = { id: 'scorecard-report', kind: 'report', title: 'Performance scorecard', audience: 'Managers and analysts', theme: 'teal', pages: ['scorecard', 'drivers'], name: `${model} – Scorecard` };
    ops.reasons = reasonsFor(profile, 'scorecard');
    out.push(ops);
  }

  for (const r of out) {
    const b = built.get(r.name.toLowerCase());
    r.built = b ? { id: b.id, url: b.url, builtAt: b.builtAt } : null;
    r.available = true;
  }
  return out;
}
