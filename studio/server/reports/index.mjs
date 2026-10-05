// Reports & apps: model profile, report catalog (themes, page templates), report build/deploy and previews.
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.mjs';
import * as F from '../fabric.mjs';
import { exportReport } from '../powerbi.mjs';
import { getProject, updateProject, setStep, recordArtifact, assertProjectTenant, modelWorkspaceId } from '../project.mjs';
import { profileModel } from './profile.mjs';
import { allThemes, themeById } from './themes.mjs';
import { PAGE_TEMPLATES, buildReportPages } from './templates.mjs';
import { recommendations } from './recommend.mjs';
import { ruleSet, ruleValues } from './rules.mjs';
import { reportFiles } from '../generators/pbir.mjs';
import { newId } from '../config.mjs';
import { itemNameFor, purposeOf } from '../naming.mjs';

const PREVIEW_DIR = join(DATA_DIR, 'previews');
let profileCache = { key: null, at: 0, data: null };

export function reportsCatalog() {
  return {
    themes: allThemes().map((t) => ({ id: t.id, name: t.name, description: t.description, header: t.header, headerText: t.headerText, page: t.page, card: t.card, accent: t.accent, ink: t.ink, dataColors: t.dataColors.slice(0, 6), dark: Boolean(t.dark), uploaded: Boolean(t.uploaded) })),
    pages: PAGE_TEMPLATES,
  };
}

export function requireModel() {
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  if (!p.semanticModel?.id) throw new Error('Create the semantic model first (Semantic model tab). Reports are built on it.');
  return p;
}

/** Profile of the project's semantic model (cached 10 minutes; refresh after model changes). */
export async function currentProfile({ refresh = false } = {}) {
  await assertProjectTenant();
  const p = requireModel();
  const key = `${modelWorkspaceId(p)}|${p.semanticModel.id}`;
  if (!refresh && profileCache.key === key && Date.now() - profileCache.at < 10 * 60 * 1000) return profileCache.data;
  const data = await profileModel(modelWorkspaceId(p), p.semanticModel.id, { modelName: p.semanticModel.name });
  profileCache = { key, at: Date.now(), data };
  return data;
}

export function resetProfileCache() { profileCache = { key: null, at: 0, data: null }; }

/** Recommended reports (and later dashboards and apps) for the project, with reasons from the model profile. */
export async function currentRecommendations({ refresh = false } = {}) {
  const profile = await currentProfile({ refresh });
  const project = getProject();
  const rules = ruleSet(profile, project);
  let values = [];
  if (rules.rules.some((r) => r.metrics.length)) {
    try { values = await ruleValues(modelWorkspaceId(project), project.semanticModel.id, rules); } catch { values = []; }
  }
  return { recommendations: recommendations(profile, project, { rules, values }), insights: profile.insights, rules: { source: rules.source, count: rules.rules.length, values } };
}

const PAGE_IDS = PAGE_TEMPLATES.map((x) => x.id);

/** A report built before keeps its name (so it is updated, not duplicated); a new one follows the naming standard. */
export function reportNameFor(p, name, purpose) {
  return F.itemName('Report', itemNameFor('Report', { name, known: (p.reports || []).map((r) => r.name), purpose: purpose || purposeOf(p.semanticModel.name, 'SemanticModel') }));
}

/** Keep Copilot's suggested report design so the user can review and apply it. Nothing changes in Fabric. */
export async function proposeReport({ name, theme, pages, audience, summary }, { chatId = null } = {}) {
  const p = requireModel();
  const pg = (pages || []).filter((x) => PAGE_IDS.includes(x));
  const warnings = [];
  if (pages?.length && pg.length < pages.length) warnings.push(`Unknown pages left out: ${pages.filter((x) => !PAGE_IDS.includes(x)).join(', ')}.`);
  const themeIds = allThemes().map((t) => t.id);
  if (theme && !themeIds.includes(theme)) warnings.push(`Unknown theme "${theme}" – using Fabric Studio.`);
  const reportName = reportNameFor(p, name);
  const text = String(summary || '').trim();
  const proposal = {
    id: newId(), kind: 'report', chatId, createdAt: new Date().toISOString(),
    name: reportName,
    theme: themeIds.includes(theme) ? theme : 'studio',
    pages: pg.length ? pg : PAGE_IDS,
    audience: String(audience || '').slice(0, 120),
    summary: text.length > 1200 ? `${text.slice(0, 1200).replace(/\s+\S*$/, '')}…` : text,
    updatesExisting: (p.reports || []).some((r) => r.name.toLowerCase() === reportName.toLowerCase()),
    warnings,
  };
  updateProject({ reportProposal: proposal });
  return proposal;
}

/** Build (or rebuild) a Power BI report from templates and deploy it to the project workspace. */
export async function runReport(ctx, { name, theme: themeId = 'studio', pages = ['executive', 'drivers', 'scorecard'], preview = true, proposalId } = {}) {
  const p = requireModel();
  const theme = themeById(themeId);
  ctx.step('Read the semantic model (measures, dimensions, time)');
  const profile = { ...(await currentProfile({ refresh: true })) };
  for (const w of profile.warnings) ctx.log(w);
  ctx.log(`Main measure ${profile.primary.name} · ${profile.kpis.length} KPIs · time ${profile.time?.grain || 'none'} · share ${profile.share?.label || '–'} · breakdown ${profile.breakdown?.label || '–'} · top list ${profile.entity?.label || '–'}`);
  ctx.progress(25);

  ctx.step(`Design ${pages.length} page${pages.length === 1 ? '' : 's'} with the ${theme.name} theme`);
  let extensions = [];
  if (pages.includes('rules')) {
    const set = ruleSet(profile, p);
    if (set.rules.length) {
      profile.ruleSet = set;
      extensions = set.extensions;
      ctx.log(`${set.rules.length} business rules from ${set.source} · ${set.rules.reduce((a, r) => a + r.metrics.length, 0)} rule measures${extensions.length ? ` (${extensions.length} added to the report)` : ''}`);
    } else {
      pages = pages.filter((x) => x !== 'rules');
      ctx.log('No business rules found (deploy the ontology or add rule measures); the Business rules page was left out.');
    }
  }
  if (pages.includes('plan')) {
    if (p.planning?.spec) {
      profile.plan = planReportSpec(p.planning);
      ctx.log(`Plan ${p.planning.planYear}: ${Object.values(p.planning.spec.names).length} plan measures from the Plan table`);
    } else {
      pages = pages.filter((x) => x !== 'plan');
      ctx.log('No plan yet (Planning tab); the Plan vs actual page was left out.');
    }
  }
  const built = buildReportPages(profile, theme, { pages });
  if (!built.length) throw new Error('Select at least one page.');
  const reportName = reportNameFor(p, name);
  const files = reportFiles({ semanticModelId: p.semanticModel.id, theme, pages: built, extensions });
  ctx.log(`${built.length} pages · ${built.reduce((a, x) => a + x.visuals.length, 0)} visuals · ${Object.keys(files).length} definition parts`);
  ctx.progress(40);

  const { entry } = await deployReport(ctx, {
    reportName, files, preview,
    description: `Power BI report generated by Fabric MCP Studio from ${p.semanticModel.name}.`,
    entry: { theme: theme.id, pages: built.map((x) => x.displayName) },
    onSaved: (item) => {
      const proposal = getProject().reportProposal;
      if (proposalId && proposal?.id === proposalId) updateProject({ reportProposal: { ...proposal, appliedAt: new Date().toISOString(), reportId: item.id } });
    },
  });
  return { id: entry.id, name: reportName, url: entry.url, pages: entry.pages };
}

/**
 * Create or update a Report item from definition files, record it in the project, render a preview and mark the
 * Reports step done. entry: extra fields saved with the report (theme, pages, template…).
 */
export async function deployReport(ctx, { reportName, files, description, entry: extra = {}, preview = true, onSaved }) {
  const p = getProject();
  const ws = p.workspace;
  ctx.step(`Deploy report "${reportName}"`);
  const definition = F.toParts(files);
  let item = await F.findItem(ws.id, 'Report', reportName);
  // A report the studio built on another semantic model of the project is never rebound to this one.
  const other = item && (p.reports || []).find((r) => r.id === item.id && r.semanticModelId && r.semanticModelId !== p.semanticModel.id);
  if (other) {
    const owner = (p.semanticModels || []).find((m) => m.id === other.semanticModelId);
    throw new Error(`"${reportName}" is a report on ${owner?.name || 'another semantic model'}. Choose another name for this model's report.`);
  }
  if (item) {
    await F.updateDefinition(ws.id, item.id, definition);
    ctx.log('Updated the existing report');
  } else {
    item = await F.createItem(ws.id, { name: reportName, type: 'Report', description, definition });
    recordArtifact({ type: 'Report', id: item.id, name: reportName, workspaceId: ws.id, url: reportUrl(ws.id, item.id) });
  }
  ctx.progress(70);
  const entry = { id: item.id, name: reportName, theme: null, pages: [], ...extra, semanticModelId: p.semanticModel.id, url: reportUrl(ws.id, item.id), builtAt: new Date().toISOString(), preview: null };
  saveReport(entry);
  onSaved?.(item);

  if (preview) {
    ctx.step('Render a preview');
    try {
      const out = await exportReport(ws.id, item.id, { signal: ctx.signal });
      mkdirSync(PREVIEW_DIR, { recursive: true });
      const file = join(PREVIEW_DIR, `${item.id}.${out.format.toLowerCase()}`);
      for (const ext of ['pdf', 'png', 'zip']) rmSync(join(PREVIEW_DIR, `${item.id}.${ext}`), { force: true });
      writeFileSync(file, out.bytes);
      saveReport({ ...entry, preview: { format: out.format, at: new Date().toISOString() } });
      ctx.log(`Preview ready (${out.format})`);
    } catch (e) {
      ctx.log(`Preview not available: ${e.message.split('\n')[0]}. The report is ready – open it in Power BI.`);
    }
  }
  setStep('reports', 'done', reportName);
  return { item, entry };
}

export const reportUrl = (workspaceId, id) => `https://app.powerbi.com/groups/${workspaceId}/reports/${id}`;

/** Measure and column references for the Plan vs actual page (from the project's plan). */
export function planReportSpec(pl) {
  const n = pl.spec.names;
  const table = pl.spec.modelTable;
  const ref = (name, label, percent = false) => ({ kind: 'measure', table, name, label, formatString: percent ? '0.0%' : pl.measure.formatString, percent });
  const d = pl.date;
  return {
    planYear: pl.planYear, baseYear: pl.baseYear, measureLabel: pl.measure.label || pl.measure.name,
    m: {
      actual: ref(n.actual, 'Actual'), budget: ref(n.budget, 'Budget'), forecast: ref(n.forecast, 'Forecast'), budgetToDate: ref(n.budgetToDate, 'Budget to date'),
      variance: ref(n.variance, 'Variance to budget'), variancePct: ref(n.variancePct, 'Variance %', true), attainment: ref(n.attainment, 'Budget attainment', true), fcVsBudget: ref(n.fcVsBudget, 'Forecast vs budget'),
    },
    month: { kind: 'column', table: d.table, name: d.monthName || d.month, label: 'Month' },
    year: { kind: 'column', table: d.table, name: d.year, label: 'Year' },
    dims: pl.spec.dims.map((x) => ({ kind: 'column', table: x.table, name: x.label, label: x.labelText })),
  };
}

function saveReport(entry) {
  const reports = (getProject().reports || []).filter((r) => r.id !== entry.id);
  updateProject({ reports: [entry, ...reports] });
}

/** Saved preview of a report: { contentType, bytes } or null. */
export function reportPreview(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  for (const [ext, contentType] of [['pdf', 'application/pdf'], ['png', 'image/png'], ['zip', 'application/zip']]) {
    const file = join(PREVIEW_DIR, `${id}.${ext}`);
    if (existsSync(file)) return { contentType, bytes: readFileSync(file) };
  }
  return null;
}

/** Forget a report (optionally deleting it in Fabric). */
export async function removeReport(id, { deleteItem = false } = {}) {
  await assertProjectTenant();
  const p = getProject();
  if (deleteItem && p.workspace) await F.deleteItem(p.workspace.id, id);
  for (const ext of ['pdf', 'png', 'zip']) rmSync(join(PREVIEW_DIR, `${id}.${ext}`), { force: true });
  updateProject({ reports: (p.reports || []).filter((r) => r.id !== id) });
  return { ok: true };
}
