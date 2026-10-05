// Live event scenarios: what the simulator streams for the project's data. Each scenario defines the Eventhouse table
// (columns with roles the dashboard builder understands), loads reference data from the project's source or semantic
// model, and makes realistic events – real keys, names and prices – with an adjustable share of business-rule breaks.
import { withPool } from '../sql.mjs';
import { dax, modelMetadata } from '../powerbi.mjs';
import { getProject } from '../project.mjs';
import { presetFor, ADVENTUREWORKS, RETAIL } from '../presets.mjs';

const rnd = Math.random;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const round2 = (x) => Math.round(x * 100) / 100;

/** Weighted picker over items with a numeric weight (built once, O(log n) per draw). */
function weighted(items, weightOf) {
  const list = items.filter((x) => weightOf(x) > 0);
  if (!list.length) return () => pick(items);
  const cum = [];
  let total = 0;
  for (const x of list) { total += weightOf(x); cum.push(total); }
  return () => {
    const r = rnd() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
    return list[lo];
  };
}

function orderId(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.floor(rnd() * 1296).toString(36).toUpperCase().padStart(2, '0')}`;
}

const col = (name, type, role, label) => ({ name, type, ...(role ? { role } : {}), ...(label ? { label } : {}) });

// ---------------- AdventureWorks (AdventureWorksDW2022 sample) ----------------

const AW_COLUMNS = [
  col('EventTime', 'datetime', 'time', 'Time'),
  col('OrderId', 'string', 'order', 'Order'),
  col('Channel', 'string', 'channel', 'Channel'),
  col('ProductKey', 'long', 'itemKey', 'Product key'),
  col('Product', 'string', 'item', 'Product'),
  col('Category', 'string', 'group', 'Product category'),
  col('Subcategory', 'string', 'subgroup', 'Product subcategory'),
  col('CustomerKey', 'long', 'partyKey', 'Customer key'),
  col('ResellerKey', 'long', null, 'Reseller key'),
  col('Buyer', 'string', 'party', 'Customer or reseller'),
  col('SalesTerritoryKey', 'long', 'regionKey', 'Sales territory key'),
  col('Region', 'string', 'region', 'Sales territory'),
  col('Country', 'string', 'country', 'Country'),
  col('TerritoryGroup', 'string', null, 'Territory group'),
  col('Quantity', 'int', 'qty', 'Quantity'),
  col('UnitPrice', 'real', 'price', 'Unit price'),
  col('DiscountPct', 'real', 'discount', 'Discount'),
  col('SalesAmount', 'real', 'amount', 'Sales amount'),
  col('ProductCost', 'real', 'cost', 'Product cost'),
  col('Margin', 'real', 'margin', 'Margin'),
  col('RuleBreak', 'string', 'rule', 'Business rule broken'),
  col('Source', 'string', 'source', 'Source'),
];

async function loadAdventureWorks(ms) {
  return withPool({ server: ms.server, database: ms.database }, async (pool) => {
    const q = async (text) => (await pool.request().query(text)).recordset;
    const products = await q(`
      SELECT p.ProductKey, p.EnglishProductName AS Product, sc.EnglishProductSubcategoryName AS Subcategory,
             c.EnglishProductCategoryName AS Category, CAST(p.ListPrice AS float) AS ListPrice,
             CAST(ISNULL(p.DealerPrice, p.ListPrice * 0.6) AS float) AS DealerPrice, CAST(p.StandardCost AS float) AS StandardCost,
             ISNULL(i.Qty, 0) AS InternetQty, ISNULL(r.Qty, 0) AS ResellerQty
      FROM dbo.DimProduct p
      JOIN dbo.DimProductSubcategory sc ON sc.ProductSubcategoryKey = p.ProductSubcategoryKey
      JOIN dbo.DimProductCategory c ON c.ProductCategoryKey = sc.ProductCategoryKey
      LEFT JOIN (SELECT ProductKey, SUM(OrderQuantity) AS Qty FROM dbo.FactInternetSales GROUP BY ProductKey) i ON i.ProductKey = p.ProductKey
      LEFT JOIN (SELECT ProductKey, SUM(OrderQuantity) AS Qty FROM dbo.FactResellerSales GROUP BY ProductKey) r ON r.ProductKey = p.ProductKey
      WHERE p.ListPrice IS NOT NULL AND p.StandardCost IS NOT NULL AND (i.Qty > 0 OR r.Qty > 0)`);
    const territories = await q(`SELECT SalesTerritoryKey, SalesTerritoryRegion AS Region, SalesTerritoryCountry AS Country, SalesTerritoryGroup AS TerritoryGroup
      FROM dbo.DimSalesTerritory WHERE SalesTerritoryRegion <> 'NA'`);
    const customers = await q(`SELECT TOP 4000 c.CustomerKey, CONCAT(c.FirstName, ' ', c.LastName) AS Name, g.SalesTerritoryKey
      FROM dbo.DimCustomer c JOIN dbo.DimGeography g ON g.GeographyKey = c.GeographyKey ORDER BY NEWID()`);
    const resellers = await q(`SELECT r.ResellerKey, r.ResellerName AS Name, g.SalesTerritoryKey
      FROM dbo.DimReseller r JOIN dbo.DimGeography g ON g.GeographyKey = r.GeographyKey`);
    if (!products.length || !territories.length) throw new Error('The AdventureWorks tables are empty – load the sample data first.');
    return { products, territories, customers, resellers };
  });
}

function adventureWorks(ref) {
  const terr = new Map(ref.territories.map((t) => [t.SalesTerritoryKey, t]));
  const customers = ref.customers.filter((c) => terr.has(c.SalesTerritoryKey));
  const resellers = ref.resellers.filter((r) => terr.has(r.SalesTerritoryKey));
  const internetProduct = weighted(ref.products, (p) => p.InternetQty);
  const resellerProduct = weighted(ref.products, (p) => p.ResellerQty);
  return {
    id: 'adventureworks', label: 'AdventureWorks sales', table: 'SalesEvents', columns: AW_COLUMNS,
    description: 'Internet and reseller order lines with real products, customers, resellers, territories and prices.',
    unit: 'sales line',
    rules: [
      { id: 'DiscountApproval', label: 'Discount needs approval', description: 'Reseller line with a discount of 30% or more.' },
      { id: 'SalesBelowCost', label: 'Sold below cost', description: 'Sales amount lower than the product cost.' },
    ],
    references: { products: ref.products.length, customers: customers.length, resellers: resellers.length, territories: ref.territories.length },
    makeOrder(at, { ruleBreakPct = 3 } = {}) {
      const internet = rnd() < 0.62 || !resellers.length;
      const lines = [];
      const id = orderId(internet ? 'SO-I' : 'SO-R');
      if (internet) {
        const c = pick(customers);
        const t = terr.get(c.SalesTerritoryKey);
        const n = 1 + Math.floor(rnd() * rnd() * 4);
        for (let i = 0; i < n; i++) {
          const p = internetProduct();
          lines.push(line(at, id, 'Internet', p, { CustomerKey: c.CustomerKey, Buyer: c.Name }, t, 1, p.ListPrice, 0));
        }
      } else {
        const r = pick(resellers);
        const t = terr.get(r.SalesTerritoryKey);
        const n = 1 + Math.floor(rnd() * 6);
        for (let i = 0; i < n; i++) {
          const p = resellerProduct();
          const qty = 1 + Math.floor(rnd() * rnd() * 14);
          // Dealer price, kept above cost unless this line breaks a rule (the share of rule breaks is the user's setting).
          let price = p.DealerPrice > p.StandardCost * 1.02 ? p.DealerPrice : p.StandardCost * (1.05 + rnd() * 0.15);
          const fits = (d) => price * (1 - d) > p.StandardCost * 1.02;
          let disc = qty >= 11 && fits(0.02) ? 0.02 : 0;
          const u = rnd();
          if (u < ruleBreakPct / 200) disc = [0.3, 0.35, 0.4][Math.floor(rnd() * 3)];
          else if (u < ruleBreakPct / 100) price = p.StandardCost * (0.85 + rnd() * 0.12);
          else if (u < ruleBreakPct / 100 + 0.06) { const d = [0.05, 0.1][Math.floor(rnd() * 2)]; if (fits(d)) disc = Math.max(disc, d); }
          lines.push(line(at, id, 'Reseller', p, { ResellerKey: r.ResellerKey, Buyer: r.Name }, t, qty, price, disc));
        }
      }
      return lines;
    },
  };
  function line(at, id, channel, p, buyer, t, qty, price, disc) {
    const amount = round2(qty * price * (1 - disc));
    const cost = round2(qty * p.StandardCost);
    const rule = disc >= 0.3 ? 'Discount needs approval' : amount < cost ? 'Sold below cost' : '';
    return {
      EventTime: at.toISOString(), OrderId: id, Channel: channel, ProductKey: p.ProductKey, Product: p.Product, Category: p.Category, Subcategory: p.Subcategory,
      CustomerKey: buyer.CustomerKey ?? null, ResellerKey: buyer.ResellerKey ?? null, Buyer: buyer.Buyer,
      SalesTerritoryKey: t.SalesTerritoryKey, Region: t.Region, Country: t.Country, TerritoryGroup: t.TerritoryGroup,
      Quantity: qty, UnitPrice: round2(price), DiscountPct: disc, SalesAmount: amount, ProductCost: cost, Margin: round2(amount - cost),
      RuleBreak: rule, Source: 'Studio simulator',
    };
  }
}

// ---------------- Contoso Retail sample ----------------

const RETAIL_COLUMNS = [
  col('EventTime', 'datetime', 'time', 'Time'),
  col('OrderId', 'string', 'order', 'Order'),
  col('Channel', 'string', 'channel', 'Channel'),
  col('ProductId', 'string', 'itemKey', 'Product ID'),
  col('Product', 'string', 'item', 'Product'),
  col('Category', 'string', 'group', 'Category'),
  col('Subcategory', 'string', 'subgroup', 'Subcategory'),
  col('Brand', 'string', null, 'Brand'),
  col('CustomerId', 'string', 'partyKey', 'Customer ID'),
  col('Customer', 'string', 'party', 'Customer'),
  col('Segment', 'string', null, 'Segment'),
  col('StoreId', 'string', 'regionKey', 'Store ID'),
  col('Store', 'string', 'site', 'Store'),
  col('Region', 'string', 'region', 'Region'),
  col('Quantity', 'int', 'qty', 'Quantity'),
  col('UnitPrice', 'real', 'price', 'Unit price'),
  col('DiscountPct', 'real', 'discount', 'Discount'),
  col('SalesAmount', 'real', 'amount', 'Net sales'),
  col('ProductCost', 'real', 'cost', 'Cost of goods sold'),
  col('Margin', 'real', 'margin', 'Gross margin'),
  col('RuleBreak', 'string', 'rule', 'Business rule broken'),
  col('Source', 'string', 'source', 'Source'),
];

async function loadRetail(ms) {
  return withPool({ server: ms.server, database: ms.database }, async (pool) => {
    const q = async (text) => (await pool.request().query(text)).recordset;
    const products = await q(`SELECT p.ProductId, p.ProductName, p.Category, p.Subcategory, p.Brand, CAST(p.UnitCost AS float) AS UnitCost, CAST(p.ListPrice AS float) AS ListPrice, ISNULL(s.Qty, 0) AS Qty
      FROM dbo.products p LEFT JOIN (SELECT ProductId, SUM(Quantity) AS Qty FROM dbo.sales GROUP BY ProductId) s ON s.ProductId = p.ProductId`);
    const customers = await q('SELECT TOP 3000 CustomerId, CustomerName, Segment, Region FROM dbo.customers ORDER BY NEWID()');
    const stores = await q('SELECT StoreId, StoreName, Channel, Region FROM dbo.stores');
    if (!products.length || !stores.length) throw new Error('The Contoso Retail tables are empty – load the sample data first.');
    return { products, customers, stores };
  });
}

function retail(ref) {
  const product = weighted(ref.products, (p) => p.Qty + 1);
  const physical = ref.stores.filter((s) => s.Channel !== 'Online');
  const online = ref.stores.filter((s) => s.Channel === 'Online');
  return {
    id: 'retail', label: 'Contoso Retail sales', table: 'SalesEvents', columns: RETAIL_COLUMNS,
    description: 'Store and online order lines with real products, customers, stores and prices.',
    unit: 'sales line',
    rules: [
      { id: 'DiscountCap', label: 'Discount above cap', description: 'Discount above 20% outside November and December.' },
      { id: 'BelowCost', label: 'Sold below cost', description: 'Net sales lower than the cost of goods sold.' },
    ],
    references: { products: ref.products.length, customers: ref.customers.length, stores: ref.stores.length },
    makeOrder(at, { ruleBreakPct = 3 } = {}) {
      const c = pick(ref.customers);
      const isOnline = online.length && rnd() < 0.3;
      const local = physical.filter((s) => s.Region === c.Region);
      const store = isOnline ? pick(online) : pick(local.length ? local : physical);
      const id = orderId('SO-');
      const n = 1 + Math.floor(rnd() * rnd() * 5);
      const holiday = [10, 11].includes(at.getUTCMonth());
      return Array.from({ length: n }, () => {
        const p = product();
        const qty = 1 + Math.floor(rnd() * rnd() * 4);
        let disc = rnd() < 0.7 ? 0 : [0.05, 0.1, 0.15][Math.floor(rnd() * 3)];
        if (rnd() < ruleBreakPct / 100) disc = [0.25, 0.3, 0.35][Math.floor(rnd() * 3)];
        const amount = round2(qty * p.ListPrice * (1 - disc));
        const cost = round2(qty * p.UnitCost);
        const rule = disc > 0.2 && !holiday ? 'Discount above cap' : amount < cost ? 'Sold below cost' : '';
        return {
          EventTime: at.toISOString(), OrderId: id, Channel: isOnline ? 'Online' : 'Store', ProductId: p.ProductId, Product: p.ProductName, Category: p.Category,
          Subcategory: p.Subcategory, Brand: p.Brand, CustomerId: c.CustomerId, Customer: c.CustomerName, Segment: c.Segment, StoreId: store.StoreId, Store: store.StoreName,
          Region: store.Region, Quantity: qty, UnitPrice: round2(p.ListPrice), DiscountPct: disc, SalesAmount: amount, ProductCost: cost, Margin: round2(amount - cost),
          RuleBreak: rule, Source: 'Studio simulator',
        };
      });
    },
  };
}

// ---------------- any semantic model ----------------

const safeName = (s, fallback) => {
  let n = String(s || '').replace(/[^A-Za-z0-9_]+/g, ' ').trim().split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  if (!n || !/^[A-Za-z]/.test(n)) n = fallback;
  return n.slice(0, 60);
};
const daxCol = (c) => `'${c.table.replace(/'/g, "''")}'[${c.name.replace(/]/g, ']]')}]`;
const daxMeasure = (m) => `[${m.name.replace(/]/g, ']]')}]`;

/** The table a measure aggregates: first table referenced by its expression, following measure references. */
function factTableOf(measureName, meta, seen = new Set()) {
  if (seen.has(measureName)) return null;
  seen.add(measureName);
  const m = meta.measures.find((x) => x.name === measureName);
  if (!m) return null;
  const tables = new Set(meta.tables.map((t) => t.name));
  for (const hit of m.expression.matchAll(/'([^']+)'\s*\[|\b([A-Za-z_][A-Za-z0-9_]*)\s*\[/g)) {
    const t = hit[1] || hit[2];
    if (tables.has(t)) return t;
  }
  for (const hit of m.expression.matchAll(/\[([^\]]+)\]/g)) {
    const t = factTableOf(hit[1], meta, seen);
    if (t) return t;
  }
  return null;
}

async function loadGeneric(project, profile) {
  const ws = project.semanticModel.workspaceId || project.workspace.id, sm = project.semanticModel.id;
  const meta = await modelMetadata(ws, sm);
  const dims = [];
  for (const [role, c] of [['item', profile.entity], ['group', profile.breakdown], ['region', profile.share]]) {
    if (c?.kind === 'column' && !dims.some((d) => d.table === c.table && d.name === c.name)) dims.push({ ...c, role });
  }
  const fact = factTableOf(profile.primary.name, meta)
    || Object.entries(meta.relationships.reduce((a, r) => ({ ...a, [r.fromTable]: (a[r.fromTable] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const cols = dims.map(daxCol).join(', ');
  const measures = `"__v", ${daxMeasure(profile.primary)}${fact ? `, "__n", COUNTROWS ( '${fact.replace(/'/g, "''")}' )` : ''}`;
  const rows = dims.length
    ? await dax(ws, sm, `EVALUATE TOPN ( 600, SUMMARIZECOLUMNS ( ${cols}, ${measures} ), [__v], DESC )`)
    : await dax(ws, sm, `EVALUATE ROW ( ${measures} )`);
  const combos = rows.map((r) => ({ values: dims.map((d) => r[d.name] ?? ''), v: Number(r.__v) || 0, n: Number(r.__n) || 0 })).filter((c) => c.v > 0);
  if (!combos.length) throw new Error(`${profile.primary.label} has no values to base live events on.`);
  let channels = [];
  if (profile.channels?.length > 1) {
    const r = await dax(ws, sm, `EVALUATE ROW ( ${profile.channels.map((m, i) => `"c${i}", ${daxMeasure(m)}`).join(', ')} )`);
    channels = profile.channels.map((m, i) => ({ label: m.label, w: Math.max(0, Number(r[0]?.[`c${i}`]) || 0) })).filter((c) => c.w > 0);
  }
  return { dims, combos, channels, fact };
}

function generic(ref, profile) {
  const used = new Set(['EventTime', 'EventId', 'Channel', 'RuleBreak', 'Source']);
  const uniq = (n) => { let x = n, i = 2; while (used.has(x)) x = `${n}${i++}`; used.add(x); return x; };
  const dimCols = ref.dims.map((d) => ({ ...d, col: uniq(safeName(d.label || d.name, d.role === 'item' ? 'Item' : d.role === 'group' ? 'Group' : 'Region')) }));
  const amountCol = uniq(safeName(profile.primary.label, 'Amount'));
  const columns = [
    col('EventTime', 'datetime', 'time', 'Time'),
    col('EventId', 'string', 'order', 'Event'),
    ...(ref.channels.length ? [col('Channel', 'string', 'channel', 'Channel')] : []),
    ...dimCols.map((d) => col(d.col, 'string', d.role, d.label)),
    col(amountCol, 'real', 'amount', profile.primary.label),
    col('RuleBreak', 'string', 'rule', 'Exception'),
    col('Source', 'string', 'source', 'Source'),
  ];
  // Typical event value from the rows the measure's table holds; combinations without rows there are weighted by value.
  const counted = ref.combos.filter((c) => c.n > 0);
  const avg = counted.length ? counted.reduce((a, c) => a + c.v, 0) / counted.reduce((a, c) => a + c.n, 0) : ref.combos.reduce((a, c) => a + c.v, 0) / 5000;
  const combo = weighted(ref.combos, (c) => c.n || c.v / avg);
  const channel = ref.channels.length ? weighted(ref.channels, (c) => c.w) : null;
  return {
    id: 'generic', label: `${profile.primary.label} events`, table: 'BusinessEvents', columns,
    description: `Events shaped like your ${profile.primary.label} data${dimCols.length ? ` by ${dimCols.map((d) => d.label.toLowerCase()).join(', ')}` : ''}.`,
    unit: 'event',
    rules: [{ id: 'UnusualValue', label: 'Unusual value', description: `An event whose ${profile.primary.label} is far above the usual range.` }],
    references: { combinations: ref.combos.length, ...(ref.fact ? { table: ref.fact } : {}) },
    makeOrder(at, { ruleBreakPct = 3 } = {}) {
      const c = combo();
      const base = c.n ? c.v / c.n : avg;
      const jitter = Math.exp((rnd() + rnd() + rnd() - 1.5) * 0.6);
      const unusual = rnd() < ruleBreakPct / 100;
      const e = { EventTime: at.toISOString(), EventId: orderId('EV-') };
      if (channel) e.Channel = channel().label;
      dimCols.forEach((d, i) => { e[d.col] = String(c.values[i] ?? ''); });
      e[amountCol] = round2(base * jitter * (unusual ? 4 + rnd() * 3 : 1));
      e.RuleBreak = unusual ? 'Unusual value' : '';
      e.Source = 'Studio simulator';
      return [e];
    },
  };
}

// ---------------- entry point ----------------

/** Which scenario fits the project (without loading data). */
export function scenarioKind(project = getProject()) {
  const preset = presetFor(project);
  if (preset === ADVENTUREWORKS) return 'adventureworks';
  if (preset === RETAIL) return 'retail';
  return project.semanticModel ? 'generic' : null;
}

/** Build the scenario for the project: loads reference data (SQL source for the samples, DAX for other models). */
export async function loadScenario(project = getProject(), { profile } = {}) {
  const kind = scenarioKind(project);
  if (kind === 'adventureworks') return adventureWorks(await loadAdventureWorks(project.modelSource));
  if (kind === 'retail') return retail(await loadRetail(project.modelSource));
  if (kind === 'generic') {
    if (!profile) throw new Error('Read the semantic model first.');
    return generic(await loadGeneric(project, profile), profile);
  }
  throw new Error('Load data and create the semantic model first – live events are shaped like your data.');
}

/** `.create-merge table` for a scenario's columns. */
export function tableCommand(s) {
  return `.create-merge table ${s.table} (${s.columns.map((c) => `${c.name}: ${c.type}`).join(', ')})`;
}

/** Column role -> column name. */
export function roles(s) {
  return Object.fromEntries(s.columns.filter((c) => c.role).map((c) => [c.role, c.name]));
}

/** What the UI and Copilot may see about a scenario (no reference data). */
export function scenarioSummary(s) {
  return { id: s.id, label: s.label, table: s.table, description: s.description, unit: s.unit, rules: s.rules, references: s.references, columns: s.columns.map(({ name, type, role, label }) => ({ name, type, role, label })) };
}
