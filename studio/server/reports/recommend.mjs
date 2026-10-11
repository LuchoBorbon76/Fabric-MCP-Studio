// Recommendations for the Reports & apps step: which reports to build, for whom, with which pages and theme, and why.
// Grounded in the model profile (KPIs, channels, time, segments, insights), the ontology and the reports already built.
import { standardName, purposeOf, parseName } from '../naming.mjs';
import { modelFits } from '../project.mjs';

const plural = (s) => (/[^aeiou]y$/i.test(s) ? `${s.slice(0, -1)}ies` : /(s|x|ch|sh)$/i.test(s) ? `${s}es` : `${s}s`);

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
    if (!seg && p.time) r.push(`Tracks ${p.kpis.map((k) => k.label).slice(0, 4).join(', ')} over time.`);
  }
  if (focus === 'portfolio') {
    const groups = (p.measureGroups || []).slice(0, 4);
    if (groups.length) r.push(`Covers ${groups.map((g) => `${g.name} (${g.count})`).join(', ')} measure groups.`);
    r.push(`${p.measures.length} visible measures available for analysts to explore.`);
    if (p.time) r.push(`Uses ${p.time.grain} trend visuals where the measures have date coverage.`);
  }
  if (focus === 'operations') {
    const groups = (p.measureGroups || []).filter((g) => /call|inventory|finance|quota|survey|operation/i.test(g.name)).slice(0, 3);
    if (groups.length) r.push(`Operational measure groups detected: ${groups.map((g) => g.name).join(', ')}.`);
    const pct = p.kpis.find((k) => k.percent);
    if (pct) r.push(`Highlights ${pct.label}, a ratio that is easy to miss in totals.`);
    if (p.time) r.push(`Shows recent movement by ${p.time.grain} for action-oriented metrics.`);
  }
  if (focus === 'geo' && p.geo) {
    const g = p.geo;
    r.push(g.mode === 'points'
      ? `Map with a bubble for each of ${g.points ?? 'the'} locations (latitude/longitude), sized by ${p.primary.label}.`
      : `Map of ${p.primary.label} you can drill from ${g.levels.map((c) => c.label.toLowerCase()).join(' to ')}.`);
    const top = p.insights.find((i) => i.kind === 'geo');
    if (top) r.push(top.text);
    if (g.levels.length) r.push(`Ranks the top ${plural(g.levels[0].label.toLowerCase())}${g.levels.length > 1 ? ` and ${plural(g.levels[g.levels.length - 1].label.toLowerCase())}` : ''} next to the map.`);
  }
  if (focus === 'executive' && p.geo) r.push(`Adds a map of ${p.primary.label} by ${p.geo.mode === 'points' ? 'location' : p.geo.levels.map((c) => c.label.toLowerCase()).join(' › ')}.`);
  if (partial && p.time?.fullYears?.length) r.push(`Uses full years only (${p.time.fullYears.join(', ')}) so comparisons are fair.`);
  return r.slice(0, 4);
}

/**
 * Recommended deliverables for the current project.
 * Returns [{ id, kind: 'report' | 'rules-dashboard' | 'app', title, audience, theme, pages, name, reasons[], built, available, note }]
 */
export function recommendations(profile, project, { rules = null, values = [] } = {}) {
  const model = project.semanticModel?.name || profile.model.name || 'Semantic model';
  // Reports on the active model (reports from before models were tracked count as its own); the other models' reports
  // keep their names, so a new report here never takes over one of theirs.
  const own = (project.reports || []).filter((r) => !r.semanticModelId || r.semanticModelId === project.semanticModel?.id);
  // Names in use elsewhere: reports on the project's other models, and reports found in Fabric on this model.
  const theirs = new Set([
    ...(project.reports || []).filter((r) => !own.includes(r)).map((r) => r.name.toLowerCase()),
    ...(project.semanticModel?.linked?.reports || []).filter((r) => !own.some((o) => o.id === r.id)).map((r) => r.name.toLowerCase()),
  ]);
  const built = new Map(own.map((r) => [r.name.toLowerCase(), r]));
  // A report already built for the same purpose (or with the name older versions used) keeps its name, so rebuilding
  // updates it. New ones follow the naming standard – all with the model's name first when any plain name is taken
  // (another model has it), so one model's reports are named alike.
  const plain = (purpose) => standardName('Report', purpose, project);
  const prefixed = (purpose) => standardName('Report', `${purposeOf(model, 'SemanticModel') || 'Model'}${purpose}`, project);
  const prefixAll = ['Executive', 'Regional', 'BusinessRules', 'Scorecard', 'PlanVsActual', 'MeasurePortfolio', 'Operations'].some((x) => theirs.has(plain(x).toLowerCase()));
  const nameFor = (purpose, legacy) => {
    const b = own.find((r) => r.name.toLowerCase() === legacy.toLowerCase() || parseName(r.name)?.purpose.toLowerCase() === purpose.toLowerCase());
    if (b) return b.name;
    return prefixAll ? prefixed(purpose) : plain(purpose);
  };
  const out = [];
  const hasTime = Boolean(profile.time);
  const hasSegments = Boolean(profile.share || profile.breakdown);
  const hasPortfolio = (profile.stories || []).length > 1 || profile.measures.length >= 8;

  const exec = { id: 'executive-report', kind: 'report', title: 'Executive report', audience: 'Leadership', theme: 'executive', pages: ['executive', ...(hasPortfolio ? ['portfolio'] : []), ...(profile.geo ? ['geo'] : []), 'drivers', 'scorecard'].filter((x) => x !== 'scorecard' || (hasTime && hasSegments)), name: nameFor('Executive', `${model} – Executive report`) };
  exec.reasons = reasonsFor(profile, 'executive');
  if (profile.warnings?.some((w) => /is blank without extra filters/i.test(w))) exec.reasons.push(profile.warnings.find((w) => /is blank without extra filters/i.test(w)));
  out.push(exec);

  if (profile.measures.length >= 8) {
    const portfolio = { id: 'measure-portfolio-report', kind: 'report', title: 'Measure portfolio', audience: 'Analysts and model owners', theme: 'slate', pages: ['portfolio', 'executive', 'drivers', ...(hasTime ? ['scorecard'] : [])], name: nameFor('MeasurePortfolio', `${model} – Measure portfolio`) };
    portfolio.reasons = reasonsFor(profile, 'portfolio');
    out.push(portfolio);
  }

  if ((profile.measureGroups || []).some((g) => /call|inventory|finance|quota|survey|operation/i.test(g.name)) || profile.kpis.some((k) => /call|order|issue|inventory|quota|survey/i.test(k.name))) {
    const ops = { id: 'operations-report', kind: 'report', title: 'Operations report', audience: 'Operations managers', theme: 'teal', pages: [...(hasPortfolio ? ['portfolio'] : []), 'scorecard', 'drivers', 'executive'], name: nameFor('Operations', `${model} – Operations report`) };
    ops.reasons = reasonsFor(profile, 'operations');
    out.push(ops);
  }

  // Location columns (or coordinates) in the model: a map-first report for the people who run regions.
  if (profile.geo) {
    const regional = { id: 'geo-report', kind: 'report', title: 'Regional report', audience: 'Regional and sales managers', theme: 'teal', pages: ['geo', ...(hasTime && hasSegments ? ['scorecard'] : ['drivers'])], name: nameFor('Regional', `${model} – Regional report`) };
    regional.reasons = reasonsFor(profile, 'geo');
    out.push(regional);
  }

  if (rules?.rules.some((r) => r.metrics.length)) {
    const fmt = (v) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
    const breaks = values.filter((v) => v.kind === 'violation' && Number(v.value)).slice(0, 3);
    const dash = {
      id: 'rules-dashboard', kind: 'report', title: 'Business rules dashboard', audience: 'Operations and governance', theme: 'slate', pages: ['rules'],
      name: nameFor('BusinessRules', `${model} – Business rules`),
      reasons: [
        `${rules.rules.length} rules from ${rules.source}, each explained in plain English next to its live count.`,
        ...breaks.map((v) => `${v.label}: ${fmt(v.value)} right now.`),
        rules.extensions.length ? `${rules.extensions.length} rule measure${rules.extensions.length === 1 ? ' is' : 's are'} added to the report, so no model change is needed.` : 'Every rule uses a measure from your semantic model.',
      ].slice(0, 4),
    };
    out.push(dash);
  }

  if ((hasSegments && hasTime) || (hasTime && profile.kpis.length >= 3)) {
    const ops = { id: 'scorecard-report', kind: 'report', title: 'Performance scorecard', audience: 'Managers and analysts', theme: 'teal', pages: ['scorecard', 'drivers'], name: nameFor('Scorecard', `${model} – Scorecard`) };
    ops.reasons = reasonsFor(profile, 'scorecard');
    out.push(ops);
  }

  // The plan's page only for the model its Plan table is in.
  const pl = modelFits(project).plan;
  if (pl) {
    const fmt = (v) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
    const t = pl.totals || {};
    const v = t.checked?.variance ?? t.varianceToDate;
    out.push({
      id: 'plan-report', kind: 'report', title: 'Plan vs actual', audience: 'Finance and sales leaders', theme: 'executive', pages: ['plan'],
      name: nameFor('PlanVsActual', `${model} – Plan vs actual`),
      reasons: [
        `${pl.planYear} budget of ${fmt(t.budget)} from ${pl.baseYear} actuals (${pl.growthPct >= 0 ? '+' : ''}${pl.growthPct}%), forecast ${fmt(t.forecast)}.`,
        v !== undefined && v !== null ? `Actual is ${v >= 0 ? 'ahead of' : 'behind'} budget by ${fmt(Math.abs(v))} for the months with actuals.` : 'Tracks actual against budget month by month.',
        pl.dims.length ? `Variance by ${pl.dims.map((d) => d.labelText.toLowerCase()).join(' and ')}, so you see where the gap comes from.` : 'Monthly actual, budget and forecast in one chart.',
      ],
    });
  }

  for (const r of out) {
    const b = built.get(r.name.toLowerCase());
    r.built = b ? { id: b.id, url: b.url, builtAt: b.builtAt } : null;
    r.available = true;
  }

  // The org app shares what was built on this model (and, when chosen, reports already on it in the workspace).
  const reports = own;
  const theirInWs = (project.semanticModel?.linked?.reports || []).filter((r) => !own.some((o) => o.id === r.id) && r.type !== 'PaginatedReport' && (!r.workspaceId || r.workspaceId === project.workspace?.id));
  // Reports built after the app: it bundles the reports chosen for it, until it is updated. A report that was offered
  // and left out stays out.
  const inApp = new Set(project.orgApp?.reports || []);
  const offered = new Set(project.orgApp?.considered || project.orgApp?.reports || []);
  const notInApp = project.orgApp ? reports.filter((r) => !inApp.has(r.id) && !offered.has(r.id)) : [];
  const inAppCount = project.orgApp ? (project.orgApp.reports || []).length : reports.length;
  const app = {
    id: 'org-app', kind: 'app', title: 'Org app for your organization', audience: 'Everyone who needs the numbers',
    theme: project.orgApp?.theme || reports[0]?.theme || 'executive', pages: [], name: project.orgApp?.name || standardName('OrgApp', purposeOf(model, 'SemanticModel'), project),
    reasons: reports.length || theirInWs.length
      ? [
        ...(notInApp.length ? [`${notInApp.length === 1 ? `"${notInApp[0].name}" isn't` : `${notInApp.length} reports (${notInApp.slice(0, 3).map((r) => r.name).join(', ')}) aren't`} in the app yet – update the app to add ${notInApp.length === 1 ? 'it' : 'them'}.`] : []),
        project.orgApp
          ? `Bundles ${inAppCount} report${inAppCount === 1 ? '' : 's'} behind one overview page – choose which with Update app.`
          : `You choose which reports go in it: ${[...reports, ...theirInWs].slice(0, 3).map((r) => r.name).join(', ')}${reports.length + theirInWs.length > 3 ? '…' : ''}.`,
        'People get the app without access to the workspace; you choose the audience in Fabric.',
        'Uses your report theme colors, and updates in place when you rebuild.',
      ]
      : ['Build a report first – the app shares your reports with your organization in one place.'],
    built: project.orgApp ? { id: project.orgApp.id, url: project.orgApp.url, builtAt: project.orgApp.builtAt } : null,
    available: reports.length + theirInWs.length > 0,
    reportCount: inAppCount,
    notInApp: notInApp.map((r) => ({ id: r.id, name: r.name })),
  };
  out.push(app);
  return out;
}
