import { store, get, post, del, on } from '../api.js';
import { h, toast, busy, confirmDialog, modal, field, input } from '../ui.js';
import { app, copilotSlot } from '../app.js';
import { promptGallery } from '../prompts.js';
import { fabricItemUrl } from '../lineage.js';
import { modelBar } from '../models.js';

export function renderShare(el) {
  const p = store.project || {};
  const bar = modelBar({ note: 'Answers, the data agent and the Microsoft 365 agent use it' });
  if (bar) el.append(bar);
  el.append(h('div', { class: 'grid g2' },
    askCard(p),
    teamsCard(p),
    clientsCard(p),
    agentCard(p),
    exportCard()));
}

function askCard(p) {
  return h('div', { class: 'card', style: { gridColumn: '1 / -1' } },
    h('h2', {}, 'Ask governed questions'),
    h('p', { class: 'lead' }, p.semanticModel ? `Answers come from "${p.semanticModel.name}"${p.ontology ? ` and the "${p.ontology.name}" ontology` : ''} through Fabric IQ, with your permissions and row-level security. The questions below use your own measures, dimensions and years – select one to start.` : 'Create the semantic model first to get governed answers.'),
    promptGallery({ perGroup: 4 }),
    h('div', { class: 'row mt' }, h('button', { class: 'btn ai', onclick: () => app.ask() }, '✦ Ask your own question')),
    copilotSlot());
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
    // GitHub Copilot is for developers (developer mode).
    ...(store.settings?.developer ? [
      ['GitHub Copilot in VS Code', `.\\scripts\\setup.ps1 -Client vscode${ont}`],
      ['GitHub Copilot CLI', `.\\scripts\\setup.ps1 -Client copilot-cli${ont}`],
    ] : []),
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

// ---------------- Fabric data agent ----------------
const pendingAgentProposal = (p) => Boolean(p?.dataAgentProposal && !p.dataAgentProposal.appliedAt);

export function dataAgentProposalText(pr) {
  return `${pr.name} · on ${pr.semanticModel || store.project?.semanticModel?.name || 'your model'} · ${Number(pr.instructions?.length || 0).toLocaleString()} characters of instructions${pr.updatesExisting ? ' · updates the existing agent' : ''}`;
}

function runAgentJob(body, done) {
  return post('/jobs/data-agent', body).then((j) => {
    app.watchJob(j.id);
    const off = on('job', (e) => {
      if (e.job.id !== j.id || e.job.status === 'running') return;
      off();
      if (e.job.status === 'succeeded') { toast(done, 'ok'); app.refresh(); } else toast(e.job.error || 'The data agent was not created.', 'err');
    });
    return j;
  });
}

/** Review Copilot's suggested data agent (name, instructions), then create it exactly as shown. */
export function applyDataAgentProposal(pr) {
  const current = store.project?.dataAgentProposal;
  if (!pr || !current) { toast('There are no suggestions to apply.', 'err'); return; }
  if (current.id !== pr.id) { toast('Copilot made newer suggestions – apply the latest ones.', 'err'); return; }
  if (current.appliedAt) { toast('These suggestions are already applied.', 'ok'); return; }
  const name = input({ value: current.name });
  const instructions = h('textarea', { class: 'i mono', rows: 14, style: { width: '100%', fontSize: '12px' } });
  instructions.value = current.instructions || '';
  const publish = h('input', { type: 'checkbox', checked: store.project.dataAgent ? Boolean(store.project.dataAgent.published) || undefined : true });
  const body = h('div', { class: 'col' },
    current.summary ? h('p', { class: 'small', style: { margin: 0 } }, current.summary) : null,
    h('dl', { class: 'kv' },
      h('dt', {}, 'Data source'), h('dd', {}, `${current.semanticModel} (semantic model) – every table, column and measure`),
      h('dt', {}, 'Workspace'), h('dd', {}, store.project.workspace?.name || ''),
      current.updatesExisting ? [h('dt', {}, 'Agent'), h('dd', {}, `Updates ${store.project.dataAgent?.name || 'the existing agent'}${store.project.dataAgent?.name && store.project.dataAgent.name !== current.name ? ` and renames it to ${current.name}` : ''}`)] : null),
    current.warnings?.length ? h('div', { class: 'banner warn' }, current.warnings.join(' ')) : null,
    field('Name', name),
    field('Instructions', instructions, 'What the agent answers, which measures to use and the business definitions. You can edit them before creating the agent.'),
    h('label', { class: 'row small' }, publish, 'Publish it so it can be used in Microsoft 365 Copilot and Copilot Studio'),
    h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Nothing changes in Fabric until you select the button below.'));
  modal({
    title: 'Apply Copilot\'s suggestions', className: 'appr wide', body,
    actions: [
      { label: 'Cancel' },
      {
        label: current.updatesExisting ? 'Update data agent' : 'Create data agent', class: 'pri',
        onClick: async () => {
          try {
            await runAgentJob({ name: name.value.trim() || current.name, instructions: instructions.value, description: current.description, publish: publish.checked, proposalId: current.id }, 'Data agent ready with Copilot\'s suggestions');
            toast(`Creating ${name.value.trim() || current.name}…`);
          } catch (e) { toast(e.message, 'err'); return false; }
          return true;
        },
      },
    ],
  });
}

function agentCard(p) {
  const card = h('div', { class: 'card' });
  const job = h('div', { class: 'mt' });
  const draw = () => {
    p = store.project || p;
    const a = p.dataAgent ? { ...p.dataAgent, url: p.dataAgent.url || fabricItemUrl('DataAgent', p.dataAgent.workspaceId, p.dataAgent.id) } : null;
    const pr = pendingAgentProposal(p) ? p.dataAgentProposal : null;
    const running = [...store.jobs.values()].find((j) => j.kind === 'data-agent' && j.status === 'running');
    card.innerHTML = '';
    const create = h('button', { class: `btn ${a ? '' : 'pri'}`, 'data-busy': 'Starting…', disabled: !p.semanticModel || running || undefined, title: p.semanticModel ? '' : 'Create the semantic model first' }, a ? '↻ Update with the latest model' : 'Create data agent');
    create.addEventListener('click', busy(create, async () => { await runAgentJob(a ? { name: a.name, instructions: a.instructions, description: a.description, publish: Boolean(a.published) } : {}, a ? 'Data agent updated' : 'Data agent ready'); }));
    const remove = a ? h('button', { class: 'btn ghost', 'data-busy': 'Deleting…' }, 'Delete') : null;
    remove?.addEventListener('click', busy(remove, async () => {
      if (!await confirmDialog('Delete the data agent?', `This deletes ${a.name} from Fabric. Your semantic model is not touched.`, 'Delete', true)) return;
      await del('/data-agent?delete=1'); await app.refresh();
    }));
    card.append(...[
      h('div', { class: 'row sp' }, h('div', { class: 'row' }, h('h2', {}, 'Fabric data agent'), a ? h('span', { class: `pill ${a.published ? 'ok' : 'warn'}` }, a.published ? 'Published' : 'Draft') : h('span', { class: 'badge' }, 'Copilot-guided'))),
      h('p', { class: 'lead' }, 'A conversational Fabric data agent grounded in your semantic model, with instructions from your measures and glossary. Published agents can also be used from Microsoft 365 Copilot and Copilot Studio.'),
      a ? h('dl', { class: 'kv' },
        h('dt', {}, 'Agent'), h('dd', {}, h('a', { href: a.url, target: '_blank', rel: 'noopener' }, `${a.name} ↗`)),
        h('dt', {}, 'Data source'), h('dd', {}, `${a.semanticModel} · ${a.tables} tables · ${a.measures} measures`),
        a.semanticModelId && a.semanticModelId !== p.semanticModel?.id ? [h('dt', {}, 'Note'), h('dd', {}, h('span', { class: 'pill warn' }, 'The semantic model changed – update the agent'))] : null) : null,
      pr ? h('div', { class: 'banner ok mt' }, h('div', { style: { flex: 1 } }, h('b', {}, 'Copilot suggested a data agent. '), dataAgentProposalText(pr)), h('button', { class: 'btn pri', onclick: () => applyDataAgentProposal(pr) }, '✓ Apply suggestions')) : null,
      h('div', { class: 'row mt' },
        create,
        h('button', { class: 'btn ai', disabled: !p.semanticModel || undefined, onclick: () => app.ask(`Suggest a Fabric data agent for the semantic model "${p.semanticModel?.name}": read my glossary and the model's measures, write clear instructions (role, which measure answers which question, business definitions, formatting), then call studio_propose_data_agent so I can apply it.`) }, '✦ Suggest it with Copilot'),
        a ? h('a', { class: 'btn', href: a.url, target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗') : null,
        remove),
      running ? h('div', { class: 'mt' }, app.jobCard(running)) : null,
      job].filter(Boolean));
  };
  const off = on('job', (e) => { if (!card.isConnected) { off(); return; } if (e.job.kind === 'data-agent') draw(); });
  draw();
  return card;
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
