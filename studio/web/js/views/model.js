import { store, get, post, on } from '../api.js';
import { h, toast, busy, field, input, fmtNum, modal } from '../ui.js';
import { app, copilotSlot } from '../app.js';
import { askCard } from '../prompts.js';
import { standardName, parseName, purposeOf } from '../naming.js';
import { modelsDialog, addExistingDialog } from '../models.js';

let schema = null;
let schemaKey = null;
const include = new Set();
const names = {};
let nameDraft = null;     // typed model name, kept when the designer re-renders
let newModel = false;     // the designer builds another model instead of updating the active one
on('studio.reset', () => { schema = null; schemaKey = null; include.clear(); for (const k of Object.keys(names)) delete names[k]; nameDraft = null; newModel = false; });
// "+ New model from my data" in the Semantic models pop-up: the designer builds another model.
on('model.new', () => { newModel = true; nameDraft = null; });

const STORAGE = { DirectLake: 'Direct Lake', Import: 'Import', DirectQuery: 'DirectQuery', Dual: 'Dual', Mixed: 'Mixed' };

export function renderModel(el) {
  const p = store.project || {};
  const sm = p.semanticModel;
  const designer = h('div', { class: 'card designer' });
  if (sm) el.append(modelCard(p), askCard({ title: `Ask ${sm.name}`, lead: 'Questions built from your measures, dimensions and years – answered through Fabric IQ with the DAX shown.', only: ['numbers', 'compare', 'sample'] }));
  else if (p.workspace) {
    // No model yet: an existing model is one click away (the designer below builds a new one).
    el.append(h('div', { class: 'banner', style: { marginBottom: '14px' } },
      h('div', { style: { flex: 1 } }, h('b', {}, 'Already have a semantic model? '), 'Use an existing model from any workspace you can read – reports, the data agent and Copilot work on it right away.'),
      h('button', { class: 'btn pri', onclick: () => addExistingDialog() }, '+ Add an existing model')));
  }
  if (!p.modelSource) {
    el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Connect data to design a new model. '), sm ? 'The studio designs Direct Lake models from the data source you choose in the Data page; your models keep working.' : 'The studio designs Direct Lake models from the data source you choose in the Data page.'), h('button', { class: 'btn pri', onclick: () => app.go('data') }, 'Go to Data')));
    return;
  }
  el.append(designer);
  drawDesigner(designer, p);
}

/** The model the designer updates, or null when it builds a new one (an existing model is never regenerated). */
function updatable(p) {
  const sm = p.semanticModel;
  if (!sm || newModel || sm.origin === 'existing') return null;
  if (sm.sourceItemId && p.modelSource?.itemId && sm.sourceItemId !== p.modelSource.itemId) return null;
  return sm;
}

/** A standard name for a new model that no model in the project has yet. */
function newModelName(p, purpose) {
  const taken = new Set((p.semanticModels || []).map((m) => m.name.toLowerCase()));
  for (let i = 1; i < 50; i++) {
    const n = standardName('SemanticModel', i === 1 ? purpose : `${purpose}${i}`);
    if (!taken.has(n.toLowerCase())) return n;
  }
  return standardName('SemanticModel', purpose);
}

function modelCard(p) {
  const sm = p.semanticModel;
  const ws = sm.workspaceId || p.workspace.id;
  const wsName = sm.workspaceName || p.workspace.name;
  const theirs = sm.origin === 'existing';
  const actions = [
    ['Add business measures from my glossary', `Connect to semantic model '${sm.name}' in workspace '${wsName}'. Read my glossary and add any missing business measures with descriptions, format strings and display folders. Validate each with a DAX query.`],
    ['Document every table, column and measure', `Connect to semantic model '${sm.name}' in workspace '${wsName}' and add plain-language descriptions to every table, column and measure that has none.`],
    ['Run a best-practice review', `Connect to semantic model '${sm.name}' in workspace '${wsName}', run a best-practice review, and show me a scorecard before fixing anything.`],
    ['Add Spanish translations', `Connect to semantic model '${sm.name}' in workspace '${wsName}' and add an es-MX culture with translated table, column, measure and display folder names.`],
    ['Create a row-level security role', `Propose a row-level security role for semantic model '${sm.name}' in workspace '${wsName}' (for example by region), explain it, then create it after I approve.`],
    ['Answer a business question', `Using the '${sm.name}' semantic model, what are the three most important numbers I should know? Use Fabric IQ and show the DAX.`],
  ];
  const counts = sm.tables === null || sm.tables === undefined ? 'tables and measures not read yet' : `${sm.tables} tables · ${sm.relationships ?? '–'} relationships · ${sm.measures} measures`;
  const how = theirs
    ? `Existing model${STORAGE[sm.storageMode] ? ` · ${STORAGE[sm.storageMode]}` : ''}${ws !== p.workspace.id ? ` · in ${wsName}` : ''}`
    : `Direct Lake${sm.sourceItemId && sm.sourceItemId === p.modelSource?.itemId ? ` on ${p.modelSource.itemName}` : ''}`;
  const reread = theirs ? h('button', { class: 'btn', 'data-busy': 'Reading…', title: 'Read the tables, measures and relationships again after the model changed in Fabric' }, '↻ Read again') : null;
  reread?.addEventListener('click', busy(reread, async () => { await post('/models/refresh', { id: sm.id }); toast(`${sm.name} read again`, 'ok'); await app.refresh(); }));
  const count = (p.semanticModels || []).length;
  const switcher = h('button', { class: 'btn', title: 'Switch to another semantic model, add an existing one or start a new one (or double-click Semantic model on the map)', onclick: () => modelsDialog() }, count > 1 ? `⇄ Models (${count})` : '⇄ Switch or add a model');
  return h('div', { class: 'card', style: { marginBottom: '14px' } },
    h('div', { class: 'row sp' },
      h('div', {}, h('div', { class: 'row' }, h('h2', {}, sm.name), h('span', { class: `pill ${theirs ? 'brand' : 'ok'}` }, theirs ? 'Existing model' : 'Deployed'), h('span', { class: 'pill ok' }, 'Active'), sm.quality ? h('span', { class: `pill ${sm.quality.status === 'ready' ? 'ok' : sm.quality.status === 'needs-review' ? 'warn' : 'err'}` }, `Quality ${sm.quality.score}/100`) : null), h('div', { class: 'muted small' }, `${how} · ${counts}`)),
      h('div', { class: 'row' },
        switcher,
        reread,
        h('a', { class: 'btn', href: `https://app.fabric.microsoft.com/groups/${ws}/datasets/${sm.id}/details`, target: '_blank', rel: 'noopener' }, 'Open in Fabric ↗'),
        h('a', { class: 'btn', href: `https://app.powerbi.com/groups/${ws}/modeling/${sm.id}/modelView`, target: '_blank', rel: 'noopener' }, 'Edit data model ↗'),
        p.modelSource ? h('button', { class: 'btn pri', onclick: () => app.go('ontology') }, 'Next: ontology →') : h('button', { class: 'btn pri', onclick: () => app.go('reports') }, 'Next: reports →'))),
    theirs ? h('p', { class: 'tiny muted', style: { margin: '6px 0 0' } }, 'The studio never regenerates or deletes a model you added. Changes go through Copilot (Power BI authoring) and only after you approve each one.') : null,
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
  const target = updatable(p);
  const purpose = parseName(preset?.semanticModelName)?.purpose || purposeOf(p.modelSource.itemName, p.modelSource.itemType) || 'Main';
  const smName = input({ value: nameDraft ?? (target ? target.name : newModelName(p, purpose)) });
  smName.addEventListener('input', () => { nameDraft = smName.value; });
  const body = h('div', {}, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading tables, keys and relationships from the SQL analytics endpoint…'));
  const slot = copilotSlot();   // Copilot opens here, right below the tables and relationships
  const footer = h('div');
  const createdMeasures = h('div');
  const job = h('div', { class: 'mt' });
  // Switch between updating the active model and building another one next to it.
  const canUpdate = Boolean(p.semanticModel && p.semanticModel.origin !== 'existing' && !(p.semanticModel.sourceItemId && p.semanticModel.sourceItemId !== p.modelSource.itemId));
  const toggle = p.semanticModel
    ? (target
      ? h('button', { class: 'btn', title: 'Build another semantic model from this data; the active one stays as it is', onclick: () => { newModel = true; nameDraft = null; drawDesigner(card, store.project || p); } }, '+ New model instead')
      : canUpdate ? h('button', { class: 'btn', onclick: () => { newModel = false; nameDraft = null; drawDesigner(card, store.project || p); } }, `Update ${p.semanticModel.name} instead`) : null)
    : null;
  card.append(
    h('div', { class: 'row sp' },
      h('div', {}, h('h2', {}, target ? 'Update the semantic model' : p.semanticModel ? 'Design a new semantic model' : 'Design the semantic model'),
        h('p', { class: 'lead' }, target
          ? `Changes regenerate ${target.name} (Direct Lake TMDL) from your tables and relationships. Copilot can then add business measures, descriptions, security and translations.`
          : `The studio generates a Direct Lake model (TMDL) from your tables and relationships${p.semanticModel ? ' and adds it to the project next to the models you have – it becomes the active model' : ''}. Copilot can then add business measures, descriptions, security and translations.`)),
      h('div', { class: 'row' }, toggle, h('button', { class: 'btn', onclick: () => { schema = null; drawDesigner(card, p); } }, '↻ Re-read schema'))),
    body, slot, footer, createdMeasures, job);
  app.placeChat();   // keep an open Copilot chat after the designer is rebuilt
  renderCreatedMeasures(createdMeasures, p);

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

    const create = h('button', { class: 'btn pri big', 'data-busy': 'Starting…' }, target ? 'Update semantic model' : 'Create semantic model');
    create.addEventListener('click', busy(create, async () => {
      const inc = [...include];
      if (!inc.length) throw new Error('Select at least one table.');
      const nm = smName.value.trim();
      const clash = (store.project?.semanticModels || []).find((m) => m.name.toLowerCase() === nm.toLowerCase() && m.id !== target?.id);
      if (clash && !target && clash.origin === 'existing') throw new Error(`"${clash.name}" is an existing model in the project. Choose another name.`);
      const nameMap = Object.fromEntries(Object.entries(names).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v.trim()]));
      const j = await post('/jobs/semantic-model', { name: nm, include: inc, names: Object.keys(nameMap).length ? nameMap : undefined });
      app.watchJob(j.id);
      const render = (x) => { job.innerHTML = ''; job.append(app.jobCard(x)); };
      render(j);
      const off = on('job', (e) => { if (e.job.id !== j.id) return; render(e.job); if (e.job.status !== 'running') { off(); if (e.job.status === 'succeeded') { newModel = false; nameDraft = null; toast('Semantic model deployed', 'ok'); app.refresh(); } } });
    }));
    const measuresNote = preset?.measureCount
      ? `The ${preset.label} sample adds ${preset.measureCount} business measures from its glossary (${preset.measureNames.slice(0, 4).join(', ')}…).`
      : 'Starter measures (row counts and totals of amount columns) are generated. Ask Copilot to design business measures from your glossary.';
    body.append(
      h('div', { class: 'grid g2' },
        h('div', {}, tablesTitle, h('div', { class: 'scroll' }, tbl)),
        h('div', {}, h('h3', {}, `Relationships (${s.relationships.length})`), s.relationships.length ? h('div', { class: 'scroll' }, rels) : h('div', { class: 'banner warn' }, 'No relationships found. Ask Copilot to infer them from the data, or the model is created without relationships.'),
          h('div', { class: 'banner mt' }, h('div', {}, h('b', {}, 'Measures. '), measuresNote)))));
    footer.append(...[
      pendingProposal(p) ? proposalBanner(p.modelProposal) : null,
      h('div', { class: 'formgrid mt' }, field('Semantic model name', smName)),
      h('div', { class: 'row mt' }, create,
        h('button', { class: 'btn ai', onclick: () => app.ask(`Design a star schema for my data. Selected tables: ${[...include].join(', ')}. Explain facts, dimensions, relationships and the business measures you recommend (grounded in my glossary if I have one). Name the model "${smName.value}". Then suggest the design with studio_propose_semantic_model so I can review and apply it – don't create it yet.`) }, '✦ Design it with Copilot'))].filter(Boolean));
  }).catch((e) => { body.innerHTML = ''; body.append(h('div', { class: 'banner err' }, e.message)); });
}

function humanize(n) { return String(n).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()); }

function measuresTable(measures, { suggested = false } = {}) {
  const rows = (measures || []).slice(0, 80);
  if (!rows.length) return h('div', { class: 'empty' }, suggested ? 'No suggested measures yet.' : 'No measures read yet.');
  return h('div', { class: 'scroll measures-scroll' }, h('table', { class: 't stable' },
    h('tr', {}, h('th', {}, 'Measure'), h('th', {}, 'Table'), h('th', {}, 'DAX')),
    rows.map((m) => h('tr', {},
      h('td', {}, h('b', {}, m.name), suggested && m.suggested === false ? h('span', { class: 'pill', style: { marginLeft: '6px' } }, 'default') : null),
      h('td', {}, m.table),
      h('td', { class: 'mono tiny' }, m.expression || '')))));
}

function suggestedMeasuresCard(pr) {
  const measures = pr?.preview?.measures || [];
  return h('div', { class: 'card compact mt' },
    h('div', { class: 'row sp' },
      h('div', {}, h('h3', {}, `Suggested measures (${measures.length})`), h('p', { class: 'lead' }, 'What Copilot/defaults will create when you apply this design.')),
      h('button', { class: 'btn pri', onclick: () => applyModelProposal(pr) }, '✓ Apply suggestions')),
    measuresTable(measures, { suggested: true }));
}

function renderCreatedMeasures(box, p) {
  box.innerHTML = '';
  const sm = p.semanticModel;
  if (!sm?.id) return;
  box.append(h('div', { class: 'card compact mt' },
    h('div', { class: 'row muted small' }, h('span', { class: 'spin' }), `Reading measures created in ${sm.name}…`)));
  get(`/models/measures?id=${encodeURIComponent(sm.id)}`).then((r) => {
    box.replaceChildren(h('div', { class: 'card compact mt' },
      h('h3', {}, `Created measures (${r.measures.length})`),
      h('p', { class: 'lead' }, 'Measures currently visible in the active semantic model.'),
      measuresTable(r.measures)));
  }).catch((e) => {
    box.replaceChildren(h('div', { class: 'card compact mt' }, h('h3', {}, 'Created measures'), h('div', { class: 'banner warn' }, e.message)));
  });
}

// ---------------- Copilot's suggestions ----------------

const pendingProposal = (p) => Boolean(p?.modelProposal && !p.modelProposal.appliedAt);

export function proposalCounts(pr) {
  const pv = pr.preview || { tables: [], relationships: [], measures: [] };
  return `${pr.name} · ${pv.tables.length} tables · ${pv.relationships.length} relationships · ${pv.measures.length} measures`;
}

function proposalBanner(pr) {
  const q = pr.quality;
  return h('div', { class: 'banner ok mt' },
    h('div', { style: { flex: 1 } }, h('b', {}, 'Copilot suggested a design. '), proposalCounts(pr), q ? h('span', { class: `pill ${q.status === 'ready' ? 'ok' : q.status === 'needs-review' ? 'warn' : 'err'}`, style: { marginLeft: '6px' } }, `Quality ${q.score}/100`) : null, pr.warnings?.length ? h('div', { class: 'tiny muted' }, `${pr.warnings.length} item(s) left out – see the review.`) : null),
    h('button', { class: 'btn', onclick: () => reviewSuggestedMeasures(pr) }, 'Measures'),
    h('button', { class: 'btn pri', onclick: () => applyModelProposal(pr) }, '✓ Apply suggestions'));
}

function reviewSuggestedMeasures(pr) {
  modal({ title: 'Suggested measures', className: 'wide', body: suggestedMeasuresCard(pr), actions: [{ label: 'Close' }] });
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
    current.quality ? h('div', { class: `banner ${current.quality.status === 'ready' ? 'ok' : current.quality.status === 'needs-review' ? 'warn' : 'err'}` }, h('div', {}, h('b', {}, `Quality gate: ${current.quality.summary}. `), [...(current.quality.errors || []), ...(current.quality.warnings || [])].slice(0, 4).join(' '))) : null,
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
