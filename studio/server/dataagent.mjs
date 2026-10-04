// Fabric data agent grounded in the project's semantic model. The studio writes the item definition itself (the
// semantic model as the data source with its tables, columns and measures, plus instructions from the measures and
// the glossary) instead of having Copilot hand-write it, and publishes it so Microsoft 365 Copilot and Copilot Studio
// can use it. Copilot suggests the name and instructions; the user applies them with one click.
import { newId, stableUuid } from './config.mjs';
import * as F from './fabric.mjs';
import { getProject, updateProject, setStep, recordArtifact, logActivity, assertProjectTenant, fabricUrl } from './project.mjs';
import { modelMetadata } from './powerbi.mjs';

const SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition';
const MAX_INSTRUCTIONS = 15000;
const MAX_SOURCE_INSTRUCTIONS = 15000;

function requireModel() {
  const p = getProject();
  if (!p.workspace) throw new Error('Select a workspace first.');
  if (!p.semanticModel?.id) throw new Error('Create the semantic model first – the data agent answers from it.');
  return p;
}

const clip = (s, n) => {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t;
};

/** "AdventureWorks Sales agent" -> a valid item name. */
export const agentName = (p, name) => F.itemName('DataAgent', name || `${p.semanticModel.name} agent`, 'DataAgent');

// INFO.VIEW data types -> the data agent's.
const DATA_TYPE = { Text: 'String', String: 'String', Integer: 'Int64', Int64: 'Int64', Number: 'Double', Double: 'Double', Decimal: 'Decimal', Currency: 'Decimal', Date: 'DateTime', DateTime: 'DateTime', Boolean: 'Boolean', 'True/False': 'Boolean' };

/** Default instructions from the model's measures and the glossary (Copilot can suggest better ones). */
export function defaultInstructions(p, meta) {
  const m = meta?.measures || [];
  const lines = [
    `You are the ${p.semanticModel.name} data agent. Answer business questions with the "${p.semanticModel.name}" semantic model in the ${p.workspace.name} workspace.`,
    '',
    '- Use the model\'s measures for every number instead of adding up columns yourself, and say which measure and filters you used.',
    '- Compare periods with complete years or months; say when a period is partial.',
    '- Format currency and percentages, round large numbers, and answer in short paragraphs or tables.',
    '- If a question can\'t be answered from the model, say so and suggest what data would be needed.',
  ];
  if (m.length) {
    lines.push('', 'Key measures:');
    for (const x of m.slice(0, 40)) lines.push(`- [${x.name}]${x.description ? `: ${clip(x.description, 200)}` : ''}`);
  }
  if (p.ontology?.ruleDetails?.length) {
    lines.push('', 'Business rules:');
    for (const r of p.ontology.ruleDetails.slice(0, 15)) lines.push(`- ${r.name}: ${clip(r.statement, 300)}`);
  }
  const glossary = String(p.glossary || '').trim();
  if (glossary) lines.push('', 'Business definitions (glossary):', clip(glossary, 7000));
  return clip(lines.join('\n'), MAX_INSTRUCTIONS);
}

/** The semantic model as a data agent data source: every visible table with its columns and measures. */
function dataSource(p, meta, { instructions, description }) {
  const ws = p.workspace.id;
  const sm = p.semanticModel;
  const id = (...parts) => stableUuid('data-agent', sm.id, ...parts);
  const elements = meta.tables.map((t) => ({
    id: id('table', t.name), is_selected: true, display_name: t.name, type: 'semantic_model.table', description: t.description || null,
    children: [
      ...meta.columns.filter((c) => c.table === t.name).map((c) => ({ id: id('column', t.name, c.name), is_selected: true, display_name: c.name, type: 'semantic_model.column', data_type: DATA_TYPE[c.dataType] || 'String', description: c.description || null, children: [] })),
      ...meta.measures.filter((x) => x.table === t.name).map((x) => ({ id: id('measure', t.name, x.name), is_selected: true, display_name: x.name, type: 'semantic_model.measure', data_type: DATA_TYPE[x.dataType] || 'Double', description: x.description || null, children: [] })),
    ],
  }));
  const rels = meta.relationships.map((r) => ({ FromTable: r.fromTable, FromColumn: r.fromColumn, ToTable: r.toTable, ToColumn: r.toColumn, IsActive: r.active, IsBidirectional: false, Cardinality: 'ManyToOne' }));
  return {
    $schema: `${SCHEMA}/dataSource/1.0.0/schema.json`,
    artifactId: sm.id, workspaceId: ws, displayName: sm.name, type: 'semantic_model',
    dataSourceInstructions: instructions ? clip(instructions, MAX_SOURCE_INSTRUCTIONS) : null,
    userDescription: description ? clip(description, 800) : null,
    metadata: { csdl_relationships: JSON.stringify(rels) },
    elements,
  };
}

/** Item definition parts: draft and (when publishing) published copies of the same configuration. */
function definitionParts(p, meta, { instructions, sourceInstructions, description, publish }) {
  const folder = `semantic-model-${p.semanticModel.name}`;
  const stage = { $schema: `${SCHEMA}/stageConfiguration/1.0.0/schema.json`, aiInstructions: instructions };
  const ds = dataSource(p, meta, { instructions: sourceInstructions, description });
  const files = {
    'Files/Config/data_agent.json': { $schema: `${SCHEMA}/dataAgent/2.1.0/schema.json` },
    'Files/Config/draft/stage_config.json': stage,
    [`Files/Config/draft/${folder}/datasource.json`]: ds,
  };
  if (publish) {
    files['Files/Config/publish_info.json'] = { $schema: `${SCHEMA}/publishInfo/1.0.0/schema.json`, description: clip(description || `Answers questions about ${p.semanticModel.name}.`, 500) };
    files['Files/Config/published/stage_config.json'] = stage;
    files[`Files/Config/published/${folder}/datasource.json`] = ds;
  }
  return F.toParts(files);
}

/** Measure guidance for the data source: what each measure means (helps the agent pick the right one). */
function sourceInstructionsFor(meta) {
  const withText = meta.measures.filter((m) => m.description);
  if (!withText.length) return '';
  return clip(['Measures and what they mean:', ...withText.map((m) => `- [${m.name}] (${m.table}): ${clip(m.description, 240)}`)].join('\n'), 6000);
}

/** What the Share page needs: the agent, the pending suggestion and the defaults. */
export function dataAgentState() {
  const p = getProject();
  return {
    available: Boolean(p.workspace && p.semanticModel?.id),
    agent: p.dataAgent ? { ...p.dataAgent, url: fabricUrl('DataAgent', p.dataAgent.workspaceId, p.dataAgent.id) } : null,
    proposal: p.dataAgentProposal || null,
    defaultName: p.semanticModel?.id ? agentName(p) : null,
  };
}

/** Keep Copilot's suggested data agent so the user can review and apply it. Nothing changes in Fabric. */
export async function proposeDataAgent({ name, instructions, description, summary }, { chatId = null } = {}) {
  await assertProjectTenant();
  const p = requireModel();
  const n = agentName(p, name);
  const warnings = [];
  let text = String(instructions || '').trim();
  if (!text) { text = defaultInstructions(p, await modelMetadata(p.workspace.id, p.semanticModel.id).catch(() => null)); warnings.push('No instructions were suggested – the studio wrote them from the model\'s measures and the glossary.'); }
  if (text.length > MAX_INSTRUCTIONS) warnings.push(`Instructions were shortened to ${MAX_INSTRUCTIONS.toLocaleString()} characters (the data agent limit).`);
  const proposal = {
    id: newId(), kind: 'data-agent', chatId, createdAt: new Date().toISOString(),
    name: n, instructions: clip(text, MAX_INSTRUCTIONS), description: clip(description || `Answers questions about ${p.semanticModel.name} with governed measures.`, 500),
    summary: clip(summary, 1200), semanticModel: p.semanticModel.name,
    // The studio keeps one agent per project: a suggestion with a new name renames it.
    updatesExisting: Boolean(p.dataAgent?.id),
    warnings,
  };
  updateProject({ dataAgentProposal: proposal });
  logActivity('copilot.proposal', `Copilot suggested data agent "${n}"`, { chatId });
  return proposal;
}

/** Create (or update) the data agent on the semantic model and publish it. */
export async function runDataAgent(ctx, { name, instructions, description, publish = true, proposalId } = {}) {
  await assertProjectTenant();
  const p = requireModel();
  const ws = p.workspace;
  const n = agentName(p, name || p.dataAgent?.name);

  ctx.step(`Read "${p.semanticModel.name}" (tables, columns, measures)`);
  const meta = await modelMetadata(ws.id, p.semanticModel.id);
  if (!meta.tables.length) throw new Error(`"${p.semanticModel.name}" has no visible tables to answer from.`);
  ctx.log(`${meta.tables.length} tables · ${meta.columns.length} columns · ${meta.measures.length} measures · ${meta.relationships.length} relationships`);
  ctx.progress(25);

  ctx.step('Write the instructions');
  const ai = clip(String(instructions || '').trim() || defaultInstructions(p, meta), MAX_INSTRUCTIONS);
  const desc = clip(description || `Answers questions about ${p.semanticModel.name} with governed measures.`, 500);
  const definition = definitionParts(p, meta, { instructions: ai, sourceInstructions: sourceInstructionsFor(meta), description: desc, publish });
  ctx.log(`${ai.length.toLocaleString()} characters of instructions${publish ? ' · published for Microsoft 365 Copilot and Copilot Studio' : ' · draft only'}`);
  ctx.progress(40);

  ctx.step(`${p.dataAgent?.id ? 'Update' : 'Create'} the data agent "${n}"`);
  let item = p.dataAgent?.id ? await F.getItem(ws.id, p.dataAgent.id).catch(() => null) : null;
  // Never take over or overwrite an agent the studio didn't make.
  const sameName = await F.findItem(ws.id, 'DataAgent', n);
  if (sameName && sameName.id !== item?.id) throw new Error(`A data agent named "${n}" already exists in ${ws.name} and wasn't created by the studio. Choose another name.`);
  if (item) {
    if (item.displayName !== n) {
      await F.fabric('PATCH', `/workspaces/${ws.id}/items/${item.id}`, { displayName: n });
      ctx.log(`Renamed ${item.displayName} to ${n}`);
      item = { ...item, displayName: n };
    }
    await F.updateDefinition(ws.id, item.id, definition);
    ctx.log(`Updated ${item.displayName}`);
  } else {
    item = await F.createItem(ws.id, { name: n, type: 'DataAgent', description: desc, definition });
    if (!item?.id) throw new Error('Fabric did not return the new data agent.');
    recordArtifact({ type: 'DataAgent', id: item.id, name: n, workspaceId: ws.id, note: `Grounded in ${p.semanticModel.name}` });
    ctx.log(`Created ${n}`);
  }
  ctx.progress(85);

  ctx.step('Check the data agent');
  const check = await F.getDefinition(ws.id, item.id).catch(() => null);
  const paths = (check?.parts || []).map((x) => x.path);
  const published = paths.includes('Files/Config/publish_info.json');
  if (!paths.some((x) => x.endsWith('/datasource.json'))) ctx.log('Fabric did not keep the data source – open the agent and add the semantic model there.');
  else ctx.log(`Data source: ${p.semanticModel.name}${published ? ' · published' : ' · draft (publish it in Fabric to use it outside Fabric)'}`);

  const proposal = getProject().dataAgentProposal;
  const dataAgent = {
    id: item.id, name: item.displayName || n, workspaceId: ws.id, url: fabricUrl('DataAgent', ws.id, item.id), semanticModel: p.semanticModel.name, semanticModelId: p.semanticModel.id,
    instructions: ai, description: desc, published, tables: meta.tables.length, measures: meta.measures.length,
    createdAt: p.dataAgent?.id === item.id ? p.dataAgent.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  updateProject({
    dataAgent,
    ...(proposalId && proposal?.id === proposalId ? { dataAgentProposal: { ...proposal, appliedAt: new Date().toISOString(), agentId: item.id } } : {}),
  });
  setStep('share', 'done', `Data agent ${dataAgent.name}`);
  logActivity('data-agent', `Data agent "${dataAgent.name}" on ${p.semanticModel.name}${published ? ' (published)' : ''}`, { agentId: item.id });
  return { id: item.id, name: dataAgent.name, url: fabricUrl('DataAgent', ws.id, item.id), published, tables: meta.tables.length, measures: meta.measures.length };
}

/** Forget the data agent (optionally deleting it). */
export async function removeDataAgent({ deleteItem = false } = {}) {
  await assertProjectTenant();
  const p = getProject();
  if (deleteItem && p.dataAgent?.id) await F.deleteItem(p.dataAgent.workspaceId, p.dataAgent.id).catch((e) => { if (e.status !== 404) throw e; });
  updateProject({ dataAgent: null });
  return { ok: true };
}
