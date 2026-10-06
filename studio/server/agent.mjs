// AI agent layer: GitHub Copilot SDK runtime + the customer's chosen model provider + Fabric MCP servers + studio tools.
import { CopilotClient, ToolSet, BuiltInTools, defineTool } from '@github/copilot-sdk';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { COPILOT_HOME, DATA_DIR, REPO_ROOT, STUDIO_ROOT, getSettings, envApiKey, newId, truncate, readJson, writeJson, isDeveloper } from './config.mjs';
import { getToken, tokenExpiresOn, SCOPES, whoAmI } from './auth.mjs';
import { emit } from './events.mjs';
import { getProject, updateProject, logActivity, assertProjectTenant, projectModels, sourceContexts, modelFits } from './project.mjs';
import { startJob, waitForJob } from './jobs.mjs';
import * as P from './pipelines.mjs';
import * as R from './reports/index.mjs';
import * as APPS from './reports/apps.mjs';
import * as TPL from './reports/library.mjs';
import * as RT from './realtime/index.mjs';
import * as PL from './planning/index.mjs';
import * as DP from './dataprep.mjs';
import * as DA from './dataagent.mjs';
import { readiness, cachedReadiness, assertModuleReady, assertLiveEventsAllowed } from './readiness.mjs';
import * as F from './fabric.mjs';
import { presetFor, presetSummary } from './presets.mjs';
import * as N from './naming.mjs';
import * as WTF from './workspace-taskflow.mjs';
import * as MODELS from './models.mjs';
import * as MC from './modelcheck.mjs';
import * as LINKS from './modellinks.mjs';
import * as ARTS from './artifacts.mjs';

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

/** The providers people can choose: GitHub Copilot only in developer mode. */
export const visibleProviders = () => (isDeveloper() ? PROVIDERS : PROVIDERS.filter((p) => p.id !== 'github'));

let client = null;
let clientStarting = null;
// Token pasted in Settings (memory only). Environment tokens are tried by the runtime itself; see getClient().
let memGitHubToken = '';
let authNote = '';
const ENV_TOKENS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
const chats = new Map();               // chatId -> { session, title, busy, tokenExp, transcript[] }
const approvals = new Map();           // approvalId -> { resolve, info }
const CHAT_DIR = join(DATA_DIR, 'chats');
if (!existsSync(CHAT_DIR)) mkdirSync(CHAT_DIR, { recursive: true });

export function setGitHubToken(t) { memGitHubToken = t || ''; restartClient(); }

async function startRuntime({ token = '', env } = {}) {
  const c = new CopilotClient({
    mode: 'empty',
    baseDirectory: COPILOT_HOME,
    workingDirectory: REPO_ROOT,
    logLevel: 'error',
    ...(token ? { gitHubToken: token } : {}),
    ...(env ? { env } : {}),
  });
  await c.start();
  return c;
}

/**
 * GitHub Copilot sign-in, in order: a token pasted in Settings, then the runtime's defaults (COPILOT_GITHUB_TOKEN,
 * GH_TOKEN or GITHUB_TOKEN environment variables, then the GitHub CLI sign-in). Many people set GITHUB_TOKEN for other
 * tools with a token that has no Copilot access; when that token isn't accepted, retry with the GitHub CLI sign-in.
 */
async function getClient() {
  if (client) return client;
  if (clientStarting) return clientStarting;
  clientStarting = (async () => {
    authNote = '';
    const withoutEnvTokens = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !ENV_TOKENS.includes(k.toUpperCase())));
    let c;
    if (memGitHubToken) c = await startRuntime({ token: memGitHubToken, env: withoutEnvTokens() });
    else {
      c = await startRuntime();
      const envToken = ENV_TOKENS.find((k) => process.env[k]);
      if (envToken && getSettings().provider.id === 'github') {
        let ok = false;
        try { ok = (await c.getAuthStatus())?.isAuthenticated; } catch { ok = false; }
        if (!ok) {
          try { await c.stop(); } catch { /* ignore */ }
          c = await startRuntime({ env: withoutEnvTokens() });
          authNote = `The ${envToken} environment variable has no GitHub Copilot access, so it was skipped.`;
        }
      }
    }
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
    return { ok: true, ...auth, ...(authNote ? { note: authNote } : {}) };
  } catch (e) {
    return { ok: false, isAuthenticated: false, statusMessage: e.message };
  }
}

const NOT_SIGNED_IN = 'GitHub Copilot isn\'t signed in. Open Settings › AI provider and select "Sign in with GitHub CLI" (or paste a token), or choose another AI provider.';

/** Fail early with a clear message instead of the runtime's "Session was not created with authentication info". */
async function assertCopilotSignedIn() {
  if (getSettings().provider.id !== 'github') return;
  const c = await getClient();
  let ok = false;
  try { ok = (await c.getAuthStatus())?.isAuthenticated; } catch { ok = false; }
  if (!ok) throw Object.assign(new Error(NOT_SIGNED_IN), { code: 'COPILOT_AUTH', status: 401 });
}

export async function listModels() {
  const s = getSettings().provider;
  if (s.id !== 'github') {
    const m = s.config?.modelId || s.model;
    return m ? [{ id: m, name: m }] : [];
  }
  const c = await getClient();
  const models = await c.listModels();
  // The list can come back empty (for example on Copilot Free); "auto" always works.
  if (!models.some((m) => m.id === 'auto')) models.unshift({ id: 'auto', name: 'auto' });
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

/** Why chats can't start with the selected provider yet (missing endpoint, deployment or key), or null. */
export function providerProblem() {
  try { providerConfig(); return null; } catch (e) { return e.message; }
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
  studio_set_naming: { write: false, title: 'Set the naming standard (domain and environment)' },
  studio_list_capacities: { write: false, title: 'List capacities' },
  studio_load_sample_data: { write: true, title: 'Load sample data' },
  studio_list_connections: { write: false, title: 'List Fabric connections' },
  studio_mirror_database: { write: true, title: 'Mirror database into Fabric' },
  studio_list_items: { write: false, title: 'List Fabric items' },
  studio_use_item_in_place: { write: false, title: 'Use existing item' },
  studio_create_shortcuts: { write: true, title: 'Create OneLake shortcuts' },
  studio_list_data_sources: { write: false, title: 'List the data sources of the workspace' },
  studio_switch_data_source: { write: false, title: 'Switch to another data source' },
  studio_describe_data: { write: false, title: 'Describe data source' },
  studio_query_data: { write: false, title: 'Query data (read-only)' },
  studio_data_prep_status: { write: false, title: 'Read the data prep notebook results' },
  studio_create_data_prep_notebook: { write: true, title: 'Create and run the data prep notebook' },
  studio_create_semantic_model: { write: true, title: 'Create semantic model' },
  studio_propose_semantic_model: { write: false, title: 'Suggest semantic model design' },
  studio_describe_report_options: { write: false, title: 'Read report options (model profile, themes, pages)' },
  studio_propose_report: { write: false, title: 'Suggest a Power BI report' },
  studio_create_report: { write: true, title: 'Create Power BI report' },
  studio_list_report_templates: { write: false, title: 'Read your uploaded report templates' },
  studio_check_report_template: { write: false, title: 'Check a report template against the model' },
  studio_create_report_from_template: { write: true, title: 'Create Power BI report from your template' },
  studio_create_org_app: { write: true, title: 'Create org app' },
  studio_data_agent_status: { write: false, title: 'Read the Fabric data agent' },
  studio_propose_data_agent: { write: false, title: 'Suggest a Fabric data agent' },
  studio_suggest_apply: { write: false, title: 'Offer an Apply button' },
  studio_create_data_agent: { write: true, title: 'Create the Fabric data agent' },
  studio_deploy_ontology: { write: true, title: 'Deploy ontology' },
  studio_get_glossary: { write: false, title: 'Read business glossary' },
  studio_save_glossary: { write: false, title: 'Save business glossary' },
  studio_realtime_status: { write: false, title: 'Read live data status' },
  studio_query_live_events: { write: false, title: 'Query live events (read-only KQL)' },
  studio_setup_live_data: { write: true, title: 'Set up live data (Eventhouse + Eventstream)' },
  studio_start_live_events: { write: true, title: 'Start streaming live events' },
  studio_stop_live_events: { write: false, title: 'Stop live events' },
  studio_create_realtime_dashboard: { write: true, title: 'Create Real-Time Dashboard' },
  studio_connect_live_ontology: { write: true, title: 'Bind live events to the ontology' },
  studio_create_live_alerts: { write: true, title: 'Set up Activator alerts on rule breaks' },
  studio_medallion_status: { write: false, title: 'Read the medallion layers (Bronze, Silver, Gold)' },
  studio_apply_medallion: { write: true, title: 'Apply the medallion layers and the Fabric task flow' },
  studio_remove_medallion: { write: true, title: 'Remove the medallion layers' },
  studio_task_flow_status: { write: false, title: 'Read the workspace task flow and where each item goes' },
  studio_apply_task_flow: { write: true, title: 'Apply a task flow and assign the items to its tasks' },
  studio_list_semantic_models: { write: false, title: 'List the project\'s semantic models' },
  studio_check_semantic_model: { write: false, title: 'Check the semantic model\'s data (relationship keys)' },
  studio_reload_semantic_model: { write: true, title: 'Reload the semantic model with the current data' },
  studio_find_model_dependents: { write: false, title: 'Find the reports and data agents built on the semantic model' },
  studio_fix_model_duplicates: { write: true, title: 'Remove duplicate rows from warehouse tables' },
  studio_use_semantic_model: { write: false, title: 'Switch the active semantic model or add an existing one' },
  studio_planning_status: { write: false, title: 'Read the plan (budget, forecast, variance)' },
  studio_preview_plan: { write: false, title: 'Preview a budget and forecast' },
  studio_create_plan: { write: true, title: 'Build the budget and forecast' },
  studio_create_plan_item: { write: true, title: 'Create the Fabric plan' },
  studio_list_artifacts: { write: false, title: 'List the project\'s items and what uses them' },
  studio_remove_artifacts: { write: true, title: 'Remove items' },
  studio_planning_access: { write: false, title: 'Read who can plan' },
  studio_add_planner: { write: true, title: 'Give a planner Contributor access' },
  studio_check_readiness: { write: false, title: 'Check what can run (capacity, role, tenant settings)' },
};

async function runAsJob(kind, title, fn) {
  await assertProjectTenant();
  await assertModuleReady(kind);
  const job = startJob(kind, title, fn);
  const done = await waitForJob(job.id);
  if (done.status !== 'succeeded') return { ok: false, error: done.error, log: done.logLines.slice(-8) };
  return { ok: true, result: done.result };
}

function projectSummary() {
  const p = getProject();
  const preset = presetFor(p);
  const nm = N.namingState(p);
  return {
    workspace: p.workspace, lakehouse: p.lakehouse, source: p.source, modelSource: p.modelSource,
    // The workspace's data sources; everything below belongs to the active one. Switch with studio_switch_data_source.
    dataSources: sourceContexts(p).map((s) => ({ key: s.key, label: s.label, active: s.active, models: s.models.length, reports: s.reports })),
    semanticModel: p.semanticModel, ontology: p.ontology, steps: p.steps,
    // Every semantic model in the project; the active one is semanticModel above (reports, data agent, org app and
    // suggestions use it). Switch with studio_use_semantic_model.
    semanticModels: projectModels(p).map((m) => ({ id: m.id, name: m.name, active: m.id === p.semanticModel?.id, origin: m.origin || 'studio', workspace: m.workspaceName || null, storageMode: m.storageMode || null, ...(m.linked ? { existingReports: (m.linked.reports || []).map((r) => r.name), existingDataAgents: (m.linked.agents || []).map((a) => a.name) } : {}) })),
    taskFlow: p.taskFlow ? { name: p.taskFlow.name, kind: p.taskFlow.mode === 'existing' ? 'task flow already in the workspace' : `studio's ${p.taskFlow.template} flow`, items: p.taskFlow.items } : 'none – studio_task_flow_status',
    naming: {
      pattern: nm.pattern, domain: nm.domain, environment: nm.environment, intent: nm.intent,
      confirmed: nm.configured ? true : 'no – ask the user what this environment is for and the business domain, then call studio_set_naming',
      examples: nm.examples.map((e) => e.name),
    },
    glossaryChars: (p.glossary || '').length,
    sample: preset ? { semanticModelName: presetSummary(p).semanticModelName, ontologyName: presetSummary(p).ontologyName, measures: (preset.measures || []).map((m) => `${m.table}[${m.name}]`) } : null,
    modelProposal: p.modelProposal ? { name: p.modelProposal.name, createdAt: p.modelProposal.createdAt, appliedAt: p.modelProposal.appliedAt || null } : null,
    reports: (p.reports || []).map((r) => ({ name: r.name, theme: r.theme, pages: r.pages, url: r.url, semanticModel: projectModels(p).find((m) => m.id === r.semanticModelId)?.name || null })),
    orgApp: p.orgApp ? { name: p.orgApp.name, reports: p.orgApp.reports.length } : null,
    dataAgent: p.dataAgent ? { name: p.dataAgent.name, semanticModel: p.dataAgent.semanticModel, published: p.dataAgent.published } : null,
    realtime: p.realtime ? {
      eventhouse: p.realtime.eventhouse?.name, table: p.realtime.table, eventstream: p.realtime.eventstream?.name, dashboard: p.realtime.dashboard?.name || null, rules: (p.realtime.scenario?.rules || []).map((r) => r.label),
      liveOntology: p.realtime.ontology ? p.realtime.ontology.entities.map((e) => e.entity) : null,
      alerts: p.realtime.alerts ? { activator: p.realtime.alerts.name, channel: p.realtime.alerts.channel, rules: p.realtime.alerts.rules, recipients: p.realtime.alerts.recipients?.length || 0 } : null,
      medallion: p.realtime.medallion ? { silver: p.realtime.medallion.names.clean, gold: (p.realtime.medallion.gold || []).map((g) => g.name), goldModel: p.realtime.medallion.items?.goldModel?.name || null, taskFlow: p.realtime.medallion.taskFlow?.name || null } : null,
    } : null,
    planning: p.planning ? { measure: p.planning.measure?.name, planYear: p.planning.planYear, baseYear: p.planning.baseYear, asOfMonth: p.planning.asOfMonth, growthPct: p.planning.growthPct, dimensions: (p.planning.dims || []).map((d) => d.labelText), measures: Object.values(p.planning.spec?.names || {}), planItem: p.planning.planItem?.name || null } : null,
    dataPrep: p.dataPrep ? { source: p.dataPrep.source?.name, notebook: p.dataPrep.notebook?.name, curatedLakehouse: p.dataPrep.target?.name, lastRun: p.dataPrep.lastRun?.status || null } : (p.modelSource?.itemType === 'Lakehouse' ? 'available – studio_create_data_prep_notebook' : null),
    notReady: (() => {
      const r = cachedReadiness();
      if (!r) return 'not checked yet – call studio_check_readiness';
      const list = Object.values(r.modules).filter((m) => m.status !== 'ready').map((m) => ({ module: m.id, status: m.status, reason: m.reasons.find((x) => x.status === 'error' || x.status === 'warn')?.text }));
      return list.length ? list : 'every module is ready';
    })(),
    links: p.workspace ? { workspace: `https://app.fabric.microsoft.com/groups/${p.workspace.id}` } : {},
  };
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
// Built-in and uploaded themes (read when the chat starts, so new uploads show up in the next chat).
const themeParam = () => ({ type: 'string', enum: R.reportsCatalog().themes.map((t) => t.id), description: 'Theme id (built-in or one the user uploaded)' });

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
      description: 'Select an existing workspace (by id) or create a new one (name + capacityId) and make it the project workspace. Always use this instead of fabric-core create_workspace so the studio tracks it. A new workspace is named with the naming standard ([Domain]_WS_[Purpose]_[Environment]); pass domain and environment when the user told you what the environment is for.',
      parameters: obj({ workspaceId: str('Existing workspace ID'), name: str('Name (or just the purpose, e.g. "Analytics") for a new workspace'), capacityId: str('Capacity ID for a new workspace'), domain: str('Business domain for the naming standard, e.g. Sales, Finance, Retail'), environment: str('What the environment is for: DEMO, POC, DEV, TEST, UAT, PROD, TRN or SBX') }),
      handler: async (a) => P.selectWorkspace(a),
    }),
    studioTool('studio_set_naming', {
      description: 'Set the naming standard every item the studio creates follows: [Domain]_[Object]_[Purpose]_[Environment] (e.g. Sales_SM_Revenue_PROD). Ask the user what the environment is for (demo, proof of concept, development, test, user acceptance, production, training or sandbox) and the business domain before calling. Existing items keep their names.',
      parameters: obj({ domain: str('Business domain, e.g. Sales, Finance, Retail (letters and numbers)'), environment: { type: 'string', enum: N.ENVIRONMENTS.map((e) => e.code), description: N.ENVIRONMENTS.map((e) => `${e.code} = ${e.intent}`).join('; ') } }, ['domain', 'environment']),
      handler: async (a) => N.setNaming(a),
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
      description: 'Mirror a database into the project workspace with Fabric Mirroring using an existing Fabric connection ID (never ask for passwords in chat; the user creates connections in the Data page). sourceType: azure-sql | sql-mi | sql-server | azure-postgres.',
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
    studioTool('studio_list_data_sources', {
      description: 'List the data sources used in the project workspace and what was built from each (semantic models, reports, ontology, plan, live data). One is active; the others keep their items. Loading or connecting a new data source starts a separate set of items for it. Read-only.',
      parameters: obj({}),
      handler: async () => P.sourcesState(),
    }),
    studioTool('studio_switch_data_source', {
      description: 'Make another data source of the workspace the active one (key from studio_list_data_sources): its semantic models, reports, ontology, plan and live data come back; the current one keeps its items. Nothing changes in Fabric. Use it to go back to a source instead of loading it again.',
      parameters: obj({ key: str('Data source key from studio_list_data_sources') }, ['key']),
      handler: async ({ key }) => P.switchSource(key),
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
    studioTool('studio_data_prep_status', {
      description: 'Read the data prep notebook for a lakehouse data source: whether it applies (only lakehouses), the notebook and curated lakehouse, and the last run: curated tables with their roles and keys, relationships found from the data, column renames, data fixes, KPIs with DAX and the charts with their one-line insights. Read-only.',
      parameters: obj({}),
      handler: async () => {
        const s = DP.dataPrepState();
        const r = s.dataPrep?.lastRun;
        return { available: s.available, reason: s.reason, source: s.source?.name || null, forCurrentSource: s.current, notebook: s.dataPrep?.notebook || null, target: s.dataPrep?.target || null, lastRun: r ? { status: r.status, endedAt: r.endedAt, error: r.error || null, summary: r.summary, charts: (r.charts || []).map((c) => ({ title: c.title, insight: c.insight })) } : null };
      },
    }),
    studioTool('studio_create_data_prep_notebook', {
      description: 'When the data source is a lakehouse: create (or update) a Fabric Python notebook for it and, by default, run it. Nothing about the data is fixed in the notebook – every run lists the lakehouse\'s tables and works out from the data: business-friendly column names, logged data fixes, keys and relationships (checked against the values), facts and dimensions, measures (derived columns and a KPI table with matching DAX), curated Delta tables (in a new curated lakehouse, <Domain>_LH_Curated_<Env>, by default) and charts (bar, pie, trend, Pareto, heatmap, distribution, box plot, treemap, correlation, model diagram, data quality). Running takes a few minutes. Then summarize the results with studio_data_prep_status.',
      parameters: obj({ run: { type: 'boolean', description: 'Run the notebook after creating it (default true)' }, target: { type: 'string', enum: ['new', 'same'], description: 'new (default): write curated tables to a new "<source>_Curated" lakehouse; same: write them back to the source lakehouse with the Curated_ prefix' } }),
      handler: async (a) => runAsJob('data-prep', a.run === false ? 'Create the data prep notebook' : 'Create and run the data prep notebook', (ctx) => DP.runDataPrep(ctx, { run: a.run !== false, target: a.target === 'same' ? 'same' : 'new' })),
    }),
    studioTool('studio_propose_semantic_model', {
      description: 'Suggest a semantic model design. Nothing changes in Fabric: the studio checks the design against the schema and shows the user an "Apply suggestions" button that reviews and creates it in one click. Use this every time you propose or revise a semantic model design, instead of asking the user to type a confirmation. With sample data, the sample\'s glossary measures (project state sample.measures) are always kept; list only measures to add or change.',
      parameters: obj({ ...MODEL_DESIGN, summary: str('Two or three sentences describing the design for the user (shown in the review)') }),
      handler: async (a) => {
        const proposal = await P.proposeSemanticModel({ ...modelDesign(a), summary: a.summary }, { chatId });
        const chat = chats.get(chatId);
        chat?.transcript.push({ role: 'proposal', kind: 'semantic-model', proposalId: proposal.id, at: Date.now() });
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
      description: 'Read what the studio found in the project semantic model for report design (main measure, KPIs, time grain and full years, share/breakdown dimensions, top-N entity, drill hierarchy, geography for maps, insights) plus the available report themes and page templates. Read-only.',
      parameters: obj({ refresh: { type: 'boolean' } }),
      handler: async ({ refresh }) => {
        const pr = await R.currentProfile({ refresh });
        const ref = (r) => (r ? `${r.table}[${r.name}] (${r.label})` : null);
        return {
          model: pr.model, primary: ref(pr.primary), kpis: pr.kpis.map(ref), channels: pr.channels.map(ref),
          time: pr.time && { grain: pr.time.grain, years: pr.time.years, fullYears: pr.time.fullYears, axis: pr.time.axis.map(ref) },
          share: ref(pr.share), breakdown: ref(pr.breakdown), topList: ref(pr.entity), hierarchy: pr.hierarchy.map(ref),
          geography: pr.geo
            ? { map: pr.geo.mode === 'points' ? `points at ${ref(pr.geo.lat)} / ${ref(pr.geo.lon)}${pr.geo.label ? ` labelled by ${ref(pr.geo.label)}` : ''}` : `drill ${pr.geo.levels.map(ref).join(' › ')}`, distinctValues: pr.geo.distinct, page: 'geo (Map) – include it when the user asks for maps or regional analysis' }
            : 'none – no country/state/city/postal or latitude/longitude columns that split the main measure, so the Map page is not available',
          insights: pr.insights.map((i) => i.text), warnings: pr.warnings,
          businessRules: await R.currentRecommendations().then((x) => x.rules).catch(() => null),
          themes: R.reportsCatalog().themes.map((t) => `${t.id}: ${t.name} – ${t.description}`),
          yourTemplates: TPL.describeTemplates(),
          pages: R.reportsCatalog().pages.map((x) => `${x.id}: ${x.name} – ${x.description}${x.id === 'plan' && !modelFits(getProject()).plan ? ' (not available on this model: no plan on it – the plan lives on the model its Plan table was added to)' : ''}`),
          reports: (getProject().reports || []).map((x) => ({ id: x.id, name: x.name, theme: x.theme, pages: x.pages, url: x.url })),
        };
      },
    }),
    studioTool('studio_propose_report', {
      description: 'Suggest a Power BI report for the user to review. Nothing changes in Fabric: the studio shows an "Apply suggestions" button that reviews and builds it in one click. Use this whenever you recommend a report, instead of asking the user to type a confirmation. Call studio_describe_report_options first and ground the summary in its insights.',
      parameters: obj({
        name: str('Report name'),
        theme: themeParam(),
        pages: { type: 'array', items: { type: 'string', enum: ['executive', 'drivers', 'scorecard', 'rules', 'geo'] }, description: 'Pages in order (geo = Map page; only when studio_describe_report_options reports geography)' },
        audience: str('Who the report is for, e.g. Leadership, Sales managers'),
        summary: str('Two or three sentences: why these pages and this theme fit the data and audience (shown in the review)'),
      }, ['pages', 'theme']),
      handler: async (a) => {
        const proposal = await R.proposeReport(a, { chatId });
        chats.get(chatId)?.transcript.push({ role: 'proposal', kind: 'report', proposalId: proposal.id, at: Date.now() });
        emit('chat.proposal', { chatId, proposal });
        return {
          ok: true, report: proposal.name, theme: proposal.theme, pages: proposal.pages, updatesExisting: proposal.updatesExisting, warnings: proposal.warnings,
          next: 'Summarize the recommendation briefly and tell the user to select "Apply suggestions" below your message to review and build it. Do not call studio_create_report unless the user asks you to in chat.',
        };
      },
    }),
    studioTool('studio_create_org_app', {
      description: 'Create or update a Fabric org app that bundles the studio\'s Power BI reports (overview page, Reports and Business rules sections, theme colors). People get the app without workspace access once the user adds an audience and publishes it in Fabric. Default: all reports the studio built.',
      parameters: obj({
        name: str('App name (default: "<semantic model> app")'),
        theme: themeParam(),
        reportIds: { type: 'array', items: { type: 'string' }, description: 'Report IDs to include (default: all studio reports)' },
        title: str('Overview page title'),
        body: str('Overview page text: what the app is for, in two or three sentences'),
      }),
      handler: async (a) => runAsJob('org-app', `Create org app ${a.name || ''}`.trim(), (ctx) => APPS.runOrgApp(ctx, a)),
    }),
    studioTool('studio_data_agent_status', {
      description: 'Read the Fabric data agent the studio created on the semantic model (name, link, instructions, published or draft) and any pending suggestion. Read-only.',
      parameters: obj({}),
      handler: async () => DA.dataAgentState(),
    }),
    studioTool('studio_propose_data_agent', {
      description: 'Suggest a Fabric data agent grounded in the project semantic model. Nothing changes in Fabric: the user reviews it and selects "Apply suggestions" to create it. Use this whenever the user asks for a data agent – never create DataAgent items with fabric-core tools (the studio writes the definition: the semantic model as the data source with all its tables, columns and measures, instructions, and publishing). Write the instructions from studio_get_glossary and the model\'s measures: what the agent answers, which measures mean what, business definitions and thresholds, how to format answers. Leave instructions empty to let the studio write them.',
      parameters: obj({
        name: str('Agent name (default: "<semantic model> agent")'),
        instructions: str('AI instructions for the agent (up to 15,000 characters): role, which measures to use for which questions, business definitions from the glossary, formatting'),
        description: str('One sentence describing what the agent answers (shown to users)'),
        summary: str('Two or three sentences for the user explaining the suggestion (shown in the review)'),
      }),
      handler: async (a) => {
        const proposal = await DA.proposeDataAgent(a, { chatId });
        chats.get(chatId)?.transcript.push({ role: 'proposal', kind: 'data-agent', proposalId: proposal.id, at: Date.now() });
        emit('chat.proposal', { chatId, proposal });
        return { ok: true, agent: proposal.name, semanticModel: proposal.semanticModel, updatesExisting: proposal.updatesExisting, instructionsChars: proposal.instructions.length, warnings: proposal.warnings, next: 'Tell the user to review the suggestion and select Apply suggestions. Do not call studio_create_data_agent in the same turn.' };
      },
    }),
    studioTool('studio_suggest_apply', {
      description: 'Show an "Apply" button under your answer. Call it every time you recommend something the user has to confirm before you act – for example deploying the ontology with the rules you listed, building the plan you previewed, applying the medallion layers or the Medallion task flow, setting up live data or alerts, creating shortcuts, changing measures – instead of asking the user to type "yes", "proceed" or "apply". Give the exact request you will carry out when they select Apply. (Semantic models, reports and data agents have their own propose tools.) Then end your turn; do not make the change in the same turn.',
      parameters: obj({
        title: str('Short title of what Apply does, e.g. "Deploy the ontology Retail_ONT_Sales_DEMO"'),
        summary: str('One or two sentences: what will be created or changed, and where'),
        instruction: str('The request you will carry out when the user selects Apply, written as the user would say it, e.g. "Apply it: deploy the ontology with the 6 entities and the 6 rules you listed."'),
      }, ['title', 'instruction']),
      handler: async (a) => {
        const proposal = { id: newId(), kind: 'action', title: String(a.title).slice(0, 160), summary: String(a.summary || '').slice(0, 600), instruction: String(a.instruction).slice(0, 2000), createdAt: new Date().toISOString() };
        chats.get(chatId)?.transcript.push({ role: 'proposal', kind: 'action', proposalId: proposal.id, title: proposal.title, summary: proposal.summary, instruction: proposal.instruction, at: Date.now() });
        emit('chat.proposal', { chatId, proposal });
        return { ok: true, next: 'The Apply button is shown under your answer. End your turn with a short summary of what Apply will do; don\'t ask the user to type a confirmation and don\'t make the change now.' };
      },
    }),
    studioTool('studio_create_data_agent', {
      description: 'Create (or update) the Fabric data agent on the project semantic model directly and publish it – only when the user explicitly asks to create it without reviewing a suggestion (otherwise use studio_propose_data_agent). The studio writes the full item definition. A minute.',
      parameters: obj({ name: str('Agent name'), instructions: str('AI instructions (optional – the studio writes them from the measures and glossary)'), description: str('One-sentence description'), publish: { type: 'boolean', description: 'Publish so Microsoft 365 Copilot and Copilot Studio can use it (default true)' } }),
      handler: async (a) => runAsJob('data-agent', 'Create the Fabric data agent', (ctx) => DA.runDataAgent(ctx, { name: a.name, instructions: a.instructions, description: a.description, publish: a.publish !== false })),
    }),
    studioTool('studio_create_report', {
      description: 'Build a professional Power BI report on the project semantic model from the studio templates and deploy it to the project workspace (an existing report with the same name is updated). Pages: executive (Executive summary), drivers (Performance drivers), scorecard (Scorecard), rules (Business rules dashboard: ontology rules with live counts; rule measures the model lacks are added to the report), geo (Map: Azure Maps bubbles sized by the main measure – drill country › state › city, or points at latitude/longitude – with the top places; only when studio_describe_report_options reports geography). Themes: studio, executive, teal, slate, accessible, midnight, plus any theme the user uploaded (see studio_describe_report_options). Call studio_describe_report_options first to recommend pages and a theme.',
      parameters: obj({
        name: str('Report name (default: "<semantic model> report")'),
        theme: themeParam(),
        pages: { type: 'array', items: { type: 'string', enum: ['executive', 'drivers', 'scorecard', 'rules', 'geo'] }, description: 'Pages in order (default: executive, drivers, scorecard)' },
      }),
      handler: async (a) => runAsJob('report', `Build Power BI report ${a.name || ''}`.trim(), (ctx) => R.runReport(ctx, { name: a.name, theme: a.theme, pages: a.pages?.length ? a.pages : undefined })),
    }),
    studioTool('studio_list_report_templates', {
      description: 'List the report templates and themes the user uploaded in Reports & apps (Power BI templates .pbit, reports .pbix, zipped Power BI projects, report layouts, Power BI theme .json files): pages, visuals, tables each report template uses, notes. Uploaded themes can be used as the theme of studio_create_report / studio_propose_report. Read-only.',
      parameters: obj({}),
      handler: async () => ({ templates: TPL.describeTemplates(), howToUpload: 'Reports & apps › Design a Power BI report › Your own templates › Upload template.' }),
    }),
    studioTool('studio_check_report_template', {
      description: 'Check an uploaded report template against the project semantic model before building it: which fields exist, which the studio matches by name (e.g. another table or spelling), which are missing, and how many visuals would show an error. Read-only.',
      parameters: obj({ id: str('Template id from studio_list_report_templates') }, ['id']),
      handler: async ({ id }) => TPL.checkTemplate(id),
    }),
    studioTool('studio_create_report_from_template', {
      description: 'Build a Power BI report from one of the user\'s uploaded report templates on the project semantic model and deploy it (an existing report with the same name is updated). Fields are matched to the model by name; fields the model lacks are listed and their visuals show an error until the user picks other fields in Power BI. Call studio_check_report_template first and tell the user what will be missing.',
      parameters: obj({ id: str('Template id from studio_list_report_templates'), name: str('Report name (default: from the template name, following the naming standard)') }, ['id']),
      handler: async (a) => runAsJob('report-template', `Build Power BI report from template ${TPL.getTemplate(a.id)?.name || ''}`.trim(), (ctx) => TPL.runTemplateReport(ctx, { id: a.id, name: a.name })),
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
    studioTool('studio_realtime_status', {
      description: 'Read the real-time setup: Eventhouse, KQL database, live events table (columns, business rules), Eventstream, Real-Time Dashboard and whether live events are streaming now. With live data set up, also returns headline numbers for the last 15 minutes. Read-only.',
      parameters: obj({}),
      handler: async () => {
        const s = RT.realtimeState();
        const live = s.setup ? await RT.liveSummary({ minutes: 15 }).catch((e) => ({ error: e.message })) : null;
        const sim = s.simulator;
        return {
          setUp: Boolean(s.setup), scenario: s.setup?.scenario || s.scenarioKind,
          eventhouse: s.setup?.eventhouse?.name, database: s.setup?.database?.name, table: s.setup?.table, eventstream: s.setup?.eventstream?.name,
          dashboard: s.setup?.dashboard ? { name: s.setup.dashboard.name, url: s.setup.dashboard.url, pages: s.setup.dashboard.pages } : null,
          liveOntology: s.setup?.ontology ? { ontology: s.setup.ontology.name, entities: s.setup.ontology.entities } : null,
          alerts: s.setup?.alerts ? { activator: s.setup.alerts.name, url: s.setup.alerts.url, channel: s.setup.alerts.channel, rules: s.setup.alerts.rules, recipients: s.setup.alerts.recipients?.length || 0, minAmount: s.setup.alerts.minAmount } : null,
          medallion: s.setup?.medallion ? { bronze: s.setup.medallion.names.bronze, silver: s.setup.medallion.names.clean, quarantine: s.setup.medallion.names.quarantine, gold: s.setup.medallion.gold.map((g) => g.name), taskFlow: s.setup.medallion.taskFlow?.name || null } : null,
          streaming: { running: sim.running, eventsPerMinute: sim.rate, ruleBreakPct: sim.ruleBreakPct, sent: sim.sent, stopsAt: sim.stopsAt, lastError: sim.lastError || null },
          last15Minutes: live, links: s.links,
        };
      },
    }),
    studioTool('studio_query_live_events', {
      description: 'Run one read-only KQL query against the live events table in the Eventhouse (max 100 rows). Use it to answer questions about what is happening right now, e.g. "SalesEvents | where EventTime > ago(15m) | summarize sum(SalesAmount) by Region". Call studio_realtime_status first for the table and columns. Management commands are not allowed.',
      parameters: obj({ kql: str('A read-only KQL query') }, ['kql']),
      handler: async ({ kql }) => RT.liveQuery(kql, { maxRows: 100 }),
    }),
    studioTool('studio_setup_live_data', {
      description: 'Set up live data: create (or reuse) an Eventhouse with a live events table shaped like the project\'s data, and an Eventstream with a custom endpoint that feeds it. About 2 minutes. Needs a semantic model (or one of the samples).',
      parameters: obj({ name: str('Optional Eventhouse name (letters, numbers, underscores)') }),
      handler: async ({ name }) => runAsJob('realtime', 'Set up live data (Eventhouse + Eventstream)', (ctx) => RT.runRealtimeSetup(ctx, { name })),
    }),
    studioTool('studio_start_live_events', {
      description: 'Start streaming simulated live events (real keys, names and prices from the project\'s data, with a share of business-rule breaks) into the Eventstream. Stops automatically after `minutes`. When the table has no recent data, the last hour is filled first so charts are not empty.',
      parameters: obj({
        eventsPerMinute: { type: 'number', description: 'Events per minute (6–600, default 60)' },
        ruleBreakPct: { type: 'number', description: 'Share of events that break a business rule, in percent (0–50, default 3)' },
        dataIssuePct: { type: 'number', description: 'Share of events with data-quality issues – duplicates, missing keys, zero quantities, negative amounts, future times – in percent (0–20, default 1). The medallion Silver layer quarantines or removes them' },
        minutes: { type: 'number', description: 'Stop automatically after this many minutes (1–240, default 60)' },
      }),
      handler: async (a) => {
        await assertProjectTenant();
        await assertLiveEventsAllowed();
        const s = await RT.startLiveEvents({ rate: a.eventsPerMinute, ruleBreakPct: a.ruleBreakPct, dataIssuePct: a.dataIssuePct, minutes: a.minutes });
        return { ok: true, running: s.running, eventsPerMinute: s.rate, ruleBreakPct: s.ruleBreakPct, dataIssuePct: s.dataIssuePct, stopsAt: s.stopsAt, backfilled: s.backfilled };
      },
    }),
    studioTool('studio_stop_live_events', {
      description: 'Stop streaming simulated live events.',
      parameters: obj({}),
      handler: async () => { const s = RT.stopLiveEvents(); return { ok: true, sent: s.sent }; },
    }),
    studioTool('studio_create_realtime_dashboard', {
      description: 'Create or update a Real-Time Dashboard over the live events table: a live overview page (KPIs, trend per minute, mix, regions, top items, latest events) and a business-rules page (rule-break counts, trend, who breaks the rules, latest breaks). Auto-refreshes. Every tile query is checked before deploying.',
      parameters: obj({ name: str('Optional dashboard name'), refreshSeconds: { type: 'number', enum: [30, 60, 300], description: 'Auto refresh interval (default 30)' } }),
      handler: async (a) => runAsJob('realtime-dashboard', `Build Real-Time Dashboard ${a.name || ''}`.trim(), (ctx) => RT.runRealtimeDashboard(ctx, { name: a.name, refreshSeconds: a.refreshSeconds })),
    }),
    studioTool('studio_connect_live_ontology', {
      description: 'Bind the live events table (Eventhouse) to the ontology: every entity type whose key is a column of the events (for example Product, Customer, Reseller, Sales territory) gets time-series properties such as LiveSalesAmount, LiveDiscountPct and LiveRuleBreak, plus a link to the Real-Time Dashboard. Also tags the ontology tables with their source so Fabric can preview instances. Set unlink=true to remove the live properties. Needs live data and an ontology.',
      parameters: obj({ unlink: { type: 'boolean', description: 'Remove the live properties instead of adding them' } }),
      handler: async (a) => runAsJob('realtime-ontology', a.unlink ? 'Remove live properties from the ontology' : 'Bind live events to the ontology', (ctx) => RT.runLiveOntology(ctx, { unlink: Boolean(a.unlink) })),
    }),
    studioTool('studio_create_live_alerts', {
      description: 'Create or update a Fabric Activator that checks the live events every minute and sends a Teams message (or email) for each business-rule break, with the order, buyer, region, amount and discount. One Activator rule per business rule. Recipients default to the signed-in user. Use minAmount to alert only on larger sales.',
      parameters: obj({
        channel: { type: 'string', enum: ['teams', 'email'], description: 'teams (default) or email' },
        recipients: { type: 'array', items: { type: 'string' }, description: 'Email addresses (default: the signed-in user)' },
        rules: { type: 'array', items: { type: 'string' }, description: 'Business rules to alert on, by name (default: all)' },
        minAmount: { type: 'number', description: 'Only alert when the event amount is at least this value (default 0)' },
      }),
      handler: async (a) => {
        const recipients = a.recipients?.length ? a.recipients : [(await whoAmI()).upn].filter(Boolean);
        return runAsJob('realtime-alerts', 'Set up Activator alerts on rule breaks', (ctx) => RT.runRealtimeAlerts(ctx, { channel: a.channel || 'teams', recipients, rules: a.rules, minAmount: a.minAmount }));
      },
    }),
    studioTool('studio_medallion_status', {
      description: 'Read the medallion layers of the live events: the Bronze table, the Silver table, quarantine and deduplicated view, the Gold materialized views, their rows (total and last 15 minutes), why events were quarantined, duplicates removed, Silver freshness (age of the newest checked event), view health, the Fabric items per layer (querysets, Silver lakehouse, Gold semantic model) and the workspace task flow. Read-only. Query the layers with studio_query_live_events (Silver: the deduplicated view; Gold: the materialized views).',
      parameters: obj({}),
      handler: async () => {
        const rt = getProject().realtime;
        if (!rt) return { applied: false, hint: 'Set up live data first (studio_setup_live_data).' };
        if (!rt.medallion) return { applied: false, hint: 'Apply the medallion template with studio_apply_medallion.', preview: RT.medallionPreview() };
        const m = rt.medallion;
        return {
          applied: true, names: m.names, options: m.options, checks: m.checks.map((c) => c.reason), extras: m.extras, gold: m.gold.map((g) => ({ name: g.name, label: g.label, grain: g.grain, by: g.by })),
          items: { bronzeToSilver: m.items?.silverQueryset?.name, silverLakehouse: m.items?.silverLakehouse ? { name: m.items.silverLakehouse.name, shortcut: m.items.silverLakehouse.shortcut } : null, silverToGold: m.items?.goldQueryset?.name, goldSemanticModel: m.items?.goldModel ? { name: m.items.goldModel.name, measures: m.items.goldModel.measures, singleSignOn: m.items.goldModel.sso, answers: m.items.goldModel.check?.ok ?? null } : null },
          taskFlow: m.taskFlow ? { name: m.taskFlow.name, tasks: m.taskFlow.tasks, itemsAssigned: m.taskFlow.items } : { error: m.taskFlowError || 'not created' },
          oneLake: m.oneLake, health: await RT.medallionHealth({ minutes: 15 }).catch((e) => ({ error: e.message })),
        };
      },
    }),
    studioTool('studio_apply_medallion', {
      description: 'Apply Microsoft\'s Real-Time Intelligence medallion template to the live events (safe to run again): Bronze keeps the raw events (retention for replay); update policies check every new event (time, keys, quantity, price, discount, amount), enrich it and route failures to a quarantine table with the reason; a materialized view removes duplicates (Silver); materialized views keep Gold aggregates (per minute, daily, latest per customer) fresh. Creates one Fabric item per layer (Bronze→Silver and Silver→Gold KQL querysets, a Gold DirectQuery semantic model with single sign-on), shows the layers as a task flow in the workspace with the items assigned, and moves the dashboard, alerts and live ontology to the clean data. A few minutes.',
      parameters: obj({
        bronzeDays: { type: 'number', description: 'Days the raw Bronze events are kept for replay (0 keeps the current retention; default 30)' },
        silverDays: { type: 'number', description: 'Days the Silver layer is kept (default 90)' },
        goldDays: { type: 'number', description: 'Days the Gold aggregates are kept (default 730)' },
        oneLake: { type: 'boolean', description: 'Expose the Silver table in OneLake as Delta (default true)' },
      }),
      handler: async (a) => runAsJob('medallion', 'Apply the medallion layers (Bronze, Silver, Gold)', (ctx) => RT.runMedallion(ctx, a)),
    }),
    studioTool('studio_remove_medallion', {
      description: 'Remove the medallion layers: deletes the task flow, the two querysets and the Gold semantic model, points the dashboard, alerts and live ontology back at the Bronze table, then drops the Silver and Gold tables and views. The raw events stay. Ask the user to confirm first.',
      parameters: obj({}),
      handler: async () => runAsJob('medallion-remove', 'Remove the medallion layers', (ctx) => RT.removeMedallion(ctx, { deleteItems: true })),
    }),
    studioTool('studio_task_flow_status', {
      description: 'Read the workspace task flow: the flows to choose from (Fabric\'s predesigned flows the studio builds – Medallion, Basic data analytics, Event analytics, Event medallion, Lambda, Basic machine learning models – and the task flows already in the workspace), which task ("box") each of the project\'s items goes to in the selected flow and why, the items no task takes, and whether the applied flow is up to date. Read-only. Pass flow to preview another choice.',
      parameters: obj({ flow: str('Optional: a template id (medallion, basic, event, eventMedallion, lambda, ml), a template name, or the name or id of a task flow in the workspace') }),
      handler: async ({ flow }) => {
        const s = await WTF.taskFlowState({ choice: flow || undefined, fresh: true });
        if (!s.plan) return s;
        return {
          available: s.available, reason: s.reason, templates: s.templates.map((t) => `${t.id}: ${t.name} – ${t.description}`),
          inWorkspace: s.existing.map((f) => `${f.name} (${f.tasks} tasks, ${f.items} items${f.studio ? ', created by the studio' : ''})`), listError: s.listError,
          selected: { choice: s.choice, name: s.plan.name, kind: s.mode === 'existing' ? 'a task flow already in the workspace (only the studio\'s own assignments change)' : 'a predesigned flow the studio builds as its own canvas' },
          ...(s.requestedNotFound ? { notice: `${s.notice} Tell the user the flow they asked for wasn't found.` } : {}),
          tasks: s.plan.tasks.map((t) => ({ task: t.name, type: t.type, items: t.items.map((i) => `${i.name} (${i.type}${i.pinned ? ', placed in Fabric' : ''})`), otherItems: t.others })),
          notAssigned: s.plan.unassigned.map((i) => `${i.name} (${i.type}): ${i.reason}`),
          applied: s.applied ? { name: s.applied.name, mode: s.applied.mode, items: s.applied.items, syncedAt: s.applied.syncedAt } : null,
          upToDate: s.upToDate,
        };
      },
    }),
    studioTool('studio_apply_task_flow', {
      description: 'Apply a task flow to the project workspace and assign every item the studio built to its task ("box"): a predesigned flow (Medallion, Basic data analytics, Event analytics, Event medallion, Lambda, Basic machine learning models) is created as the studio\'s own canvas; a task flow already in the workspace keeps its tasks, connectors, layout and the items people assigned – the studio only adds (and later updates) its own items. Moves put an item on another task or keep it off ("" as task). The flow is updated automatically as the studio adds or removes items. Call studio_task_flow_status first and tell the user where the items go. Seconds.',
      parameters: obj({
        flow: str('Template id (medallion, basic, event, eventMedallion, lambda, ml), template name, or the name or id of a task flow in the workspace'),
        moves: { type: 'array', items: obj({ item: str('Item name'), task: str('Task name, or empty to keep the item off the flow') }, ['item', 'task']), description: 'Optional: items to put on another task than the studio would' },
      }, ['flow']),
      handler: async ({ flow, moves }) => {
        let overrides;
        if (moves?.length) {
          const s = await WTF.taskFlowState({ choice: flow, fresh: true });
          const items = [...s.plan.tasks.flatMap((t) => t.items), ...s.plan.unassigned];
          overrides = { ...(s.plan.overrides || {}) };
          for (const m of moves) {
            const it = items.find((i) => i.name.toLowerCase() === String(m.item).toLowerCase());
            if (!it) return { ok: false, error: `No item named "${m.item}" in the project.` };
            const task = m.task ? s.plan.tasks.find((t) => t.name.toLowerCase() === String(m.task).toLowerCase()) : null;
            if (m.task && !task) return { ok: false, error: `No task named "${m.task}" in ${s.plan.name}. Tasks: ${s.plan.tasks.map((t) => t.name).join(', ')}` };
            overrides[it.id] = task ? task.key : '';
          }
        }
        return runAsJob('taskflow', 'Apply the task flow', (ctx) => WTF.runTaskFlow(ctx, { choice: flow, overrides }));
      },
    }),
    studioTool('studio_list_semantic_models', {
      description: 'List the semantic models in the project (the active one first; the studio\'s reports, data agent, org app, profile and suggestions work on the active model) with what is built on each, and – with workspaceId – the semantic models in a workspace that could be added to the project. Read-only.',
      parameters: obj({ workspaceId: str('Optional: a workspace to list existing semantic models from (the project workspace when "project")') }),
      handler: async ({ workspaceId }) => {
        const s = MODELS.modelsState();
        const out = { active: s.models.find((m) => m.active)?.name || null, models: s.models.map((m) => ({ id: m.id, name: m.name, active: m.active, origin: m.origin === 'existing' ? 'existing model added to the project' : 'built by the studio', workspace: m.workspaceName, storage: m.storage, tables: m.tables, measures: m.measures, reports: m.reports.map((r) => (r.existing ? `${r.name} (existing report in Fabric – never changed by the studio)` : r.name)), dataAgent: m.dataAgent?.name || null, existingDataAgents: m.existingAgents.map((a) => `${a.name}${a.published ? ' (published)' : ''}`), reads: m.reads.map((x) => `${x.name} (${x.type})`), lookedInFabric: m.linkedAt || 'not yet – studio_find_model_dependents', orgApp: m.orgApp?.name || null, plan: m.plan })) };
        if (workspaceId) out.available = await MODELS.availableModels(workspaceId === 'project' ? undefined : workspaceId);
        return out;
      },
    }),
    studioTool('studio_use_semantic_model', {
      description: 'Make a semantic model the active one: a model already in the project (by id or name), or an existing model from any workspace the user can read (id + workspaceId), which is added to the project. Nothing changes in Fabric. Reports, the data agent, the org app, planning prompts and your answers then use that model. Use studio_list_semantic_models to find ids.',
      parameters: obj({ id: str('Semantic model id'), name: str('Semantic model name (for a model already in the project)'), workspaceId: str('Workspace id of an existing model to add') }),
      handler: async ({ id, name, workspaceId }) => {
        const p = getProject();
        const known = projectModels(p).find((m) => m.id === id || (name && m.name.toLowerCase() === String(name).toLowerCase()));
        const s = known ? await MODELS.useModel(known.id) : await MODELS.addExistingModel({ id, workspaceId });
        WTF.syncTaskFlow().catch(() => {});
        const looking = LINKS.ensureModelLinks(s.active);
        return { ok: true, active: s.models.find((m) => m.active)?.name, models: s.models.length, warning: s.warning || undefined, builtOnIt: looking ? 'The studio is looking in Fabric for the reports and data agents built on it (and the data it reads) in the background; they appear on the map in a minute.' : undefined };
      },
    }),
    studioTool('studio_find_model_dependents', {
      description: 'Look in Fabric for what is built on a semantic model (the active one by default): Power BI reports on it and Fabric data agents that answer from it (in the model\'s and the project\'s workspace), and the lakehouse or warehouse it reads. They are shown on the map as existing items – the studio never changes or deletes them. A project without data takes the model\'s data in place (nothing is copied). Runs automatically when an existing model is added; about a minute when there are data agents.',
      parameters: obj({ id: str('Semantic model id (default: the active model)') }),
      handler: async ({ id }) => {
        await assertProjectTenant();
        const mid = id || getProject().semanticModel?.id;
        if (!mid) return { ok: false, error: 'There is no semantic model yet.' };
        const done = await waitForJob(LINKS.startModelLinks(mid).id);
        if (done.status !== 'succeeded') return { ok: false, error: done.error, log: done.logLines.slice(-8) };
        return { ok: true, result: done.result };
      },
    }),
    studioTool('studio_check_semantic_model', {
      description: 'Find why a semantic model can\'t answer (for example "contains a duplicate value … not allowed for columns on the one side of a many-to-one relationship"): reads the tables the model is built on and checks that every relationship key on the "one" side is unique – repeated keys, how many extra rows, whether they are exact copies, the source table and item, and whether the studio can fix it. It also compares the rows of each table in the model with its data: `stale` tables mean the data was fixed but the model still holds the old rows (queries keep failing) – reload it with studio_reload_semantic_model. Read-only; about a minute. Use it whenever the model profile or a DAX query fails with a relationship or duplicate-value error.',
      parameters: obj({ id: str('Semantic model id (default: the active model)') }),
      handler: async ({ id }) => MC.checkModel({ id }),
    }),
    studioTool('studio_fix_model_duplicates', {
      description: 'Remove exact duplicate rows from Fabric warehouse tables a semantic model reads (only tables studio_check_semantic_model reported with fix "dedupe"): keeps a backup copy of each table (<table>_backup_<time>), works in one transaction (all or nothing), then reloads the model and checks again. Only call it after the user agreed to change their warehouse data. Rows that differ are never removed.',
      parameters: obj({ id: str('Semantic model id (default: the active model)'), tables: { type: 'array', items: { type: 'string' }, description: 'fixKey values from studio_check_semantic_model (or schema.table names) to fix (default: every fixable table)' } }),
      handler: async (a) => runAsJob('model-fix', 'Remove duplicate rows the semantic model can\'t use', (ctx) => MC.runFixDuplicates(ctx, { id: a.id, tables: a.tables })),
    }),
    studioTool('studio_reload_semantic_model', {
      description: 'Reload a semantic model (the active one by default) so it reads its data again – when studio_check_semantic_model reports "stale" tables (the model holds other row counts than the data, for example after duplicates were removed in the warehouse): queries keep failing with the old duplicate-value error until it reloads. Reloads again (up to 5 times, 20 seconds apart) until the model holds the current rows, then checks again. Changes no data.',
      parameters: obj({ id: str('Semantic model id (default: the active model)') }),
      handler: async (a) => runAsJob('model-reload', 'Reload the semantic model with the current data', (ctx) => MC.runReloadModel(ctx, { id: a.id })),
    }),
    studioTool('studio_planning_status', {
      description: 'Read the budget and forecast: plan year, base year, growth, forecast cut-off, planned dimensions, the Plan table measures, the Fabric plan item, and plan vs actual for the plan year (overall and by the first dimension) through the semantic model. Read-only.',
      parameters: obj({}),
      handler: async () => {
        const s = PL.planningState();
        if (!s.plan) return { built: false, available: s.available, writable: s.writable, whyNot: s.problem || undefined, store: s.store || undefined, source: s.source };
        const summary = await PL.planSummary().catch((e) => ({ error: e.message }));
        const pl = s.plan;
        return { built: true, measure: pl.measure.name, planYear: pl.planYear, baseYear: pl.baseYear, forecastFrom: pl.asOfMonth ? pl.asOfMonth + 1 : 1, growthPct: pl.growthPct, overrides: pl.overrides, dimensions: pl.dims.map((d) => d.labelText), modelMeasures: pl.spec?.names, storedIn: pl.target, planItem: pl.planItem, summary, links: s.links };
      },
    }),
    studioTool('studio_preview_plan', {
      description: 'Preview a budget and forecast without changing anything: the plan year, base year, growth, forecast cut-off month and per-member growth overrides, with totals by month and by member of the first dimension. Budget = base-year actuals × (1 + growth); forecast = actuals up to the cut-off, then budget × run rate. Omit options to see the recommended defaults.',
      parameters: obj({
        measure: str('Measure to plan (default: the main sales measure)'),
        dims: { type: 'array', items: { type: 'string' }, description: 'Up to two dimension tables to plan by (default: region/territory and category)' },
        planYear: { type: 'number', description: 'Year to plan' },
        asOfMonth: { type: 'number', description: 'Forecast cut-off month (1–12): actuals up to it, projection after it. 0 = forecast equals budget' },
        growthPct: { type: 'number', description: 'Growth over the base year in percent' },
        overrides: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, growthPct: { type: 'number' } } }, description: 'Growth per member of the first dimension (key from a previous preview)' },
      }),
      handler: async (a) => {
        const r = await PL.planPreview(PL.planOptions(a));
        return { design: { measure: r.design.measure.name, planYear: r.design.planYear, baseYear: r.design.baseYear, asOfMonth: r.design.asOfMonth, growthPct: r.design.growthPct, dimensions: r.design.dims.map((d) => `${d.table} (${d.members})`), overrides: r.design.overrides }, recommended: r.defaults, availableYears: r.availableYears, totals: r.totals, months: r.months, members: r.members.slice(0, 25) };
      },
    }),
    studioTool('studio_create_plan', {
      description: 'Build the budget and forecast: computes them from the actuals (same options as studio_preview_plan), writes them next to the data (a "planning" schema in a Fabric SQL database or warehouse; for a lakehouse, a planning warehouse in the project workspace that the lakehouse reads through a OneLake shortcut, because a lakehouse SQL endpoint is read-only), adds a Plan table to the semantic model with Budget, Forecast, Budget to Date, Variance to Budget, Variance to Budget %, Budget Attainment % and Forecast vs Budget measures, and checks the totals through the model. Preview first and confirm the numbers with the user.',
      parameters: obj({
        measure: str('Measure to plan'),
        dims: { type: 'array', items: { type: 'string' }, description: 'Up to two dimension tables' },
        planYear: { type: 'number', description: 'Year to plan' },
        asOfMonth: { type: 'number', description: 'Forecast cut-off month (0–12)' },
        growthPct: { type: 'number', description: 'Growth over the base year in percent' },
        overrides: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, growthPct: { type: 'number' } } }, description: 'Growth per member of the first dimension' },
      }),
      handler: async (a) => runAsJob('planning', 'Build the budget and forecast', (ctx) => PL.runPlan(ctx, PL.planOptions(a))),
    }),
    studioTool('studio_list_artifacts', {
      description: 'List everything the project built (data source, data prep notebook, semantic model, ontology, reports, org app, plan, Fabric plan, data agent, Teams agent, live data, dashboard, alerts, live ontology, medallion layers, task flow) with what each one uses and what uses it. An item can be removed only when nothing uses it (usedBy is empty). Read-only.',
      parameters: obj({}),
      handler: async () => (await ARTS.projectArtifacts()).map((a) => ({ key: a.key, type: a.type, name: a.name, removable: a.removable, usedBy: a.usedBy.map((u) => `${u.name} (${u.type})`), removes: a.removes })),
    }),
    studioTool('studio_remove_artifacts', {
      description: 'Remove items from studio_list_artifacts by key – deletes them in Fabric (see each item\'s "removes"). Only items nothing uses can be removed: remove the users first, in order (e.g. org app, then reports, then the semantic model). Confirm with the user first (offer it with studio_suggest_apply).',
      parameters: obj({ keys: { type: 'array', items: { type: 'string' }, description: 'Keys from studio_list_artifacts, users before what they use' } }, ['keys']),
      handler: async (a) => runAsJob('remove', `Remove ${a.keys.length} item${a.keys.length === 1 ? '' : 's'}`, (ctx) => ARTS.removeArtifacts(ctx, a.keys)),
    }),
    studioTool('studio_create_plan_item', {
      description: 'Create (or check) the Fabric plan item where planners refine the budget in planning sheets. Needs the plan built first. Planners connect it to the semantic model with their own sign-in: in the plan, New Planning Sheet › Data pane › Add › the model › Connect (they need Read and Build on the model – Contributor or higher). Microsoft deprecated the shared cloud connection flow for planning, so the studio never binds one; pass connection="fabric" to recreate a plan that still uses a shared connection (fixes "DMTS connection owner missing" / "Can\'t access the semantic model"; only while it has no sheets). Tell the user not to use Manage Connections in the plan.',
      parameters: obj({ name: str('Optional plan name (letters, numbers, underscores)'), connection: { type: 'string', enum: ['fabric'], description: 'Optional: "fabric" recreates a plan that uses a (deprecated) shared connection without one' } }),
      handler: async (a) => runAsJob('plan-item', 'Create the Fabric plan', (ctx) => PL.runPlanItem(ctx, { name: a.name, connection: a.connection || undefined })),
    }),
    studioTool('studio_planning_access', {
      description: 'Who can connect the semantic model in a Fabric plan: the project workspace\'s people and groups with their roles. Planners connect with their own sign-in and need Read and Build on the model – Contributor or higher gives both (errors SM_CONN_1003 / SM_CONN_0005 otherwise). Read-only.',
      parameters: obj({}),
      handler: async () => ({ access: await PL.planAccess() }),
    }),
    studioTool('studio_add_planner', {
      description: 'Give a person access to the project workspace so they can plan: Contributor (default) or Member. Planners connect the model with their own sign-in and need Read and Build on it. Confirm the email and role with the user first.',
      parameters: obj({ email: str('The person\'s Microsoft Entra sign-in (email)'), role: { type: 'string', enum: ['Contributor', 'Member'], description: 'Default Contributor' } }, ['email']),
      handler: async (a) => PL.addPlanner({ email: a.email, role: a.role || 'Contributor' }),
    }),
    studioTool('studio_check_readiness', {
      description: 'Check what can run before acting: the workspace capacity (running or paused, SKU, trial), your workspace role, the tenant settings each module needs (when you are a Fabric administrator), and data-source limits. Returns each module (workspace, data, model, ontology, reports, realtime, planning, share) as ready, limited or blocked with reasons and fixes. Call it when an action fails or before a long journey. Read-only.',
      parameters: obj({ refresh: { type: 'boolean', description: 'Check again instead of using the last result (two minutes)' } }),
      handler: async (a) => {
        const r = await readiness({ refresh: Boolean(a.refresh) });
        return { capacity: r.capacity, role: r.role, tenantSettings: r.tenantSettings, checks: r.checks, modules: Object.values(r.modules).map((m) => ({ module: m.id, status: m.status, reasons: m.reasons.filter((x) => x.status !== 'info').map((x) => ({ status: x.status, text: x.text, fix: x.fix })) })) };
      },
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
      case 'session.error': {
        chat.busy = false;
        const message = /not created with authentication info|not authenticated/i.test(d.message || '') ? NOT_SIGNED_IN : d.message || 'The AI session reported an error.';
        chat.transcript.push({ role: 'error', content: message, at: Date.now() });
        emit('chat.error', { chatId: chat.id, message });
        persist(chat);
        break;
      }
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
  await assertCopilotSignedIn();
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
  await assertCopilotSignedIn();
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
