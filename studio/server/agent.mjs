// AI agent layer: GitHub Copilot SDK runtime + the customer's chosen model provider + Fabric MCP servers + studio tools.
import { CopilotClient, ToolSet, BuiltInTools, defineTool } from '@github/copilot-sdk';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { COPILOT_HOME, DATA_DIR, REPO_ROOT, STUDIO_ROOT, getSettings, envApiKey, newId, truncate, readJson, writeJson } from './config.mjs';
import { getToken, tokenExpiresOn, SCOPES } from './auth.mjs';
import { emit } from './events.mjs';
import { getProject, updateProject, logActivity, assertProjectTenant } from './project.mjs';
import { startJob, waitForJob } from './jobs.mjs';
import * as P from './pipelines.mjs';
import * as R from './reports/index.mjs';
import * as F from './fabric.mjs';
import { presetFor } from './presets.mjs';

export const MCP_ENDPOINTS = {
  'fabric-core': 'https://api.fabric.microsoft.com/v1/mcp/core',
  'powerbi-authoring': 'https://api.fabric.microsoft.com/v1/mcp/powerbi/authoring',
  'fabric-iq': 'https://fabriciq.svc.cloud.microsoft/v1/mcp/fabriciq',
  ontology: (ws, id) => `https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/${ws}/items/${id}/ontologyEndpoint`,
};

export const PROVIDERS = [
  { id: 'github', name: 'GitHub Copilot', license: 'GitHub Copilot Free, Pro, Pro+, Business or Enterprise', needs: 'GitHub sign-in (gh auth login) with a Copilot seat', fields: [] },
  {
    id: 'azure-openai', name: 'Azure AI Foundry / Azure OpenAI', license: 'Azure subscription with a model deployment',
    needs: 'Endpoint and deployment; Entra ID (recommended) or API key',
    fields: [
      { id: 'baseUrl', label: 'Endpoint', placeholder: 'https://my-resource.openai.azure.com' },
      { id: 'deployment', label: 'Deployment name', placeholder: 'gpt-5' },
      { id: 'modelId', label: 'Model', placeholder: 'gpt-5' },
      { id: 'authMode', label: 'Authentication', options: ['entra', 'key'] },
      { id: 'apiKey', label: 'API key (only for key auth)', secret: true },
      { id: 'apiVersion', label: 'API version (optional)', placeholder: '' },
      { id: 'wireApi', label: 'API format', options: ['completions', 'responses'] },
    ],
  },
  {
    id: 'openai', name: 'OpenAI', license: 'OpenAI API key',
    needs: 'API key', fields: [
      { id: 'modelId', label: 'Model', placeholder: 'gpt-5' },
      { id: 'apiKey', label: 'API key', secret: true },
      { id: 'baseUrl', label: 'Base URL (optional)', placeholder: 'https://api.openai.com/v1' },
    ],
  },
  {
    id: 'anthropic', name: 'Anthropic Claude', license: 'Anthropic API key',
    needs: 'API key', fields: [
      { id: 'modelId', label: 'Model', placeholder: 'claude-sonnet-4-5' },
      { id: 'apiKey', label: 'API key', secret: true },
    ],
  },
  {
    id: 'local', name: 'Local model (OpenAI-compatible)', license: 'Ollama, LM Studio, vLLM… on your network',
    needs: 'Base URL and a tool-calling model', fields: [
      { id: 'baseUrl', label: 'Base URL', placeholder: 'http://localhost:11434/v1' },
      { id: 'modelId', label: 'Model', placeholder: 'qwen3:32b' },
      { id: 'apiKey', label: 'API key (optional)', secret: true },
    ],
  },
];

let client = null;
let clientStarting = null;
let memGitHubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const chats = new Map();               // chatId -> { session, title, busy, tokenExp, transcript[] }
const approvals = new Map();           // approvalId -> { resolve, info }
const CHAT_DIR = join(DATA_DIR, 'chats');
if (!existsSync(CHAT_DIR)) mkdirSync(CHAT_DIR, { recursive: true });

export function setGitHubToken(t) { memGitHubToken = t || ''; restartClient(); }

async function getClient() {
  if (client) return client;
  if (clientStarting) return clientStarting;
  clientStarting = (async () => {
    const c = new CopilotClient({
      mode: 'empty',
      baseDirectory: COPILOT_HOME,
      workingDirectory: REPO_ROOT,
      logLevel: 'error',
      ...(memGitHubToken ? { gitHubToken: memGitHubToken } : {}),
    });
    await c.start();
    client = c;
    clientStarting = null;
    return c;
  })().catch((e) => { clientStarting = null; throw e; });
  return clientStarting;
}

export async function restartClient() {
  const c = client;
  client = null;
  for (const [id, chat] of chats) { try { await chat.session?.disconnect(); } catch { /* ignore */ } chats.delete(id); }
  if (c) { try { await c.stop(); } catch { /* ignore */ } }
}

export async function stopAgent() { await restartClient(); }

export async function copilotStatus() {
  try {
    const c = await getClient();
    const auth = await c.getAuthStatus();
    return { ok: true, ...auth };
  } catch (e) {
    return { ok: false, isAuthenticated: false, statusMessage: e.message };
  }
}

export async function listModels() {
  const s = getSettings().provider;
  if (s.id !== 'github') {
    const m = s.config?.modelId || s.model;
    return m ? [{ id: m, name: m }] : [];
  }
  const c = await getClient();
  const models = await c.listModels();
  return models.map((m) => ({ id: m.id, name: m.name || m.id, reasoning: Boolean(m.capabilities?.supports?.reasoningEffort) }));
}

// ---------------- provider ----------------

function providerConfig() {
  const s = getSettings().provider;
  const cfg = s.config || {};
  const apiKey = cfg.apiKey || envApiKey(s.id);
  switch (s.id) {
    case 'azure-openai': {
      if (!cfg.baseUrl || !(cfg.deployment || cfg.modelId)) throw new Error('Configure the Azure endpoint and deployment in Settings › AI provider.');
      const provider = {
        type: 'azure',
        baseUrl: cfg.baseUrl.replace(/\/+(openai.*)?$/i, ''),
        wireApi: cfg.wireApi || 'completions',
        modelId: cfg.modelId || cfg.deployment,
        wireModel: cfg.deployment || cfg.modelId,
        ...(cfg.apiVersion ? { azure: { apiVersion: cfg.apiVersion } } : {}),
      };
      if ((cfg.authMode || 'entra') === 'key') {
        if (!apiKey) throw new Error('Add the Azure OpenAI API key in Settings, or switch to Entra ID authentication.');
        provider.apiKey = apiKey;
      } else {
        provider.bearerTokenProvider = async () => getToken(SCOPES.cognitive);
      }
      return { model: cfg.modelId || cfg.deployment, provider };
    }
    case 'openai':
      if (!apiKey) throw new Error('Add your OpenAI API key in Settings › AI provider.');
      return { model: cfg.modelId || s.model || 'gpt-5', provider: { type: 'openai', baseUrl: cfg.baseUrl || 'https://api.openai.com/v1', apiKey } };
    case 'anthropic':
      if (!apiKey) throw new Error('Add your Anthropic API key in Settings › AI provider.');
      return { model: cfg.modelId || s.model || 'claude-sonnet-4-5', provider: { type: 'anthropic', baseUrl: cfg.baseUrl || 'https://api.anthropic.com', apiKey } };
    case 'local':
      return { model: cfg.modelId || s.model, provider: { type: 'openai', baseUrl: cfg.baseUrl || 'http://localhost:11434/v1', ...(apiKey ? { apiKey } : {}) } };
    default:
      return { model: s.model || 'auto', ...(s.reasoningEffort ? { reasoningEffort: s.reasoningEffort } : {}) };
  }
}

export function providerSummary() {
  const s = getSettings().provider;
  const meta = PROVIDERS.find((p) => p.id === s.id) || PROVIDERS[0];
  const model = s.id === 'github' ? s.model || 'auto' : s.config?.modelId || s.config?.deployment || s.model || '';
  return { id: meta.id, name: meta.name, model };
}

// ---------------- MCP servers ----------------

export async function mcpServerConfig() {
  const s = getSettings().mcp;
  const token = await getToken(SCOPES.fabric);
  const headers = { Authorization: `Bearer ${token}` };
  const servers = {};
  const isWin = process.platform === 'win32';
  const npx = (args) => (isWin ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args });
  if (s['fabric-core']) servers['fabric-core'] = { type: 'http', url: MCP_ENDPOINTS['fabric-core'], headers, tools: ['*'] };
  if (s['powerbi-authoring'] === 'hosted') servers['powerbi-authoring'] = { type: 'http', url: MCP_ENDPOINTS['powerbi-authoring'], headers, tools: ['*'] };
  if (s['powerbi-authoring'] === 'local') servers['powerbi-authoring'] = { type: 'local', ...npx(['-y', '@microsoft/powerbi-modeling-mcp@latest', '--start']), tools: ['*'], timeout: 120000 };
  if (s['fabric-iq']) servers['fabric-iq'] = { type: 'http', url: MCP_ENDPOINTS['fabric-iq'], headers: { ...headers, 'X-Variants': 'Fabric.Routing.FabricIQ.V1' }, tools: ['*'] };
  if (s['fabric-local']) servers['fabric-local'] = { type: 'local', ...npx(['-y', '@microsoft/fabric-mcp@latest', 'server', 'start', '--mode', 'all']), tools: ['*'], timeout: 120000 };
  const p = getProject();
  if (s['fabric-ontology'] && p.workspace?.id && p.ontology?.id) {
    servers['fabric-ontology'] = { type: 'http', url: MCP_ENDPOINTS.ontology(p.workspace.id, p.ontology.id), headers, tools: ONTOLOGY_TOOLS };
  }
  return servers;
}

// Ontology MCP: definitions and rules only. Natural-language questions (ask_ontology, and search_ontology on
// older ontologies) are turned off for now; numbers come from Fabric IQ.
export const ONTOLOGY_TOOLS = ['list_ontology_entities', 'list_ontology_rules', 'list_ontology_entity_types'];
const BLOCKED_TOOLS = { 'fabric-ontology': ['ask_ontology', 'search_ontology'] };

// ---------------- approvals ----------------

const READ_OPS = /^(help|list|get|export|query|execute(query)?|describe|connect|connectfabric|disconnect|getconnection|listconnections|search|find|validate|evaluate|analy[sz]e|run(query)?|preview|bpa|best)/i;

export function classifyTool(toolName, args) {
  const name = String(toolName || '');
  const studio = STUDIO_TOOLS_META[name];
  if (studio) return { write: studio.write, server: 'studio', tool: name, title: studio.title };
  const m = name.match(/^(fabric-core|powerbi-authoring|fabric-iq|fabric-local|fabric-ontology)-(.+)$/);
  if (!m) return { write: false, server: 'built-in', tool: name, title: name };
  const [, server, tool] = m;
  let write = false;
  if (server === 'fabric-core') write = /^(create|update|delete|add|bulk_move|move)/i.test(tool);
  else if (server === 'powerbi-authoring') {
    const op = args?.request?.operation || args?.operation || '';
    write = tool !== 'dax_query_operations' && tool !== 'connection_operations' && !READ_OPS.test(String(op));
  } else if (server === 'fabric-local') write = /(create|upload|delete|update|modify|reset|run-pipeline|execute)/i.test(tool);
  else if (server === 'fabric-ontology') write = /(create|update|delete|apply|write)/i.test(tool);
  return { write, server, tool, title: tool.replace(/[_-]+/g, ' ') };
}

async function approve(chatId, input) {
  const info = classifyTool(input.toolName, input.toolArgs);
  if (BLOCKED_TOOLS[info.server]?.includes(info.tool)) {
    return { permissionDecision: 'deny', permissionDecisionReason: 'Ontology questions are turned off in this studio. Use list_ontology_rules or list_ontology_entities for definitions and Fabric IQ for numbers.' };
  }
  if (!info.write) return { permissionDecision: 'allow' };
  const mode = getSettings().approvalMode;
  if (mode === 'readonly') {
    logActivity('tool.blocked', `Blocked ${info.server}/${info.tool} (read-only mode)`, { chatId });
    return { permissionDecision: 'deny', permissionDecisionReason: 'The studio is in read-only mode. Explain what you would change instead.' };
  }
  if (mode === 'auto') return { permissionDecision: 'allow' };
  const id = newId();
  const request = { id, chatId, server: info.server, tool: info.tool, title: info.title, args: truncate(JSON.stringify(input.toolArgs ?? {}, null, 2), 6000) };
  emit('approval.request', { approval: request });
  const decision = await new Promise((resolveP) => {
    approvals.set(id, { resolve: resolveP, request });
    setTimeout(() => { if (approvals.has(id)) { approvals.delete(id); resolveP('timeout'); } }, 15 * 60 * 1000);
  });
  emit('approval.resolved', { id, decision });
  logActivity(decision === 'allow' ? 'tool.approved' : 'tool.denied', `${decision === 'allow' ? 'Approved' : 'Denied'} ${info.server}/${info.tool}`, { chatId });
  if (decision === 'allow') return { permissionDecision: 'allow' };
  return { permissionDecision: 'deny', permissionDecisionReason: decision === 'timeout' ? 'No approval received in time.' : 'The user declined this change. Do not retry; ask what they would like to do instead.' };
}

export function resolveApproval(id, decision) {
  const a = approvals.get(id);
  if (!a) return false;
  approvals.delete(id);
  a.resolve(decision === 'allow' ? 'allow' : 'deny');
  return true;
}

export const pendingApprovals = () => [...approvals.values()].map((a) => a.request);

// ---------------- studio tools ----------------

const STUDIO_TOOLS_META = {
  studio_get_project_state: { write: false, title: 'Read project state' },
  studio_use_workspace: { write: true, title: 'Use or create workspace' },
  studio_list_capacities: { write: false, title: 'List capacities' },
  studio_load_sample_data: { write: true, title: 'Load sample data' },
  studio_list_connections: { write: false, title: 'List Fabric connections' },
  studio_mirror_database: { write: true, title: 'Mirror database into Fabric' },
  studio_list_items: { write: false, title: 'List Fabric items' },
  studio_use_item_in_place: { write: false, title: 'Use existing item' },
  studio_create_shortcuts: { write: true, title: 'Create OneLake shortcuts' },
  studio_describe_data: { write: false, title: 'Describe data source' },
  studio_query_data: { write: false, title: 'Query data (read-only)' },
  studio_create_semantic_model: { write: true, title: 'Create semantic model' },
  studio_propose_semantic_model: { write: false, title: 'Suggest semantic model design' },
  studio_describe_report_options: { write: false, title: 'Read report options (model profile, themes, pages)' },
  studio_create_report: { write: true, title: 'Create Power BI report' },
  studio_deploy_ontology: { write: true, title: 'Deploy ontology' },
  studio_get_glossary: { write: false, title: 'Read business glossary' },
  studio_save_glossary: { write: false, title: 'Save business glossary' },
};

async function runAsJob(kind, title, fn) {
  await assertProjectTenant();
  const job = startJob(kind, title, fn);
  const done = await waitForJob(job.id);
  if (done.status !== 'succeeded') return { ok: false, error: done.error, log: done.logLines.slice(-8) };
  return { ok: true, result: done.result };
}

function projectSummary() {
  const p = getProject();
  const preset = presetFor(p);
  return {
    workspace: p.workspace, lakehouse: p.lakehouse, source: p.source, modelSource: p.modelSource,
    semanticModel: p.semanticModel, ontology: p.ontology, steps: p.steps,
    glossaryChars: (p.glossary || '').length,
    sample: preset ? { semanticModelName: preset.semanticModelName, ontologyName: preset.ontologyName, measures: (preset.measures || []).map((m) => `${m.table}[${m.name}]`) } : null,
    modelProposal: p.modelProposal ? { name: p.modelProposal.name, createdAt: p.modelProposal.createdAt, appliedAt: p.modelProposal.appliedAt || null } : null,
    links: p.workspace ? { workspace: `https://app.fabric.microsoft.com/groups/${p.workspace.id}` } : {},
  };
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });

// Same design fields for suggesting and for creating a semantic model.
const MODEL_DESIGN = {
  name: str('Semantic model name'),
  tables: { type: 'array', items: { type: 'string' }, description: 'Source tables to include as schema.table (default: all)' },
  tableNames: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map source table (schema.table) to business name' },
  relationships: {
    type: 'array', description: 'Many-to-one relationships (from fact column to dimension key) using source table names',
    items: obj({ fromTable: str('schema.table'), fromColumn: str('column'), toTable: str('schema.table'), toColumn: str('column'), active: { type: 'boolean' } }, ['fromTable', 'fromColumn', 'toTable', 'toColumn']),
  },
  measures: {
    type: 'array', description: 'DAX measures',
    items: obj({ table: str('Business table name'), name: str('Measure name'), expression: str('DAX expression'), formatString: str('Format string'), description: str('Plain-language description'), displayFolder: str('Display folder') }, ['table', 'name', 'expression']),
  },
};

function modelDesign(a) {
  const split = (s) => { const [schema, ...rest] = String(s).split('.'); return rest.length ? { schema, table: rest.join('.') } : { schema: 'dbo', table: schema }; };
  const relationships = a.relationships?.map((r) => ({ from: { ...split(r.fromTable), column: r.fromColumn }, to: { ...split(r.toTable), column: r.toColumn }, active: r.active !== false }));
  return { name: a.name, include: a.tables, names: a.tableNames, relationships, measures: a.measures };
}

// The SDK reports a thrown error only as "Tool execution failed"; return the cause so Copilot can explain it
// (for example a paused capacity or a missing permission).
function studioTool(name, def) {
  return defineTool(name, {
    ...def,
    handler: async (a) => {
      try { return await def.handler(a); } catch (e) { return { ok: false, error: e.message || String(e) }; }
    },
  });
}

function studioTools(chatId) {
  return [
    studioTool('studio_get_project_state', {
      description: 'Get the Fabric MCP Studio project state: selected workspace, lakehouse, data source, model source (SQL endpoint), semantic model, ontology and completed steps. Call this first.',
      parameters: obj({}), handler: async () => projectSummary(),
    }),
    studioTool('studio_list_capacities', {
      description: 'List Fabric capacities the user can use (id, name, SKU, region, state).',
      parameters: obj({}), handler: async () => (await F.listCapacities()).map((c) => ({ id: c.id, name: c.displayName, sku: c.sku, region: c.region, state: c.state })),
    }),
    studioTool('studio_use_workspace', {
      description: 'Select an existing workspace (by id) or create a new one (name + capacityId) and make it the project workspace. Always use this instead of fabric-core create_workspace so the studio tracks it.',
      parameters: obj({ workspaceId: str('Existing workspace ID'), name: str('Name for a new workspace'), capacityId: str('Capacity ID for a new workspace') }),
      handler: async (a) => P.selectWorkspace(a),
    }),
    studioTool('studio_load_sample_data', {
      description: 'Load a sample dataset into the project workspace and set it as the model source. "retail": Contoso Retail (6 tables) into a lakehouse, about 3 minutes. "adventureworks": Microsoft\'s AdventureWorksDW2022 created as a Fabric SQL database and replicated to OneLake, about 8 minutes.',
      parameters: obj({ dataset: { type: 'string', enum: ['retail', 'adventureworks'] } }, ['dataset']),
      handler: async ({ dataset }) => (dataset === 'adventureworks'
        ? runAsJob('sample', 'Create AdventureWorksDW2022 in a Fabric SQL database', (ctx) => P.runSampleAdventureWorks(ctx))
        : runAsJob('sample', 'Load Contoso Retail sample', (ctx) => P.runSampleRetail(ctx))),
    }),
    studioTool('studio_list_connections', {
      description: 'List Fabric connections the user can use for mirroring (SQL, AzurePostgreSQL…), including on-premises gateway connections.',
      parameters: obj({ type: str('Optional connection type filter, e.g. SQL or AzurePostgreSQL') }),
      handler: async ({ type }) => (await F.listConnections()).filter((c) => !type || c.type === type),
    }),
    studioTool('studio_mirror_database', {
      description: 'Mirror a database into the project workspace with Fabric Mirroring using an existing Fabric connection ID (never ask for passwords in chat; the user creates connections in the Data tab). sourceType: azure-sql | sql-mi | sql-server | azure-postgres.',
      parameters: obj({
        sourceType: { type: 'string', enum: ['azure-sql', 'sql-mi', 'sql-server', 'azure-postgres'] },
        connectionId: str('Fabric connection ID'), database: str('Source database name'),
        tables: { type: 'array', items: obj({ schema: str('Schema'), name: str('Table') }, ['name']), description: 'Optional subset of tables; omit for all tables' },
        name: str('Optional mirrored database name'),
      }, ['sourceType', 'connectionId', 'database']),
      handler: async (a) => runAsJob('mirror', `Mirror ${a.database}`, (ctx) => P.runMirror(ctx, { typeId: a.sourceType, connectionId: a.connectionId, database: a.database, tables: a.tables || [], name: a.name })),
    }),
    studioTool('studio_list_items', {
      description: 'List Lakehouse, Warehouse, MirroredDatabase or SQLDatabase items in a workspace (to use the customer\'s existing Fabric data).',
      parameters: obj({ workspaceId: str('Workspace ID'), itemType: { type: 'string', enum: ['Lakehouse', 'Warehouse', 'MirroredDatabase', 'SQLDatabase'] } }, ['workspaceId', 'itemType']),
      handler: async ({ workspaceId, itemType }) => P.listSourceItems(workspaceId, itemType),
    }),
    studioTool('studio_use_item_in_place', {
      description: 'Use an existing Lakehouse, Warehouse or MirroredDatabase directly as the model source (no data copy).',
      parameters: obj({ workspaceId: str('Workspace ID of the item'), itemId: str('Item ID'), itemType: { type: 'string', enum: ['Lakehouse', 'Warehouse', 'MirroredDatabase', 'SQLDatabase'] } }, ['workspaceId', 'itemId', 'itemType']),
      handler: async (a) => P.useInPlace(a),
    }),
    studioTool('studio_create_shortcuts', {
      description: 'Create OneLake shortcuts in the project lakehouse to tables of an existing Lakehouse or Warehouse, then use the project lakehouse as the model source.',
      parameters: obj({
        sourceWorkspaceId: str('Workspace ID of the source item'), sourceItemId: str('Source item ID'),
        sourceItemType: { type: 'string', enum: ['Lakehouse', 'Warehouse'] },
        tables: { type: 'array', items: obj({ schema: str('Schema (default dbo)'), name: str('Table name') }, ['name']) },
      }, ['sourceWorkspaceId', 'sourceItemId', 'sourceItemType', 'tables']),
      handler: async (a) => runAsJob('shortcut', 'Create OneLake shortcuts', (ctx) => P.runShortcuts(ctx, a)),
    }),
    studioTool('studio_describe_data', {
      description: 'Describe the model source: tables (schema, row counts), columns (types, keys) and relationships (foreign keys or inferred). Use before designing a semantic model or ontology.',
      parameters: obj({ refresh: { type: 'boolean' } }),
      handler: async ({ refresh }) => {
        const d = await P.describeModelSource({ refresh });
        return {
          source: d.source, engine: d.engine,
          tables: d.tables.map((t) => ({ table: `${t.schema}.${t.name}`, rows: t.rows, columns: t.columns.map((c) => `${c.name} ${c.type}${c.isPk || c.isKey ? ' (key)' : ''}`) })),
          relationships: d.relationships.map((r) => `${r.from.schema}.${r.from.table}.${r.from.column} -> ${r.to.schema}.${r.to.table}.${r.to.column}${r.active === false ? ' (inactive)' : ''} [${r.source || 'preset'}]`),
        };
      },
    }),
    studioTool('studio_query_data', {
      description: 'Run one read-only T-SQL SELECT against the model source SQL analytics endpoint to profile data (max 200 rows returned). Use TOP/aggregations.',
      parameters: obj({ sql: str('A single SELECT statement') }, ['sql']),
      handler: async ({ sql }) => P.queryModelSource(sql),
    }),
    studioTool('studio_propose_semantic_model', {
      description: 'Suggest a semantic model design. Nothing changes in Fabric: the studio checks the design against the schema and shows the user an "Apply suggestions" button that reviews and creates it in one click. Use this every time you propose or revise a semantic model design, instead of asking the user to type a confirmation. With sample data, the sample\'s glossary measures (project state sample.measures) are always kept; list only measures to add or change.',
      parameters: obj({ ...MODEL_DESIGN, summary: str('Two or three sentences describing the design for the user (shown in the review)') }),
      handler: async (a) => {
        const proposal = await P.proposeSemanticModel({ ...modelDesign(a), summary: a.summary }, { chatId });
        const chat = chats.get(chatId);
        chat?.transcript.push({ role: 'proposal', proposalId: proposal.id, at: Date.now() });
        emit('chat.proposal', { chatId, proposal });
        return {
          ok: true,
          model: proposal.name,
          tables: proposal.preview.tables.map((t) => `${t.key} as ${t.name} (${t.role})`),
          relationships: proposal.preview.relationships.length,
          measures: proposal.preview.measures.map((m) => `${m.table}[${m.name}]${m.suggested ? '' : ' (sample)'}`),
          warnings: proposal.warnings,
          next: 'Summarize the design briefly and tell the user to select "Apply suggestions" below your message to review and create it. Do not call studio_create_semantic_model unless the user asks you to in chat. If there are warnings, fix the design and suggest it again.',
        };
      },
    }),
    studioTool('studio_create_semantic_model', {
      description: 'Create or update a Direct Lake semantic model over the model source. The studio generates valid TMDL. Provide business table names, relationships and DAX measures (measure.table uses the business table name). Omitted values use sensible defaults. To suggest a design for the user to review, use studio_propose_semantic_model instead.',
      parameters: obj(MODEL_DESIGN),
      handler: async (a) => {
        const d = modelDesign(a);
        return runAsJob('semantic-model', `Create semantic model ${a.name || ''}`.trim(), (ctx) => P.runSemanticModel(ctx, d));
      },
    }),
    studioTool('studio_describe_report_options', {
      description: 'Read what the studio found in the project semantic model for report design (main measure, KPIs, time grain and full years, share/breakdown dimensions, top-N entity, drill hierarchy, insights) plus the available report themes and page templates. Read-only.',
      parameters: obj({ refresh: { type: 'boolean' } }),
      handler: async ({ refresh }) => {
        const pr = await R.currentProfile({ refresh });
        const ref = (r) => (r ? `${r.table}[${r.name}] (${r.label})` : null);
        return {
          model: pr.model, primary: ref(pr.primary), kpis: pr.kpis.map(ref), channels: pr.channels.map(ref),
          time: pr.time && { grain: pr.time.grain, years: pr.time.years, fullYears: pr.time.fullYears, axis: pr.time.axis.map(ref) },
          share: ref(pr.share), breakdown: ref(pr.breakdown), topList: ref(pr.entity), hierarchy: pr.hierarchy.map(ref),
          insights: pr.insights.map((i) => i.text), warnings: pr.warnings,
          themes: R.reportsCatalog().themes.map((t) => `${t.id}: ${t.name} – ${t.description}`),
          pages: R.reportsCatalog().pages.map((x) => `${x.id}: ${x.name} – ${x.description}`),
          reports: (getProject().reports || []).map((x) => ({ id: x.id, name: x.name, theme: x.theme, pages: x.pages, url: x.url })),
        };
      },
    }),
    studioTool('studio_create_report', {
      description: 'Build a professional Power BI report on the project semantic model from the studio templates and deploy it to the project workspace (an existing report with the same name is updated). Pages: executive (Executive summary), drivers (Performance drivers), scorecard (Scorecard). Themes: studio, executive, teal, slate, accessible, midnight. Call studio_describe_report_options first to recommend pages and a theme.',
      parameters: obj({
        name: str('Report name (default: "<semantic model> report")'),
        theme: { type: 'string', enum: ['studio', 'executive', 'teal', 'slate', 'accessible', 'midnight'] },
        pages: { type: 'array', items: { type: 'string', enum: ['executive', 'drivers', 'scorecard'] }, description: 'Pages in order (default: all three)' },
      }),
      handler: async (a) => runAsJob('report', `Build Power BI report ${a.name || ''}`.trim(), (ctx) => R.runReport(ctx, { name: a.name, theme: a.theme, pages: a.pages?.length ? a.pages : undefined })),
    }),
    studioTool('studio_deploy_ontology', {
      description: 'Create or update a Fabric IQ ontology bound to the model source: entity types from tables, relationships, and business rules written in plain English (one sentence, no colons). Then the ontology MCP endpoint becomes available.',
      parameters: obj({
        name: str('Ontology name'),
        tables: { type: 'array', items: { type: 'string' }, description: 'Source tables (schema.table) to model as entities (default: all except date tables)' },
        entityNames: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map schema.table to PascalCase entity name' },
        rules: {
          type: 'array',
          items: obj({
            name: str('PascalCase rule name'), statement: str('Rule in plain English, one sentence'),
            entities: { type: 'array', items: obj({ entity: str('Entity name'), properties: { type: 'array', items: { type: 'string' } } }, ['entity']) },
            relationships: { type: 'array', items: { type: 'string' } },
          }, ['name', 'statement']),
        },
      }),
      handler: async (a) => runAsJob('ontology', `Deploy ontology ${a.name || ''}`.trim(), (ctx) => P.runOntology(ctx, { name: a.name, include: a.tables, entityNames: a.entityNames, rules: a.rules })),
    }),
    studioTool('studio_get_glossary', {
      description: 'Get the customer business glossary (definitions, measures, rules) used to ground measures and ontology rules.',
      parameters: obj({}), handler: async () => ({ glossary: getProject().glossary || '(no glossary yet)' }),
    }),
    studioTool('studio_save_glossary', {
      description: 'Save or replace the business glossary text (markdown).',
      parameters: obj({ text: str('Glossary markdown') }, ['text']),
      handler: async ({ text }) => { updateProject({ glossary: text }); return { ok: true }; },
    }),
  ];
}

function instructions() {
  const file = join(STUDIO_ROOT, 'server', 'agent-instructions.md');
  const base = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const s = projectSummary();
  return `${base}\n\n## Current project (snapshot at session start; call studio_get_project_state for the latest)\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\`\n`;
}

// ---------------- chat sessions ----------------

async function sessionConfig(chatId) {
  const prov = providerConfig();
  return {
    ...prov,
    clientName: 'fabric-mcp-studio',
    streaming: true,
    workingDirectory: REPO_ROOT,
    availableTools: new ToolSet().addBuiltIn(BuiltInTools.Isolated).addMcp('*').addCustom('*').toArray(),
    mcpServers: await mcpServerConfig(),
    tools: studioTools(chatId),
    systemMessage: { mode: 'append', content: instructions() },
    hooks: { onPreToolUse: (input) => approve(chatId, input) },
    onPermissionRequest: async () => ({ kind: 'approved' }),
    infiniteSessions: { enabled: true },
  };
}

function transcriptPath(id) { return join(CHAT_DIR, `${id}.json`); }

function persist(chat) {
  writeJson(transcriptPath(chat.id), { id: chat.id, title: chat.title, createdAt: chat.createdAt, provider: chat.provider, transcript: chat.transcript.slice(-400) });
}

function wire(chat) {
  const s = chat.session;
  const toolIndex = new Map();
  chat.unsubscribe?.();
  chat.unsubscribe = s.on((e) => {
    const d = e.data || {};
    switch (e.type) {
      case 'assistant.message_delta':
        if (d.deltaContent) emit('chat.delta', { chatId: chat.id, delta: d.deltaContent });
        break;
      case 'assistant.reasoning_delta':
        if (d.deltaContent) emit('chat.reasoning.delta', { chatId: chat.id, delta: d.deltaContent });
        break;
      case 'assistant.message':
        if (d.content) {
          chat.transcript.push({ role: 'assistant', content: d.content, at: Date.now() });
          emit('chat.message', { chatId: chat.id, content: d.content });
        }
        break;
      case 'tool.execution_start': {
        const name = d.toolName || '';
        const info = classifyTool(name, d.arguments);
        const card = { role: 'tool', id: d.toolCallId, name, server: d.mcpServerName || info.server, tool: d.toolTitle || info.tool, args: truncate(JSON.stringify(d.arguments ?? {}, null, 2), 3000), status: 'running', write: info.write, at: Date.now() };
        toolIndex.set(d.toolCallId, card);
        chat.transcript.push(card);
        emit('chat.tool.start', { chatId: chat.id, tool: card });
        break;
      }
      case 'tool.execution_complete': {
        const card = toolIndex.get(d.toolCallId) || { id: d.toolCallId };
        const content = d.result?.content ?? d.result ?? d.error;
        card.ms = Date.now() - (card.at || Date.now());
        card.result = truncate(typeof content === 'string' ? content : JSON.stringify(content), 4000);
        card.status = d.success === false || /^\s*\{\s*"ok"\s*:\s*false/.test(card.result) ? 'failed' : 'done';
        emit('chat.tool.done', { chatId: chat.id, tool: card });
        break;
      }
      case 'session.title_changed':
        if (d.title) { chat.title = d.title; emit('chat.title', { chatId: chat.id, title: d.title }); }
        break;
      case 'session.error':
        chat.busy = false;
        chat.transcript.push({ role: 'error', content: d.message || 'Session error', at: Date.now() });
        emit('chat.error', { chatId: chat.id, message: d.message || 'The AI session reported an error.' });
        persist(chat);
        break;
      case 'session.idle':
        chat.busy = false;
        emit('chat.idle', { chatId: chat.id });
        persist(chat);
        break;
      case 'assistant.usage':
        emit('chat.usage', { chatId: chat.id, usage: { model: d.model, input: d.inputTokens, output: d.outputTokens } });
        break;
      case 'session.mcp_server_status_changed':
        emit('chat.mcp', { chatId: chat.id, server: d.serverName || d.name, status: d.status, error: d.error });
        break;
      default:
    }
  });
}

export async function createChat() {
  const c = await getClient();
  const id = newId();
  const session = await c.createSession({ sessionId: id, ...(await sessionConfig(id)) });
  const chat = { id, session, title: 'New chat', busy: false, tokenExp: tokenExpiresOn(SCOPES.fabric), createdAt: new Date().toISOString(), provider: providerSummary(), transcript: [] };
  chats.set(id, chat);
  wire(chat);
  persist(chat);
  logActivity('chat.create', 'Started a Copilot chat', { chatId: id, provider: chat.provider });
  return { id, title: chat.title, provider: chat.provider };
}

async function ensureFresh(chat) {
  // Fabric tokens in MCP headers expire after ~60 minutes: resume the session with fresh headers.
  if (Date.now() < chat.tokenExp - 10 * 60 * 1000 && chat.ontologyId === getProject().ontology?.id) return;
  const c = await getClient();
  try { await chat.session.disconnect(); } catch { /* ignore */ }
  chat.session = await c.resumeSession(chat.id, await sessionConfig(chat.id));
  chat.tokenExp = tokenExpiresOn(SCOPES.fabric);
  chat.ontologyId = getProject().ontology?.id;
  wire(chat);
}

async function getChat(id) {
  let chat = chats.get(id);
  if (chat) return chat;
  const saved = readJson(transcriptPath(id), null);
  if (!saved) throw new Error('Chat not found');
  const c = await getClient();
  const session = await c.resumeSession(id, await sessionConfig(id));
  chat = { id, session, title: saved.title, busy: false, tokenExp: tokenExpiresOn(SCOPES.fabric), createdAt: saved.createdAt, provider: saved.provider, transcript: saved.transcript || [] };
  chats.set(id, chat);
  wire(chat);
  return chat;
}

export async function sendMessage(chatId, prompt) {
  const chat = await getChat(chatId);
  if (chat.busy) throw new Error('The assistant is still working on the previous message. Stop it or wait.');
  if (!chat.ontologyId) chat.ontologyId = getProject().ontology?.id;
  await ensureFresh(chat);
  chat.busy = true;
  chat.transcript.push({ role: 'user', content: prompt, at: Date.now() });
  emit('chat.user', { chatId, content: prompt });
  try {
    await chat.session.send({ prompt });
  } catch (e) {
    chat.busy = false;
    throw e;
  }
  return { ok: true };
}

export async function abortChat(chatId) {
  const chat = chats.get(chatId);
  if (!chat) return false;
  try { await chat.session.abort(); } catch { /* ignore */ }
  chat.busy = false;
  for (const [id, a] of approvals) if (a.request.chatId === chatId) resolveApproval(id, 'deny');
  return true;
}

export function listChats() {
  const live = [...chats.values()].map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, provider: c.provider, busy: c.busy }));
  return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function chatHistory(chatId) {
  const chat = chats.get(chatId) || readJson(transcriptPath(chatId), null);
  if (!chat) return null;
  return { id: chatId, title: chat.title, transcript: chat.transcript || [], busy: Boolean(chat.busy) };
}

export async function deleteChat(chatId) {
  const chat = chats.get(chatId);
  if (chat) { try { await chat.session.disconnect(); } catch { /* ignore */ } chats.delete(chatId); }
  return true;
}

/** Quick connectivity test for the selected provider (no tools). */
export async function testProvider() {
  const c = await getClient();
  const prov = providerConfig();
  const started = Date.now();
  const session = await c.createSession({
    ...prov, clientName: 'fabric-mcp-studio', availableTools: [],
    onPermissionRequest: async () => ({ kind: 'approved' }),
    systemMessage: { mode: 'append', content: 'Reply with exactly: OK' },
    infiniteSessions: { enabled: false },
  });
  try {
    const r = await session.sendAndWait({ prompt: 'Health check. Reply with exactly OK.' }, 90000);
    return { ok: true, reply: String(r?.data?.content || '').slice(0, 80), ms: Date.now() - started, ...providerSummary() };
  } finally {
    try { await session.disconnect(); } catch { /* ignore */ }
  }
}
