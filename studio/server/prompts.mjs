// Prompt suggestions for the chat, grouped by what the project has: questions that use the actual measures,
// dimensions and years of the semantic model (from the report profile), the reports, ontology rules, live data, the
// plan, the data source and the data prep notebook – plus the next build step. Read-only.
import { getProject } from './project.mjs';
import { presetFor } from './presets.mjs';
import { currentProfile } from './reports/index.mjs';

const PROFILE_WAIT_MS = 20000;

// "Product Category" -> "product category" (acronyms such as SKU stay).
const lower = (s) => String(s || '').split(' ').map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(' ');
function plural(w) {
  const s = String(w || '');
  if (/[^aeiou]y$/i.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/i.test(s)) return `${s}es`;
  return `${s}s`;
}
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** The model profile, if it comes back in time; suggestions never wait long for it. */
async function profileOrNull(p) {
  if (!p.semanticModel?.id) return null;
  try {
    return await Promise.race([currentProfile(), new Promise((resolve) => setTimeout(() => resolve(null), PROFILE_WAIT_MS))]);
  } catch { return null; }
}

function modelPrompts(p, pr, preset) {
  const groups = [];
  const model = p.semanticModel.name;
  if (!pr) {
    // No profile (no measures yet, or the model can't be queried right now): generic questions.
    groups.push({ id: 'numbers', title: 'Key numbers & trends', prompts: [
      `What are the key numbers in "${model}"? Show each headline measure with its value.`,
      `How have the main measures in "${model}" trended by month over the last two years?`,
      'Which measures does my model have, and what does each one mean in plain language?',
    ] });
    groups.push({ id: 'compare', title: 'Compare & rank', prompts: [
      'Which category contributes most to the main measure, and how has its share changed?',
      'What are the top 10 items by the main measure, and the bottom 10?',
    ] });
    return groups;
  }
  const m = pr.primary.label;
  const t = pr.time;
  const full = t?.fullYears || [];
  const [prev, last] = full.slice(-2);
  const grain = t?.grain || 'month';
  const kpis = (pr.kpis || []).filter((k) => k.name !== pr.primary.name).map((k) => k.label);
  const pct = (pr.kpis || []).find((k) => k.percent);
  const brk = pr.breakdown?.label;
  const share = pr.share?.label;
  const ent = pr.entity?.label;

  const numbers = [];
  if (last && prev) numbers.push(`What was ${m} in ${last}, and how does it compare with ${prev}?`);
  else numbers.push(`What is ${m} in total${t?.last ? ` and in ${t.last}` : ''}?`);
  numbers.push(`Give me an executive summary: ${list([m, ...kpis.slice(0, 3)])}${last ? ` for ${last}` : ''}, with what changed and why.`);
  if (t) numbers.push(`How has ${m} trended by ${grain}${full.length >= 2 ? ` from ${full[0]} to ${t.last}` : ''}? Point out peaks, dips and seasonality.`);
  for (const ins of pr.insights || []) {
    if (ins.kind === 'growth' && last) numbers.push(`Why did ${m} ${ins.value >= 0 ? 'grow' : 'fall'} in ${last}?${brk ? ` Which ${lower(brk)} drove the change?` : ''}`);
  }
  if (t && last) numbers.push(`Which months of ${last} were above or below the monthly average for ${m}?`);
  groups.push({ id: 'numbers', title: 'Key numbers & trends', prompts: numbers });

  const compare = [];
  if (brk) compare.push(`Which ${lower(brk)} has the highest ${m}${full.length >= 2 ? ', and which is growing fastest year over year' : ''}?`);
  if (share) compare.push(`What share of ${m} comes from each ${lower(share)}${full.length >= 2 ? ', and how has the mix changed' : ''}?`);
  if (ent) compare.push(`Who are the top 10 ${lower(plural(ent))} by ${m}? And the bottom 10?`);
  if (ent && last && prev) compare.push(`Which ${lower(plural(ent))} declined the most in ${last} compared with ${prev}?`);
  if (pct && (brk || share)) compare.push(`Where is ${pct.label} lowest by ${lower(brk || share)}, and what explains it?`);
  if ((pr.hierarchy || []).length > 1) compare.push(`Drill down ${pr.hierarchy.map((c) => lower(c.label)).join(' › ')}: where is ${m} concentrated?`);
  if (ent) compare.push(`How concentrated is ${m}: what share comes from the top 20% of ${lower(plural(ent))}?`);
  if (compare.length) groups.push({ id: 'compare', title: 'Compare & rank', prompts: compare });

  if (preset?.starterQuestions?.length) groups.push({ id: 'sample', title: 'Sample questions', prompts: preset.starterQuestions.slice(0, 5) });
  return groups;
}

function reportPrompts(p, pr) {
  const reports = p.reports || [];
  if (!reports.length) return null;
  const prompts = [];
  for (const r of reports.slice(0, 2)) {
    const name = /report$/i.test(r.name) ? `"${r.name}"` : `the "${r.name}" report`;
    prompts.push(`Walk me through ${name}: what does each page${r.pages?.length ? ` (${r.pages.slice(0, 4).join(', ')})` : ''} tell me right now?`);
  }
  if (pr?.primary) prompts.push(`What are the three most important things the numbers in my reports say about ${pr.primary.label}?`);
  prompts.push('Which of my reports and pages should I open to explain this year\'s performance to leadership?');
  return { id: 'reports', title: 'Your reports', prompts };
}

/** MinimumMargin -> Minimum Margin */
const words = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim();

function rulePrompts(p) {
  const o = p.ontology;
  if (!o) return null;
  const rules = (o.ruleDetails?.length ? o.ruleDetails.map((r) => r.name) : o.rules || []).slice(0, 3);
  const prompts = rules.map((r) => `How many records break the ${words(r)} rule, and which ones matter most?`);
  prompts.push(`Explain the ${words(o.name)} entities, how they relate and every business rule in plain language.`);
  if ((o.entities || []).length) prompts.push(`Tell me everything about one ${lower(words(o.entities[0]))}: its key numbers, related records and rule breaks.`);
  return { id: 'rules', title: 'Business rules', prompts };
}

function livePrompts(p) {
  const rt = p.realtime;
  if (!rt) return null;
  const prompts = ['What is happening in my live data right now?'];
  const rules = (rt.scenario?.rules || []).map((r) => r.label).filter(Boolean);
  prompts.push(`Any business-rule breaks in the last 15 minutes${rules.length ? ` (${rules.slice(0, 2).join(', ')})` : ''}? Where?`);
  prompts.push('Compare the last hour of live events with the hour before: volume, amounts and rule breaks.');
  if (rt.medallion) prompts.push('How many events did the Silver layer quarantine or deduplicate in the last hour, and why?');
  if (rt.dashboard) prompts.push(`What does the "${rt.dashboard.name}" Real-Time Dashboard show right now?`);
  return { id: 'live', title: 'Live data', prompts };
}

function planPrompts(p) {
  const pl = p.planning;
  if (!pl) return null;
  const dim = pl.dims?.[0]?.labelText;
  return { id: 'plan', title: 'Plan vs actual', prompts: [
    `Are we on plan for ${pl.planYear}? Where are we ahead or behind budget?`,
    dim ? `Which ${lower(dim)} is furthest behind its ${pl.planYear} budget, and by how much?` : `How far are we from the ${pl.planYear} budget?`,
    `What does the forecast say for the rest of ${pl.planYear}?`,
  ] };
}

function dataPrompts(p) {
  const ms = p.modelSource;
  if (!ms) return null;
  const prompts = [
    'Describe my data: the tables, row counts, keys and how they relate.',
    'Profile the largest table: value ranges, missing values, duplicates and outliers.',
  ];
  if (p.source?.method === 'mirror') prompts.push('Is mirroring up to date? Show replication status and any tables with errors.');
  const dp = p.dataPrep?.source?.lakehouseId === ms.itemId ? p.dataPrep : null;
  const s = dp?.lastRun?.status === 'Completed' ? dp.lastRun.summary : null;
  if (s) {
    prompts.push('Summarize the data prep notebook run: what it renamed, fixed and found.');
    prompts.push(`Explain the KPIs the data prep notebook calculated on ${s.main} and what the charts show.`);
    if (s.relationships?.length) prompts.push('Which relationships did the data prep notebook find, and are any keys unmatched?');
  } else if (ms.itemType === 'Lakehouse') {
    prompts.push('Create and run the data prep notebook for my lakehouse, then tell me what it fixed and found.');
  }
  if (!p.semanticModel) prompts.push('Which questions could this data answer? Suggest measures and a star schema.');
  return { id: 'data', title: 'Explore the data', prompts };
}

/** The next build steps (the studio's guided path). */
function nextPrompts(p, preset) {
  if (!p.workspace) return ['Create a new workspace called "Fabric MCP Demo" on one of my capacities', 'Show me my Fabric workspaces and capacities', 'What can you build for me in Microsoft Fabric?'];
  if (!p.modelSource) return ['Load the Contoso Retail sample data into my workspace', 'List the lakehouses and warehouses I could use as a data source', 'Which Fabric connections can I use to mirror a database?'];
  const out = [];
  if (!p.semanticModel) out.push('Describe my data and propose a star schema', 'Create the semantic model with business measures from my glossary');
  else {
    if (!p.ontology) out.push(`Deploy an ontology with the business rules from my glossary`);
    if (!p.reports?.length) out.push('Recommend and build a Power BI report for my semantic model');
    else if (!p.orgApp) out.push('Bundle my reports into an org app for business users');
    out.push('Add descriptions to every measure and column in plain business language');
    if (!p.realtime) out.push('Stream live events shaped like my data and build a real-time dashboard');
    if (!p.planning) out.push('Recommend a budget and forecast for next year from my actuals');
    if (!p.teamsAgent) out.push('Make these answers available in Microsoft Teams and Microsoft 365 Copilot');
  }
  return out;
}

/**
 * Grouped prompt suggestions: { groups: [{ id, title, kind: 'ask' | 'build', prompts: [text] }], model: name | null }.
 * With a semantic model, questions that consume the analytics come first; the build steps come last.
 */
export async function promptSuggestions() {
  const p = getProject();
  const preset = presetFor(p);
  const ask = [];
  if (p.semanticModel) {
    const pr = await profileOrNull(p);
    ask.push(...modelPrompts(p, pr, preset));
    for (const g of [reportPrompts(p, pr), rulePrompts(p), planPrompts(p), livePrompts(p)]) if (g) ask.push(g);
  } else if (p.realtime) {
    ask.push(livePrompts(p));
  }
  const data = dataPrompts(p);
  if (data) ask.push(data);
  const groups = ask.map((g) => ({ ...g, kind: 'ask', prompts: [...new Set(g.prompts)].slice(0, 6) })).filter((g) => g.prompts.length);
  const next = nextPrompts(p, preset);
  if (next.length) groups.push({ id: 'next', title: p.semanticModel ? 'Build more' : 'Next steps', kind: 'build', prompts: next.slice(0, 5) });
  return { groups, model: p.semanticModel?.name || null };
}
