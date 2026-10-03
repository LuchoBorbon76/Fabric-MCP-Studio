// Shared app actions (set by main.js) so views can navigate and talk to Copilot without circular imports.
export const app = {
  go: () => {},
  ask: () => {},
  placeChat: () => {},
  refresh: async () => {},
  rerender: () => {},
  jobCard: () => null,
  watchJob: () => {},
};

/**
 * Where Copilot opens inside a view. Copilot is always embedded in the page (never a pop-up): app.ask() from a view
 * moves the chat into that view's slot. One slot per view; views without one use the Copilot tab.
 */
export function copilotSlot() {
  const el = document.createElement('section');
  el.className = 'cslot';
  el.hidden = true;
  return el;
}

export const STEPS = [
  { id: 'ai', view: 'settings', title: 'Connect your AI', desc: 'Pick the Copilot or model you already license' },
  { id: 'workspace', view: 'workspace', title: 'Workspace', desc: 'Create a new workspace or use an existing one' },
  { id: 'data', view: 'data', title: 'Data', desc: 'Sample data, your databases, or existing Fabric data' },
  { id: 'model', view: 'model', title: 'Semantic model', desc: 'Direct Lake model with business measures' },
  { id: 'ontology', view: 'ontology', title: 'Ontology', desc: 'Entities, relationships and business rules' },
  { id: 'reports', view: 'reports', title: 'Reports & apps', desc: 'Polished Power BI reports from templates and themes' },
  { id: 'realtime', view: 'realtime', title: 'Real-time', desc: 'Live events, Real-Time Dashboard, live ontology and alerts' },
  { id: 'share', view: 'share', title: 'Ask & share', desc: 'Governed answers in Copilot, Teams and more' },
];

export function stepStatus(project, store) {
  const s = {};
  s.ai = store.health?.checks?.find((c) => c.id === 'copilot')?.status === 'ok' || store.provider?.id !== 'github' ? 'done' : 'todo';
  s.workspace = project?.workspace ? 'done' : 'todo';
  s.data = project?.modelSource ? 'done' : 'todo';
  s.model = project?.semanticModel ? 'done' : 'todo';
  s.ontology = project?.ontology ? 'done' : 'todo';
  s.reports = project?.reports?.length ? 'done' : 'todo';
  s.realtime = project?.realtime?.dashboard ? 'done' : 'todo';
  s.share = project?.teamsAgent || project?.steps?.share ? 'done' : 'todo';
  const firstTodo = STEPS.find((x) => s[x.id] !== 'done');
  if (firstTodo) s.current = firstTodo.id;
  return s;
}

/** Context-aware prompt suggestions for the chat. */
export function suggestions(project, preset) {
  const p = project || {};
  if (!p.workspace) {
    return [
      'Create a new workspace called "Fabric MCP Demo" on one of my capacities',
      'Show me my Fabric workspaces and capacities',
      'What can you build for me in Microsoft Fabric?',
    ];
  }
  if (!p.modelSource) {
    return [
      'Load the Contoso Retail sample data into my workspace',
      'List the lakehouses and warehouses I could use as a data source',
      'Which Fabric connections can I use to mirror a database?',
    ];
  }
  if (!p.semanticModel) {
    return [
      'Describe my data and propose a star schema',
      'Create the semantic model with business measures from my glossary',
      'Profile the largest table and suggest useful measures',
    ];
  }
  if (!p.ontology) {
    return [
      'Add descriptions to every measure and column in plain business language',
      'Deploy an ontology with the business rules from my glossary',
      'Recommend and build a Power BI report for my semantic model',
    ];
  }
  if (!p.reports?.length) {
    return [
      'Recommend and build a Power BI report for my semantic model',
      'Which KPIs and breakdowns should an executive report show for my data?',
      ...(preset?.starterQuestions?.slice(0, 1) || ['What are the key numbers in my semantic model?']),
    ];
  }
  if (!p.realtime) {
    return [
      'Stream live events shaped like my data and build a real-time dashboard',
      ...(preset?.starterQuestions?.slice(0, 2) || ['What are the key numbers in my semantic model?']),
    ];
  }
  if (p.realtime && !p.realtime.dashboard) return ['Build the Real-Time Dashboard for my live data', 'What is happening in my live data right now?'];
  if (p.realtime && p.ontology && !p.realtime.ontology) return ['Connect my live events to the ontology', 'What is happening in my live data right now?', 'Alert me in Teams when a business rule is broken'];
  if (p.realtime && !p.realtime.alerts) return ['Alert me in Teams when a business rule is broken', 'What is happening in my live data right now?'];
  return preset?.starterQuestions?.length ? ['What is happening in my live data right now?', ...preset.starterQuestions.slice(0, 3)] : [
    'What are the key numbers in my semantic model?',
    'Which business rules are defined in my ontology?',
    'Create a Fabric data agent grounded in my semantic model',
  ];
}
