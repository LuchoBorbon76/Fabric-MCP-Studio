import { store, get, post, del, on } from '../api.js';
import { h, toast, busy, field, input, select, confirmDialog } from '../ui.js';
import { app, copilotSlot } from '../app.js';
import { askCard } from '../prompts.js';
import { standardName } from '../naming.js';

// Budgets and forecasts on the semantic model: design and preview the plan, build it (plan values next to the data +
// Plan table in the model), the Plan vs actual report, and the Fabric plan item for planning sheets.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const money = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const pct = (n, digits = 1) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '–' : `${Number(n) >= 0 ? '+' : ''}${(Number(n) * 100).toFixed(digits)}%`);
const put = (el, ...kids) => el.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));

// Choices survive re-renders while the tab is open.
const draft = { opts: {}, preview: null, overrides: new Map() };
on('studio.reset', () => { draft.opts = {}; draft.preview = null; draft.overrides.clear(); });

export function renderPlanning(el) {
  const p = store.project || {};
  if (!p.workspace) {
    el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Select a workspace first. '), 'The plan is built on your semantic model.'), h('button', { class: 'btn pri', onclick: () => app.go('workspace') }, 'Go to Workspace')));
    return;
  }
  const wrap = h('div', { id: 'planningWrap' }, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading the plan…'));
  el.append(askCard({ title: 'Ask about the plan', only: ['plan'] }), wrap, copilotSlot());
  get('/planning').then((s) => { store.planning = s; draw(wrap, s); }).catch((e) => { wrap.innerHTML = ''; wrap.append(h('div', { class: 'banner err' }, e.message)); });
}

function draw(wrap, s) {
  wrap.innerHTML = '';
  const p = store.project || {};
  if (!s.available) {
    wrap.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Create the semantic model first. '), 'The budget and forecast are derived from its actuals and added to it as a Plan table.'), h('button', { class: 'btn pri', onclick: () => app.go('model') }, 'Go to Semantic model')));
    return;
  }
  const pl = s.plan;
  put(wrap,
    h('div', { class: 'card' },
      h('div', { class: 'row sp', style: { alignItems: 'flex-start' } },
        h('div', {}, h('h2', {}, 'Budgets and forecasts'), h('p', { class: 'lead' }, 'Start the plan from your actuals: a budget from last year with your growth targets, and a rolling forecast that blends actuals with the run rate. The studio adds them to your semantic model with variance measures, builds a Plan vs actual report, and creates the Fabric plan where planners refine the numbers in planning sheets.')),
        h('button', { class: 'btn ai', onclick: () => app.ask(pl ? 'Are we on plan? Use studio_planning_status and explain where actual is ahead of or behind budget, and what the forecast says for the year.' : 'Recommend a budget and forecast for my data with studio_preview_plan: which year, growth and forecast cut-off, and why. Point out regions or categories that deserve their own growth target.') }, pl ? '✦ Are we on plan?' : '✦ Recommend a plan')),
      flow(s, p)),
    !s.writable ? h('div', { class: 'banner warn', style: { marginTop: '14px' } }, h('div', {}, h('b', {}, 'Plans are stored next to your data. '), `Your model reads ${s.source?.type === 'Lakehouse' ? 'a lakehouse' : s.source?.type === 'MirroredDatabase' ? 'a mirrored database' : `a ${s.source?.type || 'source'}`}, which the studio can't write plan values to yet. Use a Fabric SQL database or a warehouse (for example the AdventureWorks sample) to build the plan here – you can still preview it.`)) : null,
    h('div', { class: 'grid g2', style: { marginTop: '14px', alignItems: 'start' } }, designCard(), previewCard()),
    h('div', { class: 'grid g2', style: { marginTop: '14px', alignItems: 'start' } }, buildCard(s), summaryCard(s)),
    h('div', { class: 'grid g2', style: { marginTop: '14px', alignItems: 'start' } }, reportCard(s, p), planItemCard(s)));
  if (!draft.preview) runPreview();
}

function flow(s, p) {
  const pl = s.plan;
  const report = pl && (p.reports || []).find((r) => r.pages?.includes('Plan vs actual'));
  const steps = [
    ['Actuals', p.semanticModel?.name || 'Semantic model', 'ok'],
    ['Budget & forecast', pl ? `${pl.planYear} · ${pl.growthPct >= 0 ? '+' : ''}${pl.growthPct}%` : 'From last year + growth', pl ? 'ok' : 'todo'],
    ['Plan table', pl ? `${Object.keys(pl.spec?.names || {}).length} measures in the model` : 'Budget, forecast, variance', pl ? 'ok' : 'todo'],
    ['Plan vs actual', report ? report.name : 'Power BI report', report ? 'ok' : 'todo'],
    ['Fabric plan', pl?.planItem ? pl.planItem.name : 'Planning sheets', pl?.planItem ? 'ok' : 'todo'],
  ];
  return h('div', { class: 'rtflow' }, steps.map(([t, sub, state], i) => [
    i ? h('span', { class: 'rtarrow' }, '→') : null,
    h('div', { class: `rtnode ${state}` }, h('b', {}, t), h('span', { class: 'tiny muted' }, sub)),
  ]));
}

// ---------------- design ----------------
function currentOptions() {
  const o = { ...draft.opts };
  const overrides = [...draft.overrides.entries()].filter(([, v]) => v !== '' && Number.isFinite(Number(v))).map(([key, growthPct]) => ({ key, growthPct: Number(growthPct) }));
  if (overrides.length) o.overrides = overrides;
  return o;
}

function designCard() {
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const pv = draft.preview;
  const d = pv?.design;
  const year = select((pv?.availableYears?.length ? pv.availableYears : d ? [d.planYear] : []).map((y) => ({ value: y, label: String(y), selected: y === d?.planYear })), { disabled: !pv || undefined });
  const growth = input({ type: 'number', step: 1, min: -50, max: 200, value: d ? d.growthPct : '', placeholder: '%' });
  const cut = select([{ value: 0, label: 'No actuals yet – forecast = budget' }, ...MONTHS.map((m, i) => ({ value: i + 1, label: `Actuals to ${m}, forecast from ${MONTHS[i + 1] || 'next year'}` }))].map((o) => ({ ...o, selected: d && o.value === d.asOfMonth })), { disabled: !pv || undefined });
  const measure = select((pv?.measures || (d ? [d.measure.name] : [])).map((m) => ({ value: m, label: m, selected: m === d?.measure.name })), { disabled: !pv || undefined });
  const dimOpts = (pv?.dimensions || []).map((x) => x.table);
  const dimSel = (i) => select([{ value: '', label: i ? '(none)' : '(choose)' }, ...dimOpts.map((t) => ({ value: t, label: t, selected: d?.dims[i]?.table === t }))], { disabled: !pv || undefined });
  const dim1 = dimSel(0);
  const dim2 = dimSel(1);
  const apply = h('button', { class: 'btn', 'data-busy': 'Calculating…', disabled: !pv || undefined }, '↻ Preview');
  apply.addEventListener('click', busy(apply, async () => {
    const dims = [dim1.value, dim2.value].filter(Boolean);
    const dimsChanged = d && dims.join('|') !== d.dims.map((x) => x.table).join('|');
    draft.opts = { measure: measure.value, planYear: Number(year.value), growthPct: growth.value === '' ? undefined : Number(growth.value), asOfMonth: Number(cut.value), dims: dims.length ? dims : undefined };
    if (dimsChanged || (d && measure.value !== d.measure.name)) draft.overrides.clear();
    await runPreview(true);
  }));
  const reset = h('button', { class: 'btn ghost', disabled: !pv || undefined, title: 'Back to the recommended plan' }, 'Recommended');
  reset.addEventListener('click', () => { draft.opts = {}; draft.overrides.clear(); runPreview(true); });
  put(card,
    h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, '1 · Design the plan'), pv ? h('span', { class: 'pill brand' }, d.planYear === pv.defaults?.planYear && d.growthPct === pv.defaults?.growthPct && !draft.overrides.size ? 'Recommended' : 'Custom') : null),
    pv?.defaults?.reason && !Object.keys(draft.opts).length ? h('p', { class: 'small muted' }, pv.defaults.reason) : h('p', { class: 'small muted' }, 'Budget = base-year actuals × (1 + growth), month by month, so seasonality is kept. Forecast = actuals up to the cut-off, then the budget × each region\'s run rate (actual ÷ budget so far, kept between 80% and 125%).'),
    h('div', { class: 'grid', style: { gridTemplateColumns: '1fr 1fr', gap: '10px' } },
      field('Measure', measure), field('Plan year', year, d ? `Budget from ${d.baseYear} actuals` : ''),
      field('Growth over the base year (%)', growth, pv?.defaults ? `Recommended ${pv.defaults.growthPct}% (last year's growth, kept between -10% and 25%)` : ''), field('Forecast', cut),
      field('Plan by', dim1), field('and', dim2)),
    h('p', { class: 'tiny muted' }, 'Set a different growth for a region or category in the preview table.'),
    h('div', { class: 'row', style: { marginTop: '8px' } }, apply, reset));
  return card;
}

// ---------------- preview ----------------
let previewBody = null;
let previewBusy = false;

async function runPreview(force = false) {
  if (previewBusy && !force) return;
  previewBusy = true;
  if (previewBody?.isConnected) { previewBody.innerHTML = ''; previewBody.append(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading the actuals and calculating the plan… (about 15 seconds)')); }
  try {
    draft.preview = await post('/planning/preview', currentOptions());
    const wrapEl = document.getElementById('planningWrap');
    if (store.planning && wrapEl) draw(wrapEl, store.planning);
  } catch (e) {
    if (previewBody?.isConnected) { previewBody.innerHTML = ''; previewBody.append(h('div', { class: 'banner err' }, e.message)); }
  } finally { previewBusy = false; }
}

function previewCard() {
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  previewBody = h('div');
  const pv = draft.preview;
  put(card, h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, 'Preview'), pv ? h('span', { class: 'tiny muted' }, `${pv.design.planYear} · ${pv.rows} plan rows`) : null), previewBody);
  if (!pv) { previewBody.append(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading the actuals and calculating the plan… (about 15 seconds)')); return card; }
  const t = pv.totals;
  const d = pv.design;
  put(previewBody,
    h('div', { class: 'rtstats' }, [
      [`${d.baseYear} actual`, money(t.base)], [`${d.planYear} budget`, money(t.budget)], ['Forecast', money(t.forecast)],
      [t.lastActualMonth ? `Actual to ${MONTHS[t.lastActualMonth - 1]}` : 'Actual', money(t.actualToDate)], ['vs budget to date', pct(t.variancePct)],
    ].map(([l, v]) => h('div', {}, h('span', { class: 'tiny muted' }, l), h('b', {}, v)))),
    monthChart(pv.months, d),
    memberTable(pv));
  return card;
}

/** Monthly lines: base-year actual, budget, actual and forecast. */
function monthChart(months, d) {
  const W = 560; const H = 170; const L = 46; const B = 22; const T = 10;
  const series = [
    ['base', `${d.baseYear} actual`, '#94A3B8', '4 3'], ['budget', 'Budget', 'var(--brand)', ''], ['forecast', 'Forecast', '#D97706', '6 3'], ['actual', `${d.planYear} actual`, '#16A34A', ''],
  ];
  const max = Math.max(1, ...months.flatMap((m) => series.map(([k]) => Number(m[k]) || 0)));
  const x = (i) => L + (i * (W - L - 8)) / 11;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'plchart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Budget, forecast and actuals by month');
  const add = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; svg.append(e); return e; };
  for (let g = 0; g <= 4; g++) {
    const v = (max * g) / 4;
    add('line', { x1: L, x2: W - 8, y1: y(v), y2: y(v), class: 'gl' });
    add('text', { x: L - 6, y: y(v) + 3, 'text-anchor': 'end', class: 'ax' }, v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : String(Math.round(v)));
  }
  months.forEach((m, i) => add('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', class: 'ax' }, m.label));
  if (d.asOfMonth) add('line', { x1: x(d.asOfMonth - 1) + (W - L) / 22, x2: x(d.asOfMonth - 1) + (W - L) / 22, y1: T, y2: H - B, class: 'cut' });
  for (const [k, , color, dash] of series) {
    const pts = months.map((m, i) => [x(i), Number(m[k]) || 0]).filter((_, i) => k !== 'actual' || months[i].actual);
    if (!pts.length) continue;
    add('polyline', { points: pts.map(([px, v]) => `${px},${y(v)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': k === 'budget' || k === 'actual' ? 2.4 : 1.8, 'stroke-dasharray': dash });
  }
  return h('div', { style: { marginTop: '10px' } }, svg, h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap', marginTop: '2px' } }, series.map(([, label, color, dash]) => h('span', { class: 'tiny muted row', style: { gap: '6px' } }, h('i', { class: 'plkey', style: { borderTopColor: color, borderTopStyle: dash ? 'dashed' : 'solid' } }), label)),
    d.asOfMonth ? h('span', { class: 'tiny muted' }, `| forecast from ${MONTHS[d.asOfMonth] || 'next year'}`) : null));
}

function memberTable(pv) {
  const d = pv.design;
  const dim = d.dims[0];
  if (!dim) return null;
  const rows = pv.members.slice(0, 15);
  const rerun = h('button', { class: 'btn', 'data-busy': 'Calculating…', hidden: true }, '↻ Apply growth targets');
  rerun.addEventListener('click', busy(rerun, async () => { await runPreview(true); }));
  return h('div', { style: { marginTop: '12px' } },
    h('div', { class: 'row sp' }, h('b', { class: 'small' }, `By ${dim.labelText.toLowerCase()}`), rerun),
    h('div', { class: 'scroll', style: { maxHeight: '300px' } },
      h('table', { class: 't' },
        h('tr', {}, h('th', {}, dim.labelText), h('th', { class: 'num' }, `${d.baseYear}`), h('th', { class: 'num', title: 'Growth over the base year' }, 'Growth %'), h('th', { class: 'num' }, 'Budget'), h('th', { class: 'num' }, 'Actual'), h('th', { class: 'num' }, 'Forecast')),
        rows.map((m) => {
          const val = draft.overrides.has(m.key) ? draft.overrides.get(m.key) : '';
          const g = h('input', { class: 'i plgrowth', type: 'number', step: 1, value: val, placeholder: String(d.growthPct), 'aria-label': `Growth for ${m.name}` });
          g.addEventListener('input', () => { if (g.value === '') draft.overrides.delete(m.key); else draft.overrides.set(m.key, g.value); rerun.hidden = false; });
          return h('tr', {}, h('td', {}, m.name), h('td', { class: 'num' }, money(m.base)), h('td', { class: 'num' }, g), h('td', { class: 'num' }, money(m.budget)), h('td', { class: 'num' }, m.actual ? money(m.actual) : '–'), h('td', { class: 'num' }, money(m.forecast)));
        }))),
    pv.members.length > rows.length ? h('div', { class: 'tiny muted' }, `Top ${rows.length} of ${pv.members.length} by budget.`) : null);
}

// ---------------- build ----------------
function buildCard(s) {
  const pl = s.plan;
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const job = h('div');
  const build = h('button', { class: 'btn pri', 'data-busy': 'Starting…', disabled: !s.writable || !draft.preview || undefined, title: s.writable ? '' : 'Needs a Fabric SQL database or warehouse source' }, pl ? '↻ Rebuild the plan' : 'Build the plan');
  build.addEventListener('click', busy(build, async () => {
    const pv = draft.preview;
    const ok = await confirmDialog(pl ? 'Rebuild the plan' : 'Build the plan', `Write the ${pv.design.planYear} budget and forecast (${pv.rows} rows) to a "planning" schema in your ${s.source?.type === 'Warehouse' ? 'warehouse' : 'SQL database'}, and add a Plan table with budget, forecast and variance measures to ${store.project.semanticModel.name}.`, pl ? 'Rebuild' : 'Build');
    if (!ok) return;
    await startJob('/jobs/planning', currentOptions(), job, 'The plan is in your semantic model');
  }));
  const remove = h('button', { class: 'btn ghost' }, 'Remove…');
  remove.addEventListener('click', async () => {
    const drop = await confirmDialog('Remove the plan', `Take the Plan table out of ${store.project.semanticModel.name} and delete the plan values${pl?.planItem ? ` and the Fabric plan ${pl.planItem.name}` : ''}? Reports that use the plan measures stop showing them.`, 'Remove', true);
    if (!drop) return;
    try { await del('/planning?data=1&item=1'); toast('Plan removed', 'ok'); draft.preview = null; app.refresh(); } catch (e) { toast(e.message, 'err'); }
  });
  put(card,
    h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, '2 · Build the plan'), pl ? h('span', { class: 'pill ok' }, 'Built') : h('span', { class: 'pill brand' }, 'Recommended')),
    h('p', { class: 'small muted' }, 'Writes the budget and forecast next to your data (one row per month, scenario and member) and adds a Plan table to the model. The totals are checked through the model before the plan is marked ready.'),
    pl ? h('dl', { class: 'kv', style: { marginTop: '10px' } },
      h('dt', {}, 'Plan'), h('dd', {}, `${pl.measure.name} · ${pl.planYear} (from ${pl.baseYear}, ${pl.growthPct >= 0 ? '+' : ''}${pl.growthPct}%${pl.overrides?.length ? `, ${pl.overrides.length} target${pl.overrides.length === 1 ? '' : 's'} by member` : ''})`),
      h('dt', {}, 'Forecast'), h('dd', {}, pl.asOfMonth ? `Actuals to ${MONTHS[pl.asOfMonth - 1]}, run rate after` : 'Equals the budget until actuals arrive'),
      h('dt', {}, 'Planned by'), h('dd', {}, ['Month', ...pl.dims.map((x) => x.labelText)].join(' × ')),
      h('dt', {}, 'Stored in'), h('dd', {}, h('code', {}, pl.target.table), h('div', { class: 'tiny muted' }, pl.target.label)),
      h('dt', {}, 'In the model'), h('dd', {}, h('div', { class: 'chips' }, Object.values(pl.spec?.names || {}).map((n) => h('span', { class: 'pill' }, n)))),
      h('dt', {}, 'Built'), h('dd', {}, new Date(pl.builtAt).toLocaleString())) : null,
    h('div', { class: 'row', style: { marginTop: '10px' } }, build, pl ? remove : null,
      h('button', { class: 'btn ai', disabled: !s.writable || undefined, onclick: () => app.ask('Preview a budget and forecast with studio_preview_plan, show me the totals by month and region, then build it with studio_create_plan after I confirm.') }, '✦ With Copilot')),
    job);
  return card;
}

// ---------------- plan vs actual now ----------------
function summaryCard(s) {
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const body = h('div');
  put(card, h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, 'Plan vs actual'), s.plan ? h('span', { class: 'tiny muted' }, `${s.plan.planYear} · through the model`) : null), body);
  if (!s.plan) { body.append(h('p', { class: 'small muted' }, 'Once the plan is built, actual, budget to date, variance and forecast appear here – read live from your semantic model.')); return card; }
  body.append(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Querying the model…'));
  get('/planning/summary').then((r) => {
    body.innerHTML = '';
    const t = r.total;
    const ahead = (t.variance || 0) >= 0;
    put(body,
      h('div', { class: 'rtstats big' }, [['Actual', money(t.actual)], ['Budget to date', money(t.budgetToDate)], ['Variance', money(t.variance)], ['Forecast', money(t.forecast)]].map(([l, v]) => h('div', {}, h('span', { class: 'tiny muted' }, l), h('b', {}, v)))),
      h('p', { class: 'small', style: { margin: '8px 0' } }, h('span', { class: `pill ${ahead ? 'ok' : 'err'}` }, `${pct(t.variancePct)} ${ahead ? 'ahead of' : 'behind'} budget`), ` · forecast ${money(t.forecast)} vs budget ${money(t.budget)} (${pct(t.budget ? (t.forecast - t.budget) / t.budget : null)})`),
      r.members.length ? h('div', { class: 'scroll', style: { maxHeight: '300px' } }, h('table', { class: 't' },
        h('tr', {}, h('th', {}, r.dimension), h('th', { class: 'num' }, 'Actual'), h('th', { class: 'num' }, 'Budget to date'), h('th', { class: 'num' }, 'Variance %'), h('th', { class: 'num' }, 'Forecast')),
        r.members.map((m) => h('tr', {}, h('td', {}, m.name), h('td', { class: 'num' }, money(m.actual)), h('td', { class: 'num' }, money(m.budgetToDate)), h('td', { class: `num ${(m.variance || 0) >= 0 ? 'good' : 'bad'}` }, pct(m.variancePct)), h('td', { class: 'num' }, money(m.forecast)))))) : null);
  }).catch((e) => { body.innerHTML = ''; body.append(h('div', { class: 'banner err' }, e.message)); });
  return card;
}

// ---------------- report ----------------
function reportCard(s, p) {
  const pl = s.plan;
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const job = h('div');
  const legacy = `${p.semanticModel?.name || 'Model'} – Plan vs actual`;
  const name = standardName('Report', 'PlanVsActual');
  const built = (p.reports || []).find((r) => r.name === name || r.name === legacy || r.pages?.includes('Plan vs actual'));
  const go = h('button', { class: 'btn pri', 'data-busy': 'Starting…', disabled: !pl || undefined, title: pl ? '' : 'Build the plan first' }, built ? '↻ Rebuild report' : 'Build report');
  go.addEventListener('click', busy(go, async () => { await startJob('/jobs/report', { name: built?.name || name, theme: built?.theme || 'executive', pages: ['plan'] }, job, 'Plan vs actual report ready'); }));
  put(card,
    h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, '3 · Plan vs actual report'), built ? h('span', { class: 'pill ok' }, 'Built') : pl ? h('span', { class: 'pill brand' }, 'Recommended') : h('span', { class: 'pill' }, 'Needs the plan')),
    h('p', { class: 'small muted' }, 'A Power BI page for finance and sales leaders: actual, budget, variance and forecast KPIs, the monthly trend of all three, and where the gap comes from by region and category.'),
    h('div', { class: 'rtpages' },
      h('div', {}, h('b', {}, 'KPIs'), h('span', { class: 'tiny muted' }, 'Actual · Budget · Variance · Variance % · Forecast')),
      h('div', {}, h('b', {}, 'Trend and drivers'), h('span', { class: 'tiny muted' }, 'Actual vs budget vs forecast by month · variance by region · actual vs budget by category'))),
    built ? h('dl', { class: 'kv', style: { marginTop: '10px' } }, h('dt', {}, 'Report'), h('dd', {}, h('a', { href: built.url, target: '_blank', rel: 'noopener' }, built.name, ' ↗')), h('dt', {}, 'Built'), h('dd', {}, new Date(built.builtAt).toLocaleString())) : null,
    h('div', { class: 'row', style: { marginTop: '10px' } }, go, built ? h('a', { class: 'btn', href: built.url, target: '_blank', rel: 'noopener' }, 'Open report ↗') : null, h('button', { class: 'btn ghost', onclick: () => app.go('reports') }, 'Reports & apps')),
    job);
  return card;
}

// ---------------- Fabric plan ----------------
const ASK_IN_FABRIC = 'fabric';

function planItemCard(s) {
  const pl = s.plan;
  const it = pl?.planItem;
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const job = h('div');
  const wsName = store.project.workspace?.name || 'the workspace';
  const model = store.project.semanticModel?.name || 'your model';
  const me = store.user?.upn || store.user?.name || 'the account the studio uses';

  // Which connection the plan reads the model with: none (Fabric asks when the plan opens) or a shared connection.
  const connSel = select([{ value: ASK_IN_FABRIC, label: 'Choose it in Fabric when the plan opens (recommended)' }]);
  const current = it?.connectionId || (it?.connected ? '?' : ASK_IN_FABRIC);
  get('/planning/connections').then((r) => {
    for (const c of r.connections) connSel.append(h('option', { value: c.id, selected: c.id === current || undefined }, `Use the shared connection "${c.name}"${c.credentialType ? ` (${c.credentialType})` : ''}`));
    if (current === '?') connSel.append(h('option', { value: '?', selected: true, disabled: true }, `Connected through "${it.connectionName}"`));
    sync();
  }).catch(() => {});
  connSel.value = current === '?' ? ASK_IN_FABRIC : current;

  const go = h('button', { class: 'btn pri', 'data-busy': 'Starting…', disabled: !pl || undefined, title: pl ? (it ? 'Checks the plan in Fabric and recreates it when it points to a model that no longer exists (only while it has no sheets)' : '') : 'Build the plan first' }, it ? '↻ Check the plan' : 'Create the Fabric plan');
  go.addEventListener('click', busy(go, async () => { await startJob('/jobs/plan-item', it ? {} : { connection: connSel.value }, job, 'Fabric plan ready'); }));
  const change = h('button', { class: 'btn', 'data-busy': 'Updating…' }, 'Change the connection');
  change.addEventListener('click', busy(change, async () => {
    const ok = await confirmDialog('Change the plan\'s connection', `Fabric keeps a plan's semantic model connection once the plan exists, so the studio deletes "${it.name}" and creates it again ${connSel.value === ASK_IN_FABRIC ? 'without a connection – Fabric asks for one when you open it' : 'with the connection you picked'}. This only works while the plan has no sheets; otherwise change it in the plan (Manage Semantic Model Connection).`, 'Recreate the plan');
    if (!ok) return;
    await startJob('/jobs/plan-item', { connection: connSel.value }, job, connSel.value === ASK_IN_FABRIC ? 'Plan recreated – connect it when it opens' : 'Plan recreated with the new connection');
  }));
  const sync = () => { change.hidden = !it || connSel.value === current || connSel.value === '?'; };
  connSel.addEventListener('change', sync);
  sync();

  const dims = pl ? pl.dims.map((x) => x.labelText) : ['Region', 'Category'];
  const n = pl?.spec?.names || { budget: 'Budget', forecast: 'Forecast', actual: 'Actual' };
  put(card,
    h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, '4 · Plan in Fabric'), it ? h('span', { class: `pill ${it.connected ? 'ok' : 'warn'}` }, it.connected ? 'Connected' : 'Connect when it opens') : pl ? h('span', { class: 'pill brand' }, 'Next') : h('span', { class: 'pill' }, 'Needs the plan')),
    h('p', { class: 'small muted' }, 'Planning in Fabric IQ gives planners Excel-like planning sheets on the same model: adjust the budget, run what-if scenarios, comment, approve, and write the results back to a Fabric SQL database.'),
    it ? h('dl', { class: 'kv', style: { marginTop: '10px' } },
      h('dt', {}, 'Plan'), h('dd', {}, h('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.name, ' ↗')),
      h('dt', {}, 'Semantic model'), h('dd', {}, it.connected ? `${model} through the shared connection "${it.connectionName}" – read with the sign-in saved in that connection` : `${model} – Fabric asks for the connection when the plan opens`)) : null,
    pl ? field('Semantic model connection', connSel, 'A shared connection reads the model with the sign-in saved in it, for everyone who opens the plan. If that account can\'t open the model, the plan says it can\'t access the semantic model.') : null,
    h('ol', { class: 'pre small', style: { marginTop: '10px' } },
      h('li', {}, it ? 'Open the plan.' : 'Create the plan here.'),
      it?.connected ? null : h('li', {}, 'In the plan, select Semantic Model › Create Connection (or pick a connection), sign in with an account that is Contributor or higher in ', h('b', {}, wsName), ', then pick ', h('b', {}, model), ' › Connect.'),
      h('li', {}, 'New Planning Sheet › Rows: ', h('b', {}, dims.join(' › ')), ' · Columns: ', h('b', {}, 'Year › Month'), ' · Values: ', h('b', {}, `${n.budget}, ${n.forecast}, ${n.actual}`), '.'),
      h('li', {}, 'Add input rows or columns to adjust the budget; set a writeback destination to keep the planners\' numbers in a SQL database.')),
    h('div', { class: 'row', style: { marginTop: '10px' } }, go, change, it ? h('a', { class: 'btn', href: it.url, target: '_blank', rel: 'noopener' }, 'Open plan ↗') : null),
    it?.semanticModelId && it.semanticModelId !== store.project.semanticModel?.id ? h('div', { class: 'banner err mt' }, h('div', {}, h('b', {}, 'The plan points to a semantic model that no longer exists. '),
      `${model} was created again since the plan was made. Select Check the plan to recreate the plan on the current model.`)) : null,
    it?.connected ? h('div', { class: 'banner warn mt' }, h('div', {}, h('b', {}, 'Plan says "Can\'t access the semantic model"? '),
      `The sign-in saved in "${it.connectionName}" can't open ${model} in ${wsName}. Pick "Choose it in Fabric when the plan opens" above and select Change the connection, then open the plan and connect with your own sign-in – or select Manage Semantic Model Connection in the plan and sign in again.`)) : null,
    h('p', { class: 'tiny muted' }, `The studio works as ${me}. Planners need Contributor or higher in ${wsName} (Viewers can look but not plan), and XMLA endpoints enabled for the tenant and set to Read Only or Read Write on the capacity (F SKU or Premium).`),
    job);
  return card;
}

async function startJob(path, payload, container, doneText) {
  const j = await post(path, payload);
  app.watchJob(j.id);
  const render = (x) => { container.querySelector(':scope > .jobcard-slot')?.remove(); container.append(h('div', { class: 'jobcard-slot mt' }, app.jobCard(x))); };
  render(j);
  const off = on('job', (e) => {
    if (e.job.id !== j.id) return;
    render(e.job);
    if (e.job.status !== 'running') { off(); if (e.job.status === 'succeeded') { toast(doneText, 'ok'); if (path === '/jobs/planning') draft.preview = null; app.refresh(); } }
  });
}
