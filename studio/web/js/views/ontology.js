import { store, get, post, patch, on } from '../api.js';
import { h, toast, busy, field, input } from '../ui.js';
import { app, copilotSlot } from '../app.js';

let rules = null;
on('studio.reset', () => { rules = null; });

export function renderOntology(el) {
  const p = store.project || {};
  if (!p.modelSource) {
    el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Connect data first. '), 'The ontology binds business concepts to the same data as the semantic model.'), h('button', { class: 'btn pri', onclick: () => app.go('data') }, 'Go to Data')));
    return;
  }
  if (p.ontology) el.append(ontologyCard(p));
  el.append(h('div', { class: 'grid g2', style: { marginTop: p.ontology ? '14px' : 0 } }, glossaryCard(p), designerCard(p)), copilotSlot());
}

function ontologyCard(p) {
  const o = p.ontology;
  const ws = p.workspace.id;
  const mcpUrl = `https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/${ws}/items/${o.id}/ontologyEndpoint`;
  return h('div', { class: 'card' },
    h('div', { class: 'row sp' },
      h('div', {}, h('div', { class: 'row' }, h('h2', {}, o.name), h('span', { class: 'pill ok' }, 'Deployed'), h('span', { class: 'badge preview' }, 'Preview')),
        h('div', { class: 'muted small' }, `${o.entities?.length || 0} entities · ${o.relationships?.length || 0} relationships · ${o.rules?.length || 0} business rules`)),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: `https://app.fabric.microsoft.com/groups/${ws}/ontologies/${o.id}`, target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗'),
        h('button', { class: 'btn pri', onclick: () => app.go('reports') }, 'Next: reports & apps →'))),
    h('dl', { class: 'kv mt' },
      h('dt', {}, 'Entities'), h('dd', {}, (o.entities || []).join(', ')),
      h('dt', {}, 'Rules'), h('dd', {}, (o.rules || []).join(', ') || '–'),
      h('dt', {}, 'Ontology MCP'), h('dd', { class: 'mono tiny' }, mcpUrl)),
    h('div', { class: 'chips mt' },
      h('button', { class: 'chip', onclick: () => app.ask('Using the ontology, explain the business entities, how they relate, and every business rule in plain language.') }, '✦ Explain my ontology'),
      h('button', { class: 'chip', onclick: () => app.ask('Which records currently break each business rule in my ontology? Use the semantic model or read-only SQL to count them.') }, '✦ Check rule violations'),
      h('button', { class: 'chip', onclick: () => app.ask('Compare my glossary with the ontology rules and propose missing rules or clearer statements.') }, '✦ Find gaps vs. glossary')));
}

function glossaryCard(p) {
  const ta = h('textarea', { class: 'i', style: { minHeight: '320px', fontFamily: 'Consolas, monospace', fontSize: '12px' }, placeholder: '# Business glossary\n\n| Term | Definition |\n|---|---|\n| Active customer | A customer with a purchase in the last 90 days |\n\n## Business rules\n1. …' }, p.glossary || '');
  const file = h('input', { type: 'file', accept: '.md,.txt,.csv', hidden: true });
  file.addEventListener('change', async () => { const f = file.files[0]; if (f) { ta.value = await f.text(); toast(`Loaded ${f.name}`); } });
  const save = h('button', { class: 'btn pri', 'data-busy': 'Saving…' }, 'Save glossary');
  save.addEventListener('click', busy(save, async () => { await patch('/project', { glossary: ta.value }); toast('Glossary saved', 'ok'); }));
  return h('div', { class: 'card' },
    h('h2', {}, 'Business glossary'),
    h('p', { class: 'lead' }, 'Definitions, measures and rules in plain language. Copilot uses it to write measures and ontology rules that match how your business talks.'),
    ta,
    h('div', { class: 'row mt' }, save,
      h('button', { class: 'btn', onclick: () => file.click() }, 'Upload .md/.txt'), file,
      h('button', { class: 'btn ai', onclick: () => app.ask('Draft a business glossary for my data: entities, key measures with formulas, customer classifications and business rules. Base it on the tables and a quick profile of the data, then save it with studio_save_glossary after I review it.') }, '✦ Draft it with Copilot')));
}

function designerCard(p) {
  const card = h('div', { class: 'card' });
  const name = input({ value: p.ontology?.name || store.preset?.ontologyName || (p.source?.id === 'retail' ? 'Contoso_Retail_Ontology' : `${p.modelSource.itemName.replace(/[^A-Za-z0-9_]+/g, '_')}_Ontology`) });
  const preview = h('div', {}, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Building a preview from your tables…'));
  const rulesBox = h('div');
  const job = h('div', { class: 'mt' });
  card.append(h('h2', {}, p.ontology ? 'Update the ontology' : 'Design the ontology'),
    h('p', { class: 'lead' }, 'Entity types come from your tables and relationships. Business rules are short plain-English statements linked to entities.'),
    preview, rulesBox, h('div', { class: 'formgrid mt' }, field('Ontology name', name, 'Letters, numbers and underscores only (Fabric naming rule)')));

  const drawRules = () => {
    rulesBox.innerHTML = '';
    rulesBox.append(h('h3', { class: 'mt' }, `Business rules (${rules.length})`));
    for (const [i, r] of rules.entries()) {
      const n = input({ value: r.name, style: { maxWidth: '200px' } });
      const s = h('textarea', { class: 'i', style: { minHeight: '46px' } }, r.statement);
      n.addEventListener('input', () => { r.name = n.value; });
      s.addEventListener('input', () => { r.statement = s.value; });
      rulesBox.append(h('div', { class: 'row', style: { alignItems: 'flex-start', marginBottom: '6px' } }, n, h('div', { style: { flex: 1 } }, s), h('button', { class: 'btn danger', title: 'Remove', onclick: () => { rules.splice(i, 1); drawRules(); } }, '✕')));
    }
    rulesBox.append(h('button', { class: 'btn', onclick: () => { rules.push({ name: `Rule${rules.length + 1}`, statement: '' }); drawRules(); } }, '＋ Add rule'));
  };

  get('/ontology/preview').then((pv) => {
    preview.innerHTML = '';
    if (!rules) rules = pv.rules.map((r) => ({ ...r }));
    const t = h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Entity'), h('th', {}, 'Bound to'), h('th', {}, 'Key'), h('th', { class: 'num' }, 'Properties')));
    for (const e of pv.entities) t.append(h('tr', {}, h('td', {}, h('b', {}, e.name)), h('td', { class: 'mono tiny' }, e.table), h('td', { class: 'mono tiny' }, e.key || '–'), h('td', { class: 'num' }, e.properties)));
    preview.append(h('div', { class: 'scroll' }, t), h('div', { class: 'tiny muted mt' }, `Relationships: ${pv.relationships.map((r) => r.label).join(' · ') || 'none'}`));
    drawRules();
  }).catch((e) => { preview.innerHTML = ''; preview.append(h('div', { class: 'banner err' }, e.message)); });

  const deploy = h('button', { class: 'btn pri big', 'data-busy': 'Starting…' }, p.ontology ? 'Update ontology' : 'Deploy ontology');
  deploy.addEventListener('click', busy(deploy, async () => {
    const valid = (rules || []).filter((r) => r.name.trim() && r.statement.trim()).map((r) => ({ name: r.name.trim(), statement: r.statement.trim() }));
    const j = await post('/jobs/ontology', { name: name.value.trim(), rules: valid });
    app.watchJob(j.id);
    const render = (x) => { job.innerHTML = ''; job.append(app.jobCard(x)); };
    render(j);
    const off = on('job', (e) => { if (e.job.id !== j.id) return; render(e.job); if (e.job.status !== 'running') { off(); if (e.job.status === 'succeeded') { toast('Ontology deployed', 'ok'); app.refresh(); } } });
  }));
  card.append(h('div', { class: 'row mt' }, deploy,
    h('button', { class: 'btn ai', onclick: () => app.ask(`Read my glossary and data, then propose ontology business rules (one sentence each, referencing the entities and properties they use). After I confirm, deploy the ontology "${name.value}" with studio_deploy_ontology.`) }, '✦ Generate rules with Copilot')),
  job,
  h('p', { class: 'tiny muted' }, 'Ontology is a preview feature. Agents use the Ontology MCP endpoint (paid F2+ or P1+) to read entities and business rules. Ontology questions are turned off for now; numbers come from Fabric IQ.'));
  return card;
}
