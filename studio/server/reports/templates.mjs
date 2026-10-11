// Report templates: page archetypes (executive summary, performance drivers, scorecard) built from a model profile
// (reports/profile.mjs). Layouts follow the archetypes of Microsoft's Power BI report design guidance on a 1280x720
// canvas: 24 px margins, 16 px gutters, header band, KPI row, hero visual, supporting visuals.
import { V_, PAGE, topNFilter, notBlankFilter, hexId, ruleParagraphs } from '../generators/pbir.mjs';

const M = PAGE.margin;
const G = PAGE.gutter;
const W = PAGE.width - 2 * M;
const HEADER = 80;
const TOP = HEADER + G;

export const PAGE_TEMPLATES = [
  { id: 'executive', name: 'Executive summary', archetype: 'Executive summary', description: 'Headline KPIs, trend by channel, share of the main measure, top breakdown and top 10 list.', needs: ['kpis'] },
  { id: 'portfolio', name: 'Measure portfolio', archetype: 'Executive overview', description: 'Top report-ready measure stories across the model, with historical trends and a cross-measure matrix.', needs: ['kpis'] },
  { id: 'drivers', name: 'Performance drivers', archetype: 'Analytical canvas', description: 'Drill-down matrix (category → item), year-over-year comparison by segment, and the biggest contributors.', needs: ['kpis'] },
  { id: 'scorecard', name: 'Scorecard', archetype: 'Operational monitor', description: 'Segment × year scorecard, margin trend by segment, and a ranked breakdown with data bars.', needs: ['kpis'] },
  { id: 'rules', name: 'Business rules', archetype: 'Operational monitor', description: 'Ontology rules in plain English with live counts, rule breaks by year, and where they happen.', needs: ['rules'] },
  { id: 'plan', name: 'Plan vs actual', archetype: 'Operational monitor', description: 'Actual, budget and forecast KPIs, the monthly trend of all three, and the variance to budget by region and category.', needs: ['plan'] },
  { id: 'geo', name: 'Map', archetype: 'Geographic', description: 'Azure Maps bubbles sized by the main measure – drill from country to state to city, or points at latitude/longitude – with the biggest places and a ranking. Needs location columns in the model.', needs: ['geo'] },
];

/** Page-level filter: column IN values (e.g. full years only). */
export function inFilter(column, values) {
  const literal = (v) => ({ Literal: { Value: typeof v === 'number' ? `${v}L` : `'${String(v).replace(/'/g, "''")}'` } });
  return {
    filters: [{
      name: `Filter${hexId('in', column.table, column.name, values.join(',')).slice(0, 18)}`,
      field: { Column: { Expression: { SourceRef: { Entity: column.table } }, Property: column.name } },
      type: 'Categorical',
      filter: {
        Version: 2,
        From: [{ Name: 'f', Entity: column.table, Type: 0 }],
        Where: [{ Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: 'f' } }, Property: column.name } }], Values: values.map((v) => [literal(v)]) } } }],
      },
      howCreated: 'User',
    }],
  };
}

function periodText(profile) {
  const t = profile.time;
  if (!t) return '';
  const years = t.fullYears.length ? t.fullYears : t.years;
  if (!years.length) return '';
  return years.length > 1 ? `${years[0]}–${years[years.length - 1]}${t.fullYears.length && t.fullYears.length < t.years.length ? ' (full years)' : ''}` : `${years[0]}`;
}

/** Header band with title, subtitle and up to two dropdown slicers on the right. */
function header(theme, profile, title, subtitle) {
  const out = [
    { key: 'band', pos: { x: 0, y: 0, w: PAGE.width, h: HEADER, z: 0 }, visual: V_.band(theme, null, theme.header) },
    { key: 'title', pos: { x: M, y: 14, w: 760, h: 56, z: 500 }, visual: V_.textbox([{ text: title, size: 22, bold: true, color: theme.headerText }, { text: subtitle, size: 11, color: theme.headerText }]) },
  ];
  const slicers = profile.slicers.slice(0, 2);
  let x = PAGE.width - M;
  slicers.slice().reverse().forEach((s, i) => {
    const w = i === 0 && slicers.length > 1 ? 210 : 170;
    x -= w;
    out.push({ key: `slicer-${s.name}`, pos: { x, y: 12, w, h: 56, z: 600 + i }, visual: V_.slicer(theme, { field: s, title: s.label }) });
    x -= 12;
  });
  return out;
}

function kpiRow(theme, profile, y, h = 96) {
  const kpis = profile.kpis.slice(0, 4);
  const w = (W - (kpis.length - 1) * G) / kpis.length;
  return kpis.map((k, i) => ({ key: `kpi-${k.name}`, pos: { x: M + i * (w + G), y, w, h }, visual: V_.card(theme, k, { label: k.label, accent: theme.dataColors[i % theme.dataColors.length] }) }));
}

const trendTitle = (profile) => `${profile.time.grain === 'month' ? 'Monthly' : profile.time.grain === 'quarter' ? 'Quarterly' : 'Yearly'} ${profile.primary.label.replace(/^total\s+/i, '').toLowerCase()}${profile.channels.length > 1 ? ' by channel' : ''}`;
const sameMeasure = (a, b) => a?.table === b?.table && a?.name === b?.name;
function storyMeasures(profile, max = 4) {
  const out = [];
  for (const s of profile.stories || []) if (s.primary && !out.some((m) => sameMeasure(m, s.primary))) out.push(s.primary);
  for (const k of profile.kpis || []) if (!out.some((m) => sameMeasure(m, k))) out.push(k);
  return out.slice(0, max);
}

// ---------------- page builders ----------------

function executive(theme, profile, { subtitle }) {
  const p = profile;
  const visuals = [...header(theme, p, 'Executive summary', subtitle), ...kpiRow(theme, p, TOP)];
  const row2 = TOP + 96 + G;
  const row2h = 232;
  const row3 = row2 + row2h + G;
  const row3h = PAGE.height - M - row3;
  const leftW = p.share ? 752 : W;
  if (p.time) visuals.push({ key: 'trend', pos: { x: M, y: row2, w: leftW, h: row2h }, visual: V_.trend(theme, { measures: p.channels.length > 1 ? p.channels : [p.primary], axis: p.time.axis, title: trendTitle(p) }) });
  if (p.share) visuals.push({ key: 'share', pos: { x: M + leftW + G, y: row2, w: W - leftW - G, h: row2h }, visual: V_.donut(theme, { measure: p.primary, category: p.share, title: `${p.primary.label} by ${p.share.label.toLowerCase()}` }) });
  const barsW = p.entity ? 480 : W;
  if (p.breakdown) visuals.push({ key: 'breakdown', pos: { x: M, y: row3, w: barsW, h: row3h }, visual: V_.bars(theme, { measures: [p.primary], category: p.breakdown, title: `${p.primary.label} by ${p.breakdown.label.toLowerCase()}` }), filterConfig: notBlankFilter(p.breakdown) });
  if (p.entity) {
    const second = p.kpis.find((k) => k.percent) || p.kpis[1];
    visuals.push({
      key: 'top10', pos: { x: p.breakdown ? M + barsW + G : M, y: row3, w: p.breakdown ? W - barsW - G : W, h: row3h },
      visual: V_.table(theme, { columns: [p.entity], measures: [p.primary, ...(second ? [second] : [])], title: `Top 10 ${p.entity.label.toLowerCase()}s by ${p.primary.label.toLowerCase()}`, bars: true }),
      filterConfig: topNFilter(p.entity, p.primary, 10),
    });
  }
  return { displayName: 'Executive summary', visuals };
}

function portfolio(theme, profile, { subtitle }) {
  const p = profile;
  const stories = (p.stories || []).slice(0, 4);
  const measures = storyMeasures(p, 4);
  const visuals = [...header(theme, p, 'Measure portfolio', subtitle)];
  const cards = stories.length
    ? stories.map((s, i) => ({ key: `story-${s.key || s.label}`, ref: s.primary, label: `${s.label}: ${s.primary.label}`, accent: theme.dataColors[i % theme.dataColors.length] }))
    : p.kpis.slice(0, 4).map((k, i) => ({ key: `story-${k.name}`, ref: k, label: k.label, accent: theme.dataColors[i % theme.dataColors.length] }));
  const w = (W - (cards.length - 1) * G) / Math.max(1, cards.length);
  cards.forEach((c, i) => visuals.push({ key: c.key, pos: { x: M + i * (w + G), y: TOP, w, h: 96 }, visual: V_.card(theme, c.ref, { label: c.label, accent: c.accent, labelSize: cards.length > 3 ? 8.5 : 10 }) }));
  const row2 = TOP + 96 + G;
  const row2h = p.time ? 230 : 0;
  if (p.time && measures.length) {
    visuals.push({ key: 'portfolio-trend', pos: { x: M, y: row2, w: W, h: row2h }, visual: V_.trend(theme, { measures, axis: p.time.axis, title: `Historical movement across ${measures.length} report-ready measures`, area: false }) });
  }
  const y = p.time ? row2 + row2h + G : TOP + 96 + G;
  const h = PAGE.height - M - y;
  const rows = (p.hierarchy || []).length > 1 ? p.hierarchy.slice(0, 2) : [p.breakdown || p.share || p.entity].filter(Boolean);
  const leftW = p.entity && rows.length ? 740 : W;
  if (rows.length && measures.length) {
    visuals.push({ key: 'portfolio-matrix', pos: { x: M, y, w: leftW, h }, visual: V_.matrix(theme, { rows, measures, title: `${measures.map((m) => m.label).join(', ')} by ${rows.map((r) => r.label.toLowerCase()).join(' › ')}` }) });
  }
  if (p.entity) {
    visuals.push({
      key: 'portfolio-top', pos: { x: rows.length ? M + leftW + G : M, y, w: rows.length ? W - leftW - G : W, h },
      visual: V_.table(theme, { columns: [p.entity], measures: measures.slice(0, 3), title: `Top ${p.entity.label.toLowerCase()}s across key measures`, bars: true }),
      filterConfig: topNFilter(p.entity, measures[0] || p.primary, 10),
    });
  }
  return { displayName: 'Measure portfolio', visuals };
}

function drivers(theme, profile, { subtitle }) {
  const p = profile;
  const visuals = [...header(theme, p, 'Performance drivers', subtitle)];
  const h = PAGE.height - M - TOP;
  const leftW = 600;
  const rows = p.hierarchy.length ? p.hierarchy : [p.breakdown, p.entity].filter(Boolean);
  const values = p.kpis.slice(0, 3);
  if (rows.length) visuals.push({ key: 'matrix', pos: { x: M, y: TOP, w: leftW, h }, visual: V_.matrix(theme, { rows, measures: values, title: `${rows.map((r) => r.label).join(' › ')}` }) });
  const rx = rows.length ? M + leftW + G : M;
  const rw = rows.length ? W - leftW - G : W;
  const half = (h - G) / 2;
  if (p.time) {
    visuals.push({ key: 'yoy', pos: { x: rx, y: TOP, w: rw, h: half }, visual: V_.bars(theme, { measures: [p.primary], category: { ...p.time.year, sortByValue: false }, series: p.share, horizontal: false, title: `${p.primary.label} by year${p.share ? ` and ${p.share.label.toLowerCase()}` : ''}` }) });
  }
  const contributor = p.entity || p.breakdown;
  if (contributor) {
    visuals.push({
      key: 'contributors', pos: { x: rx, y: p.time ? TOP + half + G : TOP, w: rw, h: p.time ? half : h },
      visual: V_.bars(theme, { measures: [p.primary], category: contributor, title: `Biggest contributors · ${contributor.label.toLowerCase()}` }),
      filterConfig: contributor === p.entity ? topNFilter(contributor, p.primary, 8) : undefined,
    });
  }
  return { displayName: 'Performance drivers', visuals };
}

function scorecard(theme, profile, { subtitle }) {
  const p = profile;
  const visuals = [...header(theme, p, 'Scorecard', subtitle), ...kpiRow(theme, p, TOP, 88)];
  const y = TOP + 88 + G;
  const h1 = 264;
  const segment = p.share || p.breakdown;
  if (segment && p.time) visuals.push({ key: 'grid', pos: { x: M, y, w: 600, h: h1 }, visual: V_.matrix(theme, { rows: [segment], columns: [p.time.year], measures: [p.primary], title: `${p.primary.label} · ${segment.label.toLowerCase()} by year` }) });
  const pct = p.kpis.find((k) => k.percent);
  if (p.time) {
    visuals.push({ key: 'ratio-trend', pos: { x: segment ? M + 600 + G : M, y, w: segment ? W - 600 - G : W, h: h1 }, visual: V_.trend(theme, { measures: [pct || p.primary], axis: [p.time.year], title: `${(pct || p.primary).label} by year`, area: false, labels: true }) });
  }
  const y2 = y + h1 + G;
  const rank = p.breakdown || p.share;
  if (rank) {
    visuals.push({ key: 'ranked', pos: { x: M, y: y2, w: W, h: PAGE.height - M - y2 }, visual: V_.table(theme, { columns: [rank], measures: p.kpis.slice(0, 4), title: `${rank.label} ranking`, bars: true }), filterConfig: notBlankFilter(rank) });
  }
  return { displayName: 'Scorecard', visuals };
}

const KIND_COLOR = { violation: '#DC2626', watch: '#D97706' };

function rules(theme, profile, { subtitle }) {
  const p = profile;
  const set = p.ruleSet || { rules: [] };
  const withMetrics = set.rules.filter((r) => r.metrics.length);
  const order = ['violation', 'watch', 'segment'];
  const metrics = withMetrics.flatMap((r) => r.metrics.map((m) => ({ ...m, rule: r }))).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, 5);
  const sub = `${set.rules.length} rules from ${set.source}${subtitle ? ` · ${subtitle}` : ''}`;
  const visuals = [...header(theme, p, 'Business rules', sub)];
  if (metrics.length) {
    const w = (W - (metrics.length - 1) * G) / metrics.length;
    metrics.forEach((m, i) => visuals.push({ key: `rule-${m.ref.table}-${m.ref.name}`, pos: { x: M + i * (w + G), y: TOP, w, h: 96 }, visual: V_.card(theme, m.ref, { label: m.ref.label, accent: KIND_COLOR[m.kind] || theme.accent, exact: m.type === 'count', labelSize: metrics.length > 4 ? 9 : 10 }) }));
  }
  const y = TOP + (metrics.length ? 96 + G : 0);
  const h = PAGE.height - M - y;
  const leftW = 500;
  const violations = metrics.filter((m) => m.kind !== 'segment');
  const segment = p.breakdown || p.share;
  const textH = segment && violations.length ? Math.min(h, 256) : h;
  visuals.push({ key: 'rule-text', pos: { x: M, y, w: leftW, h: textH }, visual: V_.paragraphs(ruleParagraphs(theme, set.rules.slice(0, 7)), { theme, title: 'What each rule means' }) });
  if (segment && violations.length && h - textH - G > 120) {
    visuals.push({ key: 'rule-segment', pos: { x: M, y: y + textH + G, w: leftW, h: h - textH - G }, visual: V_.table(theme, { columns: [segment], measures: violations.slice(0, 2).map((m) => m.ref), title: `Rule breaks by ${segment.label.toLowerCase()}`, bars: true }), filterConfig: notBlankFilter(segment) });
  }
  const rx = M + leftW + G;
  const rw = W - leftW - G;
  const timed = violations.filter((m) => m.type === 'count' && (p.dateLinked || []).includes(m.ref.table));
  const half = (h - G) / 2;
  if (p.time && timed.length) {
    visuals.push({ key: 'rule-years', pos: { x: rx, y, w: rw, h: half }, visual: V_.bars(theme, { measures: timed.slice(0, 3).map((m) => m.ref), category: { ...p.time.year, sortByValue: false }, horizontal: false, title: 'Rule breaks by year', exact: true }) });
  }
  const top = timed[0] || violations[0];
  if (p.entity && top) {
    visuals.push({
      key: 'rule-where', pos: { x: rx, y: p.time && timed.length ? y + half + G : y, w: rw, h: p.time && timed.length ? half : h },
      visual: V_.table(theme, { columns: [p.entity], measures: [top.ref, ...violations.filter((m) => m !== top).slice(0, 2).map((m) => m.ref)], title: `Where rules break · top ${p.entity.label.toLowerCase()}s`, bars: true }),
      filterConfig: topNFilter(p.entity, top.ref, 10),
    });
  }
  return { displayName: 'Business rules', visuals };
}

// Plan vs actual: profile.plan = { planYear, baseYear, measureLabel, m: { actual, budget, forecast, budgetToDate, variance,
// variancePct, attainment, fcVsBudget }, month, year, dims: [column refs] } (measure and column refs as in the profile).
function plan(theme, profile) {
  const pl = profile.plan;
  const m = pl.m;
  const sub = `${pl.measureLabel} · ${pl.planYear} budget from ${pl.baseYear} actuals${profile.model?.name ? ` · ${profile.model.name}` : ''}`;
  const visuals = [...header(theme, { ...profile, slicers: pl.dims.slice(0, 2) }, `Plan vs actual ${pl.planYear}`, sub)];
  const kpis = [[m.actual, theme.dataColors[0]], [m.budget, theme.dataColors[1]], [m.variance, theme.accent], [m.variancePct, theme.accent], [m.forecast, theme.dataColors[2]]];
  const kw = (W - (kpis.length - 1) * G) / kpis.length;
  kpis.forEach(([k, accent], i) => visuals.push({ key: `plan-kpi-${k.name}`, pos: { x: M + i * (kw + G), y: TOP, w: kw, h: 96 }, visual: V_.card(theme, k, { label: k.label, accent }) }));
  const row2 = TOP + 96 + G;
  const row2h = 250;
  visuals.push({ key: 'plan-trend', pos: { x: M, y: row2, w: W, h: row2h }, visual: V_.trend(theme, { measures: [m.actual, m.budget, m.forecast], axis: [pl.month], title: `${pl.measureLabel}: actual, budget and forecast by month`, area: false, labels: false }) });
  const row3 = row2 + row2h + G;
  const row3h = PAGE.height - M - row3;
  const [d1, d2] = pl.dims;
  const leftW = d2 ? 700 : W;
  if (d1) visuals.push({ key: 'plan-by-d1', pos: { x: M, y: row3, w: leftW, h: row3h }, visual: V_.table(theme, { columns: [d1], measures: [m.actual, m.budgetToDate, m.variance, m.variancePct, m.forecast], title: `Variance to budget by ${d1.label.toLowerCase()}`, bars: false }), filterConfig: notBlankFilter(d1) });
  if (d2) visuals.push({ key: 'plan-by-d2', pos: { x: M + leftW + G, y: row3, w: W - leftW - G, h: row3h }, visual: V_.bars(theme, { measures: [m.actual, m.budgetToDate], category: d2, title: `Actual vs budget by ${d2.label.toLowerCase()}` }), filterConfig: notBlankFilter(d2) });
  return { displayName: 'Plan vs actual', visuals };
}

// Map: where the main measure comes from. Places drill from the coarse level down; coordinates show one bubble each.
// profile.geo = { mode: 'places' | 'points', levels: [column refs coarse → fine], lat, lon, label }.
const plural = (s) => (/[^aeiou]y$/i.test(s) ? `${s.slice(0, -1)}ies` : /(s|x|ch|sh)$/i.test(s) ? `${s}es` : `${s}s`);
function geo(theme, profile, { subtitle }) {
  const p = profile;
  const g = p.geo;
  const visuals = [...header(theme, p, 'Where the numbers come from', subtitle), ...kpiRow(theme, p, TOP, 88)];
  const y = TOP + 88 + G;
  const h = PAGE.height - M - y;
  const mapW = 760;
  const coarse = g.levels[0] || null;
  const fine = g.mode === 'points' ? g.label || g.levels[g.levels.length - 1] || null : g.levels[g.levels.length - 1] || null;
  const tips = p.kpis.filter((k) => k.name !== p.primary.name).slice(0, 2);
  const where = g.mode === 'points' ? (g.label?.label || 'location') : g.levels.map((c) => c.label).join(' › ');
  visuals.push({
    key: 'map', pos: { x: M, y, w: mapW, h },
    visual: V_.map(theme, {
      locations: g.mode === 'points' ? (g.label ? [g.label] : []) : g.levels,
      lat: g.mode === 'points' ? g.lat : null, lon: g.mode === 'points' ? g.lon : null,
      size: p.primary, tooltips: tips,
      title: `${p.primary.label} by ${where.toLowerCase()}${g.mode === 'places' && g.levels.length > 1 ? ' (drill down for detail)' : ''}`,
    }),
  });
  const rx = M + mapW + G;
  const rw = W - mapW - G;
  const half = (h - G) / 2;
  const same = (a, b) => Boolean(a && b && a.table === b.table && a.name === b.name);
  const showTable = fine && !same(fine, coarse);
  if (coarse) {
    visuals.push({ key: 'geo-bars', pos: { x: rx, y, w: rw, h: showTable ? half : h }, visual: V_.bars(theme, { measures: [p.primary], category: coarse, title: `${p.primary.label} by ${coarse.label.toLowerCase()}` }), filterConfig: topNFilter(coarse, p.primary, 10) });
  }
  if (showTable) {
    // The place one level up tells same-named places apart (Springfield, Illinois and Springfield, Missouri). A top-N
    // filter ranks names, not places, so with the parent the table lists every place, highest first.
    const parent = g.mode === 'places' && g.levels.length > 1 ? g.levels[g.levels.length - 2] : null;
    const second = p.kpis.find((k) => k.percent) || tips[0];
    const name = plural(fine.label.toLowerCase());
    visuals.push({
      key: 'geo-top', pos: { x: rx, y: coarse ? y + half + G : y, w: rw, h: coarse ? half : h },
      visual: V_.table(theme, { columns: [fine, ...(parent ? [parent] : [])], measures: [p.primary, ...(second ? [second] : [])], title: parent ? `${name.charAt(0).toUpperCase()}${name.slice(1)} by ${p.primary.label.toLowerCase()}, highest first` : `Top 10 ${name} by ${p.primary.label.toLowerCase()}`, bars: true }),
      filterConfig: parent ? notBlankFilter(fine) : topNFilter(fine, p.primary, 10),
    });
  }
  return { displayName: 'Map', visuals };
}

const BUILDERS = { executive, portfolio, drivers, scorecard, rules, plan, geo };

/**
 * Report plan for a model profile: { pages: [{ name, displayName, visuals, filterConfig }] } ready for reportFiles().
 * options: { pages: ['executive', ...], subtitle }
 */
export function buildReportPages(profile, theme, { pages = ['executive', 'drivers', 'scorecard'], subtitle } = {}) {
  const period = periodText(profile);
  const sub = subtitle || [profile.model.name, period].filter(Boolean).join(' · ');
  const pageFilter = profile.time && profile.time.fullYears.length && profile.time.fullYears.length < profile.time.years.length ? inFilter(profile.time.year, profile.time.fullYears) : null;
  return pages.filter((id) => BUILDERS[id] && (id !== 'plan' || profile.plan) && (id !== 'geo' || profile.geo)).map((id) => {
    const page = BUILDERS[id](theme, profile, { subtitle: sub });
    // The plan page shows the plan year only; the other pages compare full years.
    const filter = id === 'plan' ? inFilter(profile.plan.year, [profile.plan.planYear]) : pageFilter;
    return { name: hexId('page', id), ...page, ...(filter ? { filterConfig: filter } : {}) };
  });
}
