// Fabric Well-Architected review: read-only inventory, scoring and guided remediations.
import { fabric, listCapacities, listItems } from './fabric.mjs';
import { getProject, projectModels, sourceContexts } from './project.mjs';
import { readiness } from './readiness.mjs';
import { projectArtifacts } from './artifacts.mjs';
import { costState } from './costs.mjs';

const TTL_MS = 5 * 60 * 1000;

const PILLARS = {
  reliability: { label: 'Reliability', focus: 'Availability, recoverability, workload isolation and failure handling.' },
  security: { label: 'Security', focus: 'Identity, access, tenant controls, data protection and secure sharing.' },
  cost: { label: 'Cost Optimization', focus: 'Capacity sizing, utilization, cost visibility and spend governance.' },
  operations: { label: 'Operational Excellence', focus: 'Governance, ownership, naming, task flows, deployment and repeatable operations.' },
  performance: { label: 'Performance Efficiency', focus: 'Model design, query patterns, capacity pressure and workload tuning.' },
};

const DOMAINS = {
  tenant: 'Tenant settings',
  workspaces: 'Workspaces',
  domains: 'Domains',
  access: 'Roles & access',
  capacity: 'Capacity & costs',
  security: 'Security',
  monitoring: 'Monitoring',
  reliability: 'Reliability',
  performance: 'Performance',
  artifacts: 'Artifacts',
};

const SEVERITY = {
  critical: { label: 'Critical', penalty: 34, rank: 5 },
  high: { label: 'High', penalty: 20, rank: 4 },
  medium: { label: 'Medium', penalty: 11, rank: 3 },
  low: { label: 'Low', penalty: 5, rank: 2 },
  unknown: { label: 'Unknown', penalty: 7, rank: 1 },
  info: { label: 'Info', penalty: 0, rank: 0 },
};

let cache = { key: '', at: 0, data: null, pending: null };

const pct = (n) => Math.round(Number(n) || 0);
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function readMaybe(label, fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: clean(e.message || String(e)), label }; }
}

function byType(items = []) {
  const m = new Map();
  for (const i of items) m.set(i.type || 'Item', (m.get(i.type || 'Item') || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
}

function roleSummary(assignments = []) {
  const counts = { Admin: 0, Member: 0, Contributor: 0, Viewer: 0, Other: 0 };
  let external = 0;
  let servicePrincipals = 0;
  for (const a of assignments) {
    const role = counts[a.role] === undefined ? 'Other' : a.role;
    counts[role]++;
    const p = a.principal || {};
    const text = `${p.displayName || ''} ${p.userPrincipalName || ''} ${p.emailAddress || ''}`.toLowerCase();
    if (text.includes('#ext#') || text.includes('_ext@')) external++;
    if (/serviceprincipal|app/i.test(p.type || p.principalType || '')) servicePrincipals++;
  }
  return { ...counts, external, servicePrincipals, total: assignments.length };
}

function tenantMap(result) {
  if (!result.ok) return { available: false, error: result.error, settings: [] };
  const list = result.value?.tenantSettings || result.value?.value || [];
  return {
    available: true,
    settings: list.map((s) => ({
      name: s.settingName || s.name || '',
      title: s.title || s.displayName || s.settingName || '',
      enabled: Boolean(s.enabled),
      groups: (s.enabledSecurityGroups || s.securityGroups || []).length,
    })).filter((s) => s.name),
  };
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

function projectKey(p) {
  return [
    p.workspace?.id || '',
    p.sourceKey || '',
    p.semanticModel?.id || '',
    p.ontology?.id || '',
    p.realtime?.eventhouse?.id || '',
    p.planning?.planYear || '',
    (p.reports || []).length,
    (p.semanticModels || []).length,
  ].join('|');
}

function findingFactory(findings) {
  return (f) => {
    findings.push({
      id: f.id,
      pillar: f.pillar,
      pillarLabel: PILLARS[f.pillar]?.label || f.pillar,
      domain: f.domain,
      domainLabel: DOMAINS[f.domain] || f.domain,
      severity: f.severity || 'medium',
      severityLabel: SEVERITY[f.severity || 'medium'].label,
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

async function readInventory(p, refresh) {
  const wsId = p.workspace?.id;
  const capacityId = p.workspace?.capacityId;
  const [rd, capacities, workspaceItems, roles, tenant, domains, artifacts, costs] = await Promise.all([
    readiness({ refresh }).catch((e) => ({ error: e.message })),
    readMaybe('capacities', () => listCapacities()),
    wsId ? readMaybe('workspace items', () => listItems(wsId)) : Promise.resolve({ ok: true, value: [] }),
    wsId ? readMaybe('workspace roles', () => fabric('GET', `/workspaces/${wsId}/roleAssignments`)) : Promise.resolve({ ok: true, value: { value: [] } }),
    readMaybe('tenant settings', () => fabric('GET', '/admin/tenantsettings')),
    readMaybe('domains', () => fabric('GET', '/admin/domains')),
    readMaybe('project artifacts', () => projectArtifacts()),
    capacityId ? readMaybe('costs', () => costState({ capacityId })) : Promise.resolve({ ok: false, error: 'No capacity selected.' }),
  ]);
  const caps = capacities.ok ? capacities.value || [] : [];
  const cap = caps.find((c) => String(c.id).toLowerCase() === String(capacityId || '').toLowerCase()) || null;
  const itemList = workspaceItems.ok ? workspaceItems.value || [] : [];
  const roleList = roles.ok ? roles.value?.value || roles.value?.roleAssignments || [] : [];
  const domainList = domains.ok ? domains.value?.value || domains.value?.domains || [] : [];
  return {
    readiness: rd,
    capacities: caps,
    capacity: cap,
    workspaceItems: itemList,
    workspaceItemsError: workspaceItems.ok ? '' : workspaceItems.error,
    roles: roleList,
    rolesError: roles.ok ? '' : roles.error,
    tenant: tenantMap(tenant),
    domains: { available: domains.ok, list: domainList, error: domains.ok ? '' : domains.error },
    artifacts: artifacts.ok ? artifacts.value || [] : [],
    artifactsError: artifacts.ok ? '' : artifacts.error,
    costs: costs.ok ? costs.value : null,
    costsError: costs.ok ? '' : costs.error,
  };
}

function evaluate(p, inv) {
  const findings = [];
  const add = findingFactory(findings);
  const ws = p.workspace;
  const model = p.semanticModel;
  const role = inv.readiness?.role || null;
  const capacity = inv.readiness?.capacity || (inv.capacity ? {
    id: inv.capacity.id, name: inv.capacity.displayName || inv.capacity.name, sku: inv.capacity.sku, state: inv.capacity.state, region: inv.capacity.region,
  } : null);

  if (!ws) {
    add({
      id: 'workspace-missing', pillar: 'operations', domain: 'workspaces', severity: 'critical',
      title: 'No Fabric workspace selected',
      detail: 'A WAF review needs a landing zone scope. Select or create a workspace first.',
      recommendation: 'Use the Workspace page to choose the landing zone, then generate the WAF review again.',
      evidence: ['Project workspace is empty.'], fixType: 'guided', fixLabel: 'Open Workspace', fixTarget: { view: 'workspace' },
    });
  }

  if (ws && !capacity?.id && !ws.capacityId) {
    add({
      id: 'workspace-no-capacity', pillar: 'reliability', domain: 'capacity', severity: 'high',
      title: 'Workspace is not assigned to a visible Fabric capacity',
      detail: 'Fabric workloads need a running capacity boundary for availability, performance and cost controls.',
      recommendation: 'Assign the workspace to a Fabric capacity and rerun the review.',
      evidence: [`Workspace: ${ws.name}`], fixType: 'admin', fixLabel: 'Open capacity settings', fixLink: 'https://app.fabric.microsoft.com/admin-portal/capacities',
    });
  }
  if (capacity?.state && !/^active|running$/i.test(capacity.state)) {
    add({
      id: 'capacity-not-running', pillar: 'reliability', domain: 'capacity', severity: 'high',
      title: 'Capacity is not running',
      detail: `${capacity.name || 'The capacity'} is ${capacity.state}. Users and background workloads can fail while the capacity is paused or unavailable.`,
      recommendation: 'Resume the capacity or move the workspace to a running capacity.',
      evidence: [`Capacity: ${capacity.name || capacity.id} · ${capacity.sku || 'SKU unknown'} · ${capacity.state}`],
      fixType: 'admin', fixLabel: 'Open Azure Fabric capacities', fixLink: 'https://portal.azure.com/#browse/Microsoft.Fabric%2Fcapacities',
    });
  }
  if (capacity?.trial) {
    add({
      id: 'capacity-trial', pillar: 'reliability', domain: 'capacity', severity: 'medium',
      title: 'Trial capacity limits production readiness',
      detail: 'Trial capacities are useful for demos but not a production landing zone baseline.',
      recommendation: 'Use a paid F SKU or Premium capacity for production workloads and ontology-backed agents.',
      evidence: [`Capacity SKU: ${capacity.sku}`], fixType: 'admin',
    });
  }

  const tenant = inv.tenant;
  if (!tenant.available) {
    add({
      id: 'tenant-settings-not-readable', pillar: 'security', domain: 'tenant', severity: 'unknown',
      title: 'Tenant settings could not be evaluated',
      detail: 'Only Fabric administrators can read tenant-wide settings. Security, sharing and workload controls may still need review.',
      recommendation: 'Ask a Fabric administrator to run the WAF review or validate tenant settings in the Fabric admin portal.',
      evidence: [tenant.error || 'Tenant settings API was not available to this user.'], fixType: 'admin', fixLabel: 'Open tenant settings', fixLink: 'https://app.fabric.microsoft.com/admin-portal/tenantSettings',
    });
  } else {
    const settings = new Map(tenant.settings.map((s) => [s.name, s]));
    const mustBeOn = [
      ['FabricGAWorkloads', 'operations', 'tenant', 'Users can create Fabric items', 'high'],
      ['CreateAppWorkspaces', 'operations', 'tenant', 'Create workspaces', 'medium'],
      ['DatasetExecuteQueries', 'performance', 'tenant', 'Semantic Model Execute Queries REST API', 'medium'],
      ['PowerBIMCP', 'operations', 'tenant', 'Power BI MCP endpoints', 'low'],
      ['ExportToPowerPoint', 'operations', 'tenant', 'Export reports as PowerPoint/PDF', 'low'],
      ['EnableAOAI', 'operations', 'tenant', 'Fabric AI experiences', 'low'],
    ];
    for (const [name, pillar, domain, label, severity] of mustBeOn) {
      const s = settings.get(name);
      if (s && !s.enabled) add({
        id: `tenant-${name}-off`, pillar, domain, severity,
        title: `Tenant setting is off: ${s.title || label}`,
        detail: 'This reduces what the landing zone can create, monitor or validate from the Studio.',
        recommendation: 'Turn on the setting for the right security group, or document why this landing zone intentionally does not use it.',
        evidence: [`${s.title || label}: off`], fixType: 'admin', fixLabel: 'Open tenant settings', fixLink: 'https://app.fabric.microsoft.com/admin-portal/tenantSettings',
      });
    }
    const broad = tenant.settings.filter((s) => s.enabled && !s.groups && /AllowNonEntraADAuthInEventStream|ShareToTeamsTenant|ExportToPowerPoint|FabricGAWorkloads/i.test(s.name));
    if (broad.length) add({
      id: 'tenant-settings-broad-scope', pillar: 'security', domain: 'tenant', severity: 'low',
      title: 'Some tenant settings appear enabled for the whole tenant',
      detail: 'Broad tenant settings can be fine for mature tenants, but production landing zones should know whether settings are intentionally scoped or open.',
      recommendation: 'Review whether these settings should be limited to security groups for this landing zone.',
      evidence: broad.slice(0, 6).map((s) => `${s.title || s.name}: enabled for all users`),
      fixType: 'admin', fixLabel: 'Open tenant settings', fixLink: 'https://app.fabric.microsoft.com/admin-portal/tenantSettings',
    });
  }

  if (!inv.domains.available) {
    add({
      id: 'domains-not-readable', pillar: 'operations', domain: 'domains', severity: 'unknown',
      title: 'Fabric domains could not be evaluated',
      detail: 'Domains organize ownership, discoverability and governed data product boundaries, but the current user could not read them.',
      recommendation: 'Have a Fabric administrator validate that the landing zone workspace is assigned to the right domain with owners and access policies.',
      evidence: [inv.domains.error || 'Domain API was not available to this user.'], fixType: 'admin',
    });
  } else if (!inv.domains.list.length) {
    add({
      id: 'no-fabric-domains', pillar: 'operations', domain: 'domains', severity: 'medium',
      title: 'No Fabric domains were found',
      detail: 'Without domains, workspaces tend to become ownerless or hard to discover across business areas.',
      recommendation: 'Create Fabric domains for the business areas and assign workspaces to the appropriate domain.',
      evidence: ['Domain inventory returned zero domains.'], fixType: 'admin', fixLabel: 'Open OneLake catalog', fixLink: 'https://app.fabric.microsoft.com/explore',
    });
  }

  if (ws && inv.rolesError) {
    add({
      id: 'workspace-access-not-readable', pillar: 'security', domain: 'access', severity: 'unknown',
      title: 'Workspace role assignments could not be listed',
      detail: 'The review cannot confirm admins, contributors, viewers, external users or service principals.',
      recommendation: 'Ask a workspace admin to review roles and remove direct broad access that is not required.',
      evidence: [inv.rolesError], fixType: 'admin', fixLabel: 'Open workspace access', fixLink: `https://app.fabric.microsoft.com/groups/${ws.id}/settings/access`,
    });
  } else if (ws) {
    const rs = roleSummary(inv.roles);
    if (role === 'Viewer') add({
      id: 'current-user-viewer', pillar: 'operations', domain: 'access', severity: 'high',
      title: 'Current user only has Viewer access',
      detail: 'The Studio cannot apply most remediations and some inventory checks may be incomplete.',
      recommendation: 'Use a workspace admin/member account for remediation or ask for Contributor access.',
      evidence: [`Your role: ${role}`], fixType: 'admin',
    });
    if (rs.Admin > 4) add({
      id: 'too-many-admins', pillar: 'security', domain: 'access', severity: 'medium',
      title: 'Workspace has many admins',
      detail: 'Too many admins increases the blast radius of accidental or malicious changes.',
      recommendation: 'Keep day-to-day builders as Contributor or Member and reserve Admin for workspace owners.',
      evidence: [`Admins: ${rs.Admin}`, `Assignments listed: ${rs.total}`], fixType: 'admin', fixLabel: 'Open workspace access', fixLink: `https://app.fabric.microsoft.com/groups/${ws.id}/settings/access`,
    });
    if (rs.Admin + rs.Member + rs.Contributor > 12) add({
      id: 'broad-write-access', pillar: 'security', domain: 'access', severity: 'medium',
      title: 'Workspace write access looks broad',
      detail: 'Large write-access groups make production change control harder.',
      recommendation: 'Move consumers to Viewer/App audiences and keep workspace write roles to the landing zone team.',
      evidence: [`Admin/Member/Contributor assignments: ${rs.Admin + rs.Member + rs.Contributor}`], fixType: 'admin',
    });
    if (rs.external) add({
      id: 'external-users', pillar: 'security', domain: 'access', severity: 'medium',
      title: 'External users appear in workspace access',
      detail: 'Guest users may be intentional, but production landing zones need explicit review and expiry.',
      recommendation: 'Validate every guest user, their role and whether access should move to an app audience or be time-boxed.',
      evidence: [`External-looking assignments: ${rs.external}`], fixType: 'admin',
    });
    if (rs.servicePrincipals) add({
      id: 'service-principal-access', pillar: 'security', domain: 'access', severity: 'low',
      title: 'Service principals have workspace access',
      detail: 'Automation identities should be traceable, least-privileged and owned.',
      recommendation: 'Document owner, purpose, secret/certificate rotation and role for each service principal.',
      evidence: [`Service principals/apps: ${rs.servicePrincipals}`], fixType: 'manual',
    });
  }

  const items = inv.workspaceItems;
  if (ws && inv.workspaceItemsError) {
    add({
      id: 'workspace-items-not-readable', pillar: 'operations', domain: 'artifacts', severity: 'unknown',
      title: 'Workspace items could not be inventoried',
      detail: 'The WAF review cannot score item sprawl, workload mix or artifact governance without item inventory.',
      recommendation: 'Run with an account that can list workspace items.',
      evidence: [inv.workspaceItemsError], fixType: 'admin',
    });
  } else if (ws) {
    if (!items.length) add({
      id: 'workspace-empty', pillar: 'operations', domain: 'workspaces', severity: 'medium',
      title: 'Workspace has no visible Fabric items',
      detail: 'An empty landing zone may be valid before a build, but there is nothing to assess yet.',
      recommendation: 'Connect data or add the existing artifacts that belong to this landing zone, then rerun the WAF review.',
      evidence: [`Workspace: ${ws.name}`], fixType: 'guided', fixTarget: { view: 'data' },
    });
    if (items.length > 80 && !p.taskFlow) add({
      id: 'item-sprawl-no-taskflow', pillar: 'operations', domain: 'workspaces', severity: 'medium',
      title: 'Many items without a workspace task flow',
      detail: 'Task flows help users understand raw, curated, serving, AI, monitoring and distribution layers.',
      recommendation: 'Apply a Fabric task flow and assign items to the right boxes.',
      evidence: [`Visible items: ${items.length}`], fixType: 'guided', fixLabel: 'Open Workspace task flow', fixTarget: { view: 'workspace' },
    });
    const noDescription = items.filter((i) => !clean(i.description)).length;
    if (noDescription >= Math.min(10, Math.max(3, Math.floor(items.length / 2)))) add({
      id: 'items-missing-descriptions', pillar: 'operations', domain: 'artifacts', severity: 'low',
      title: 'Many items do not have descriptions',
      detail: 'Descriptions make discovery, ownership handoff and operational triage easier.',
      recommendation: 'Add descriptions to production data products, models, reports and automation artifacts.',
      evidence: [`Items without descriptions: ${noDescription} of ${items.length}`], fixType: 'guided',
    });
  }

  if (!p.naming?.domain || !p.naming?.environment) {
    add({
      id: 'naming-not-confirmed', pillar: 'operations', domain: 'workspaces', severity: 'low',
      title: 'Naming standard is not confirmed',
      detail: 'A landing zone should make domain, artifact type, purpose and environment clear from item names.',
      recommendation: 'Set the naming standard in the Workspace section before creating more artifacts.',
      evidence: ['Project naming standard is missing or inferred.'], fixType: 'guided', fixLabel: 'Open Workspace', fixTarget: { view: 'workspace' },
    });
  }

  if (!p.taskFlow && (items.length || inv.artifacts.length)) {
    add({
      id: 'taskflow-missing', pillar: 'operations', domain: 'reliability', severity: 'low',
      title: 'No task flow is applied',
      detail: 'A task flow gives operators a shared map of the landing zone and reduces accidental changes to the wrong layer.',
      recommendation: 'Use an existing workspace task flow or apply a Fabric predesigned flow from the Workspace page.',
      evidence: [`Project artifacts: ${inv.artifacts.length}`, `Workspace items: ${items.length}`], fixType: 'guided', fixLabel: 'Open task flow', fixTarget: { view: 'workspace' },
    });
  }

  if (model) {
    const models = projectModels(p);
    if (models.length > 1) add({
      id: 'multiple-models', pillar: 'operations', domain: 'artifacts', severity: 'info',
      title: 'Several semantic models are tracked',
      detail: 'This can be healthy, but ownership and active-model selection should be clear.',
      recommendation: 'Document which model is production, which are experimental, and what reports/agents depend on each one.',
      evidence: [`Semantic models in project: ${models.length}`], fixType: 'manual',
    });
    if (!Number(model.measures)) add({
      id: 'model-no-measures', pillar: 'performance', domain: 'performance', severity: 'high',
      title: 'Semantic model has no visible measures',
      detail: 'Reports and governed answers should use explicit business measures instead of raw columns.',
      recommendation: 'Add business measures with descriptions and formats, grounded in the glossary.',
      evidence: [`Semantic model: ${model.name}`, `Measures: ${model.measures ?? 'unknown'}`], fixType: 'guided', fixLabel: 'Open Semantic model', fixTarget: { view: 'model' },
    });
    if (!Number(model.relationships)) add({
      id: 'model-no-relationships', pillar: 'performance', domain: 'performance', severity: 'medium',
      title: 'Semantic model has no visible relationships',
      detail: 'Without relationships, DAX filters and report drill paths are likely weak or incorrect.',
      recommendation: 'Run the semantic model review/check and rebuild or repair relationships from source keys.',
      evidence: [`Semantic model: ${model.name}`, `Relationships: ${model.relationships ?? 'unknown'}`], fixType: 'guided', fixTarget: { view: 'model' },
    });
    const q = Number(model.quality?.score);
    if (Number.isFinite(q) && q < 85) add({
      id: 'model-quality-low', pillar: 'performance', domain: 'performance', severity: q < 70 ? 'high' : 'medium',
      title: 'Semantic model quality score is below target',
      detail: 'The model was created but still has quality warnings that can affect reports and answers.',
      recommendation: 'Review model warnings, relationships and measures before promoting this landing zone.',
      evidence: [`Quality score: ${q}/100`, ...(model.quality?.warnings || []).slice(0, 4)], fixType: 'guided', fixTarget: { view: 'model' },
    });
    if (!p.reports?.length && !(model.linked?.reports || []).length) add({
      id: 'no-report-consumer', pillar: 'operations', domain: 'artifacts', severity: 'low',
      title: 'No reports are attached to the active model',
      detail: 'A production model should normally have an owned report, data product, app or agent consumer.',
      recommendation: 'Create or add the reports/data products that certify how the model is consumed.',
      evidence: [`Active model: ${model.name}`], fixType: 'guided', fixTarget: { view: 'reports' },
    });
  }

  if (p.realtime) {
    if (!p.realtime.medallion) add({
      id: 'realtime-no-medallion', pillar: 'reliability', domain: 'reliability', severity: 'medium',
      title: 'Real-time workload has no medallion layers',
      detail: 'Streaming workloads need replay, data quality checks, deduplication and serving aggregates.',
      recommendation: 'Apply the medallion layers so Bronze keeps raw events, Silver validates/deduplicates, and Gold serves aggregates.',
      evidence: [`Eventhouse: ${p.realtime.eventhouse?.name || 'configured'}`], fixType: 'guided', fixTarget: { view: 'realtime' },
    });
    if (!p.realtime.alerts) add({
      id: 'realtime-no-alerts', pillar: 'reliability', domain: 'monitoring', severity: 'medium',
      title: 'No Activator alerts are configured for live rule breaks',
      detail: 'Operators need proactive detection when business rules or streaming health signals fail.',
      recommendation: 'Create Activator alerts for the highest-value rules and route them to Teams or email.',
      evidence: [`Eventstream: ${p.realtime.eventstream?.name || 'configured'}`], fixType: 'guided', fixTarget: { view: 'realtime' },
    });
  }

  if (!inv.costs) {
    add({
      id: 'capacity-metrics-unavailable', pillar: 'cost', domain: 'monitoring', severity: 'medium',
      title: 'Capacity Metrics data is not available',
      detail: 'Cost, utilization, throttling and noisy-neighbor analysis require the Microsoft Fabric Capacity Metrics app.',
      recommendation: 'Install/connect the Capacity Metrics app, then rerun the WAF review.',
      evidence: [inv.costsError || 'Capacity Metrics app not available.'], fixType: 'guided', fixLabel: 'Open Costs', fixTarget: { view: 'costs' },
    });
  } else if (inv.costs.status !== 'ok') {
    add({
      id: 'capacity-metrics-not-connected', pillar: 'cost', domain: 'monitoring', severity: 'medium',
      title: 'Capacity Metrics app is missing or not connected',
      detail: inv.costs.message || 'The review cannot score capacity usage patterns without metrics.',
      recommendation: 'Use Costs & usage to install/connect the Capacity Metrics app.',
      evidence: [`Metrics status: ${inv.costs.status}`], fixType: 'guided', fixLabel: 'Open Costs', fixTarget: { view: 'costs' },
    });
  } else {
    const s = inv.costs.summary || {};
    if (s.peak > 100 || s.maxReject > 0 || s.maxDelay > 100) add({
      id: 'capacity-overload-signals', pillar: 'performance', domain: 'capacity', severity: 'high',
      title: 'Capacity metrics show overload or throttling signals',
      detail: 'Users may see slow reports or failed jobs when peak usage exceeds capacity limits.',
      recommendation: 'Tune heavy items first, stagger background jobs, and scale intentionally for predictable peaks.',
      evidence: [`Peak: ${pct(s.peak)}%`, `Max delay: ${pct(s.maxDelay)}%`, `Max rejection: ${pct(s.maxReject)}%`], fixType: 'guided', fixTarget: { view: 'costs' },
    });
    if (s.maxCarry > 0) add({
      id: 'capacity-carry-forward', pillar: 'cost', domain: 'capacity', severity: 'medium',
      title: 'Capacity has smoothing or carry-forward backlog',
      detail: 'Bursty work can delay later operations or create overage.',
      recommendation: 'Spread background jobs, reduce burst size, or intentionally scale for peak windows.',
      evidence: [`Carry-forward: ${pct(s.maxCarry)}%`], fixType: 'guided', fixTarget: { view: 'costs' },
    });
    if (s.avgUtil < 20 && s.peak < 70 && inv.costs.pricing?.available) add({
      id: 'capacity-underutilized', pillar: 'cost', domain: 'capacity', severity: 'low',
      title: 'Capacity appears underutilized',
      detail: 'Always-on pay-as-you-go capacity may be larger or more continuously available than needed for this workload.',
      recommendation: 'Pause dev/test capacities when idle and reserve only stable production baseline usage.',
      evidence: [`Average utilization: ${pct(s.avgUtil)}%`, `Peak: ${pct(s.peak)}%`], fixType: 'guided', fixTarget: { view: 'costs' },
    });
  }

  if (p.reports?.length && !p.orgApp) {
    add({
      id: 'reports-not-packaged', pillar: 'security', domain: 'security', severity: 'low',
      title: 'Reports are not packaged in an org app',
      detail: 'Sharing reports directly from a workspace often grants broader access than an app audience.',
      recommendation: 'Bundle certified reports into an org app and share through app audiences where possible.',
      evidence: [`Reports in project: ${p.reports.length}`], fixType: 'guided', fixTarget: { view: 'reports' },
    });
  }

  const sourceList = sourceContexts(p);
  if (sourceList.length > 1) {
    add({
      id: 'multiple-data-sources', pillar: 'operations', domain: 'artifacts', severity: 'info',
      title: 'Workspace tracks multiple data sources',
      detail: 'This is supported by the Studio; each source keeps its own model/reports. Promote only the sources meant for the landing zone.',
      recommendation: 'Document which source is production and remove or archive sources that are only experiments.',
      evidence: sourceList.map((s) => `${s.active ? 'Active' : 'Inactive'}: ${s.label}`), fixType: 'manual',
    });
  }

  return findings;
}

function summarize(p, inv, findings) {
  const pillarScores = Object.entries(PILLARS).map(([id, meta]) => {
    const f = findings.filter((x) => x.pillar === id && x.severity !== 'info');
    const score = scoreFor(f);
    return { id, ...meta, score, status: scoreLabel(score), findings: f.length, topFinding: sortedFindings(f)[0]?.title || 'No material findings' };
  });
  const domainScores = Object.entries(DOMAINS).map(([id, label]) => {
    const f = findings.filter((x) => x.domain === id && x.severity !== 'info');
    const score = scoreFor(f);
    return { id, label, score, status: scoreLabel(score), findings: f.length, topFinding: sortedFindings(f)[0]?.title || 'No material findings' };
  });
  const material = findings.filter((f) => f.severity !== 'info');
  const overallScore = clamp(Math.round(pillarScores.reduce((a, x) => a + x.score, 0) / pillarScores.length));
  const itemsByType = byType(inv.workspaceItems);
  return {
    at: new Date().toISOString(),
    scope: {
      tenant: p.tenant || null,
      workspace: p.workspace ? { id: p.workspace.id, name: p.workspace.name, capacityId: p.workspace.capacityId || null } : null,
      capacity: inv.readiness?.capacity || (inv.capacity ? { id: inv.capacity.id, name: inv.capacity.displayName || inv.capacity.name, sku: inv.capacity.sku, state: inv.capacity.state, region: inv.capacity.region } : null),
      source: p.source ? { label: p.source.label, method: p.source.method, kind: p.source.kind } : null,
      semanticModel: p.semanticModel ? { id: p.semanticModel.id, name: p.semanticModel.name, origin: p.semanticModel.origin || 'studio' } : null,
    },
    overallScore,
    overallLabel: scoreLabel(overallScore),
    pillars: pillarScores,
    domains: domainScores,
    findings: sortedFindings(findings),
    recommendations: sortedFindings(material).slice(0, 10),
    inventory: {
      workspaceItems: inv.workspaceItems.length,
      itemTypes: itemsByType,
      projectArtifacts: inv.artifacts.length,
      artifactTypes: byType(inv.artifacts.map((a) => ({ type: a.type }))),
      semanticModels: projectModels(p).length,
      dataSources: sourceContexts(p).length,
      roleAssignments: inv.roles.length,
      tenantSettingsVisible: inv.tenant.available,
      domainsVisible: inv.domains.available,
      domains: inv.domains.list.length,
      capacityMetrics: inv.costs?.status || (inv.costsError ? 'unavailable' : 'not checked'),
    },
    fixSummary: {
      auto: material.filter((f) => f.fixType === 'auto').length,
      guided: material.filter((f) => f.fixType === 'guided').length,
      manual: material.filter((f) => f.fixType === 'manual').length,
      admin: material.filter((f) => f.fixType === 'admin').length,
    },
  };
}

export async function wafAssessment({ refresh = false } = {}) {
  const p = getProject();
  const key = projectKey(p);
  const fresh = cache.key === key && cache.data && Date.now() - cache.at < TTL_MS;
  if (!refresh && fresh) return cache.data;
  if (cache.pending && cache.key === key) return cache.pending;
  cache.key = key;
  cache.pending = (async () => {
    const inv = await readInventory(p, refresh);
    const findings = evaluate(p, inv);
    const data = summarize(p, inv, findings);
    cache = { key, at: Date.now(), data, pending: null };
    return data;
  })().catch((e) => { cache.pending = null; throw e; });
  return cache.pending;
}

function markdown(a) {
  const lines = [];
  lines.push('# Fabric Well-Architected Review', '');
  lines.push(`Generated: ${a.at}`);
  lines.push(`Scope: ${a.scope.workspace?.name || 'No workspace selected'}`);
  lines.push(`Overall score: ${a.overallScore}/100 (${a.overallLabel})`, '');
  lines.push('## WAF pillar scores', '');
  lines.push('| Pillar | Score | Status | Top finding |');
  lines.push('|---|---:|---|---|');
  for (const p of a.pillars) lines.push(`| ${p.label} | ${p.score} | ${p.status} | ${p.topFinding} |`);
  lines.push('', '## Control domain scores', '');
  lines.push('| Domain | Score | Status | Top finding |');
  lines.push('|---|---:|---|---|');
  for (const d of a.domains) lines.push(`| ${d.label} | ${d.score} | ${d.status} | ${d.topFinding} |`);
  lines.push('', '## Top recommendations', '');
  if (!a.recommendations.length) lines.push('No material recommendations found.');
  for (const [i, f] of a.recommendations.entries()) {
    lines.push(`${i + 1}. **${f.title}** (${f.severityLabel}, ${f.pillarLabel} / ${f.domainLabel})`);
    lines.push(`   - ${f.detail}`);
    lines.push(`   - Recommendation: ${f.recommendation}`);
    lines.push(`   - Fix: ${f.fixType}${f.fixLabel ? ` – ${f.fixLabel}` : ''}`);
    if (f.evidence.length) lines.push(`   - Evidence: ${f.evidence.join('; ')}`);
  }
  lines.push('', '## Inventory', '');
  lines.push(`- Workspace items: ${a.inventory.workspaceItems}`);
  lines.push(`- Project artifacts: ${a.inventory.projectArtifacts}`);
  lines.push(`- Semantic models: ${a.inventory.semanticModels}`);
  lines.push(`- Data sources: ${a.inventory.dataSources}`);
  lines.push(`- Role assignments listed: ${a.inventory.roleAssignments}`);
  lines.push(`- Capacity Metrics: ${a.inventory.capacityMetrics}`);
  if (a.inventory.itemTypes.length) lines.push(`- Item types: ${a.inventory.itemTypes.map((x) => `${x.type} (${x.count})`).join(', ')}`);
  return `${lines.join('\n')}\n`;
}

function html(a) {
  const pill = (s) => s >= 90 ? 'ok' : s >= 75 ? 'good' : s >= 60 ? 'warn' : 'bad';
  const rows = (items, cols) => items.map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof c === 'function' ? c(r) : r[c])}</td>`).join('')}</tr>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Fabric WAF Review - ${esc(a.scope.workspace?.name || 'Workspace')}</title>
<style>
body{font-family:Segoe UI,Aptos,Arial,sans-serif;margin:32px;color:#1b1b1f;background:#f6f8fb}h1{margin-bottom:4px}.muted{color:#5b5f6b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card{background:white;border:1px solid #e2e5ea;border-radius:12px;padding:14px;margin:14px 0;box-shadow:0 1px 3px #0001}.score{font-size:32px;font-weight:800}.ok{color:#107c10}.good{color:#0078d4}.warn{color:#c26c00}.bad{color:#c50f1f}table{border-collapse:collapse;width:100%;background:white}td,th{border-bottom:1px solid #e2e5ea;padding:8px;text-align:left;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#5b5f6b;background:#eef3fa}.finding{border-left:4px solid #0078d4}.finding.high,.finding.critical{border-left-color:#c50f1f}.finding.medium,.finding.unknown{border-left-color:#c26c00}.tag{display:inline-block;border-radius:999px;background:#eef3fa;padding:2px 8px;font-size:12px;margin-right:4px}
</style></head><body>
<h1>Fabric Well-Architected Review</h1>
<div class="muted">Generated ${esc(new Date(a.at).toLocaleString())} · Scope: ${esc(a.scope.workspace?.name || 'No workspace selected')}</div>
<div class="card"><div class="muted">Overall score</div><div class="score ${pill(a.overallScore)}">${a.overallScore}/100</div><b>${esc(a.overallLabel)}</b></div>
<h2>WAF pillars</h2><div class="grid">${a.pillars.map((p) => `<div class="card"><div class="muted">${esc(p.label)}</div><div class="score ${pill(p.score)}">${p.score}</div><b>${esc(p.label)}</b><p>${esc(p.topFinding)}</p></div>`).join('')}</div>
<h2>Control domains</h2><table><tr><th>Domain</th><th>Score</th><th>Status</th><th>Top finding</th></tr>${rows(a.domains, ['label', 'score', 'status', 'topFinding'])}</table>
<h2>Top recommendations</h2>${a.recommendations.length ? a.recommendations.map((f, i) => `<div class="card finding ${esc(f.severity)}"><span class="tag">${i + 1}</span><span class="tag">${esc(f.severityLabel)}</span><span class="tag">${esc(f.pillarLabel)}</span><span class="tag">${esc(f.domainLabel)}</span><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p><p><b>Recommendation:</b> ${esc(f.recommendation)}</p>${f.evidence.length ? `<p class="muted"><b>Evidence:</b> ${esc(f.evidence.join('; '))}</p>` : ''}<p><b>Fix:</b> ${esc(f.fixType)}${f.fixLabel ? ` - ${esc(f.fixLabel)}` : ''}</p></div>`).join('') : '<p>No material recommendations found.</p>'}
<h2>Inventory</h2><table><tr><th>Metric</th><th>Value</th></tr>
<tr><td>Workspace items</td><td>${a.inventory.workspaceItems}</td></tr>
<tr><td>Project artifacts</td><td>${a.inventory.projectArtifacts}</td></tr>
<tr><td>Semantic models</td><td>${a.inventory.semanticModels}</td></tr>
<tr><td>Data sources</td><td>${a.inventory.dataSources}</td></tr>
<tr><td>Role assignments listed</td><td>${a.inventory.roleAssignments}</td></tr>
<tr><td>Capacity Metrics</td><td>${esc(a.inventory.capacityMetrics)}</td></tr>
<tr><td>Item types</td><td>${esc(a.inventory.itemTypes.map((x) => `${x.type} (${x.count})`).join(', ') || 'None')}</td></tr>
</table></body></html>`;
}

export async function wafReport({ format = 'markdown', refresh = false } = {}) {
  const assessment = await wafAssessment({ refresh });
  return /^html$/i.test(format) ? html(assessment) : markdown(assessment);
}
