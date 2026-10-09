import { get } from '../api.js';
import { h, toast, busy, fmtDate } from '../ui.js';
import { md } from '../md.js';

let state = null;
let selected = '';
let installOpened = false;

const money = (v) => Number.isFinite(Number(v)) ? Number(v).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : 'n/a';
const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v).toLocaleString(undefined, { maximumFractionDigits: d }) : '–';
const pct = (v) => `${num(v, Math.abs(v) < 10 ? 1 : 0)}%`;
const hrs = (s) => `${num(Number(s || 0) / 3600, 1)} h`;
const short = (s, n = 44) => String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || '');
const chart = (c) => h('div', { html: md(`\`\`\`studio-chart\n${JSON.stringify(c)}\n\`\`\``) });

async function load({ fresh = false } = {}) {
  if (state && !fresh) return state;
  const q = selected ? `?capacityId=${encodeURIComponent(selected)}` : '';
  state = await get(`/costs${q}`);
  selected = state.selectedCapacityId || selected;
  return state;
}

function card(title, value, note, kind = '') {
  return h('div', { class: `kpi ${kind}` }, h('div', { class: 'kl' }, title), h('div', { class: 'kvv' }, value), note ? h('div', { class: 'tiny muted' }, note) : null);
}

function simpleTable(cols, rows, empty = 'No rows') {
  if (!rows?.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'scroll' }, h('table', { class: 't' },
    h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label))),
    rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : r[c.key]))))));
}

function rankList({ title, subtitle, rows, label, value, meta, empty = 'No rows found.' }) {
  const max = Math.max(...(rows || []).map((r) => Number(value(r)) || 0), 0);
  return h('div', { class: 'card compact' },
    h('h2', {}, title),
    subtitle ? h('p', { class: 'lead' }, subtitle) : null,
    rows?.length ? h('div', { class: 'ranklist' }, rows.slice(0, 10).map((r, i) => {
      const v = Number(value(r)) || 0;
      return h('div', { class: 'rank' },
        h('div', { class: 'rhead' }, h('b', {}, label(r)), h('span', {}, num(v))),
        meta ? h('div', { class: 'tiny muted' }, meta(r)) : null,
        h('div', { class: 'rbar' }, h('i', { style: { width: `${max ? Math.max(3, v / max * 100) : 0}%` } })),
        i === 0 ? h('div', { class: 'tiny muted' }, 'Largest contributor in this list') : null);
    })) : h('div', { class: 'empty' }, empty));
}

function operationEvidence(rows) {
  if (!rows?.length) return null;
  return h('div', { class: 'evidence' },
    rows.slice(0, 4).map((r) => h('div', {},
      h('b', {}, short(r.key, 32)),
      h('span', {}, [
        r.topItem ? short(r.topItem, 34) : 'No artifact name',
        r.topItemKind,
        r.topWorkspace && r.topWorkspace !== r.topItem ? short(r.topWorkspace, 30) : null,
        `${num(r.cu)} CU seconds`,
      ].filter(Boolean).join(' · ')))));
}

function visualSummary(s) {
  const x = s.summary;
  if (!x) return null;
  const kindRows = x.byKind.slice(0, 6).map((r) => ({ Type: r.key, 'CU seconds': r.cu }));
  const costRows = s.pricing?.available ? [
    { Option: 'Pay-as-you-go', Monthly: s.pricing.paygMonthly },
    { Option: 'Reservation', Monthly: s.pricing.reservationMonthly },
    { Option: 'Estimated savings', Monthly: s.pricing.reservationSavingsMonthly },
  ] : [];
  const topOps = x.byOperation.slice(0, 6).map((r) => ({ Operation: r.key, 'CU seconds': r.cu }));
  return h('div', { class: 'visual-summary' },
    kindRows.length ? h('div', { class: 'card visual' },
      chart({ type: 'donut', title: 'CU mix by workload type', subtitle: 'Which Fabric workload family is using capacity.', x: 'Type', y: 'CU seconds', rows: kindRows }),
      h('div', { class: 'vnote' }, `Largest: ${kindRows[0].Type} (${num(kindRows[0]['CU seconds'])} CU seconds)`)) : null,
    topOps.length ? h('div', { class: 'card visual' },
      chart({ type: 'horizontalBar', title: 'Top operation types', subtitle: 'The kind of work creating the most load.', x: 'Operation', y: ['CU seconds'], rows: topOps, maxRows: 6 }),
      h('div', { class: 'vnote' }, `Start with ${topOps[0].Operation}. The details below show the artifact and workspace behind each operation.`),
      operationEvidence(x.byOperation)) : null,
    costRows.length ? h('div', { class: 'card visual' },
      chart({ type: 'horizontalBar', title: 'Cost comparison', subtitle: 'Always-on monthly estimate for this capacity.', x: 'Option', y: ['Monthly'], format: { Monthly: 'currency' }, rows: costRows }),
      h('div', { class: 'vnote' }, `Reservation estimate saves about ${money(s.pricing.reservationSavingsMonthly)} per month if this capacity stays on.`)) : null);
}

function installCard(el, s) {
  if (s.status === 'missing-app' && !installOpened) {
    installOpened = true;
    setTimeout(() => {
      const w = window.open(s.install.url, '_blank', 'noopener');
      toast(w ? 'Opened the Microsoft Fabric Capacity Metrics install flow.' : 'Your browser blocked the install window. Select Install app to continue.', w ? 'ok' : 'err');
    }, 600);
  }
  el.append(h('div', { class: 'banner warn' },
    h('div', { style: { flex: 1 } },
      h('b', {}, s.status === 'missing-app' ? 'Install the Capacity Metrics app. ' : 'Connect the Capacity Metrics app. '),
      s.message || 'The metrics app needs to be installed and connected before the dashboard can show utilization.',
      h('div', { class: 'tiny muted mt' }, 'The studio opens the supported Microsoft install flow. Microsoft still asks a capacity admin to finish Install/Connect in Fabric.')),
    h('a', { class: 'btn pri', href: s.install.url, target: '_blank', rel: 'noopener' }, s.status === 'missing-app' ? 'Install app ↗' : 'Open setup ↗')));
}

function costCard(s) {
  const c = s.selectedCapacity;
  const p = s.pricing || {};
  const rows = p.available ? [
    ['Capacity', `${c.name} · ${c.sku} · ${p.cu} CU`],
    ['Pay-as-you-go if always on', `${money(p.paygMonthly)} / month (${money(p.hourly)} / hour)`],
    ['1-year reservation estimate', `${money(p.reservationMonthly)} / month`],
    ['Estimated reservation savings', `${money(p.reservationSavingsMonthly)} / month (~41%)`],
  ] : [
    ['Capacity', c ? `${c.name} · ${c.sku || 'SKU unknown'}` : 'No capacity selected'],
    ['Price lookup', p.reason || 'Pricing is not available.'],
  ];
  return h('div', { class: 'card' },
    h('h2', {}, 'Cost view'),
    h('p', { class: 'lead' }, 'A simple estimate for an always-on capacity. Your actual bill can be lower if you pause pay-as-you-go capacities, and higher if overage or storage is used.'),
    h('table', { class: 't' }, rows.map(([a, b]) => h('tr', {}, h('th', {}, a), h('td', {}, b)))),
    h('p', { class: 'tiny muted' }, p.note || 'For exact regional prices, open Azure pricing.', ' ', h('a', { href: s.pricingPage, target: '_blank', rel: 'noopener' }, 'Azure pricing ↗')));
}

function recommendations(s) {
  const r = s.summary?.recommendations || [];
  return h('div', { class: 'card' },
    h('h2', {}, 'What to do next'),
    h('p', { class: 'lead' }, 'Plain-English recommendations based on utilization, smoothing, overage and the biggest consumers.'),
    h('ol', { class: 'pre' }, r.map((x) => h('li', {}, x))),
    h('div', { class: 'banner', style: { marginTop: '12px' } }, h('div', {}, h('b', {}, 'How to improve utilization. '), 'Tune or move the heaviest items first, separate background refresh windows, avoid overlapping long-running jobs, pause dev/test capacity when not used, and reserve only the stable always-on baseline.')));
}

function overview(el, s) {
  const x = s.summary;
  const cap = s.selectedCapacity;
  const hasTime = Boolean(x?.timeline?.length);
  const hasCarry = Boolean(x?.overage?.some((r) => r.add || r.burndown || r.cumulative));
  const totalCuHours = (x?.byItem || []).reduce((a, r) => a + Number(r.cu || 0), 0) / 3600;
  const topItem = x?.byItem?.[0];
  const sel = h('select', { class: 'i', style: { maxWidth: '360px' }, onchange: async (e) => { selected = e.target.value; state = null; await renderCosts(el); } },
    s.capacities.map((c) => h('option', { value: c.id, selected: c.id === s.selectedCapacityId || undefined }, `${c.name || c.id} · ${c.sku || '?'} · ${c.state || '?'}`)));
  el.append(h('div', { class: 'card' },
    h('div', { class: 'row sp' },
      h('div', {}, h('h1', {}, 'Costs & utilization'), h('p', { class: 'lead' }, 'A friendly view of capacity health, heavy hitters, smoothing/overage, and cost choices.')),
      h('div', { class: 'row' }, sel, h('button', { class: 'btn', 'data-busy': 'Refreshing…', onclick: busy(null, async () => { state = null; await renderCosts(el); }) }, '↻ Refresh'), s.metricsApp?.reportUrl ? h('a', { class: 'btn', href: s.metricsApp.reportUrl, target: '_blank', rel: 'noopener' }, 'Open Capacity Metrics ↗') : h('a', { class: 'btn', href: s.install.url, target: '_blank', rel: 'noopener' }, 'Install metrics app ↗'))),
    h('div', { class: 'grid g4 mt cost-kpis' },
      card('Capacity', `${cap?.name || 'Unknown'} · ${cap?.sku || '?'}`, cap?.state || ''),
      card('CU used', x ? `${num(totalCuHours, 1)} CU-hours` : '–', 'From item history in Capacity Metrics'),
      hasTime
        ? card('Peak usage', pct(x.peak), x.peak > 100 ? 'Above the capacity line' : 'Highest recent point', x.peak > 100 ? 'bad' : '')
        : card('Timepoint usage', 'Not available', 'Metrics app has no timepoint rows yet', 'warn'),
      hasCarry
        ? card('Carry-forward', pct(x.maxCarry), 'Work is being paid back', 'warn')
        : card('Top item', topItem ? short(topItem.item, 24) : 'None found', topItem ? `${num(topItem.cu)} CU seconds` : 'No item history rows'))));
}

function charts(el, s) {
  const x = s.summary;
  if (!x) return;
  const timeline = x.timeline.slice(-80).map((r) => ({ Time: new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), Interactive: r.interactive, Background: r.background, Limit: r.limit }));
  const over = x.overage.slice(-80).map((r) => ({ Time: new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), Add: r.add, Burndown: r.burndown, Cumulative: r.cumulative }));
  const hasOver = over.some((r) => r.Add || r.Burndown || r.Cumulative);
  const hasMix = x.interactiveCu || x.backgroundCu;
  const noSeries = h('div', { class: 'empty' }, 'The Capacity Metrics app has no timepoint rows for this capacity yet. Refresh/connect the app in Fabric; the heavy-hitter tables below can still use the item history data.');
  const visual = visualSummary(s);
  if (visual) el.append(visual);
  el.append(h('div', { class: 'grid g2' },
    h('div', { class: 'card' }, timeline.length ? chart({ type: 'area', title: 'Capacity usage over time', subtitle: 'Interactive and background CU seconds. The limit line is the 30-second allowance.', x: 'Time', y: ['Interactive', 'Background', 'Limit'], rows: timeline }) : [h('h2', {}, 'Capacity usage over time'), noSeries]),
    h('div', { class: 'card' }, hasOver ? chart({ type: 'line', title: 'Smoothing / overage carry-forward', subtitle: 'If cumulative carry-forward rises, future work may be delayed or billed as overage.', x: 'Time', y: ['Add', 'Burndown', 'Cumulative'], rows: over }) : [h('h2', {}, 'Smoothing / overage carry-forward'), h('div', { class: 'empty' }, 'No overage/carry-forward was found for this capacity. That means there is no visible backlog being paid back in the metrics app data.')]),
    h('div', { class: 'card' }, hasMix ? chart({ type: 'donut', title: 'User vs background work', subtitle: 'Interactive means user-triggered; background means refresh/jobs/scheduled work.', x: 'Type', y: 'CU seconds', rows: [{ Type: 'User-triggered', 'CU seconds': x.interactiveCu }, { Type: 'Background', 'CU seconds': x.backgroundCu }] }) : [h('h2', {}, 'User vs background work'), h('div', { class: 'empty' }, 'No timepoint detail rows were found for user/background split. The item-history heavy hitters below still show what consumed the most CUs.')])));
  el.append(h('div', { class: 'grid g3' },
    rankList({ title: 'Top workspaces', subtitle: 'Where the capacity is being spent.', rows: x.byWorkspace, label: (r) => short(r.key, 40), value: (r) => r.cu, meta: (r) => `${num(r.operations)} operations · ${num(r.users)} users` }),
    rankList({ title: 'Heavy-hitter items', subtitle: 'The individual items to investigate first.', rows: x.byItem, label: (r) => short(r.item, 42), value: (r) => r.cu, meta: (r) => `${r.itemKind} · ${short(r.workspace, 34)}` }),
    rankList({ title: 'Users and service principals', subtitle: 'Who triggered the most consuming work when user detail is available.', rows: x.byUser, label: (r) => short(r.key, 44), value: (r) => r.cu, meta: (r) => `${num(r.operations)} operations`, empty: 'No user-level detail rows found. The metrics app sometimes keeps only item history for older periods.' })));
}

function detailTables(el, s) {
  const x = s.summary;
  if (!x) return;
  const itemCols = [
    { label: 'Item', render: (r) => h('div', {}, h('b', {}, short(r.item, 58)), h('div', { class: 'tiny muted' }, `${r.itemKind} · ${r.workspace}`)) },
    { label: 'CU seconds', num: true, render: (r) => num(r.cu) },
    { label: 'Duration', num: true, render: (r) => hrs(r.duration) },
    { label: 'Operations', num: true, render: (r) => num(r.operations) },
  ];
  const opCols = [
    { label: 'Operation', render: (r) => r.key },
    { label: 'Top artifact', render: (r) => h('div', {}, h('b', {}, short(r.topItem || 'Unknown item', 46)), h('div', { class: 'tiny muted' }, [r.topItemKind, r.topWorkspace].filter(Boolean).join(' · '))) },
    { label: 'CU seconds', num: true, render: (r) => num(r.cu) },
    { label: 'Operations', num: true, render: (r) => num(r.operations) },
  ];
  el.append(h('div', { class: 'grid g2' },
    h('div', { class: 'card' }, h('h2', {}, 'Most expensive items'), h('p', { class: 'lead' }, 'Start here: these are the items to tune, reschedule or scale around.'), simpleTable(itemCols, x.byItem)),
    h('div', { class: 'card' }, h('h2', {}, 'Most expensive operation types'), h('p', { class: 'lead' }, 'This explains what kind of work is consuming the capacity.'), simpleTable(opCols, x.byOperation)),
    h('div', { class: 'card' }, h('h2', {}, 'Workspace leaderboard'), simpleTable([{ label: 'Workspace', key: 'key' }, { label: 'CU seconds', num: true, render: (r) => num(r.cu) }, { label: 'Operations', num: true, render: (r) => num(r.operations) }], x.byWorkspace)),
    h('div', { class: 'card' }, h('h2', {}, 'Item type mix'), simpleTable([{ label: 'Type', key: 'key' }, { label: 'CU seconds', num: true, render: (r) => num(r.cu) }, { label: 'Operations', num: true, render: (r) => num(r.operations) }], x.byKind))));
}

export async function renderCosts(el) {
  el.innerHTML = '';
  el.append(h('div', { class: 'card' }, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading capacity usage and cost data…')));
  try {
    const s = await load({ fresh: true });
    el.innerHTML = '';
    overview(el, s);
    if (s.status !== 'ok') {
      installCard(el, s);
      el.append(costCard(s));
      return;
    }
    el.append(h('div', { class: 'tiny muted mb' }, `Metrics from ${s.metricsApp.name}. Last read ${fmtDate(s.lastRefresh)}. Capacity Metrics data can lag refreshes by a few minutes.`));
    charts(el, s);
    el.append(recommendations(s), costCard(s));
    detailTables(el, s);
  } catch (e) {
    el.innerHTML = '';
    el.append(h('div', { class: 'banner err' }, e.message));
    toast(e.message, 'err');
  }
}
