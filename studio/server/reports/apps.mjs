// Org app: bundles the studio's reports (and the business rules dashboard) into one Fabric org app with an overview
// page, a section per kind of content and the report theme's colors. Sharing (audiences) is done in Fabric.
import { randomUUID } from 'node:crypto';
import * as F from '../fabric.mjs';
import { getProject, updateProject, setStep, recordArtifact, assertProjectTenant, projectModels, modelContext } from '../project.mjs';
import { themeById } from './themes.mjs';
import { tint } from '../generators/pbir.mjs';
import { itemNameFor, parseName, purposeOf } from '../naming.mjs';

const SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/orgapp/definition/orgAppDefinition/2.0.0/schema.json';

export const appUrl = (workspaceId) => `https://app.fabric.microsoft.com/groups/${workspaceId}/list?experience=power-bi`;

/** Short display name for a report inside the app ("AdventureWorks Sales – Business rules" or "Sales_RPT_BusinessRules_DEV" -> "Business rules"). */
function shortName(reportName, modelName) {
  const s = String(reportName);
  const std = parseName(s);
  if (std) {
    const words = std.purpose.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
    return words.map((w, i) => (i === 0 || /^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(' ');
  }
  if (modelName && s.toLowerCase().startsWith(modelName.toLowerCase())) {
    const rest = s.slice(modelName.length).replace(/^\s*[–—:-]\s*/, '').trim();
    if (rest) return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return s;
}

/** Org app definition (definition.json). Rules dashboards get their own section after the reports. */
export function orgAppDefinition({ title, body, theme, reports, modelName, workspaceId, existing }) {
  const keep = new Map((existing?.elements || []).flatMap((e) => (e.elements ? e.elements : [e])).filter((e) => e.itemId).map((e) => [e.itemId, e.elementId]));
  const overviewId = existing?.elements?.find((e) => e.elementType === 'overview')?.elementId || randomUUID();
  const item = (r) => ({ elementType: 'item', elementId: keep.get(r.id) || randomUUID(), itemType: 'Report', itemId: r.id, folderObjectId: workspaceId, displayName: shortName(r.name, modelName).slice(0, 100) });
  const isRules = (r) => r.pages?.length === 1 && r.pages[0] === 'Business rules';
  const main = reports.filter((r) => !isRules(r));
  const rules = reports.filter(isRules);
  const sectionId = (name) => existing?.elements?.find((e) => e.elementType === 'section' && e.displayName === name)?.elementId || randomUUID();
  const elements = [{ elementType: 'overview', elementId: overviewId, displayName: 'Overview', header: { title: title.slice(0, 100), body: body.slice(0, 1000), showTheme: true } }];
  if (main.length) elements.push({ elementType: 'section', elementId: sectionId('Reports'), displayName: 'Reports', elements: main.map(item) });
  if (rules.length) elements.push({ elementType: 'section', elementId: sectionId('Business rules'), displayName: 'Business rules', elements: rules.map(item) });
  return {
    $schema: SCHEMA,
    settings: {
      theme: { background: theme.header, foreground: theme.headerText, backgroundHover: tint(theme.header, 0.12), backgroundSelected: tint(theme.header, 0.22), backgroundPressed: tint(theme.header, 0.3) },
      experienceSettings: { navigationPane: { isHidden: false, isCollapsed: false, independentPageNavigation: false } },
      itemTypeSettings: { report: { hidePagePane: false } },
    },
    elements,
  };
}

/**
 * The reports the org app can bundle for the active model: the studio's reports on it, and reports already on it in
 * Fabric in the project workspace (an org app only shows items of its own workspace; adding one doesn't change it).
 */
export function appReportChoices(p = getProject()) {
  const own = (p.reports || []).filter((r) => !r.semanticModelId || r.semanticModelId === p.semanticModel?.id);
  const theirs = (p.semanticModel?.linked?.reports || [])
    .filter((r) => !own.some((o) => o.id === r.id) && r.type !== 'PaginatedReport' && (!r.workspaceId || r.workspaceId === p.workspace?.id))
    .map((r) => ({ id: r.id, name: r.name, pages: [], theme: null, existing: true }));
  return { own, theirs };
}

const AUDIENCE_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/orgappaudience/definition/orgAppAudienceDefinition/1.0.0/schema.json';

/**
 * What an audience shows: the overview, links and items of the app (Fabric refuses references to sections). Without an
 * audience an org app shows "No items to show", even to its owner.
 */
export function audienceDefinition(app, appId, existing) {
  const refs = [];
  const walk = (list) => {
    for (const e of list || []) {
      if (e.elementType === 'section') walk(e.elements);
      else if (e.elementType === 'item') refs.push({ elementId: e.elementId, itemType: e.itemType, itemId: e.itemId, folderObjectId: e.folderObjectId });
      else refs.push({ elementId: e.elementId });
    }
  };
  walk(app.elements);
  return { $schema: AUDIENCE_SCHEMA, settings: { hasAccessToHiddenContent: false, tabOrder: 0, ...(existing?.settings || {}) }, parentAppId: appId, elementReferences: refs };
}

const readJson = async (ws, id) => {
  const d = await F.getDefinition(ws, id);
  const part = d?.parts?.find((x) => x.path === 'definition.json');
  return part ? JSON.parse(Buffer.from(part.payload, 'base64').toString('utf8')) : null;
};

/** The app's audience (the one it was created with, or one Fabric holds for it), updated to show every element. */
async function ensureAudience(ctx, ws, appId, appName, definition, knownId) {
  let audience = null;
  let current = null;
  const audiences = await F.listItems(ws, 'OrgAppAudience').catch(() => []);
  for (const a of [...audiences.filter((x) => x.id === knownId), ...audiences.filter((x) => x.id !== knownId)]) {
    const d = await readJson(ws, a.id).catch(() => null);
    if (d?.parentAppId?.toLowerCase() === appId.toLowerCase()) { audience = a; current = d; break; }
  }
  const def = F.toParts({ 'definition.json': audienceDefinition(definition, appId, current) });
  if (audience) {
    await F.updateDefinition(ws, audience.id, def);
    ctx.log(`Audience "${audience.displayName}" shows the overview and every report in the app`);
    return audience.id;
  }
  // Named like the app, as Fabric does; another name when that one is taken.
  for (const name of [appName, `${appName}_All`, `${appName}_${Date.now().toString(36)}`]) {
    try {
      const made = await F.fabric('POST', `/workspaces/${ws}/orgAppAudiences`, { displayName: name, description: 'Everyone the app is shared with', definition: def });
      const id = made?.id || (await F.findItem(ws, 'OrgAppAudience', name))?.id;
      ctx.log(`Audience "${name}" created – it shows the overview and the reports`);
      return id || null;
    } catch (e) {
      if (!/already in use|AlreadyInUse|ItemDisplayNameAlreadyInUse|409/i.test(String(e.message))) throw e;
    }
  }
  return null;
}

/** Create or update the project's org app with the selected reports (by default the studio's reports on the model). */
export async function runOrgApp(ctx, { name, theme: themeId, reportIds, title, body } = {}) {
  await assertProjectTenant();
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  // The org app belongs to the active model: by default it shares that model's reports (reports built before models
  // were tracked belong to it too). Chosen reports can also be ones already on the model in the workspace.
  const { own, theirs } = appReportChoices(p);
  let reports = own;
  if (reportIds?.length) {
    const byId = new Map([...own, ...theirs, ...(p.reports || [])].map((r) => [r.id, r]));
    const unknown = reportIds.filter((id) => !byId.has(id));
    if (unknown.length) throw new Error(`${unknown.length === 1 ? 'A chosen report isn\'t' : `${unknown.length} chosen reports aren't`} on ${p.semanticModel?.name || 'the semantic model'} in ${p.workspace.name} (${unknown.join(', ')}). Look again for the model's reports, then choose again.`);
    reports = [...new Set(reportIds)].map((id) => byId.get(id));
  }
  if (!reports.length) throw new Error(theirs.length ? 'Choose at least one report for the app.' : `Build at least one report on ${p.semanticModel?.name || 'the semantic model'} first – the app shares your reports.`);
  const theme = themeById(themeId || reports.find((r) => r.theme)?.theme || p.orgApp?.theme);
  const model = p.semanticModel?.name || '';
  const appName = F.itemName('OrgApp', itemNameFor('OrgApp', { name, current: p.orgApp?.name, purpose: purposeOf(model, 'SemanticModel') || 'Reports' }));
  ctx.step(`Design the app (${reports.length} report${reports.length === 1 ? '' : 's'}, ${theme.name} colors)`);
  const ws = p.workspace;
  const existingItem = await F.findItem(ws.id, 'OrgApp', appName);
  const otherModel = existingItem && existingItem.id !== p.orgApp?.id ? projectModels(p).find((m) => m.id !== p.semanticModel?.id && modelContext(p, m.id).orgApp?.id === existingItem.id) : null;
  if (otherModel) throw new Error(`"${appName}" is the org app of ${otherModel.name}. Choose another name for this model's app.`);
  let existing = null;
  if (existingItem) {
    try {
      const d = await F.getDefinition(ws.id, existingItem.id);
      const part = d?.parts?.find((x) => x.path === 'definition.json');
      existing = part ? JSON.parse(Buffer.from(part.payload, 'base64').toString('utf8')) : null;
    } catch { existing = null; }
  }
  const describe = (r) => { const s = shortName(r.name, model); return !r.pages?.length || (r.pages.length === 1 && r.pages[0] === s) ? s : `${s} (${r.pages.join(', ')})`; };
  const list = reports.map(describe);
  const overviewBody = body || [
    `Reports built on the ${model || 'project'} semantic model, so every number matches its measures and your security.`,
    `Includes ${list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0]}.`,
  ].join(' ');
  const definition = orgAppDefinition({ title: title || appName, body: overviewBody, theme, reports, modelName: model, workspaceId: ws.id, existing });
  ctx.progress(35);
  ctx.step(`${existingItem ? 'Update' : 'Create'} the org app "${appName}"`);
  const parts = F.toParts({ 'definition.json': definition });
  let item = existingItem;
  if (item) await F.updateDefinition(ws.id, item.id, parts);
  else {
    item = await F.createItem(ws.id, { name: appName, type: 'OrgApp', description: `Org app created by Fabric MCP Studio for ${model || 'the project'}.`, definition: parts });
    recordArtifact({ type: 'OrgApp', id: item.id, name: appName, workspaceId: ws.id, url: appUrl(ws.id) });
  }
  ctx.progress(80);
  ctx.step('Show the reports in the app (its audience)');
  // The audience refers to the app's elements as Fabric stored them.
  const stored = await readJson(ws.id, item.id).catch(() => null);
  const audienceId = await ensureAudience(ctx, ws.id, item.id, appName, stored?.elements?.length ? stored : definition, p.orgApp?.id === item.id ? p.orgApp.audienceId : null);
  ctx.progress(95);
  // considered: the reports offered when the app was made, so a report left out on purpose isn't "not in the app yet".
  const considered = [...new Set([...appReportChoices(getProject()).own.map((r) => r.id), ...reports.map((r) => r.id)])];
  const orgApp = { id: item.id, name: appName, theme: theme.id, reports: reports.map((r) => r.id), considered, audienceId, url: appUrl(ws.id), builtAt: new Date().toISOString() };
  updateProject({ orgApp });
  setStep('apps', 'done', appName);
  ctx.log(`${reports.length} report${reports.length === 1 ? '' : 's'} in the app: ${reports.map((r) => r.name).join(', ')}`);
  ctx.log('Next: open the app in Fabric, add people to its audience and publish it.');
  return orgApp;
}
