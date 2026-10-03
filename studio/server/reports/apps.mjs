// Org app: bundles the studio's reports (and the business rules dashboard) into one Fabric org app with an overview
// page, a section per kind of content and the report theme's colors. Sharing (audiences) is done in Fabric.
import { randomUUID } from 'node:crypto';
import * as F from '../fabric.mjs';
import { getProject, updateProject, setStep, recordArtifact, assertProjectTenant } from '../project.mjs';
import { themeById } from './themes.mjs';
import { tint } from '../generators/pbir.mjs';

const SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/orgapp/definition/orgAppDefinition/2.0.0/schema.json';

export const appUrl = (workspaceId) => `https://app.fabric.microsoft.com/groups/${workspaceId}/list?experience=power-bi`;

/** Short display name for a report inside the app ("AdventureWorks Sales – Business rules" -> "Business rules"). */
function shortName(reportName, modelName) {
  const s = String(reportName);
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

/** Create or update the project's org app with the selected reports. */
export async function runOrgApp(ctx, { name, theme: themeId, reportIds, title, body } = {}) {
  await assertProjectTenant();
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  const all = p.reports || [];
  const reports = reportIds?.length ? all.filter((r) => reportIds.includes(r.id)) : all;
  if (!reports.length) throw new Error('Build at least one report first – the app shares your reports.');
  const theme = themeById(themeId || reports[0].theme);
  const model = p.semanticModel?.name || '';
  const appName = F.itemName('OrgApp', name || `${model || 'Fabric'} app`);
  ctx.step(`Design the app (${reports.length} report${reports.length === 1 ? '' : 's'}, ${theme.name} colors)`);
  const ws = p.workspace;
  const existingItem = await F.findItem(ws.id, 'OrgApp', appName);
  let existing = null;
  if (existingItem) {
    try {
      const d = await F.getDefinition(ws.id, existingItem.id);
      const part = d?.parts?.find((x) => x.path === 'definition.json');
      existing = part ? JSON.parse(Buffer.from(part.payload, 'base64').toString('utf8')) : null;
    } catch { existing = null; }
  }
  const describe = (r) => { const s = shortName(r.name, model); return r.pages.length === 1 && r.pages[0] === s ? s : `${s} (${r.pages.join(', ')})`; };
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
  ctx.progress(90);
  const orgApp = { id: item.id, name: appName, theme: theme.id, reports: reports.map((r) => r.id), url: appUrl(ws.id), builtAt: new Date().toISOString() };
  updateProject({ orgApp });
  setStep('apps', 'done', appName);
  ctx.log('Next: open the app in Fabric, add an audience (who can see it) and publish it.');
  return orgApp;
}
