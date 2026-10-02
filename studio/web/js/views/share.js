import { store, get, post, on } from '../api.js';
import { h, toast, busy, confirmDialog } from '../ui.js';
import { app, suggestions } from '../app.js';

export function renderShare(el) {
  const p = store.project || {};
  const qs = suggestions(p, store.preset);
  el.append(h('div', { class: 'grid g2' },
    askCard(p, qs),
    teamsCard(p),
    clientsCard(p),
    agentCard(p),
    exportCard()));
}

function askCard(p, qs) {
  return h('div', { class: 'card' },
    h('h2', {}, 'Ask governed questions'),
    h('p', { class: 'lead' }, p.semanticModel ? `Answers come from "${p.semanticModel.name}"${p.ontology ? ` and the "${p.ontology.name}" ontology` : ''} through Fabric IQ, with your permissions and row-level security.` : 'Create the semantic model first to get governed answers.'),
    h('div', { class: 'chips' }, qs.map((q) => h('button', { class: 'chip', onclick: () => app.ask(q, { open: 'tab' }) }, q))),
    h('div', { class: 'row mt' }, h('button', { class: 'btn ai', onclick: () => app.go('copilot') }, '✦ Open Copilot')));
}

function teamsCard(p) {
  const win = store.platform === 'win32';
  const withOnt = h('input', { type: 'checkbox', checked: Boolean(p.ontology) || undefined, disabled: !p.ontology || undefined });
  const job = h('div', { class: 'mt' });
  const run = (body, label) => {
    const b = h('button', { class: body.publish ? 'btn' : body.dryRun ? 'btn' : 'btn pri', 'data-busy': 'Starting…', disabled: !win || undefined }, label);
    b.addEventListener('click', busy(b, async () => {
      if (!body.dryRun && !(await confirmDialog(label, body.publish ? 'This submits the agent to your organization\'s app catalog for admin approval.' : 'This creates a Microsoft Entra app (read-only delegated Power BI permissions), registers the OAuth connection and installs the agent for you in Microsoft 365 Copilot and Teams.'))) return;
      const j = await post('/jobs/teams-agent', { ...body, includeOntology: withOnt.checked });
      app.watchJob(j.id);
      const render = (x) => { job.innerHTML = ''; job.append(app.jobCard(x)); };
      render(j);
      const off = on('job', (e) => { if (e.job.id !== j.id) return; render(e.job); if (e.job.status !== 'running') off(); });
    }));
    return b;
  };
  return h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('h2', {}, 'Microsoft 365 Copilot & Teams'), p.teamsAgent ? h('span', { class: 'pill ok' }, 'Installed') : null),
    h('p', { class: 'lead' }, 'Install a Copilot agent that business users can ask in Teams, Outlook and the Microsoft 365 Copilot app. It queries your semantic model (and ontology) through MCP, as each user.'),
    h('label', { class: 'row small' }, withOnt, 'Include the ontology endpoint', p.ontology ? null : h('span', { class: 'tiny muted' }, '(deploy the ontology first)')),
    h('div', { class: 'row mt' }, run({ dryRun: true }, 'Validate package'), run({}, 'Install for me'), run({ publish: true }, 'Publish to my organization')),
    win ? null : h('div', { class: 'banner warn mt' }, 'The installer is a PowerShell script. On macOS/Linux run scripts/install-teams-agent.ps1 with PowerShell 7.'),
    h('ul', { class: 'pre' }, h('li', {}, 'Requires Microsoft 365 Copilot and permission to upload custom apps.'), h('li', {}, 'Opens a browser for the Microsoft 365 sign-in on first install.'), h('li', {}, 'Customize the agent in agents/contoso-retail-analyst (name, instructions, conversation starters).')),
    job);
}

function clientsCard(p) {
  const ont = p.ontology ? ' -IncludeOntology' : '';
  const clients = [
    ['GitHub Copilot in VS Code', `.\\scripts\\setup.ps1 -Client vscode${ont}`],
    ['GitHub Copilot CLI', `.\\scripts\\setup.ps1 -Client copilot-cli${ont}`],
    ['Claude Code', `.\\scripts\\setup.ps1 -Client claude-code${ont}`],
    ['Cursor', `.\\scripts\\setup.ps1 -Client cursor${ont}`],
  ];
  const t = h('table', { class: 't' });
  for (const [name, cmd] of clients) {
    t.append(h('tr', {}, h('td', {}, h('b', {}, name)), h('td', { class: 'mono tiny' }, cmd), h('td', { class: 'num' }, h('button', { class: 'btn', onclick: () => { navigator.clipboard.writeText(cmd); toast('Copied'); } }, 'Copy'))));
  }
  return h('div', { class: 'card' },
    h('h2', {}, 'Use it from other AI clients'),
    h('p', { class: 'lead' }, 'Same MCP servers, any client your team already licenses. Run from the repository folder.'),
    t,
    h('p', { class: 'small muted mt' }, 'Copilot Studio and Azure AI Foundry agents: see clients/copilot-studio and clients/azure-ai-foundry in the repository.'));
}

function agentCard(p) {
  const name = p.semanticModel ? `${p.semanticModel.name} agent` : 'Data agent';
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', {}, 'Fabric data agent'), h('span', { class: 'badge' }, 'Copilot-guided')),
    h('p', { class: 'lead' }, 'Publish a conversational Fabric data agent grounded in your semantic model, with instructions from your glossary. Data agents can also be used from Microsoft 365 Copilot and Copilot Studio.'),
    h('button', { class: 'btn ai', disabled: !p.semanticModel || undefined, onclick: () => app.ask(`Create a Fabric data agent named "${name}" in workspace '${p.workspace?.name}' grounded in the semantic model '${p.semanticModel?.name}'. Use fabric-local to get the DataAgent item definition schema, write agent instructions from my glossary, show me the definition, and create it with fabric-core after I approve.`) }, '✦ Create it with Copilot'));
}

function exportCard() {
  const dl = h('button', { class: 'btn', 'data-busy': 'Preparing…' }, 'Download project & audit log (JSON)');
  dl.addEventListener('click', busy(dl, async () => {
    const data = await get('/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `fabric-mcp-studio-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
  }));
  return h('div', { class: 'card' },
    h('h2', {}, 'Export'),
    h('p', { class: 'lead' }, 'Keep a record of what was built: project settings, created items with links, and every approved or declined change.'),
    dl);
}
