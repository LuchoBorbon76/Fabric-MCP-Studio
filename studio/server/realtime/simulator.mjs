// Live event simulator: streams events shaped like the project's data to the Eventstream's custom endpoint (Event Hubs
// protocol over HTTPS with a shared access signature). The endpoint key stays in memory in the studio process – it is
// never stored in the project, shown to Copilot or written to logs.
import { createHmac } from 'node:crypto';
import * as F from '../fabric.mjs';
import { emit } from '../events.mjs';
import { logActivity } from '../project.mjs';
import { scenarioSummary } from './scenarios.mjs';

const TICK_MS = 2000;
const MAX_BATCH = 250;
export const LIMITS = { minRate: 6, maxRate: 600, maxMinutes: 240, maxBackfillMinutes: 180 };

let sim = idle();
let conn = null; // { key: eventstreamId, ns, hub, keyName, key }

function idle() {
  return { running: false, startedAt: null, stopsAt: null, stoppedAt: null, stopReason: '', rate: 60, ruleBreakPct: 3, sent: 0, failed: 0, ruleBreaks: 0, amount: 0, batches: 0, lastSentAt: null, lastError: '', backfilled: 0, backfilling: false, recent: [], scenario: null };
}

export function simulatorStatus() {
  const { timer, scenarioObj, carry, failStreak, lastEmit, ...pub } = sim; // eslint-disable-line no-unused-vars
  return { ...pub, recent: pub.recent.slice(0, 12) };
}

function publish(force = false) {
  const now = Date.now();
  if (!force && now - (sim.lastEmit || 0) < 1500) return;
  sim.lastEmit = now;
  emit('realtime.simulator', { simulator: simulatorStatus() });
}

/** Custom endpoint connection of the Eventstream source (cached in memory only). */
export async function endpoint(rt, { refresh = false } = {}) {
  if (!refresh && conn?.eventstreamId === rt.eventstream.id) return conn;
  const topo = await F.fabric('GET', `/workspaces/${rt.workspaceId}/eventstreams/${rt.eventstream.id}/topology`);
  const src = topo?.sources?.find((s) => s.type === 'CustomEndpoint');
  if (!src) throw new Error('The Eventstream has no custom endpoint source. Run "Set up live data" again.');
  const c = await F.fabric('GET', `/workspaces/${rt.workspaceId}/eventstreams/${rt.eventstream.id}/sources/${src.id}/connection`);
  const parts = Object.fromEntries(String(c?.accessKeys?.primaryConnectionString || '').split(';').filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  if (!c?.fullyQualifiedNamespace || !parts.SharedAccessKey) throw new Error('Could not read the Eventstream custom endpoint. You need Contributor (or higher) on the workspace.');
  conn = { eventstreamId: rt.eventstream.id, sourceId: src.id, sourceName: src.name, ns: c.fullyQualifiedNamespace, hub: c.eventHubName || parts.EntityPath, keyName: parts.SharedAccessKeyName, key: parts.SharedAccessKey, connectionString: c.accessKeys.primaryConnectionString };
  return conn;
}

export function forgetEndpoint() { conn = null; }

function sas(uri, keyName, key, ttlSeconds = 3600) {
  const se = Math.floor(Date.now() / 1000) + ttlSeconds;
  const enc = encodeURIComponent(uri);
  const sig = createHmac('sha256', key).update(`${enc}\n${se}`).digest('base64');
  return `SharedAccessSignature sr=${enc}&sig=${encodeURIComponent(sig)}&se=${se}&skn=${encodeURIComponent(keyName)}`;
}

/** Send events to the custom endpoint in batches (Event Hubs REST "send batch"). */
export async function sendEvents(rt, events) {
  let c = await endpoint(rt);
  for (let i = 0; i < events.length; i += MAX_BATCH) {
    const chunk = events.slice(i, i + MAX_BATCH);
    for (let attempt = 1; ; attempt++) {
      const base = `https://${c.ns}/${c.hub}`;
      const res = await fetch(`${base}/messages?timeout=60&api-version=2014-01`, {
        method: 'POST',
        headers: { Authorization: sas(base, c.keyName, c.key), 'Content-Type': 'application/vnd.microsoft.servicebus.json' },
        body: JSON.stringify(chunk.map((e) => ({ Body: JSON.stringify(e) }))),
      });
      if (res.ok) break;
      const text = (await res.text()).slice(0, 300);
      if (res.status === 401 && attempt === 1) { c = await endpoint(rt, { refresh: true }); continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
      throw new Error(`The Eventstream endpoint rejected the events (${res.status}): ${text}`);
    }
  }
}

function track(events, scenario, { recent = true } = {}) {
  const R = Object.fromEntries(scenario.columns.filter((c) => c.role).map((c) => [c.role, c.name]));
  for (const e of events) {
    sim.sent++;
    if (R.amount) sim.amount += Number(e[R.amount]) || 0;
    if (R.rule && e[R.rule]) sim.ruleBreaks++;
  }
  if (!recent) return;
  const latest = events.slice(-6).reverse().map((e) => ({
    time: e[R.time], channel: R.channel ? e[R.channel] : '', item: R.item ? e[R.item] : '', party: R.party ? e[R.party] : '', region: R.region ? e[R.region] : '',
    amount: R.amount ? e[R.amount] : null, rule: R.rule ? e[R.rule] : '',
  }));
  sim.recent = [...latest, ...sim.recent].slice(0, 12);
}

/**
 * Start streaming. `scenario` is a loaded scenario (reference data in memory); `rt` the project's realtime setup.
 * rate = events per minute; minutes = auto-stop; backfillMinutes = history to send first so charts aren't empty.
 */
export async function startSimulator(rt, scenario, { rate = 60, ruleBreakPct = 3, minutes = 60, backfillMinutes = 0 } = {}) {
  if (sim.running) stopSimulator('restarted');
  rate = Math.min(LIMITS.maxRate, Math.max(LIMITS.minRate, Math.round(Number(rate) || 60)));
  ruleBreakPct = Math.min(50, Math.max(0, Number(ruleBreakPct) || 0));
  minutes = Math.min(LIMITS.maxMinutes, Math.max(1, Math.round(Number(minutes) || 60)));
  backfillMinutes = Math.min(LIMITS.maxBackfillMinutes, Math.max(0, Math.round(Number(backfillMinutes) || 0)));
  await endpoint(rt);
  sim = { ...idle(), running: true, startedAt: new Date().toISOString(), stopsAt: new Date(Date.now() + minutes * 60000).toISOString(), rate, ruleBreakPct, scenario: scenarioSummary(scenario), scenarioObj: scenario, carry: 0, failStreak: 0, backfilling: backfillMinutes > 0 };
  const run = sim;
  logActivity('realtime.start', `Started live events: ${rate} ${scenario.unit}s per minute, ${ruleBreakPct}% rule breaks, stops after ${minutes} min`, {});

  // History first (in the background) so the dashboard's charts aren't empty; live events start right away.
  if (backfillMinutes) {
    const total = Math.min(6000, Math.round((rate / 2) * backfillMinutes));
    const events = [];
    const from = Date.now() - backfillMinutes * 60000;
    while (events.length < total) {
      const at = new Date(from + Math.random() * backfillMinutes * 60000);
      events.push(...scenario.makeOrder(at, { ruleBreakPct }));
    }
    events.sort((a, b) => String(a.EventTime).localeCompare(String(b.EventTime)));
    sendEvents(rt, events)
      .then(() => { if (sim === run) { run.backfilled = events.length; track(events, scenario, { recent: false }); } })
      .catch((e) => { if (sim === run) run.lastError = `Could not fill the last ${backfillMinutes} minutes: ${e.message}`; })
      .finally(() => { if (sim === run) { run.backfilling = false; publish(true); } });
  }

  const tick = async () => {
    if (!sim.running) return;
    if (Date.now() >= Date.parse(sim.stopsAt)) { stopSimulator('time limit reached'); return; }
    sim.carry += (sim.rate * TICK_MS) / 60000;
    const due = Math.floor(sim.carry);
    if (due < 1) return;
    const events = [];
    const now = Date.now();
    while (events.length < due) events.push(...scenario.makeOrder(new Date(now - Math.random() * TICK_MS), { ruleBreakPct: sim.ruleBreakPct }));
    sim.carry -= events.length;
    try {
      await sendEvents(rt, events);
      sim.batches++;
      sim.failStreak = 0;
      sim.lastSentAt = new Date().toISOString();
      sim.lastError = '';
      track(events, scenario);
    } catch (e) {
      sim.failed += events.length;
      sim.failStreak++;
      sim.lastError = e.message;
      if (sim.failStreak >= 5) { stopSimulator(`stopped after repeated errors: ${e.message}`); return; }
    }
    publish();
  };
  sim.timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  publish(true);
  return simulatorStatus();
}

export function updateSimulator({ rate, ruleBreakPct } = {}) {
  if (!sim.running) return simulatorStatus();
  if (rate !== undefined) sim.rate = Math.min(LIMITS.maxRate, Math.max(LIMITS.minRate, Math.round(Number(rate) || sim.rate)));
  if (ruleBreakPct !== undefined) sim.ruleBreakPct = Math.min(50, Math.max(0, Number(ruleBreakPct) || 0));
  publish(true);
  return simulatorStatus();
}

export function stopSimulator(reason = 'stopped') {
  if (sim.timer) clearInterval(sim.timer);
  const wasRunning = sim.running;
  sim = { ...sim, running: false, timer: null, scenarioObj: null, stoppedAt: new Date().toISOString(), stopReason: reason };
  if (wasRunning) logActivity('realtime.stop', `Stopped live events (${reason}) after ${sim.sent.toLocaleString('en-US')} events`, {});
  publish(true);
  return simulatorStatus();
}
