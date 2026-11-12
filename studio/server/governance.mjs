// OneLake-focused governance review: combines WAF signals with catalog depth checks.
import { fabric, getWorkspace, listItems, listLakehouseTables, listWorkspaces } from './fabric.mjs';
import { getProject, sourceContexts } from './project.mjs';
import * as WAF from './waf.mjs';

const TTL_MS = 5 * 60 * 1000;

const DOMAINS = {
  tenant: { label: 'Tenant settings', focus: 'Tenant-level controls and guardrails that affect Fabric governance.' },
  workspaces: { label: 'Workspaces', focus: 'Landing-zone structure, ownership and operational boundaries.' },
  domains: { label: 'Domains', focus: 'Business-domain assignment and discoverability in OneLake catalog.' },
  access: { label: 'Roles & access', focus: 'Least privilege and controlled access for users and apps.' },
  capacity: { label: 'Capacity & costs', focus: 'Capacity health, utilization and spend governance.' },
  security: { label: 'Security', focus: 'Sharing boundaries, identity controls and governed distribution.' },
  monitoring: { label: 'Monitoring', focus: 'Operational observability and proactive issue detection.' },
  reliability: { label: 'Reliability', focus: 'Resilience patterns, task-flow clarity and recoverability.' },
  performance: { label: 'Performance', focus: 'Model quality and runtime efficiency for analytics workloads.' },
  catalog: { label: 'OneLake catalog', focus: 'Catalog completeness, metadata quality and data-product stewardship.' },
};

const SEVERITY = {
  critical: { label: 'Critical', penalty: 34, rank: 5 },
  high: { label: 'High', penalty: 20, rank: 4 },
  medium: { label: 'Medium', penalty: 11, rank: 3 },
  low: { label: 'Low', penalty: 5, rank: 2 },
  unknown: { label: 'Unknown', penalty: 7, rank: 1 },
  info: { label: 'Info', penalty: 0, rank: 0 },
};

const ONE_LAKE_TYPES = new Set(['Lakehouse', 'Warehouse', 'MirroredDatabase', 'SQLDatabase']);

let cache = { key: '', at: 0, data: null, pending: null };

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function readMaybe(label, fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: clean(e.message || String(e)), label }; }
}

function byType(items = []) {
  const m = new Map();
  for (const i of items) m.set(i.type || 'Item', (m.get(i.type || 'Item') || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
}

function itemName(i) {
  return clean(i?.displayName || i?.name || i?.type || 'Item');
}

function scoreFor(findings) {
  const penalty = findings.reduce((a, f) => a + (SEVERITY[f.severity]?.penalty || 0), 0);
  return clamp(100 - penalty);
}

function scoreLabel(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Needs attention';
  return 'High risk';
}

function sortedFindings(findings) {
  return [...findings].sort((a, b) => (SEVERITY[b.severity]?.rank || 0) - (SEVERITY[a.severity]?.rank || 0) || a.title.localeCompare(b.title));
}

function projectKey(p, scope = 'workspace') {
  return [
    scope,
    p.workspace?.id || '',
    p.workspace?.capacityId || '',
    p.sourceKey || '',
    p.semanticModel?.id || '',
    p.ontology?.id || '',
    p.realtime?.eventhouse?.id || '',
    p.planning?.planYear || '',
    (p.reports || []).length,
    (p.semanticModels || []).length,
    (p.sources || []).length,
  ].join('|');
}

function domainWorkspaceIds(domain) {
  const out = [];
  const add = (v) => {
    if (!v) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (typeof v === 'object') out.push(v.workspaceId || v.id || v.workspace?.id || '');
  };
  add(domain.workspaceId);
  for (const listName of ['workspaceIds', 'workspaces', 'assignedWorkspaces']) {
    const list = domain[listName];
    if (Array.isArray(list)) for (const v of list) add(v);
  }
  return out.filter(Boolean).map((x) => String(x).toLowerCase());
}

function domainsFromPayload(v) {
  if (Array.isArray(v?.value)) return v.value;
  if (Array.isArray(v?.domains)) return v.domains;
  if (Array.isArray(v)) return v;
  return [];
}

async function readCatalogInventory(p, { scope = 'workspace' } = {}) {
  const wsId = p.workspace?.id;
  if (!wsId) {
    return {
      workspaceItems: [],
      workspaceItemsError: '',
      workspaceItemsPartialErrors: [],
      itemTypes: [],
      itemExplorer: [],
      workspacesInScope: 0,
      dataProducts: 0,
      describedDataProducts: 0,
      describedItems: 0,
      catalogCoveragePct: 0,
      lakehouses: 0,
      lakehousesSampled: 0,
      totalLakehouseTables: 0,
      emptyLakehouses: 0,
      lakehouseTableErrors: 0,
      lakehouseTableCoverage: [],
      domainsVisible: false,
      domains: 0,
      workspaceDomainAssignments: 0,
      workspacesAssignedToDomains: 0,
      sourceContexts: sourceContexts(p),
      inactiveSourcesWithAssets: 0,
      scopeMode: scope,
      scopeCapacity: null,
    };
  }

  const selectedWorkspace = {
    id: wsId,
    name: clean(p.workspace?.name || 'Workspace'),
    capacityId: p.workspace?.capacityId || null,
    type: 'Workspace',
  };
  const scopeWorkspaces = [selectedWorkspace];

  if (scope === 'capacity') {
    let capacityId = selectedWorkspace.capacityId;
    if (!capacityId) {
      const wsMeta = await readMaybe('workspace metadata', () => getWorkspace(wsId));
      if (wsMeta.ok) capacityId = wsMeta.value?.capacityId || null;
    }
    if (capacityId) {
      const allWs = await readMaybe('capacity workspaces', () => listWorkspaces());
      if (allWs.ok) {
        const sameCapacity = (allWs.value || []).filter((w) => String(w.capacityId || '') === String(capacityId) && w.type !== 'Personal');
        if (sameCapacity.length) {
          scopeWorkspaces.length = 0;
          for (const w of sameCapacity) {
            scopeWorkspaces.push({
              id: w.id,
              name: clean(w.displayName || w.name || 'Workspace'),
              capacityId: w.capacityId || capacityId,
              type: w.type || 'Workspace',
            });
          }
        }
      }
      selectedWorkspace.capacityId = capacityId;
    }
  }

  const itemReads = await Promise.all(scopeWorkspaces.map(async (w) => {
    const res = await readMaybe(`workspace items (${w.name})`, () => listItems(w.id));
    return { workspace: w, res };
  }));
  const itemErrors = itemReads.filter((x) => !x.res.ok).map((x) => ({ workspaceId: x.workspace.id, workspaceName: x.workspace.name, error: x.res.error }));
  const items = itemReads.filter((x) => x.res.ok).flatMap((x) => (x.res.value || []).map((i) => ({ ...i, __workspaceId: x.workspace.id, __workspaceName: x.workspace.name })));
  const allItemReadsFailed = itemReads.length > 0 && itemReads.every((x) => !x.res.ok);

  const dataProducts = items.filter((i) => ONE_LAKE_TYPES.has(i.type || ''));
  const describedDataProducts = dataProducts.filter((i) => clean(i.description)).length;
  const describedItems = items.filter((i) => clean(i.description)).length;
  const coverage = dataProducts.length ? Math.round((describedDataProducts / dataProducts.length) * 100) : 0;
  const lakehouses = items.filter((i) => i.type === 'Lakehouse');
  const fallbackWorkspace = clean(p.workspace?.name || '');
  const itemExplorer = items.slice(0, 600).map((i, idx) => ({
    id: i.id || `${i.type || 'item'}-${idx}`,
    name: itemName(i),
    type: clean(i.type || i.itemType || 'Item'),
    owner: clean(
      i.owner?.displayName || i.owner?.name || i.createdBy?.displayName || i.createdBy?.name
      || i.lastUpdatedBy?.displayName || i.lastUpdatedBy?.name || i.createdBy?.userPrincipalName || '',
    ),
    location: clean(i.workspaceName || i.__workspaceName || fallbackWorkspace),
    refreshedAt: i.lastUpdatedDateTime || i.lastUpdatedTime || i.modifiedDateTime || i.updatedAt || i.createdDateTime || i.createdAt || '',
    description: clean(i.description || ''),
  }));

  const sample = lakehouses.slice(0, 24);
  const tableChecks = await Promise.all(sample.map(async (lh) => {
    const sourceWsId = lh.__workspaceId || wsId;
    const res = await readMaybe('lakehouse tables', () => listLakehouseTables(sourceWsId, lh.id));
    if (!res.ok) return { id: lh.id, workspaceId: sourceWsId, workspaceName: lh.__workspaceName || fallbackWorkspace, name: itemName(lh), tables: 0, error: res.error };
    const tables = Array.isArray(res.value) ? res.value : (res.value?.value || res.value?.tables || []);
    return { id: lh.id, workspaceId: sourceWsId, workspaceName: lh.__workspaceName || fallbackWorkspace, name: itemName(lh), tables: tables.length, error: '' };
  }));
  const totalLakehouseTables = tableChecks.reduce((a, x) => a + (x.error ? 0 : x.tables), 0);
  const emptyLakehouses = tableChecks.filter((x) => !x.error && x.tables === 0).length;
  const lakehouseTableErrors = tableChecks.filter((x) => x.error).length;

  const domainsRes = await readMaybe('domains', () => fabric('GET', '/admin/domains'));
  const domainList = domainsRes.ok ? domainsFromPayload(domainsRes.value) : [];
  const scopeWorkspaceIds = new Set(scopeWorkspaces.map((w) => String(w.id).toLowerCase()));
  const assignedWs = new Set();
  let workspaceDomainAssignments = 0;
  for (const d of domainList) {
    for (const id of domainWorkspaceIds(d)) {
      if (!scopeWorkspaceIds.has(id)) continue;
      assignedWs.add(id);
      workspaceDomainAssignments += 1;
    }
  }

  const sources = sourceContexts(p);
  const inactiveSourcesWithAssets = sources.filter((s) => !s.active && (
    (s.models || []).length || Number(s.reports) > 0 || Boolean(s.ontology) || Boolean(s.plan) || Boolean(s.realtime) || Boolean(s.dataAgent) || Boolean(s.orgApp)
  )).length;

  return {
    workspaceItems: items,
    workspaceItemsError: allItemReadsFailed ? (itemErrors[0]?.error || 'Could not read workspace items in the selected scope.') : '',
    workspaceItemsPartialErrors: itemErrors,
    itemTypes: byType(items),
    itemExplorer,
    workspacesInScope: scopeWorkspaces.length,
    dataProducts: dataProducts.length,
    describedDataProducts,
    describedItems,
    catalogCoveragePct: coverage,
    lakehouses: lakehouses.length,
    lakehousesSampled: sample.length,
    totalLakehouseTables,
    emptyLakehouses,
    lakehouseTableErrors,
    lakehouseTableCoverage: tableChecks,
    domainsVisible: domainsRes.ok,
    domains: domainList.length,
    workspaceDomainAssignments,
    workspacesAssignedToDomains: assignedWs.size,
    sourceContexts: sources,
    inactiveSourcesWithAssets,
    scopeMode: scope,
    scopeCapacity: selectedWorkspace.capacityId ? { id: selectedWorkspace.capacityId } : null,
  };
}

function findingFactory(findings) {
  return (f) => {
    const severity = f.severity || 'medium';
    findings.push({
      id: f.id,
      pillar: f.pillar || 'operations',
      pillarLabel: f.pillarLabel || 'Operational Excellence',
      domain: f.domain || 'catalog',
      domainLabel: DOMAINS[f.domain || 'catalog']?.label || f.domain || 'OneLake catalog',
      severity,
      severityLabel: SEVERITY[severity]?.label || 'Medium',
      title: clean(f.title),
      detail: clean(f.detail),
      recommendation: clean(f.recommendation),
      evidence: (f.evidence || []).map(clean).filter(Boolean),
      fixType: f.fixType || 'guided',
      fixLabel: f.fixLabel || '',
      fixLink: f.fixLink || '',
      fixTarget: f.fixTarget || null,
    });
  };
}

function evaluateCatalog(p, inv) {
  const findings = [];
  const add = findingFactory(findings);

  if (!p.workspace) {
    add({
      id: 'catalog-workspace-missing',
      severity: 'critical',
      title: 'No workspace selected',
      detail: 'Catalog governance needs a landing-zone workspace scope.',
      recommendation: 'Choose a workspace first, then generate the governance review.',
      evidence: ['Project workspace is empty.'],
      fixType: 'guided',
      fixLabel: 'Open Workspace',
      fixTarget: { view: 'workspace' },
    });
    return findings;
  }

  if (inv.workspaceItemsError) {
    const scopeLabel = inv.scopeMode === 'capacity' ? 'capacity scope' : 'workspace';
    add({
      id: 'catalog-items-not-readable',
      severity: 'unknown',
      title: `${scopeLabel[0].toUpperCase()}${scopeLabel.slice(1)} items could not be inventoried`,
      detail: 'OneLake catalog scoring needs item inventory and metadata.',
      recommendation: 'Run the governance review with an account that can list workspace items.',
      evidence: [inv.workspaceItemsError],
      fixType: 'admin',
      fixLabel: 'Open workspace access',
      fixLink: `https://app.fabric.microsoft.com/groups/${p.workspace.id}/settings/access`,
    });
    return findings;
  }

  if (!inv.workspaceItems.length) {
    const scopeLabel = inv.scopeMode === 'capacity' ? 'across this capacity' : 'in this workspace';
    add({
      id: 'catalog-workspace-empty',
      severity: 'medium',
      title: inv.scopeMode === 'capacity' ? 'No visible items in this capacity scope' : 'Workspace has no visible items',
      detail: 'There is nothing in the landing zone yet to catalog or govern.',
      recommendation: 'Connect data or add existing data products, then rerun the governance review.',
      evidence: [`Items visible ${scopeLabel}: ${inv.workspaceItems.length}`],
      fixType: 'guided',
      fixTarget: { view: 'data' },
    });
  }

  if (inv.workspaceItemsPartialErrors?.length) {
    add({
      id: 'catalog-partial-item-visibility',
      severity: 'low',
      title: 'Some workspaces in scope could not be inventoried',
      detail: 'The assessment completed, but inventory from one or more scoped workspaces was not readable.',
      recommendation: 'Verify permissions on all scoped workspaces to improve governance coverage.',
      evidence: inv.workspaceItemsPartialErrors.slice(0, 4).map((x) => `${x.workspaceName}: ${x.error}`),
      fixType: 'admin',
      fixLabel: 'Open workspace access',
      fixLink: `https://app.fabric.microsoft.com/groups/${p.workspace.id}/settings/access`,
    });
  }

  if (!inv.dataProducts) {
    add({
      id: 'catalog-no-data-products',
      severity: 'high',
      title: 'No OneLake data products found',
      detail: 'No lakehouse, warehouse, mirrored database or Fabric SQL database is visible in this workspace.',
      recommendation: 'Add or connect a OneLake data product before promoting this workspace as a governed landing zone.',
      evidence: [`Workspace items: ${inv.workspaceItems.length}`],
      fixType: 'guided',
      fixTarget: { view: 'data' },
    });
  } else if (inv.catalogCoveragePct < 60) {
    add({
      id: 'catalog-metadata-low',
      severity: 'medium',
      title: 'Catalog metadata coverage is low',
      detail: 'Most OneLake data products are missing descriptions, which weakens discoverability and ownership clarity.',
      recommendation: 'Add descriptions for every production data product and major artifact.',
      evidence: [`Described data products: ${inv.describedDataProducts}/${inv.dataProducts} (${inv.catalogCoveragePct}%)`],
      fixType: 'manual',
    });
  } else if (inv.catalogCoveragePct < 85) {
    add({
      id: 'catalog-metadata-partial',
      severity: 'low',
      title: 'Catalog metadata is only partially complete',
      detail: 'Some data products still lack descriptive metadata.',
      recommendation: 'Raise data-product description coverage above 85% for production governance baselines.',
      evidence: [`Described data products: ${inv.describedDataProducts}/${inv.dataProducts} (${inv.catalogCoveragePct}%)`],
      fixType: 'manual',
    });
  }

  if (inv.lakehouses && !inv.lakehousesSampled && inv.lakehouseTableErrors) {
    add({
      id: 'catalog-lakehouse-tables-not-readable',
      severity: 'unknown',
      title: 'Lakehouse table inventory could not be read',
      detail: 'Table-level governance checks could not verify lakehouse content.',
      recommendation: 'Review lakehouse permissions and rerun the governance review.',
      evidence: [`Lakehouses with table-inventory errors: ${inv.lakehouseTableErrors}`],
      fixType: 'admin',
      fixLabel: 'Open Workspace',
      fixTarget: { view: 'workspace' },
    });
  } else if (inv.lakehousesSampled && !inv.totalLakehouseTables) {
    add({
      id: 'catalog-no-lakehouse-tables',
      severity: 'high',
      title: 'Lakehouses are present but no tables were found',
      detail: 'Data products without cataloged tables are usually incomplete or not yet loaded.',
      recommendation: 'Load/ingest data into the lakehouses or connect existing tables before downstream modeling.',
      evidence: [`Lakehouses sampled: ${inv.lakehousesSampled}`],
      fixType: 'guided',
      fixTarget: { view: 'data' },
    });
  } else if (inv.emptyLakehouses) {
    add({
      id: 'catalog-empty-lakehouses',
      severity: 'medium',
      title: 'Some lakehouses have no visible tables',
      detail: 'Empty lakehouses increase catalog noise and make stewardship harder.',
      recommendation: 'Remove unused lakehouses or complete ingestion so each lakehouse has a clear purpose.',
      evidence: [`Empty lakehouses in sample: ${inv.emptyLakehouses}/${inv.lakehousesSampled}`],
      fixType: 'guided',
      fixTarget: { view: 'data' },
    });
  }

  if (inv.domainsVisible && inv.domains && !inv.workspaceDomainAssignments) {
    add({
      id: 'catalog-workspace-no-domain',
      severity: 'medium',
      title: inv.scopeMode === 'capacity' ? 'No scoped workspace is mapped to a visible Fabric domain' : 'Workspace is not mapped to a visible Fabric domain',
      detail: 'Domain assignment helps governance boundaries, ownership and catalog discovery.',
      recommendation: inv.scopeMode === 'capacity' ? 'Assign scoped workspaces to business domains with clear owners.' : 'Assign this workspace to a business domain with clear owners.',
      evidence: inv.scopeMode === 'capacity'
        ? [`Domains visible: ${inv.domains}`, `Scoped workspaces mapped to domains: ${inv.workspacesAssignedToDomains}/${inv.workspacesInScope}`]
        : [`Domains visible: ${inv.domains}`, `Workspace-domain assignments found: ${inv.workspaceDomainAssignments}`],
      fixType: 'admin',
      fixLabel: 'Open OneLake catalog',
      fixLink: 'https://app.fabric.microsoft.com/explore',
    });
  } else if (inv.scopeMode === 'capacity' && inv.domainsVisible && inv.workspacesInScope > inv.workspacesAssignedToDomains) {
    add({
      id: 'catalog-capacity-partial-domain-mapping',
      severity: 'low',
      title: 'Some capacity workspaces are not mapped to visible domains',
      detail: 'Domain assignment is incomplete across the selected capacity scope.',
      recommendation: 'Map remaining capacity workspaces to domains to improve ownership and discovery.',
      evidence: [`Scoped workspaces mapped to domains: ${inv.workspacesAssignedToDomains}/${inv.workspacesInScope}`],
      fixType: 'admin',
      fixLabel: 'Open OneLake catalog',
      fixLink: 'https://app.fabric.microsoft.com/explore',
    });
  }

  if (inv.sourceContexts.length > 1) {
    add({
      id: 'catalog-multiple-sources',
      severity: 'info',
      title: 'Workspace tracks multiple data-source contexts',
      detail: 'Multi-source work is supported, but governance should clearly identify production vs experiment contexts.',
      recommendation: 'Document source ownership and lifecycle for each context, and clean up stale contexts.',
      evidence: inv.sourceContexts.map((s) => `${s.active ? 'Active' : 'Inactive'}: ${s.label}`),
      fixType: 'manual',
    });
  }

  if (inv.inactiveSourcesWithAssets > 2) {
    add({
      id: 'catalog-stale-sources',
      severity: 'low',
      title: 'Several inactive data sources still have artifacts',
      detail: 'Inactive source contexts with models/reports can confuse catalog consumers and support teams.',
      recommendation: 'Archive or remove stale source contexts that are no longer governed products.',
      evidence: [`Inactive sources with assets: ${inv.inactiveSourcesWithAssets}`],
      fixType: 'guided',
      fixLabel: 'Open Data',
      fixTarget: { view: 'data' },
    });
  }

  if (!p.naming?.domain || !p.naming?.environment) {
    add({
      id: 'catalog-naming-not-confirmed',
      severity: 'low',
      title: 'Naming standard is not confirmed',
      detail: 'Catalog governance is stronger when domain and environment are explicit in artifact names.',
      recommendation: 'Confirm the naming standard in Workspace before creating more governed artifacts.',
      evidence: ['Project naming domain/environment is missing or inferred.'],
      fixType: 'guided',
      fixLabel: 'Open Workspace',
      fixTarget: { view: 'workspace' },
    });
  }

  return findings;
}

function normalizeWafFinding(f) {
  const severity = f.severity || 'medium';
  const domain = f.domain === 'artifacts' ? 'catalog' : (f.domain || 'catalog');
  return {
    ...f,
    domain,
    domainLabel: DOMAINS[domain]?.label || f.domainLabel || domain,
    severity,
    severityLabel: SEVERITY[severity]?.label || f.severityLabel || 'Medium',
  };
}

function summarize(p, waf, inv, findings) {
  const material = findings.filter((f) => f.severity !== 'info');
  const domains = Object.entries(DOMAINS).map(([id, meta]) => {
    const f = findings.filter((x) => x.domain === id && x.severity !== 'info');
    const score = scoreFor(f);
    return { id, label: meta.label, focus: meta.focus, score, status: scoreLabel(score), findings: f.length, topFinding: sortedFindings(f)[0]?.title || 'No material findings' };
  });
  const overallScore = clamp(Math.round(domains.reduce((a, d) => a + d.score, 0) / domains.length));

  return {
    at: new Date().toISOString(),
    scope: {
      ...waf.scope,
      mode: inv.scopeMode || 'workspace',
      workspacesInScope: inv.workspacesInScope || (waf.scope?.workspace ? 1 : 0),
      scopeCapacity: inv.scopeCapacity || null,
    },
    overallScore,
    overallLabel: scoreLabel(overallScore),
    domains,
    findings: sortedFindings(findings),
    recommendations: sortedFindings(material).slice(0, 12),
    inventory: {
      workspaceItems: inv.workspaceItems.length,
      itemTypes: inv.itemTypes,
      itemExplorer: inv.itemExplorer,
      roleAssignments: waf.inventory.roleAssignments,
      tenantSettingsVisible: waf.inventory.tenantSettingsVisible,
      domainsVisible: inv.domainsVisible,
      domains: inv.domains,
      workspaceDomainAssignments: inv.workspaceDomainAssignments,
      workspacesInScope: inv.workspacesInScope || (waf.scope?.workspace ? 1 : 0),
      workspacesAssignedToDomains: inv.workspacesAssignedToDomains || (inv.workspaceDomainAssignments > 0 ? 1 : 0),
      workspaceItemsPartialErrors: inv.workspaceItemsPartialErrors || [],
      capacityMetrics: waf.inventory.capacityMetrics,
      dataProducts: inv.dataProducts,
      describedDataProducts: inv.describedDataProducts,
      catalogCoveragePct: inv.catalogCoveragePct,
      describedItems: inv.describedItems,
      lakehouses: inv.lakehouses,
      lakehousesSampled: inv.lakehousesSampled,
      lakehouseTables: inv.totalLakehouseTables,
      lakehousesWithoutTables: inv.emptyLakehouses,
      lakehouseTableErrors: inv.lakehouseTableErrors,
      lakehouseTableCoverage: inv.lakehouseTableCoverage,
      sourceContexts: inv.sourceContexts.length,
      inactiveSourcesWithAssets: inv.inactiveSourcesWithAssets,
    },
    fixSummary: {
      auto: material.filter((f) => f.fixType === 'auto').length,
      guided: material.filter((f) => f.fixType === 'guided').length,
      manual: material.filter((f) => f.fixType === 'manual').length,
      admin: material.filter((f) => f.fixType === 'admin').length,
    },
  };
}

export async function governanceAssessment({ refresh = false, scope = 'workspace' } = {}) {
  const p = getProject();
  const scopeMode = scope === 'capacity' ? 'capacity' : 'workspace';
  const key = projectKey(p, scopeMode);
  const fresh = cache.key === key && cache.data && Date.now() - cache.at < TTL_MS;
  if (!refresh && fresh) return cache.data;
  if (cache.pending && cache.key === key) return cache.pending;
  cache.key = key;
  cache.pending = (async () => {
    const [waf, inv] = await Promise.all([
      WAF.wafAssessment({ refresh }),
      readCatalogInventory(p, { scope: scopeMode }),
    ]);
    const findings = [
      ...waf.findings.map(normalizeWafFinding),
      ...evaluateCatalog(p, inv),
    ];
    const data = summarize(p, waf, inv, findings);
    cache = { key, at: Date.now(), data, pending: null };
    return data;
  })().catch((e) => { cache.pending = null; throw e; });
  return cache.pending;
}

function markdown(a) {
  const lines = [];
  const scopeLabel = a.scope.mode === 'capacity'
    ? `All workspaces in capacity (${a.scope.capacity?.name || a.scope.scopeCapacity?.id || a.scope.workspace?.capacityId || 'unknown'})`
    : (a.scope.workspace?.name || 'No workspace selected');
  lines.push('# OneLake Catalog Governance Review', '');
  lines.push(`Generated: ${a.at}`);
  lines.push(`Scope: ${scopeLabel}`);
  lines.push(`Overall score: ${a.overallScore}/100 (${a.overallLabel})`, '');
  lines.push('## Governance domain scores', '');
  lines.push('| Domain | Score | Status | Top finding |');
  lines.push('|---|---:|---|---|');
  for (const d of a.domains) lines.push(`| ${d.label} | ${d.score} | ${d.status} | ${d.topFinding} |`);
  lines.push('', '## Top recommendations', '');
  if (!a.recommendations.length) lines.push('No material recommendations found.');
  for (const [i, f] of a.recommendations.entries()) {
    lines.push(`${i + 1}. **${f.title}** (${f.severityLabel}, ${f.domainLabel})`);
    lines.push(`   - ${f.detail}`);
    lines.push(`   - Recommendation: ${f.recommendation}`);
    lines.push(`   - Fix: ${f.fixType}${f.fixLabel ? ` – ${f.fixLabel}` : ''}`);
    if (f.evidence.length) lines.push(`   - Evidence: ${f.evidence.join('; ')}`);
  }
  lines.push('', '## OneLake catalog inventory', '');
  lines.push(`- Workspace items: ${a.inventory.workspaceItems}`);
  lines.push(`- Data products: ${a.inventory.dataProducts}`);
  lines.push(`- Data-product description coverage: ${a.inventory.catalogCoveragePct}% (${a.inventory.describedDataProducts}/${a.inventory.dataProducts || 0})`);
  lines.push(`- Lakehouses: ${a.inventory.lakehouses} (${a.inventory.lakehousesSampled} sampled)`);
  lines.push(`- Lakehouse tables discovered: ${a.inventory.lakehouseTables}`);
  lines.push(`- Lakehouses without tables (sample): ${a.inventory.lakehousesWithoutTables}`);
  lines.push(`- Source contexts: ${a.inventory.sourceContexts}`);
  lines.push(`- Inactive source contexts with assets: ${a.inventory.inactiveSourcesWithAssets}`);
  if (a.inventory.itemTypes.length) lines.push(`- Item types: ${a.inventory.itemTypes.map((x) => `${x.type} (${x.count})`).join(', ')}`);
  if (a.inventory.lakehouseTableCoverage.length) {
    lines.push('', '## Lakehouse table coverage', '', '| Lakehouse | Tables | Note |', '|---|---:|---|');
    for (const l of a.inventory.lakehouseTableCoverage) lines.push(`| ${l.name} | ${l.tables} | ${l.error ? l.error : ''} |`);
  }
  return `${lines.join('\n')}\n`;
}

function html(a) {
  const pill = (s) => s >= 90 ? 'ok' : s >= 75 ? 'good' : s >= 60 ? 'warn' : 'bad';
  const rows = (items, cols) => items.map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof c === 'function' ? c(r) : r[c])}</td>`).join('')}</tr>`).join('');
  const scopeLabel = a.scope.mode === 'capacity'
    ? `All workspaces in capacity (${a.scope.capacity?.name || a.scope.scopeCapacity?.id || a.scope.workspace?.capacityId || 'unknown'})`
    : (a.scope.workspace?.name || 'No workspace selected');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>OneLake Catalog Governance - ${esc(a.scope.workspace?.name || 'Workspace')}</title>
<style>
body{font-family:Segoe UI,Aptos,Arial,sans-serif;margin:32px;color:#1b1b1f;background:#f6f8fb}h1{margin-bottom:4px}.muted{color:#5b5f6b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card{background:white;border:1px solid #e2e5ea;border-radius:12px;padding:14px;margin:14px 0;box-shadow:0 1px 3px #0001}.score{font-size:32px;font-weight:800}.ok{color:#107c10}.good{color:#0078d4}.warn{color:#c26c00}.bad{color:#c50f1f}table{border-collapse:collapse;width:100%;background:white}td,th{border-bottom:1px solid #e2e5ea;padding:8px;text-align:left;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#5b5f6b;background:#eef3fa}.finding{border-left:4px solid #0078d4}.finding.high,.finding.critical{border-left-color:#c50f1f}.finding.medium,.finding.unknown{border-left-color:#c26c00}.tag{display:inline-block;border-radius:999px;background:#eef3fa;padding:2px 8px;font-size:12px;margin-right:4px}
</style></head><body>
<h1>OneLake Catalog Governance Review</h1>
<div class="muted">Generated ${esc(new Date(a.at).toLocaleString())} · Scope: ${esc(scopeLabel)}</div>
<div class="card"><div class="muted">Overall score</div><div class="score ${pill(a.overallScore)}">${a.overallScore}/100</div><b>${esc(a.overallLabel)}</b></div>
<h2>Governance domains</h2><div class="grid">${a.domains.map((d) => `<div class="card"><div class="muted">${esc(d.label)}</div><div class="score ${pill(d.score)}">${d.score}</div><b>${esc(d.status)}</b><p>${esc(d.topFinding)}</p></div>`).join('')}</div>
<h2>Top recommendations</h2>${a.recommendations.length ? a.recommendations.map((f, i) => `<div class="card finding ${esc(f.severity)}"><span class="tag">${i + 1}</span><span class="tag">${esc(f.severityLabel)}</span><span class="tag">${esc(f.domainLabel)}</span><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p><p><b>Recommendation:</b> ${esc(f.recommendation)}</p>${f.evidence.length ? `<p class="muted"><b>Evidence:</b> ${esc(f.evidence.join('; '))}</p>` : ''}<p><b>Fix:</b> ${esc(f.fixType)}${f.fixLabel ? ` - ${esc(f.fixLabel)}` : ''}</p></div>`).join('') : '<p>No material recommendations found.</p>'}
<h2>OneLake catalog inventory</h2><table><tr><th>Metric</th><th>Value</th></tr>
<tr><td>Workspace items</td><td>${a.inventory.workspaceItems}</td></tr>
<tr><td>Data products</td><td>${a.inventory.dataProducts}</td></tr>
<tr><td>Data-product metadata coverage</td><td>${a.inventory.catalogCoveragePct}% (${a.inventory.describedDataProducts}/${a.inventory.dataProducts || 0})</td></tr>
<tr><td>Lakehouses</td><td>${a.inventory.lakehouses} (${a.inventory.lakehousesSampled} sampled)</td></tr>
<tr><td>Lakehouse tables discovered</td><td>${a.inventory.lakehouseTables}</td></tr>
<tr><td>Lakehouses without tables (sample)</td><td>${a.inventory.lakehousesWithoutTables}</td></tr>
<tr><td>Source contexts</td><td>${a.inventory.sourceContexts}</td></tr>
<tr><td>Inactive source contexts with assets</td><td>${a.inventory.inactiveSourcesWithAssets}</td></tr>
<tr><td>Item types</td><td>${esc(a.inventory.itemTypes.map((x) => `${x.type} (${x.count})`).join(', ') || 'None')}</td></tr>
</table>
${a.inventory.lakehouseTableCoverage.length ? `<h2>Lakehouse table coverage</h2><table><tr><th>Lakehouse</th><th>Tables</th><th>Note</th></tr>${rows(a.inventory.lakehouseTableCoverage, ['name', 'tables', (x) => x.error || ''])}</table>` : ''}
</body></html>`;
}

export async function governanceReport({ format = 'markdown', refresh = false, scope = 'workspace' } = {}) {
  const assessment = await governanceAssessment({ refresh, scope });
  return /^html$/i.test(format) ? html(assessment) : markdown(assessment);
}
