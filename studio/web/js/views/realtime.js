import { store, get, post, patch, del, on } from '../api.js';
import { h, toast, busy, field, input, select, fmtNum, confirmDialog } from '../ui.js';
import { app, copilotSlot } from '../app.js';

// Live events → Eventstream → Eventhouse → Real-Time Dashboard. The view keeps one subscription to the simulator's
// progress and refreshes the Eventhouse numbers while it is open.
let offSim = null;
// Element.append() would print null/false as text; h() already skips them.
const put = (el, ...kids) => el.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
let pollTimer = null;

const money = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const ago = (iso) => {
  if (!iso) return '–';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function renderRealtime(el) {
  offSim?.(); offSim = null;
  clearInterval(pollTimer); pollTimer = null;
  const p = store.project || {};
  if (!p.workspace) {
    el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Select a workspace first. '), 'Live data goes into an Eventhouse in your workspace.'), h('button', { class: 'btn pri', onclick: () => app.go('workspace') }, 'Go to Workspace')));
    return;
  }
  const wrap = h('div', {}, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading the live data setup…'));
  el.append(wrap, copilotSlot());
  get('/realtime').then((s) => { store.realtime = s; draw(wrap, s); }).catch((e) => { wrap.innerHTML = ''; wrap.append(h('div', { class: 'banner err' }, e.message)); });
}

function draw(wrap, s) {
  wrap.innerHTML = '';
  const p = store.project || {};
  if (!s.available) {
    wrap.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Create the semantic model first. '), 'Live events are shaped like your data – the same products, customers, regions and amounts – so the studio reads them from your model.'), h('button', { class: 'btn pri', onclick: () => app.go('model') }, 'Go to Semantic model')));
    return;
  }
  const setup = s.setup;
  wrap.append(
    h('div', { class: 'card' },
      h('div', { class: 'row sp', style: { alignItems: 'flex-start' } },
        h('div', {}, h('h2', {}, 'Real-time intelligence'), h('p', { class: 'lead' }, 'Stream events shaped like your data through an Eventstream into an Eventhouse, watch them on an auto-refreshing Real-Time Dashboard, and ask Copilot what is happening right now.')),
        h('button', { class: 'btn ai', onclick: () => app.ask(setup ? 'What is happening in my live data right now? Use studio_realtime_status and studio_query_live_events, highlight business-rule breaks and where they come from.' : 'Explain what the Real-time step will create in my workspace (Eventhouse, table, Eventstream, dashboard) and what the live events will look like for my data.') }, setup ? '✦ Ask about live data' : '✦ Explain with Copilot'))),
    h('div', { class: 'grid g2', style: { marginTop: '14px', alignItems: 'start' } }, setupCard(s, p), simulatorCard(s)),
    h('div', { class: 'grid g2', style: { marginTop: '14px', alignItems: 'start' } }, dashboardCard(s), nowCard(s)),
    h('div', { class: 'grid g2', style: { marginTop: '14px', alignItems: 'start' } }, ontologyCard(s), alertsCard(s)),
    setup ? endpointCard(s) : null);
}

// ---------------- setup ----------------
function setupCard(s, p) {
  const st = s.setup;
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const job = h('div');
  if (!st) {
    const defName = `${(p.semanticModel?.name || 'Studio').replace(/\s+(semantic model|model)$/i, '').replace(/[^A-Za-z0-9_]+/g, '_')}_Live`;
    const name = input({ value: defName, placeholder: 'Letters, numbers and underscores' });
    const go = h('button', { class: 'btn pri', 'data-busy': 'Starting…' }, 'Set up live data');
    go.addEventListener('click', busy(go, async () => { await startJob('/jobs/realtime-setup', { name: name.value.trim() }, job, 'Live data is ready – start the events'); }));
    put(card, 
      h('h3', {}, '1 · Set up live data'),
      h('p', { class: 'small muted' }, `Creates an Eventhouse with a table shaped like your ${s.scenarioKind === 'generic' ? 'semantic model' : 'sample data'} and an Eventstream with a custom endpoint that feeds it. About 2 minutes.`),
      field('Eventhouse name', name),
      h('ul', { class: 'pre small' },
        h('li', {}, 'Eventhouse and KQL database (Real-Time Intelligence)'),
        h('li', {}, s.scenarioKind === 'adventureworks' ? 'SalesEvents table: internet and reseller order lines with real products, customers, resellers and territories'
          : s.scenarioKind === 'retail' ? 'SalesEvents table: store and online order lines with real products, customers and stores'
            : 'BusinessEvents table shaped like your main measure and its top dimensions'),
        h('li', {}, 'Eventstream with a custom endpoint (any app can send events to it)')),
      h('div', { class: 'row', style: { marginTop: '10px' } }, go), job);
    return card;
  }
  const remove = h('button', { class: 'btn ghost', title: 'Forget the live data setup or delete it from Fabric' }, 'Remove…');
  remove.addEventListener('click', async () => {
    const drop = await confirmDialog('Remove live data', `Delete the dashboard, the Eventstream ${st.eventstream.name} and the Eventhouse ${st.eventhouse.name} (with all events) from Fabric? Select Cancel to keep them.`, 'Delete from Fabric', true);
    if (!drop) return;
    try { await del('/realtime?delete=1'); toast('Live data removed', 'ok'); app.refresh(); } catch (e) { toast(e.message, 'err'); }
  });
  const rerun = h('button', { class: 'btn', 'data-busy': 'Starting…', title: 'Check the table and the Eventstream again' }, '↻ Check setup');
  rerun.addEventListener('click', busy(rerun, async () => { await startJob('/jobs/realtime-setup', { name: st.eventhouse.name }, job, 'Live data setup checked'); }));
  put(card, 
    h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, '1 · Live data'), h('span', { class: 'pill ok' }, 'Ready')),
    h('dl', { class: 'kv', style: { marginTop: '10px' } },
      h('dt', {}, 'Events'), h('dd', {}, st.scenario.label, h('div', { class: 'tiny muted' }, st.scenario.description)),
      h('dt', {}, 'Eventhouse'), h('dd', {}, h('a', { href: s.links.eventhouse, target: '_blank', rel: 'noopener' }, st.eventhouse.name, ' ↗')),
      h('dt', {}, 'Table'), h('dd', {}, h('a', { href: s.links.database, target: '_blank', rel: 'noopener' }, `${st.database.name}.${st.table}`, ' ↗'), h('div', { class: 'tiny muted' }, `${st.scenario.columns.length} columns: ${st.scenario.columns.map((c) => c.name).join(', ')}`)),
      h('dt', {}, 'Eventstream'), h('dd', {}, h('a', { href: s.links.eventstream, target: '_blank', rel: 'noopener' }, st.eventstream.name, ' ↗'), h('div', { class: 'tiny muted' }, 'Custom endpoint → Eventhouse')),
      h('dt', {}, 'Business rules'), h('dd', {}, h('div', { class: 'chips' }, st.scenario.rules.map((r) => h('span', { class: 'pill warn', title: r.description }, r.label))))),
    h('div', { class: 'row', style: { marginTop: '10px' } }, rerun, remove), job);
  return card;
}

// ---------------- simulator ----------------
function simulatorCard(s) {
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const sim = s.simulator;
  const ready = Boolean(s.setup);
  const rate = h('input', { type: 'range', min: s.limits.minRate, max: 300, step: 6, value: sim.rate || 60 });
  const rateV = h('b', {}, `${rate.value}/min`);
  const rules = h('input', { type: 'range', min: 0, max: 20, step: 1, value: sim.ruleBreakPct ?? 3 });
  const rulesV = h('b', {}, `${rules.value}%`);
  const minutes = select([15, 30, 60, 120, 240].map((m) => ({ value: m, label: m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`, selected: m === 60 })));
  let t = null;
  const live = () => { clearTimeout(t); t = setTimeout(() => { if (store.realtime?.simulator?.running) patch('/realtime/simulator', { rate: Number(rate.value), ruleBreakPct: Number(rules.value) }).catch(() => {}); }, 400); };
  rate.addEventListener('input', () => { rateV.textContent = `${rate.value}/min`; live(); });
  rules.addEventListener('input', () => { rulesV.textContent = `${rules.value}%`; live(); });
  const start = h('button', { class: 'btn pri', 'data-busy': 'Starting…', disabled: !ready || undefined, title: ready ? 'Send events to the Eventstream' : 'Set up live data first' }, '▶ Start events');
  start.addEventListener('click', busy(start, async () => {
    const r = await post('/realtime/simulator/start', { rate: Number(rate.value), ruleBreakPct: Number(rules.value), minutes: Number(minutes.value) });
    updateSim(r);
    toast(r.backfilling ? "Streaming – the last hour is filled first so the charts aren't empty" : 'Streaming live events', 'ok');
  }));
  const stop = h('button', { class: 'btn danger', 'data-busy': 'Stopping…' }, '■ Stop');
  stop.addEventListener('click', busy(stop, async () => { updateSim(await post('/realtime/simulator/stop')); }));
  const status = h('span', { class: 'pill' });
  const stats = h('div', { class: 'rtstats' });
  const recent = h('div');
  const note = h('div', { class: 'tiny muted' });
  put(card, 
    h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, '2 · Live events'), status),
    h('p', { class: 'small muted' }, 'Simulated events use real keys, names and prices from your data, with a share of business-rule breaks. They stop on their own.'),
    h('div', { class: 'grid', style: { gridTemplateColumns: '1fr 1fr', gap: '10px' } },
      field(h('span', {}, 'Events per minute ', rateV), rate),
      field(h('span', {}, 'Rule breaks ', rulesV), rules)),
    field('Stop after', minutes),
    h('div', { class: 'row', style: { marginTop: '10px' } }, start, stop), note, stats, recent);

  function updateSim(x) {
    store.realtime = { ...(store.realtime || {}), simulator: x };
    status.className = `pill ${x.running ? 'ok' : ''}`;
    status.textContent = x.running ? '● Streaming' : 'Stopped';
    start.hidden = x.running; stop.hidden = !x.running;
    note.textContent = x.running ? `Stops at ${new Date(x.stopsAt).toLocaleTimeString()} · ${x.rate} events per minute · ${x.ruleBreakPct}% rule breaks${x.backfilling ? ' · filling the last hour…' : x.backfilled ? ` · last hour filled with ${fmtNum(x.backfilled)} events` : ''}` : x.stopReason ? `Last run ${x.stopReason}${x.stoppedAt ? ` (${ago(x.stoppedAt)})` : ''}.` : '';
    if (x.lastError) note.append(h('div', { class: 'banner err', style: { marginTop: '8px' } }, x.lastError));
    stats.innerHTML = '';
    if (x.sent || x.running) {
      stats.append(...[
        ['Sent', fmtNum(x.sent)], ['Rule breaks', fmtNum(x.ruleBreaks)], ['Amount', money(x.amount)], ['Last batch', ago(x.lastSentAt)],
      ].map(([l, v]) => h('div', {}, h('span', { class: 'tiny muted' }, l), h('b', {}, v))));
    }
    recent.innerHTML = '';
    if (x.recent?.length) {
      recent.append(h('table', { class: 't', style: { marginTop: '10px' } },
        h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Channel'), h('th', {}, 'Item'), h('th', {}, 'Region'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Rule')),
        x.recent.slice(0, 6).map((e) => h('tr', {},
          h('td', {}, new Date(e.time).toLocaleTimeString()), h('td', {}, e.channel || ''), h('td', {}, e.item || ''), h('td', {}, e.region || ''),
          h('td', { class: 'num' }, money(e.amount)), h('td', {}, e.rule ? h('span', { class: 'pill err' }, e.rule) : '')))));
    }
  }
  updateSim(sim);
  offSim = on('realtime.simulator', (e) => { if (card.isConnected) updateSim(e.simulator); });
  return card;
}

// ---------------- dashboard ----------------
function dashboardCard(s) {
  const st = s.setup;
  const d = st?.dashboard;
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const job = h('div');
  const build = h('button', { class: 'btn pri', 'data-busy': 'Starting…', disabled: !st || undefined, title: st ? '' : 'Set up live data first' }, d ? '↻ Update dashboard' : 'Build dashboard');
  build.addEventListener('click', busy(build, async () => { await startJob('/jobs/realtime-dashboard', d ? { name: d.name } : {}, job, 'Real-Time Dashboard ready'); }));
  put(card, 
    h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, '3 · Real-Time Dashboard'), d ? h('span', { class: 'pill ok' }, 'Built') : h('span', { class: 'pill brand' }, 'Recommended')),
    h('p', { class: 'small muted' }, 'An auto-refreshing dashboard over the live table. Every tile query is checked against the Eventhouse before it is deployed.'),
    h('div', { class: 'rtpages' },
      h('div', {}, h('b', {}, 'Live overview'), h('span', { class: 'tiny muted' }, 'Orders, amount, margin and rule-break KPIs · amount per minute by channel · mix by category · regions · top items · latest events')),
      h('div', {}, h('b', {}, 'Business rules'), h('span', { class: 'tiny muted' }, 'A count per rule · share of events breaking a rule · loss below cost · breaks per minute · who breaks the rules · latest breaks to review'))),
    d ? h('dl', { class: 'kv', style: { marginTop: '10px' } },
      h('dt', {}, 'Dashboard'), h('dd', {}, h('a', { href: d.url, target: '_blank', rel: 'noopener' }, d.name, ' ↗')),
      h('dt', {}, 'Tiles'), h('dd', {}, `${d.tiles} on ${d.pages.length} pages · refreshes every ${d.refreshSeconds} seconds`),
      h('dt', {}, 'Built'), h('dd', {}, new Date(d.builtAt).toLocaleString())) : null,
    h('div', { class: 'row', style: { marginTop: '10px' } }, build, d ? h('a', { class: 'btn', href: d.url, target: '_blank', rel: 'noopener' }, 'Open dashboard ↗') : null,
      h('button', { class: 'btn ai', disabled: !st || undefined, onclick: () => app.ask('Build or update the Real-Time Dashboard for my live data with studio_create_realtime_dashboard, then tell me what each page shows.') }, '✦ With Copilot')),
    job);
  return card;
}

// ---------------- what's in the Eventhouse ----------------
function nowCard(s) {
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const st = s.setup;
  const body = h('div');
  const label = st?.scenario.columns.find((c) => c.role === 'amount')?.label || 'Amount';
  put(card, h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, 'In the Eventhouse now'), h('span', { class: 'tiny muted' }, 'Last 15 minutes · KQL')), body);
  if (!st) { body.append(h('p', { class: 'small muted' }, 'Numbers appear here once live data is set up and events arrive (usually within 30 seconds).')); return card; }
  body.append(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Querying the Eventhouse…'));
  const load = async (first = false) => {
    if (!first && !card.isConnected) { clearInterval(pollTimer); return; }
    try {
      const r = await get('/realtime/summary?minutes=15');
      body.innerHTML = '';
      body.append(h('div', { class: 'rtstats big' }, [
        ['Events', fmtNum(r.Events || 0)], ...(r.Orders !== undefined ? [['Orders', fmtNum(r.Orders || 0)]] : []), [label, money(r.Amount || 0)], ['Rule breaks', fmtNum(r.RuleBreaks || 0)],
      ].map(([l, v]) => h('div', {}, h('span', { class: 'tiny muted' }, l), h('b', {}, v)))),
      h('div', { class: 'tiny muted', style: { marginTop: '8px' } }, `${fmtNum(r.Total || 0)} events in total · last event ${ago(r.LastEvent)} · last ingested ${ago(r.LastIngested)}`));
    } catch (e) { body.innerHTML = ''; body.append(h('div', { class: 'banner err' }, e.message)); }
  };
  load(true);
  pollTimer = setInterval(load, 15000);
  return card;
}

// ---------------- live ontology ----------------
function ontologyCard(s) {
  const st = s.setup;
  const ont = s.ontology;
  const lo = st?.ontology;
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const job = h('div');
  const keys = (st?.scenario.columns || []).filter((c) => /(key|id)$/i.test(c.name) && c.role !== 'order').map((c) => c.name);
  const ready = Boolean(st && ont);
  const connect = h('button', { class: 'btn pri', 'data-busy': 'Starting…', disabled: !ready || undefined, title: !st ? 'Set up live data first' : !ont ? 'Create the ontology first' : '' }, lo ? '↻ Update live properties' : 'Connect live events');
  connect.addEventListener('click', busy(connect, async () => { await startJob('/jobs/realtime-ontology', {}, job, 'Live events are part of the ontology'); }));
  const unlink = h('button', { class: 'btn ghost', 'data-busy': 'Starting…' }, 'Remove live properties');
  unlink.addEventListener('click', busy(unlink, async () => {
    if (!(await confirmDialog('Remove live properties', `Take the live time-series properties and the dashboard link off the entity types in ${ont.name}? The events stay in the Eventhouse.`, 'Remove'))) return;
    await startJob('/jobs/realtime-ontology', { unlink: true }, job, 'Live properties removed');
  }));
  put(card, 
    h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, '4 · Live ontology'), lo ? h('span', { class: 'pill ok' }, 'Connected') : ready ? h('span', { class: 'pill brand' }, 'Recommended') : h('span', { class: 'pill' }, ont ? 'Needs live data' : 'Needs an ontology')),
    h('p', { class: 'small muted' }, 'Adds the live events to your ontology as time-series properties of the entity types they mention – each product, customer, reseller or region gets its live sales, discounts, margins and rule breaks – and links the Real-Time Dashboard from them. Agents and people exploring the ontology see history and live data together.'),
    !ont ? h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Create the ontology first. '), 'The live properties are added to its entity types.'), h('button', { class: 'btn', onclick: () => app.go('ontology') }, 'Go to Ontology')) : null,
    lo ? h('dl', { class: 'kv', style: { marginTop: '10px' } },
      h('dt', {}, 'Ontology'), h('dd', {}, h('a', { href: s.links.ontology, target: '_blank', rel: 'noopener' }, ont?.name || lo.name, ' ↗')),
      h('dt', {}, 'Entity types'), h('dd', {}, h('div', { class: 'chips' }, lo.entities.map((e) => h('span', { class: 'pill ok', title: `${st.table}.${e.eventColumn} → ${e.key}\n${e.properties.join(', ')}` }, `${e.entity} · ${e.properties.length}`)))),
      h('dt', {}, 'Properties'), h('dd', {}, h('span', { class: 'small' }, lo.entities[0]?.properties.join(', ') || '–'), h('div', { class: 'tiny muted' }, 'Time series ordered by event time, read live from the Eventhouse')),
      h('dt', {}, 'Dashboard link'), h('dd', {}, lo.dashboardLinked ? 'On each entity type' : h('span', { class: 'muted' }, 'Build the dashboard, then update to link it')),
      h('dt', {}, 'Updated'), h('dd', {}, new Date(lo.linkedAt).toLocaleString()))
      : st ? h('ul', { class: 'pre small' },
        h('li', {}, keys.length ? `Matches entity keys to the event columns ${keys.join(', ')}` : 'Matches entity keys to the event columns'),
        h('li', {}, 'One Eventhouse-backed table and join per entity type, no data copied'),
        h('li', {}, 'Also lets Fabric preview the instances of every entity type')) : null,
    h('div', { class: 'row', style: { marginTop: '10px' } }, connect, lo ? unlink : null, s.links?.ontology ? h('a', { class: 'btn', href: s.links.ontology, target: '_blank', rel: 'noopener' }, 'Open ontology ↗') : null,
      h('button', { class: 'btn ai', disabled: !ready || undefined, onclick: () => app.ask('Connect my live events to the ontology with studio_connect_live_ontology, then explain which entity types got live properties and how to use them.') }, '✦ With Copilot')),
    job);
  return card;
}

// ---------------- Activator alerts ----------------
function alertsCard(s) {
  const st = s.setup;
  const a = st?.alerts;
  const card = h('div', { class: 'card', style: { marginTop: 0 } });
  const job = h('div');
  const amountLabel = st?.scenario.columns.find((c) => c.role === 'amount')?.label || 'Amount';
  const channel = select([{ value: 'teams', label: 'Teams message', selected: (a?.channel || 'teams') === 'teams' }, { value: 'email', label: 'Email', selected: a?.channel === 'email' }]);
  const recipients = input({ value: (a?.recipients || [store.user?.upn].filter(Boolean)).join(', '), placeholder: 'name@contoso.com, …' });
  const minAmount = input({ type: 'number', min: 0, step: 100, value: a?.minAmount || 0 });
  const rules = (st?.scenario.rules || []).map((r) => ({ r, cb: h('input', { type: 'checkbox', checked: (!a || a.rules.includes(r.label)) || undefined }) }));
  const volume = h('div', { class: 'tiny muted' });
  const estimate = () => {
    const sim = store.realtime?.simulator || s.simulator;
    const share = rules.length ? rules.filter((x) => x.cb.checked).length / rules.length : 1;
    const perMin = (sim.rate || 60) * ((sim.ruleBreakPct ?? 3) / 100) * share;
    volume.textContent = `With ${sim.rate || 60} simulated events per minute and ${sim.ruleBreakPct ?? 3}% rule breaks, expect about ${perMin < 1 ? 'one message every few minutes' : `${Math.round(perMin)} message${Math.round(perMin) === 1 ? '' : 's'} per minute`}${Number(minAmount.value) > 0 ? ' (fewer with the amount filter)' : ''}.`;
  };
  rules.forEach((x) => x.cb.addEventListener('change', estimate));
  minAmount.addEventListener('input', estimate);
  estimate();
  const save = h('button', { class: 'btn pri', 'data-busy': 'Starting…', disabled: !st || undefined, title: st ? '' : 'Set up live data first' }, a ? '↻ Update alerts' : 'Create alerts');
  save.addEventListener('click', busy(save, async () => {
    const picked = rules.filter((x) => x.cb.checked).map((x) => x.r.id);
    if (!picked.length) throw new Error('Pick at least one business rule.');
    await startJob('/jobs/realtime-alerts', { channel: channel.value, recipients: recipients.value, rules: picked, minAmount: Number(minAmount.value) || 0 }, job, 'Activator alerts are running');
  }));
  const remove = h('button', { class: 'btn ghost', 'data-busy': 'Removing…' }, 'Remove alerts');
  remove.addEventListener('click', busy(remove, async () => {
    if (!(await confirmDialog('Remove alerts', `Delete the Activator ${a.name} from Fabric? No more messages are sent.`, 'Delete', true))) return;
    await del('/realtime/alerts');
    toast('Alerts removed', 'ok');
    app.refresh();
  }));
  put(card, 
    h('div', { class: 'row sp' }, h('h3', { style: { margin: 0 } }, '5 · Alerts on rule breaks'), a ? h('span', { class: 'pill ok' }, '● Running') : st ? h('span', { class: 'pill brand' }, 'Recommended') : h('span', { class: 'pill' }, 'Needs live data')),
    h('p', { class: 'small muted' }, 'A Fabric Activator checks the live events every minute and sends a message for each business-rule break, with the order, buyer, region, amount and discount – so the right people act while it matters.'),
    a ? h('dl', { class: 'kv', style: { marginTop: '10px' } },
      h('dt', {}, 'Activator'), h('dd', {}, h('a', { href: s.links.activator, target: '_blank', rel: 'noopener' }, a.name, ' ↗')),
      h('dt', {}, 'Sends'), h('dd', {}, `${a.channel === 'email' ? 'Email' : 'Teams message'} to ${a.recipients.length} recipient${a.recipients.length === 1 ? '' : 's'}${a.minAmount ? ` · ${amountLabel} ≥ ${money(a.minAmount)}` : ''}`),
      h('dt', {}, 'Rules'), h('dd', {}, h('div', { class: 'chips' }, a.rules.map((r) => h('span', { class: 'pill warn' }, r)))),
      h('dt', {}, 'Updated'), h('dd', {}, new Date(a.updatedAt).toLocaleString())) : null,
    st ? h('div', { class: 'grid', style: { gridTemplateColumns: '1fr 2fr', gap: '10px', marginTop: '10px' } }, field('Send as', channel), field('Recipients', recipients, 'Email addresses, separated by commas')) : null,
    st ? h('div', { class: 'f' }, 'Business rules', h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '12px' } }, rules.map(({ r, cb }) => h('label', { class: 'row small', title: r.description }, cb, r.label)))) : null,
    st ? field(`Only when ${amountLabel.toLowerCase()} is at least`, minAmount, '0 alerts on every rule break') : null,
    st ? volume : null,
    h('div', { class: 'row', style: { marginTop: '10px' } }, save, a ? remove : null, a ? h('a', { class: 'btn', href: s.links.activator, target: '_blank', rel: 'noopener' }, 'Open Activator ↗') : null,
      h('button', { class: 'btn ai', disabled: !st || undefined, onclick: () => app.ask('Set up Activator alerts on my live business-rule breaks with studio_create_live_alerts. Ask me for the channel and recipients first, and suggest a minimum amount if the event rate is high.') }, '✦ With Copilot')),
    job);
  return card;
}

// ---------------- your own apps ----------------
function endpointCard() {
  const card = h('div', { class: 'card' });
  const body = h('div');
  const show = h('button', { class: 'btn', 'data-busy': 'Loading…' }, 'Show endpoint');
  show.addEventListener('click', busy(show, async () => {
    const e = await get('/realtime/endpoint');
    body.innerHTML = '';
    const secret = h('code', { class: 'secret' }, '••••••••••••••••');
    const reveal = h('button', { class: 'btn', 'data-busy': '…' }, 'Copy connection string');
    reveal.addEventListener('click', busy(reveal, async () => {
      const k = await get('/realtime/endpoint?key=1');
      await navigator.clipboard.writeText(k.connectionString);
      toast('Connection string copied – keep it secret', 'ok');
    }));
    const sample = {}; for (const c of e.columns) sample[c.name] = c.type === 'datetime' ? new Date().toISOString() : ['int', 'long', 'real'].includes(c.type) ? 0 : '…';
    body.append(
      h('dl', { class: 'kv' },
        h('dt', {}, 'Namespace'), h('dd', {}, h('code', {}, e.namespace)),
        h('dt', {}, 'Event hub'), h('dd', {}, h('code', {}, e.eventHub)),
        h('dt', {}, 'Key name'), h('dd', {}, h('code', {}, e.keyName)),
        h('dt', {}, 'Connection string'), h('dd', {}, secret, ' ', reveal)),
      h('p', { class: 'tiny muted' }, `Send JSON events (Event Hubs or Kafka protocol) with these columns to land them in ${e.table}:`),
      h('pre', { class: 'code' }, JSON.stringify(sample, null, 2)));
    show.hidden = true;
  }));
  put(card, 
    h('div', { class: 'row sp' },
      h('div', {}, h('h3', { style: { margin: 0 } }, 'Stream your own events'), h('p', { class: 'small muted', style: { margin: '4px 0 0' } }, 'Point an app, device or service at the Eventstream\'s custom endpoint. Events with the same columns appear on the same dashboard. The connection string is a secret: it is never shown to Copilot.')),
      show),
    body);
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
    if (e.job.status !== 'running') { off(); if (e.job.status === 'succeeded') { toast(doneText, 'ok'); app.refresh(); } }
  });
}
