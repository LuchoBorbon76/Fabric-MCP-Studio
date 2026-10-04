import { store, get, post, on } from '../api.js';
import { h, toast, busy, field, input, fmtNum, modal } from '../ui.js';
import { app, copilotSlot } from '../app.js';
import { askCard } from '../prompts.js';

let schema = null;
let schemaKey = null;
const include = new Set();
const names = {};
let nameDraft = null;     // typed model name, kept when the designer re-renders
on('studio.reset', () => { schema = null; schemaKey = null; include.clear(); for (const k of Object.keys(names)) delete names[k]; nameDraft = null; });

export function renderModel(el) {
  const p = store.project || {};
  if (!p.modelSource) {
    el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Connect data first. '), 'The semantic model is built on the data source you choose in the Data page.'), h('button', { class: 'btn pri', onclick: () => app.go('data') }, 'Go to Data')));
    return;
  }
  if (p.semanticModel) el.append(modelCard(p), askCard({ title: `Ask ${p.semanticModel.name}`, lead: 'Questions built from your measures, dimensions and years – answered through Fabric IQ with the DAX shown.', only: ['numbers', 'compare', 'sample'] }));

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
  if (schemaKey !== key) nameDraft = null;
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
  const smName = input({ value: nameDraft ?? (p.semanticModel?.name || preset?.semanticModelName || `${p.modelSource.itemName.replace(/_/g, ' ')} Model`) });
  smName.addEventListener('input', () => { nameDraft = smName.value; });
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
      pendingProposal(p) ? proposalBanner(p.modelProposal) : null,
      h('div', { class: 'formgrid mt' }, field('Semantic model name', smName)),
      h('div', { class: 'row mt' }, create,
        h('button', { class: 'btn ai', onclick: () => app.ask(`Design a star schema for my data. Selected tables: ${[...include].join(', ')}. Explain facts, dimensions, relationships and the business measures you recommend (grounded in my glossary if I have one). Name the model "${smName.value}". Then suggest the design with studio_propose_semantic_model so I can review and apply it – don't create it yet.`) }, '✦ Design it with Copilot')));
  }).catch((e) => { body.innerHTML = ''; body.append(h('div', { class: 'banner err' }, e.message)); });
}

function humanize(n) { return String(n).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()); }

// ---------------- Copilot's suggestions ----------------

const pendingProposal = (p) => Boolean(p?.modelProposal && !p.modelProposal.appliedAt);

export function proposalCounts(pr) {
  const pv = pr.preview || { tables: [], relationships: [], measures: [] };
  return `${pr.name} · ${pv.tables.length} tables · ${pv.relationships.length} relationships · ${pv.measures.length} measures`;
}

function proposalBanner(pr) {
  return h('div', { class: 'banner ok mt' },
    h('div', { style: { flex: 1 } }, h('b', {}, 'Copilot suggested a design. '), proposalCounts(pr), pr.warnings?.length ? h('div', { class: 'tiny muted' }, `${pr.warnings.length} item(s) left out – see the review.`) : null),
    h('button', { class: 'btn pri', onclick: () => applyModelProposal(pr) }, '✓ Apply suggestions'));
}

/** Review Copilot's suggested design, then create or update the semantic model exactly as shown. */
export function applyModelProposal(pr) {
  const current = store.project?.modelProposal;
  if (!pr || !current) { toast('There are no suggestions to apply.', 'err'); return; }
  if (current.id !== pr.id) { toast('Copilot made newer suggestions – apply the latest ones.', 'err'); return; }
  if (current.appliedAt) { toast('These suggestions are already applied.', 'ok'); return; }
  const pv = current.preview;
  const fromCopilot = pv.measures.filter((m) => m.suggested).length;
  const tbl = (head, rows) => h('div', { class: 'scroll' }, h('table', { class: 't' }, h('tr', {}, head.map((x) => h('th', {}, x))), rows));
  const body = h('div', { class: 'col' },
    current.summary ? h('p', { class: 'small', style: { margin: 0 } }, current.summary) : null,
    h('dl', { class: 'kv' },
      h('dt', {}, 'Semantic model'), h('dd', {}, h('b', {}, current.name), current.updatesExisting ? ' – updates the existing model' : ' – new Direct Lake model'),
      h('dt', {}, 'Data source'), h('dd', {}, store.project.modelSource?.itemName || '')),
    current.warnings?.length ? h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Left out. '), current.warnings.join(' '))) : null,
    h('h3', {}, `Tables (${pv.tables.length})`),
    tbl(['Business name', 'Source table', 'Role'], pv.tables.map((t) => h('tr', {}, h('td', {}, h('b', {}, t.name)), h('td', { class: 'mono tiny' }, t.key), h('td', {}, h('span', { class: `pill ${t.role === 'fact' ? 'brand' : ''}` }, t.role))))),
    h('h3', {}, `Relationships (${pv.relationships.length})`),
    pv.relationships.length
      ? tbl(['From (many)', 'To (one)', ''], pv.relationships.map((r) => h('tr', {}, h('td', { class: 'mono tiny' }, r.from), h('td', { class: 'mono tiny' }, r.to), h('td', {}, r.active ? '' : h('span', { class: 'pill' }, 'inactive')))))
      : h('div', { class: 'banner warn' }, 'No relationships – the model is created without them.'),
    h('h3', {}, `Measures (${pv.measures.length})${fromCopilot && fromCopilot !== pv.measures.length ? ` · ${fromCopilot} from Copilot, the rest from the sample glossary` : ''}`),
    pv.measures.length
      ? tbl(['Measure', 'Table', 'DAX'], pv.measures.map((m) => h('tr', {}, h('td', {}, h('b', {}, m.name), m.suggested && fromCopilot !== pv.measures.length ? h('span', { class: 'pill brand', style: { marginLeft: '6px' } }, 'Copilot') : null), h('td', {}, m.table), h('td', { class: 'mono tiny' }, m.expression))))
      : h('div', { class: 'muted small' }, 'No measures.'),
    h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Nothing changes in Fabric until you select the button below.'));
  modal({
    title: 'Apply Copilot\'s suggestions', className: 'appr wide', body,
    actions: [
      { label: 'Cancel' },
      {
        label: current.updatesExisting ? 'Update semantic model' : 'Create semantic model', class: 'pri',
        onClick: async () => {
          try {
            const j = await post('/jobs/semantic-model', { name: current.name, include: current.include, names: current.names, relationships: current.relationships || undefined, measures: current.measures, proposalId: current.id });
            // Show the applied design in the designer too.
            include.clear();
            for (const k of current.include) include.add(k);
            for (const k of Object.keys(names)) delete names[k];
            Object.assign(names, current.names || {});
            nameDraft = current.name;
            app.watchJob(j.id);
            toast(`Creating ${current.name}…`);
            const off = on('job', (e) => {
              if (e.job.id !== j.id || e.job.status === 'running') return;
              off();
              if (e.job.status === 'succeeded') { toast('Semantic model deployed with Copilot\'s suggestions', 'ok'); app.refresh(); } else toast(e.job.error || 'The semantic model was not created.', 'err');
            });
          } catch (e) { toast(e.message, 'err'); return false; }
          return true;
        },
      },
    ],
  });
}
