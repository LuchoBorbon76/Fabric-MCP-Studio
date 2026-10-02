import { store, get, post, on } from '../api.js';
import { h, toast, busy, field, input, fmtNum } from '../ui.js';
import { app, copilotSlot } from '../app.js';

let schema = null;
let schemaKey = null;
const include = new Set();
const names = {};

export function renderModel(el) {
  const p = store.project || {};
  if (!p.modelSource) {
    el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Connect data first. '), 'The semantic model is built on the data source you choose in the Data tab.'), h('button', { class: 'btn pri', onclick: () => app.go('data') }, 'Go to Data')));
    return;
  }
  if (p.semanticModel) el.append(modelCard(p));

  const designer = h('div', { class: 'card' });
  el.append(designer);
  drawDesigner(designer, p);
}

function modelCard(p) {
  const sm = p.semanticModel;
  const ws = p.workspace.id;
  const actions = [
    ['Add business measures from my glossary', `Connect to semantic model '${sm.name}' in workspace '${p.workspace.name}'. Read my glossary and add any missing business measures with descriptions, format strings and display folders. Validate each with a DAX query.`],
    ['Document every table, column and measure', `Connect to semantic model '${sm.name}' in workspace '${p.workspace.name}' and add plain-language descriptions to every table, column and measure that has none.`],
    ['Run a best-practice review', `Connect to semantic model '${sm.name}' in workspace '${p.workspace.name}', run a best-practice review, and show me a scorecard before fixing anything.`],
    ['Add Spanish translations', `Connect to semantic model '${sm.name}' in workspace '${p.workspace.name}' and add an es-MX culture with translated table, column, measure and display folder names.`],
    ['Create a row-level security role', `Propose a row-level security role for semantic model '${sm.name}' (for example by region), explain it, then create it after I approve.`],
    ['Answer a business question', `Using the '${sm.name}' semantic model, what are the three most important numbers I should know? Use Fabric IQ and show the DAX.`],
  ];
  return h('div', { class: 'card', style: { marginBottom: '14px' } },
    h('div', { class: 'row sp' },
      h('div', {}, h('div', { class: 'row' }, h('h2', {}, sm.name), h('span', { class: 'pill ok' }, 'Deployed')), h('div', { class: 'muted small' }, `Direct Lake on ${p.modelSource.itemName} · ${sm.tables} tables · ${sm.relationships} relationships · ${sm.measures} measures`)),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: `https://app.fabric.microsoft.com/groups/${ws}/datasets/${sm.id}/details`, target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗'),
        h('a', { class: 'btn', href: `https://app.powerbi.com/groups/${ws}/modeling/${sm.id}/modelView`, target: '_blank', rel: 'noopener' }, 'Edit data model ↗'),
        h('button', { class: 'btn pri', onclick: () => app.go('ontology') }, 'Next: ontology →'))),
    h('div', { class: 'mt' }, h('div', { class: 'tiny muted mb' }, 'Improve it with Copilot (Power BI Authoring MCP)'), h('div', { class: 'chips' }, actions.map(([label, prompt]) => h('button', { class: 'chip', onclick: () => app.ask(prompt) }, `✦ ${label}`)))));
}

async function loadSchema(refresh) {
  const ms = store.project.modelSource;
  const key = `${ms.server}|${ms.database}|${store.project.source?.id || ''}`;
  if (!refresh && schema && schemaKey === key) return schema;
  schema = await get(`/model/describe${refresh ? '?refresh=1' : ''}`);
  schemaKey = key;
  include.clear();
  for (const k of Object.keys(names)) delete names[k];
  // Sample presets start from their curated star schema; other sources start with every table.
  const curated = store.preset?.include;
  for (const t of schema.tables) {
    const k = `${t.schema}.${t.name}`;
    if (!curated?.length || curated.includes(k) || curated.includes(t.name)) include.add(k);
  }
  if (!include.size) for (const t of schema.tables) include.add(`${t.schema}.${t.name}`);
  return schema;
}

const presetName = (t) => store.preset?.names?.[`${t.schema}.${t.name}`] || store.preset?.names?.[t.name] || '';

function drawDesigner(card, p) {
  card.innerHTML = '';
  const preset = store.preset;
  const smName = input({ value: p.semanticModel?.name || preset?.semanticModelName || `${p.modelSource.itemName.replace(/_/g, ' ')} Model` });
  const body = h('div', {}, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading tables, keys and relationships from the SQL analytics endpoint…'));
  const slot = copilotSlot();   // Copilot opens here, right below the tables and relationships
  const footer = h('div');
  const job = h('div', { class: 'mt' });
  card.append(
    h('div', { class: 'row sp' },
      h('div', {}, h('h2', {}, p.semanticModel ? 'Update the semantic model' : 'Design the semantic model'), h('p', { class: 'lead' }, 'The studio generates a Direct Lake model (TMDL) from your tables and relationships. Copilot can then add business measures, descriptions, security and translations.')),
      h('button', { class: 'btn', onclick: () => { schema = null; drawDesigner(card, p); } }, '↻ Re-read schema')),
    body, slot, footer, job);
  app.placeChat();   // keep an open Copilot chat after the designer is rebuilt

  loadSchema(false).then((s) => {
    body.innerHTML = '';
    if (!s.tables.length) { body.append(h('div', { class: 'banner warn' }, 'No tables found yet. If you just loaded or mirrored data, wait a minute and re-read the schema.')); return; }
    const tablesTitle = h('h3', {});
    const countTables = () => { tablesTitle.textContent = `Tables (${include.size} of ${s.tables.length} selected)`; };
    countTables();
    const tbl = h('table', { class: 't' }, h('tr', {}, h('th', {}, ''), h('th', {}, 'Source table'), h('th', {}, 'Business name'), h('th', { class: 'num' }, 'Rows'), h('th', { class: 'num' }, 'Columns'), h('th', {}, 'Key')));
    for (const t of s.tables) {
      const key = `${t.schema}.${t.name}`;
      const cb = h('input', { type: 'checkbox', checked: include.has(key) || undefined });
      cb.addEventListener('change', () => { if (cb.checked) include.add(key); else include.delete(key); countTables(); });
      const nm = input({ value: names[key] || '', placeholder: presetName(t) || humanize(t.name), style: { padding: '4px 8px' } });
      nm.addEventListener('input', () => { names[key] = nm.value; });
      const k = t.columns.find((c) => c.isPk || c.isKey);
      tbl.append(h('tr', {}, h('td', {}, cb), h('td', {}, h('b', {}, key)), h('td', {}, nm), h('td', { class: 'num' }, fmtNum(t.rows)), h('td', { class: 'num' }, t.columns.length), h('td', { class: 'mono tiny' }, k?.name || '–')));
    }
    const rels = h('table', { class: 't' }, h('tr', {}, h('th', {}, 'From (many)'), h('th', {}, ''), h('th', {}, 'To (one)'), h('th', {}, 'Source')));
    for (const r of s.relationships) rels.append(h('tr', {}, h('td', { class: 'mono tiny' }, `${r.from.table}.${r.from.column}`), h('td', {}, '→'), h('td', { class: 'mono tiny' }, `${r.to.table}.${r.to.column}`), h('td', {}, h('span', { class: `pill ${r.active === false ? '' : 'brand'}` }, r.active === false ? 'inactive' : (r.source || 'sample preset')))));

    const create = h('button', { class: 'btn pri big', 'data-busy': 'Starting…' }, p.semanticModel ? 'Update semantic model' : 'Create semantic model');
    create.addEventListener('click', busy(create, async () => {
      const inc = [...include];
      if (!inc.length) throw new Error('Select at least one table.');
      const nameMap = Object.fromEntries(Object.entries(names).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v.trim()]));
      const j = await post('/jobs/semantic-model', { name: smName.value.trim(), include: inc, names: Object.keys(nameMap).length ? nameMap : undefined });
      app.watchJob(j.id);
      const render = (x) => { job.innerHTML = ''; job.append(app.jobCard(x)); };
      render(j);
      const off = on('job', (e) => { if (e.job.id !== j.id) return; render(e.job); if (e.job.status !== 'running') { off(); if (e.job.status === 'succeeded') { toast('Semantic model deployed', 'ok'); app.refresh(); } } });
    }));
    const measuresNote = preset?.measureCount
      ? `The ${preset.label} sample adds ${preset.measureCount} business measures from its glossary (${preset.measureNames.slice(0, 4).join(', ')}…).`
      : 'Starter measures (row counts and totals of amount columns) are generated. Ask Copilot to design business measures from your glossary.';
    body.append(
      h('div', { class: 'grid g2' },
        h('div', {}, tablesTitle, h('div', { class: 'scroll' }, tbl)),
        h('div', {}, h('h3', {}, `Relationships (${s.relationships.length})`), s.relationships.length ? h('div', { class: 'scroll' }, rels) : h('div', { class: 'banner warn' }, 'No relationships found. Ask Copilot to infer them from the data, or the model is created without relationships.'),
          h('div', { class: 'banner mt' }, h('div', {}, h('b', {}, 'Measures. '), measuresNote)))));
    footer.append(
      h('div', { class: 'formgrid mt' }, field('Semantic model name', smName)),
      h('div', { class: 'row mt' }, create,
        h('button', { class: 'btn ai', onclick: () => app.ask(`Design a star schema for my data. Selected tables: ${[...include].join(', ')}. Explain facts, dimensions, relationships and the business measures you recommend (grounded in my glossary if I have one). Then create the semantic model "${smName.value}" with studio_create_semantic_model after I confirm.`) }, '✦ Design it with Copilot')));
  }).catch((e) => { body.innerHTML = ''; body.append(h('div', { class: 'banner err' }, e.message)); });
}

function humanize(n) { return String(n).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()); }
