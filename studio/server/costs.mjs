// Costs & utilization: friendly summary over Fabric Capacity Metrics, plus capacity cost estimates.
import { listCapacities, listWorkspaces } from './fabric.mjs';
import { getProject } from './project.mjs';
import { listApps, appReports, groupDatasets, dax } from './powerbi.mjs';
import { netFetch } from './config.mjs';

const METRICS_APP = 'Microsoft Fabric Capacity Metrics';
const INSTALL_URL = 'https://go.microsoft.com/fwlink/?linkid=2219875';
const PRICING_URL = 'https://azure.microsoft.com/pricing/details/microsoft-fabric/';
const RESERVATION_FACTOR = 0.59; // Azure pricing page: reservations can save about 41% vs pay-as-you-go.

const cleanRow = (r) => Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [k.replace(/^.*\[(.*)\]$/, '$1').replace(/^\[(.*)\]$/, '$1'), v]));
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const low = (s) => String(s || '').toLowerCase();
const cuOf = (sku) => Number(String(sku || '').match(/^F(\d+)/i)?.[1]) || Number(String(sku || '').match(/^P(\d+)/i)?.[1]) * 64 || 0;
const regionCode = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'westus2';
const sumBy = (rows, key, val) => {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const cur = m.get(k) || { key: k, cu: 0, duration: 0, operations: 0, users: 0, records: 0 };
    cur.cu += n(val(r));
    cur.duration += n(r['Duration (s)'] ?? r.duration);
    cur.operations += n(r.Operations ?? r.operations);
    cur.users += n(r.Users ?? r.users);
    cur.records++;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.cu - a.cu);
};

async function metricsArtifacts() {
  let app = null;
  try { app = (await listApps()).find((a) => a.name === METRICS_APP || /Fabric Capacity Metrics/i.test(a.name)); } catch { /* no Power BI app access */ }
  if (!app) return { app: null, report: null, dataset: null };
  const [reports, datasets] = await Promise.all([
    appReports(app.id).catch(() => []),
    app.workspaceId ? groupDatasets(app.workspaceId).catch(() => []) : Promise.resolve([]),
  ]);
  return { app, report: reports[0] || null, dataset: datasets.find((d) => /Fabric Capacity Metrics/i.test(d.name)) || datasets[0] || null };
}

async function capacityPrice(capacity) {
  const cu = cuOf(capacity?.sku);
  const region = regionCode(capacity?.region || capacity?.location || capacity?.regionName);
  if (!cu) return { available: false, reason: 'The capacity SKU is not an Azure F SKU with a CU count.' };
  try {
    const filter = encodeURIComponent(`serviceName eq 'Microsoft Fabric' and armRegionName eq '${region}'`);
    const r = await netFetch(`https://prices.azure.com/api/retail/prices?$filter=${filter}`, {}, { repeatable: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const candidates = (j.Items || []).filter((x) => x.productName === 'Fabric Capacity'
      && /Capacity Usage CU/i.test(x.meterName || '')
      && !/Storage|BCDR|OneLake|SQL Storage/i.test(`${x.skuName} ${x.meterName}`));
    const unit = candidates.map((x) => Number(x.retailPrice)).filter((x) => x > 0).sort((a, b) => a - b)[0] || null;
    if (!unit) return { available: false, reason: `Azure retail prices didn't return a Fabric CU-hour price for ${region}.`, url: PRICING_URL };
    const hourly = unit * cu;
    return {
      available: true, region, cu, unit, hourly,
      paygMonthly: hourly * 730,
      reservationMonthly: hourly * 730 * RESERVATION_FACTOR,
      reservationSavingsMonthly: hourly * 730 * (1 - RESERVATION_FACTOR),
      note: 'Reservation estimate uses the Azure pricing page guidance of about 41% savings versus pay-as-you-go.',
      url: PRICING_URL,
    };
  } catch (e) {
    return { available: false, reason: `Could not read Azure retail pricing (${e.message}).`, url: PRICING_URL };
  }
}

async function modelRows(workspaceId, datasetId, capacityId) {
  const cap = String(capacityId || '').toUpperCase();
  const queries = {
    capacities: 'EVALUATE SELECTCOLUMNS(Capacities, "Capacity Id", Capacities[Capacity Id], "Capacity name", Capacities[Capacity name], "SKU", Capacities[SKU], "State", Capacities[State], "Region", Capacities[Region without default], "Owners", Capacities[Owners])',
    items: `EVALUATE TOPN(2000, FILTER(Items, Items[Capacity Id] = "${cap}"), Items[Timestamp], DESC)`,
    workspaces: `EVALUATE TOPN(2000, FILTER(Workspaces, Workspaces[Capacity Id] = "${cap}"), Workspaces[Workspace name], ASC)`,
    ops: `EVALUATE TOPN(600, FILTER('Metrics By Item And Operation', 'Metrics By Item And Operation'[Capacity Id] = "${cap}"), 'Metrics By Item And Operation'[CU (s)], DESC)`,
    interactive: `EVALUATE TOPN(300, FILTER('Timepoint Interactive Detail', 'Timepoint Interactive Detail'[Capacity Id] = "${cap}"), 'Timepoint Interactive Detail'[Total CU (s)], DESC)`,
    background: `EVALUATE TOPN(300, FILTER('Timepoint Background Detail', 'Timepoint Background Detail'[Capacity Id] = "${cap}"), 'Timepoint Background Detail'[Total CU (s)], DESC)`,
    // These timepoint tables are already scoped by the metrics app's selected capacity in most installs and don't carry
    // a visible Capacity Id. Use them as-is: when the app is configured for one capacity this is the right time series.
    timeline: 'EVALUATE TOPN(350, \'Timepoint CU Detail\', \'Timepoint CU Detail\'[Window start time], DESC)',
    overage: 'EVALUATE TOPN(350, \'Timepoint Overage Detail\', \'Timepoint Overage Detail\'[Window start time], DESC)',
    history: `EVALUATE TOPN(2000, FILTER('Item History Main', CONTAINSSTRING('Item History Main'[ItemHistoryUniquKey], "${cap}")), 'Item History Main'[ArtifactName], ASC)`,
  };
  const out = {};
  await Promise.all(Object.entries(queries).map(async ([k, q]) => {
    try { out[k] = (await dax(workspaceId, datasetId, q)).map(cleanRow); }
    catch (e) { out[k] = []; out[`${k}Error`] = e.message; }
  }));
  return out;
}

function buildSummary(rows, capacityId, fabricWorkspaces = []) {
  const cap = String(capacityId || '').toUpperCase();
  const itemById = new Map((rows.items || []).map((i) => [String(i['Item Id'] || '').toUpperCase(), i]));
  const wsById = new Map((rows.workspaces || []).map((w) => [String(w['Workspace Id'] || '').toUpperCase(), w]));
  for (const w of fabricWorkspaces || []) if (w?.id && !wsById.has(String(w.id).toUpperCase())) wsById.set(String(w.id).toUpperCase(), { 'Workspace name': w.displayName || w.name || w.id });
  const histByItem = new Map();
  const guidRx = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/ig;
  for (const h of rows.history || []) {
    const ids = String(h.ItemHistoryUniquKey || '').match(guidRx) || [];
    const itemId = String(ids[2] || '').toUpperCase();
    if (!itemId || histByItem.has(itemId)) continue;
    histByItem.set(itemId, { name: h.ArtifactName, workspace: h.WorkspaceName, kind: h.ArtifactKind, operation: h.OperationName, usage: h.UtilizationType, billing: h['Billing type'] });
  }
  const enrich = (r, kind) => {
    const itemId = String(r['Item Id'] || '').toUpperCase();
    const item = itemById.get(itemId);
    const hist = histByItem.get(itemId);
    const ws = wsById.get(String(r['Workspace Id'] || item?.['Workspace Id'] || '').toUpperCase());
    return {
      kind, itemId: r['Item Id'], item: item?.['Item name'] || hist?.name || r.Item || `Item ${String(r['Item Id'] || '').slice(0, 8)}`,
      itemKind: item?.['Item kind'] || hist?.kind || r['Artifact Kind'] || 'Item',
      workspace: ws?.['Workspace name'] || item?.['Workspace name'] || hist?.workspace || (r['Workspace Id'] ? `Workspace ${String(r['Workspace Id']).slice(0, 8)}` : 'Unknown workspace'),
      operation: r['Operation name'] || r.Operation || 'Operation',
      user: r.User || item?.Users || 'Unknown or service principal',
      cu: n(r['CU (s)'] ?? r['Total CU (s)']), duration: n(r['Duration (s)']), operations: n(r.Operations) || 1,
      users: n(r.Users), throttling: n(r['Throttling (min)'] ?? r['Throttling (s)']) / (r['Throttling (s)'] ? 60 : 1),
      billing: r['Billing type'] || item?.['Billable type'] || '',
      failed: n(r['Failed operations']), rejected: n(r['Rejected operations']),
    };
  };
  const ops = (rows.ops || []).map((r) => enrich(r, 'Operation summary'));
  const details = [...(rows.interactive || []).map((r) => enrich(r, 'User'),), ...(rows.background || []).map((r) => enrich(r, 'Background'))];
  const timeline = (rows.timeline || []).map((r) => ({
    at: r['Window start time'], interactive: n(r.Interactive), background: n(r.Background),
    interactiveNonBillable: n(r['Interactive non billable']), backgroundNonBillable: n(r['Background non billable']),
    limit: n(r['CU limit']), delay: n(r['Interactive delay %']), rejection: n(r['Interactive rejection %']), bgRejection: n(r['Background rejection %']),
  })).filter((r) => r.at).sort((a, b) => new Date(a.at) - new Date(b.at));
  const overage = (rows.overage || []).map((r) => ({
    at: r['Window start time'], add: n(r['Carry forward add']), burndown: n(r['Carry forward burndown']), cumulative: n(r['Cumulative carry forward']),
  })).filter((r) => r.at).sort((a, b) => new Date(a.at) - new Date(b.at));
  const recent = timeline.slice(-240);
  const pct = (r) => r.limit ? ((r.interactive + r.background) / r.limit) * 100 : 0;
  const avgUtil = recent.length ? recent.reduce((a, r) => a + pct(r), 0) / recent.length : 0;
  const peak = recent.reduce((m, r) => Math.max(m, pct(r)), 0);
  const maxDelay = recent.reduce((m, r) => Math.max(m, r.delay), 0);
  const maxReject = recent.reduce((m, r) => Math.max(m, r.rejection, r.bgRejection), 0);
  const maxCarry = overage.reduce((m, r) => Math.max(m, r.cumulative), 0);
  const byWorkspace = sumBy(ops, (r) => r.workspace, (r) => r.cu).slice(0, 10);
  const byItem = sumBy(ops, (r) => `${r.item}|${r.workspace}|${r.itemKind}`, (r) => r.cu).map((x) => {
    const [item, workspace, itemKind] = x.key.split('|');
    return { ...x, item, workspace, itemKind };
  }).slice(0, 12);
  const byOperation = sumBy(ops, (r) => r.operation, (r) => r.cu).slice(0, 10);
  const byKind = sumBy(ops, (r) => r.itemKind, (r) => r.cu).slice(0, 8);
  const byUser = sumBy(details, (r) => r.user, (r) => r.cu).slice(0, 10);
  const interactiveCu = details.filter((r) => r.kind === 'User').reduce((a, r) => a + r.cu, 0);
  const backgroundCu = details.filter((r) => r.kind === 'Background').reduce((a, r) => a + r.cu, 0);
  const recommendations = [];
  const topItem = byItem[0];
  const topWorkspace = byWorkspace[0];
  const topOperation = byOperation[0];
  const topKind = byKind[0];
  const topUser = byUser[0];
  if (topItem) {
    const where = topItem.workspace && topItem.workspace !== topItem.item ? ` in **${topItem.workspace}**` : '';
    recommendations.push(`Start with **${topItem.item}** (${topItem.itemKind})${where}. It used ${Math.round(topItem.cu).toLocaleString()} CU seconds across ${Math.round(topItem.operations).toLocaleString()} operations. Open the item in Capacity Metrics item history and check whether this is a refresh, long query loop, notebook/dataflow run, or always-on item; tune it before changing capacity size.`);
  }
  if (topOperation) recommendations.push(`The largest operation type is **${topOperation.key}** (${Math.round(topOperation.cu).toLocaleString()} CU seconds). If this operation runs on a schedule, move it outside business hours; if it is user-triggered, reduce result size, add model aggregations/indexing where applicable, and avoid repeated broad queries.`);
  if (topWorkspace) recommendations.push(`Assign an owner to **${topWorkspace.key}**. It is the top workspace by consumption (${Math.round(topWorkspace.cu).toLocaleString()} CU seconds). Review its pipelines, dataflows, notebooks, semantic model refreshes and reports together instead of troubleshooting individual users first.`);
  if (topKind) recommendations.push(`The busiest workload type is **${topKind.key}**. Use this to route the work: warehouses/SQL endpoints need query tuning and concurrency review; dataflows/pipelines need schedule staggering; Eventhouse/streaming needs retention and always-on review; Planning needs session and sheet usage review.`);
  if (topUser) recommendations.push(`The most expensive user or service principal in the detail rows is **${topUser.key}** (${Math.round(topUser.cu).toLocaleString()} CU seconds). Pair that identity with the top artifact above to find the exact workflow to tune. If user detail is missing, use Capacity Metrics item history drill-through for the heavy items.`);
  else recommendations.push('The metrics model did not expose user-level CU rows for this period. Use the **item history** drill-through in Capacity Metrics for the top artifacts to see the triggering users/service principals.');
  if (peak > 100 || maxDelay > 100 || maxReject > 0) recommendations.push('There are overload/throttling signals. Protect business users first: move background jobs away from the peak window, reduce overlapping refreshes, and consider temporary scale-up only for predictable peaks.');
  if (maxCarry > 0) recommendations.push(`Carry-forward reached ${Math.round(maxCarry).toLocaleString()}%. That means past bursts are still being paid back. Reduce burst size, spread background work, or intentionally configure overage/scale-up for the peak window.`);
  if (avgUtil < 20 && peak < 70 && byItem.length) recommendations.push('Average timepoint utilization looks low while item history has real usage. That often means the capacity is bursty or timepoint data is incomplete. If this is a dev/test capacity, pause it when idle; if it is production, reserve only the stable baseline and keep pay-as-you-go for bursty periods.');
  if (!recommendations.length) recommendations.push('No obvious overload pattern was found in the metrics app data. Keep watching top items and schedule heavy background jobs away from business hours.');
  return { cap, avgUtil, peak, maxDelay, maxReject, maxCarry, timeline, overage, ops: ops.slice(0, 40), details: details.slice(0, 40), byWorkspace, byItem, byOperation, byKind, byUser, interactiveCu, backgroundCu, recommendations, topItem, topWorkspace, topOperation, topKind, topUser };
}

export async function costState({ capacityId } = {}) {
  const p = getProject();
  const [capacities, workspaces, artifacts] = await Promise.all([
    listCapacities().catch(() => []),
    listWorkspaces().catch(() => []),
    metricsArtifacts(),
  ]);
  const projectWs = p.workspace?.id ? workspaces.find((w) => w.id === p.workspace.id) : null;
  const currentId = String(capacityId || projectWs?.capacityId || capacities[0]?.id || '').toUpperCase();
  const current = capacities.find((c) => String(c.id).toUpperCase() === currentId) || capacities[0] || null;
  const pricing = await capacityPrice(current);
  const base = {
    install: { url: INSTALL_URL, docs: 'https://learn.microsoft.com/fabric/enterprise/metrics-app-install' },
    pricingPage: PRICING_URL,
    projectWorkspace: p.workspace ? { id: p.workspace.id, name: p.workspace.name, capacityId: projectWs?.capacityId || null } : null,
    capacities: capacities.map((c) => ({ id: c.id, name: c.displayName || c.name, sku: c.sku || '', state: c.state || '', region: c.region || c.location || '', trial: /^FT/i.test(c.sku || '') })),
    selectedCapacityId: current?.id || null,
    selectedCapacity: current ? { id: current.id, name: current.displayName || current.name, sku: current.sku || '', state: current.state || '', region: current.region || current.location || '' } : null,
    metricsApp: artifacts.app ? { installed: true, id: artifacts.app.id, name: artifacts.app.name, workspaceId: artifacts.app.workspaceId, reportUrl: artifacts.report?.webUrl || null, datasetId: artifacts.dataset?.id || null } : { installed: false, installUrl: INSTALL_URL },
    pricing,
  };
  if (!artifacts.app || !artifacts.dataset?.id || !artifacts.app.workspaceId || !current?.id) {
    return { ...base, status: !artifacts.app ? 'missing-app' : 'missing-data', summary: null, message: !artifacts.app ? 'Microsoft Fabric Capacity Metrics is not installed for this account.' : 'The Capacity Metrics app is installed, but its semantic model was not found or has not been connected yet.' };
  }
  const rows = await modelRows(artifacts.app.workspaceId, artifacts.dataset.id, current.id);
  const summary = buildSummary(rows, current.id, workspaces);
  return { ...base, status: 'ok', lastRefresh: new Date().toISOString(), errors: Object.fromEntries(Object.entries(rows).filter(([k]) => k.endsWith('Error'))), summary };
}
