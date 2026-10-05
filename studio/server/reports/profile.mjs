// Model profile for report design: classifies measures and columns of any semantic model (metadata from INFO.VIEW)
// and profiles the data with a few DAX queries, so templates can pick KPIs, the time grain, share and breakdown
// dimensions, and the entity for "top N" lists. Everything is read-only.
import { modelMetadata, dax } from '../powerbi.mjs';

const tRef = (t) => `'${String(t).replace(/'/g, "''")}'`;
const cRef = (c) => `${tRef(c.table)}[${String(c.name).replace(/]/g, ']]')}]`;
const mRef = (m) => `[${String(m.name).replace(/]/g, ']]')}]`;

const LANG = /^(spanish|french|german|chinese|arabic|hebrew|thai|japanese|turkish|italian|portuguese|dutch)/i;
const NOT_CATEGORY = /(key|id|guid|code|phone|email|address|line\d|postal|zip|url|image|photo|description|alternate|suffix|title|middle|first ?name|last ?name|birth|date|flag|rownumber|status$)/i;
const PREFER_SHARE = /(region|territory|group|channel|segment|country|continent|market|tier|business ?type)/i;
const PREFER_BREAKDOWN = /(category|subcategory|product ?line|department|brand|country|territory|region|segment|store|channel)/i;
const PREFER_ENTITY = /(product|customer|reseller|store|account|employee|supplier|vendor|client|item|sku|model)/i;
// Tables and columns that rarely make a good headline breakdown.
const WEAK = /(promotion|scenario|currency|account|organization|department ?group|reason|class|style|size|colou?r|flag|status|unit|measure|weight|education|occupation|marital|gender|commute|cars|children|house|payment|bank)/i;
const STRONG_TABLE = /(product|geograph|territor|region|customer|store|channel|market|segment|country)/i;

export const isPercent = (m) => /%/.test(m.formatString || '') || /(margin|%|rate|ratio|share|pct|percent)/i.test(m.name);
const isComparison = (m) => /(\bPY\b|prior|last year|\bLY\b|YoY|growth|change|vs\.?|variance|delta|ytd|mtd|qtd)/i.test(m.name);
const isCurrency = (m) => m.dataType === 'Currency' || /[$€£¥]/.test(m.formatString || '') || /(sales|revenue|amount|cost|profit|price|value|spend|income|margin amount)/i.test(m.name);
const isCount = (m) => /(count|orders|customers|transactions|units|quantity|qty|visits|tickets|cases|members|accounts|#)/i.test(m.name);
const isAverage = (m) => /(average|avg|per |mean)/i.test(m.name);

/** Business label for a column: EnglishProductCategoryName -> Product Category, CalendarYear -> Year. */
export function columnLabel(name) {
  let s = String(name).replace(LANG, '').replace(/^(english|calendar)/i, '');
  s = s.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim();
  if (/\s/.test(s)) s = s.replace(/\s+name$/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function scoreMeasure(m) {
  let s = 0;
  if (isCurrency(m)) s += 4;
  if (/(sales|revenue)/i.test(m.name)) s += 4;
  if (/^total\b/i.test(m.name)) s += 3;
  if (/amount|value/i.test(m.name)) s += 1;
  if (isPercent(m) || isComparison(m) || isAverage(m)) s -= 8;
  if (/cost/i.test(m.name)) s -= 3;
  return s;
}

function pickKpis(measures, primary, channels) {
  // Skip channel-specific variants ("Internet Gross Profit") when the model has the overall measure.
  const prefixes = channels.map((m) => m.name.split(/\s+/)[0].toLowerCase());
  const channelVariant = (m) => prefixes.some((p) => m.name.toLowerCase().startsWith(`${p} `));
  const pool = measures.filter((m) => m !== primary && !isComparison(m) && !channelVariant(m));
  const pick = [];
  const take = (pred) => { const m = pool.find((x) => !pick.includes(x) && pred(x)); if (m) pick.push(m); };
  take((m) => /profit/i.test(m.name) && !isPercent(m));
  take((m) => isPercent(m) && /margin/i.test(m.name));
  take((m) => isPercent(m));
  take((m) => isAverage(m));
  take((m) => isCount(m) && /(order|transaction)/i.test(m.name));
  take((m) => isCount(m));
  take((m) => isCurrency(m) && !/cost/i.test(m.name));
  return [primary, ...pick].slice(0, 4);
}

/** Measures that split the primary measure by channel: "Internet Sales Amount" + "Reseller Sales Amount" for "Total Sales Amount". */
function channelMeasures(measures, primary) {
  const base = primary.name.replace(/^total\s+/i, '');
  if (base === primary.name) return [];
  const rx = new RegExp(`^(.+)\\s+${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  return measures.filter((m) => m !== primary && rx.test(m.name) && !isComparison(m)).slice(0, 4);
}

// A year column: "Year", "Calendar Year", "Fiscal Year", "Order Year"… – not "Week Number Of Year" or "Day Of Year".
const NOT_YEAR = /day|week|month|quarter|semester|period|half|of\s*year|number\s*of/i;
const isYearName = (n) => /year/i.test(n) && !NOT_YEAR.test(n);

/**
 * Year columns among cols, best first: the calendar year, then other years (fiscal last). Each kind is looked for in the
 * visible columns, then the hidden ones, before the next kind – a hidden CalendarYear beats a visible Fiscal Year.
 */
function yearColumns(cols, hidden = []) {
  const all = [...cols, ...hidden];
  const typed = (c, types) => types.includes(c.dataType);
  const tiers = [
    (c) => /^(calendar\s*)?year(\s*(number|no|num))?$/i.test(c.name) && typed(c, ['Integer', 'Number', 'Text']),
    (c) => isYearName(c.name) && !/fiscal/i.test(c.name) && typed(c, ['Integer', 'Number']),
    (c) => isYearName(c.name) && typed(c, ['Integer', 'Number']),
  ];
  const out = [];
  for (const t of tiers) for (const c of all) if (t(c) && !out.includes(c)) out.push(c);
  return out;
}

export function dateInfo(meta) {
  const dateTable = meta.tables.find((t) => t.dataCategory === 'Time')?.name
    || meta.tables.find((t) => /^(dim)?(date|calendar|time)$/i.test(t.name.replace(/\s+/g, '')))?.name;
  if (!dateTable) return null;
  const cols = meta.columns.filter((c) => c.table === dateTable);
  const hidden = (meta.hiddenColumns || []).filter((c) => c.table === dateTable);
  const find = (rx, type) => cols.find((c) => rx.test(c.name) && (!type || type.includes(c.dataType)));
  // A model can hide its year (and date) and show only labels: reports can still use the hidden column.
  const years = yearColumns(cols, hidden);
  const quarter = find(/^(calendar)?\s?quarter(number)?$/i, ['Integer', 'Number']);
  const monthNum = find(/^month(number)?(ofyear)?$|^month ?(no|num(ber)?)( of year)?$/i, ['Integer', 'Number']);
  const monthName = find(/^(english)?month(name)?$|^month name$/i, ['Text']);
  const date = cols.find((c) => c.dataType === 'Date' && c.isKey) || find(/date/i, ['Date'])
    || hidden.find((c) => c.dataType === 'Date' && c.isKey) || hidden.find((c) => /date/i.test(c.name) && c.dataType === 'Date');
  return { table: dateTable, year: years[0] || null, yearCandidates: years, quarter, monthNum, monthName, date };
}

/** Values that look like years (four digits, "FY2014" too). Blanks (facts without a matching date) don't count. */
const looksLikeYears = (values) => {
  const set = values.filter((v) => v !== null && v !== undefined && v !== '');
  return !set.length || set.every((v) => {
    const n = Number(String(v).match(/\d{4}/)?.[0] ?? NaN);
    return n >= 1000 && n <= 9999;
  });
};

const col = (c, label) => ({ kind: 'column', table: c.table, name: c.name, label: label || columnLabel(c.name) });
const meas = (m, label) => ({ kind: 'measure', table: m.table, name: m.name, label: label || m.name, formatString: m.formatString, percent: isPercent(m), displayFolder: m.displayFolder || '', description: m.description || '' });

/**
 * Profile a semantic model for report design.
 * Returns { model, measures, kpis, primary, channels, time, share, breakdown, entity, hierarchy, slicers, insights, warnings }.
 */
export async function profileModel(workspaceId, datasetId, { modelName = '' } = {}) {
  const meta = await modelMetadata(workspaceId, datasetId);
  const warnings = [];
  const measures = meta.measures;
  if (!measures.length) throw new Error('This semantic model has no measures yet. Add business measures first (Semantic model tab › Copilot), then design reports.');
  const primary = [...measures].sort((a, b) => scoreMeasure(b) - scoreMeasure(a))[0];
  const channels = channelMeasures(measures, primary);
  const kpis = pickKpis(measures, primary, channels);
  const date = dateInfo(meta);

  // Fact tables hold measures or are only ever on the "many" side; candidate categories live in dimensions.
  const oneSide = new Set(meta.relationships.map((r) => r.toTable));
  const factTables = new Set([...measures.map((m) => m.table), ...meta.relationships.filter((r) => !oneSide.has(r.fromTable)).map((r) => r.fromTable)]);
  const dimTables = oneSide;
  const candidates = meta.columns.filter((c) => c.dataType === 'Text' && c.table !== date?.table && !LANG.test(c.name) && !NOT_CATEGORY.test(c.name)
    && (dimTables.has(c.table) || !factTables.has(c.table)));

  // Distinct counts and longest value (one query): drops single-letter code columns such as ProductLine = 'R'.
  const top = candidates.slice(0, 60);
  const distinct = {};
  const longest = {};
  if (top.length) {
    const row = (await dax(workspaceId, datasetId, `EVALUATE ROW(${top.map((c, i) => `"d${i}", COUNTROWS(VALUES(${cRef(c)})), "l${i}", MAXX(VALUES(${cRef(c)}), LEN(${cRef(c)}))`).join(', ')})`))[0] || {};
    top.forEach((c, i) => { distinct[`${c.table}.${c.name}`] = Number(row[`d${i}`]) || 0; longest[`${c.table}.${c.name}`] = Number(row[`l${i}`]) || 0; });
  }
  const withCard = top.map((c) => ({ ...c, distinct: distinct[`${c.table}.${c.name}`] || 0 })).filter((c) => c.distinct > 1 && longest[`${c.table}.${c.name}`] > 2);
  const fit = (c, prefer) => (prefer.test(c.name) ? 3 : 0) + (STRONG_TABLE.test(c.table) ? 2 : 0) - (WEAK.test(c.name) || WEAK.test(c.table) ? 4 : 0);
  const best = (list, prefer, tie) => list.sort((a, b) => fit(b, prefer) - fit(a, prefer) || tie(a, b));
  const shortlist = [
    ...best(withCard.filter((c) => c.distinct <= 8), PREFER_SHARE, (a, b) => a.distinct - b.distinct).slice(0, 10),
    ...best(withCard.filter((c) => c.distinct > 8 && c.distinct <= 40), PREFER_BREAKDOWN, (a, b) => a.distinct - b.distinct).slice(0, 8),
    ...best(withCard.filter((c) => c.distinct > 40 && /name$/i.test(c.name)), PREFER_ENTITY, (a, b) => b.distinct - a.distinct).slice(0, 6),
  ];
  let coverage = {};
  if (shortlist.length) {
    // How much of the primary measure each column splits: the per-value values add up to the total when filters reach the facts.
    const row = (await dax(workspaceId, datasetId, `EVALUATE ROW("total", ${mRef(primary)}, ${shortlist.map((c, i) => `"c${i}", SUMX(VALUES(${cRef(c)}), ${mRef(primary)})`).join(', ')})`))[0] || {};
    const total = Number(row.total) || 0;
    shortlist.forEach((c, i) => { coverage[`${c.table}.${c.name}`] = total ? Number(row[`c${i}`]) / total : 0; });
  }
  // A column splits the measure when the per-value values add up to the total (filters reach the facts).
  const splits = (c) => Math.abs((coverage[`${c.table}.${c.name}`] ?? 0) - 1) < 0.01;
  const good = shortlist.filter(splits);
  const pick = (pred, prefer, tie = (a, b) => a.distinct - b.distinct) => best(good.filter(pred), prefer, tie)[0] || null;
  const share = pick((c) => c.distinct >= 2 && c.distinct <= 6 && fit(c, PREFER_SHARE) > 0, PREFER_SHARE);
  const breakdown = pick((c) => c.distinct >= 3 && c.distinct <= 15 && c !== share, PREFER_BREAKDOWN) || pick((c) => c.distinct >= 3 && c.distinct <= 40 && c !== share, PREFER_BREAKDOWN);
  const entity = pick((c) => c.distinct > 15 && /name$/i.test(c.name), PREFER_ENTITY, (a, b) => b.distinct - a.distinct) || pick((c) => c.distinct > 15, PREFER_ENTITY, (a, b) => b.distinct - a.distinct);
  if (!good.length) warnings.push('No category column splits the main measure; breakdown visuals were left out.');

  // Hierarchy for the detail matrix: walk from the entity table to its parent dimensions (Product -> Subcategory -> Category).
  const hierarchy = [];
  if (entity) {
    const nameCol = (table) => withCard.find((c) => c.table === table && /name$/i.test(c.name)) || withCard.find((c) => c.table === table);
    let table = entity.table;
    const chain = [entity];
    for (let i = 0; i < 3; i++) {
      const up = meta.relationships.find((r) => r.fromTable === table && r.active && r.toTable !== date?.table && !factTables.has(r.toTable));
      if (!up) break;
      const c = nameCol(up.toTable);
      if (c) chain.unshift(c);
      table = up.toTable;
    }
    if (chain.length > 1) hierarchy.push(...chain);
  }

  // Time: periods with data decide the grain (monthly up to two years, quarterly beyond).
  let time = null;
  const insights = [];
  let rows = null;
  if (date?.year) {
    const periodCol = date.monthNum || date.quarter;
    // The first candidate that really holds years (a name can mislead: "Year Offset" holds -3…0).
    const rejected = [];
    for (const cand of date.yearCandidates.slice(0, 3)) {
      const got = await dax(workspaceId, datasetId, `EVALUATE SUMMARIZECOLUMNS(${cRef(cand)}${periodCol ? `, ${cRef(periodCol)}` : ''}, "v", ${mRef(primary)}) ORDER BY ${cRef(cand)}${periodCol ? `, ${cRef(periodCol)}` : ''}`);
      if (looksLikeYears(got.map((r) => r[cand.name]))) { date.year = cand; rows = got; break; }
      rejected.push(cand.name);
    }
    if (!rows) {
      warnings.push(`${date.table} has no column with years (${rejected.join(', ')} hold other numbers), so trend visuals were left out. Add a year column to the date table.`);
      date.year = null;
    } else if (date.year.hidden) warnings.push(`The years come from ${date.table}[${date.year.name}], which is hidden in the model; the reports use it anyway.`);
  }
  if (date?.year) {
    // Facts without a matching date show as a blank year: not a period to compare.
    const years = [...new Set(rows.map((r) => r[date.year.name]))].filter((y) => y !== null && y !== undefined && y !== '');
    const perYear = new Map();
    for (const r of rows) perYear.set(r[date.year.name], (perYear.get(r[date.year.name]) || []).concat(r));
    const fullYears = years.filter((y) => (date.monthNum ? perYear.get(y).length === 12 : date.quarter ? perYear.get(y).length === 4 : true));
    const months = date.monthNum ? rows.filter((r) => years.includes(r[date.year.name])).length : null;
    const grain = !date.monthNum && !date.quarter ? 'year' : months && months <= 24 ? 'month' : date.quarter ? 'quarter' : 'month';
    const monthCol = date.monthName && date.monthName.sortBy ? date.monthName : date.monthNum;
    const axis = grain === 'year' ? [col(date.year, 'Year')] : [col(date.year, 'Year'), grain === 'quarter' ? col(date.quarter, 'Quarter') : col(monthCol, 'Month')];
    time = { table: date.table, year: col(date.year, 'Year'), axis, grain, years, fullYears, first: years[0], last: years[years.length - 1] };
    if (fullYears.length >= 2) {
      const sum = (y) => perYear.get(y).reduce((a, r) => a + (Number(r.v) || 0), 0);
      const [prev, last] = fullYears.slice(-2);
      const growth = sum(prev) ? (sum(last) - sum(prev)) / sum(prev) : null;
      if (growth !== null) insights.push({ kind: 'growth', text: `${primary.name} ${growth >= 0 ? 'grew' : 'fell'} ${Math.abs(growth * 100).toFixed(1)}% in ${last} vs ${prev}.`, value: growth });
    }
    if (years.length && fullYears.length < years.length) insights.push({ kind: 'partial', text: `Partial periods: ${years.filter((y) => !fullYears.includes(y)).join(', ')} (compare full years only).` });
  } else if (!date) warnings.push('No date table found; trend visuals were left out.');
  else if (!warnings.some((w) => w.includes('has no column with years'))) warnings.push(`${date.table} has no year column; trend visuals were left out.`);

  // Concentration insight for the share dimension.
  if (share) {
    const rows = await dax(workspaceId, datasetId, `EVALUATE TOPN(1, SUMMARIZECOLUMNS(${cRef(share)}, "v", ${mRef(primary)}), [v], DESC)`);
    const total = Number((await dax(workspaceId, datasetId, `EVALUATE ROW("t", ${mRef(primary)})`))[0]?.t) || 0;
    if (rows[0] && total) insights.push({ kind: 'share', text: `${rows[0][share.name]} drives ${Math.round((Number(rows[0].v) / total) * 100)}% of ${primary.name}.` });
  }

  const slicers = [time?.year, share ? col(share) : null].filter(Boolean);
  // Tables a date filter reaches (facts with an active relationship to the date table): rule counts on them trend by year.
  const dateLinked = date ? [...new Set(meta.relationships.filter((r) => r.active && r.toTable === date.table).map((r) => r.fromTable))] : [];
  return {
    model: { workspaceId, id: datasetId, name: modelName, tables: meta.tables.length, measures: measures.length, relationships: meta.relationships.length },
    tables: meta.tables.map((t) => t.name),
    dateLinked,
    measures: measures.map((m) => meas(m)),
    primary: meas(primary),
    kpis: kpis.map((m) => meas(m)),
    channels: channels.map((m) => meas(m, m.name.replace(new RegExp(`\\s*${primary.name.replace(/^total\s+/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '') || m.name)),
    time,
    share: share ? col(share) : null,
    breakdown: breakdown ? col(breakdown) : null,
    entity: entity ? col(entity) : null,
    hierarchy: hierarchy.map((c) => col(c)),
    slicers,
    insights,
    warnings,
  };
}
