// Presets for the bundled sample datasets: business names, relationships, measures and rules from the glossary.
export const RETAIL = {
  lakehouseName: 'RetailLakehouse',
  semanticModelName: 'Retail Sales',
  ontologyName: 'Contoso Retail Ontology',
  glossaryFile: 'data/retail/business-glossary.md',
  names: { customers: 'Customer', products: 'Product', stores: 'Store', sales: 'Sales', returns: 'Returns', dates: 'Date' },
  descriptions: {
    customers: 'A person or business with a Contoso Retail account, classified by segment and loyalty tier.',
    products: 'A sellable item (SKU) classified by category, subcategory and brand.',
    stores: 'A point of sale. Physical stores belong to a sales region; online channels belong to the Digital region.',
    sales: 'One product on one customer order, at one store, on one date.',
    returns: 'Units from a single sales line that a customer brought back.',
    dates: 'Calendar and fiscal calendar (fiscal year starts July 1).',
  },
  relationships: [
    { from: { schema: 'dbo', table: 'sales', column: 'CustomerId' }, to: { schema: 'dbo', table: 'customers', column: 'CustomerId' }, label: 'Sale By Customer' },
    { from: { schema: 'dbo', table: 'sales', column: 'ProductId' }, to: { schema: 'dbo', table: 'products', column: 'ProductId' }, label: 'Sale Of Product' },
    { from: { schema: 'dbo', table: 'sales', column: 'StoreId' }, to: { schema: 'dbo', table: 'stores', column: 'StoreId' }, label: 'Sale At Store' },
    { from: { schema: 'dbo', table: 'sales', column: 'OrderDate' }, to: { schema: 'dbo', table: 'dates', column: 'Date' } },
    { from: { schema: 'dbo', table: 'returns', column: 'SalesLineId' }, to: { schema: 'dbo', table: 'sales', column: 'SalesLineId' }, label: 'Return Of Sale' },
    { from: { schema: 'dbo', table: 'returns', column: 'ReturnDate' }, to: { schema: 'dbo', table: 'dates', column: 'Date' }, active: false },
  ],
  dateTable: { table: 'Date', column: 'Date' },
  measures: [
    { table: 'Sales', name: 'Gross Sales', expression: 'SUMX ( Sales, Sales[Quantity] * Sales[UnitPrice] )', formatString: '#,0.00', displayFolder: 'Sales', description: 'Quantity × unit price before discounts.' },
    { table: 'Sales', name: 'Net Sales', expression: 'SUMX ( Sales, Sales[Quantity] * Sales[UnitPrice] * ( 1 - Sales[DiscountPct] ) )', formatString: '#,0.00', displayFolder: 'Sales', description: 'Quantity × unit price × (1 − discount). The default sales/revenue number.' },
    { table: 'Sales', name: 'COGS', expression: 'SUMX ( Sales, Sales[Quantity] * Sales[UnitCost] )', formatString: '#,0.00', displayFolder: 'Sales', description: 'Cost of goods sold: quantity × unit cost.' },
    { table: 'Sales', name: 'Gross Margin', expression: '[Net Sales] - [COGS]', formatString: '#,0.00', displayFolder: 'Sales', description: 'Net Sales minus COGS.' },
    { table: 'Sales', name: 'Gross Margin %', expression: 'DIVIDE ( [Gross Margin], [Net Sales] )', formatString: '0.0%', displayFolder: 'Sales', description: 'Gross Margin ÷ Net Sales.' },
    { table: 'Sales', name: 'Units Sold', expression: 'SUM ( Sales[Quantity] )', formatString: '#,0', displayFolder: 'Sales', description: 'Sum of quantity sold.' },
    { table: 'Sales', name: 'Orders', expression: 'DISTINCTCOUNT ( Sales[OrderId] )', formatString: '#,0', displayFolder: 'Sales', description: 'Distinct count of orders.' },
    { table: 'Sales', name: 'Average Order Value', expression: 'DIVIDE ( [Net Sales], [Orders] )', formatString: '#,0.00', displayFolder: 'Sales', description: 'Net Sales ÷ Orders.' },
    { table: 'Returns', name: 'Units Returned', expression: 'SUM ( Returns[Quantity] )', formatString: '#,0', displayFolder: 'Returns', description: 'Sum of returned quantity.' },
    { table: 'Returns', name: 'Return Rate', expression: 'DIVIDE ( [Units Returned], [Units Sold] )', formatString: '0.00%', displayFolder: 'Returns', description: 'Units Returned ÷ Units Sold.' },
    { table: 'Sales', name: 'Net Sales PY', expression: "CALCULATE ( [Net Sales], SAMEPERIODLASTYEAR ( 'Date'[Date] ) )", formatString: '#,0.00', displayFolder: 'Time Intelligence', description: 'Net Sales for the same period of the prior year.' },
    { table: 'Sales', name: 'Net Sales YoY %', expression: 'DIVIDE ( [Net Sales] - [Net Sales PY], [Net Sales PY] )', formatString: '0.0%', displayFolder: 'Time Intelligence', description: 'Year-over-year change in Net Sales.' },
    { table: 'Sales', name: 'Net Sales FYTD', expression: "TOTALYTD ( [Net Sales], 'Date'[Date], \"6/30\" )", formatString: '#,0.00', displayFolder: 'Time Intelligence', description: 'Fiscal year-to-date Net Sales (fiscal year starts July 1).' },
    {
      table: 'Customer', name: 'Active Customers', formatString: '#,0', displayFolder: 'Customers',
      description: 'Customers with at least one purchase in the last 90 days.',
      expression: "VAR LastSale = CALCULATE ( MAX ( Sales[OrderDate] ), REMOVEFILTERS () )\nVAR AsOf = MIN ( MAX ( 'Date'[Date] ), LastSale )\nRETURN CALCULATE ( DISTINCTCOUNT ( Sales[CustomerId] ), DATESINPERIOD ( 'Date'[Date], AsOf, -90, DAY ) )",
    },
    {
      table: 'Customer', name: 'At-Risk Customers', formatString: '#,0', displayFolder: 'Customers',
      description: 'Customers with no purchase in the last 120 days and lifetime Net Sales of at least 3,000.',
      expression: "VAR LastSale = CALCULATE ( MAX ( Sales[OrderDate] ), REMOVEFILTERS () )\nVAR AsOf = MIN ( MAX ( 'Date'[Date] ), LastSale )\nRETURN\n    COUNTROWS (\n        FILTER (\n            VALUES ( Customer[CustomerId] ),\n            VAR LastPurchase = CALCULATE ( MAX ( Sales[OrderDate] ), REMOVEFILTERS ( 'Date' ), 'Date'[Date] <= AsOf )\n            VAR Lifetime = CALCULATE ( [Net Sales], REMOVEFILTERS ( 'Date' ), 'Date'[Date] <= AsOf )\n            RETURN NOT ISBLANK ( LastPurchase ) && DATEDIFF ( LastPurchase, AsOf, DAY ) > 120 && Lifetime >= 3000\n        )\n    )",
    },
    {
      table: 'Store', name: 'Same-Store Sales', formatString: '#,0.00', displayFolder: 'Same-Store',
      description: 'Net Sales from physical stores open for the whole comparison period and the same period of the prior year.',
      expression: "VAR PriorStart = EDATE ( MIN ( 'Date'[Date] ), -12 )\nVAR Comparable = FILTER ( ALL ( Store[StoreId], Store[Channel], Store[OpenDate] ), Store[Channel] = \"Store\" && Store[OpenDate] <= PriorStart )\nRETURN CALCULATE ( [Net Sales], KEEPFILTERS ( Comparable ) )",
    },
    {
      table: 'Store', name: 'Same-Store Sales PY', formatString: '#,0.00', displayFolder: 'Same-Store',
      description: 'Same-Store Sales for the same period of the prior year.',
      expression: "VAR PriorStart = EDATE ( MIN ( 'Date'[Date] ), -12 )\nVAR Comparable = FILTER ( ALL ( Store[StoreId], Store[Channel], Store[OpenDate] ), Store[Channel] = \"Store\" && Store[OpenDate] <= PriorStart )\nRETURN CALCULATE ( [Net Sales], KEEPFILTERS ( Comparable ), SAMEPERIODLASTYEAR ( 'Date'[Date] ) )",
    },
    { table: 'Store', name: 'Same-Store Sales Growth %', expression: 'DIVIDE ( [Same-Store Sales] - [Same-Store Sales PY], [Same-Store Sales PY] )', formatString: '0.0%', displayFolder: 'Same-Store', description: 'Year-over-year change in Same-Store Sales.' },
  ],
  ontology: {
    exclude: ['dates'],
    entityNames: { customers: 'Customer', products: 'Product', stores: 'Store', sales: 'Sale', returns: 'ProductReturn' },
    rules: [
      { name: 'MinimumMargin', statement: "A product's list price must be at least 20% above its unit cost. Products that break this rule must be reviewed by Merchandising.", entities: [{ entity: 'Product', properties: ['UnitCost', 'ListPrice'] }] },
      { name: 'ReturnWindow', statement: 'A product return is valid only if its return date is within 30 days of the order date of the sale it references. Returns outside the window require a manager override.', entities: [{ entity: 'ProductReturn', properties: ['ReturnDate'] }, { entity: 'Sale', properties: ['OrderDate'] }], relationships: ['Return Of Sale'] },
      { name: 'DiscountCap', statement: 'Line discounts above 20% are allowed only for sales with an order date in November or December.', entities: [{ entity: 'Sale', properties: ['DiscountPct', 'OrderDate'] }] },
      { name: 'AtRiskCustomer', statement: 'A customer is at risk when they have made no purchase in the last 120 days and their lifetime net sales (quantity times unit price times one minus discount) are at least 3000.', entities: [{ entity: 'Customer' }, { entity: 'Sale', properties: ['OrderDate', 'Quantity', 'UnitPrice', 'DiscountPct'] }], relationships: ['Sale By Customer'] },
      { name: 'ActiveCustomer', statement: 'A customer is active when they have made at least one purchase in the last 90 days.', entities: [{ entity: 'Customer' }, { entity: 'Sale', properties: ['OrderDate'] }], relationships: ['Sale By Customer'] },
    ],
  },
  starterQuestions: [
    'What were total net sales and gross margin %?',
    'How did same-store sales growth compare with total growth for January to September 2026 versus 2025?',
    'How many at-risk customers do we have, what does at-risk mean, and which region should a win-back campaign start in?',
    'Which region is declining this year and by how much?',
    'Which products break the minimum margin rule?',
  ],
};

export const ADVENTUREWORKS = {
  semanticModelName: 'AdventureWorks Sales',
  ontologyName: 'AdventureWorks Ontology',
  starterQuestions: [
    'What is total revenue (TotalDue) by product category?',
    'Who are the top 10 customers by revenue?',
    'Which products have never been ordered?',
  ],
};

export function presetFor(project) {
  if (project?.source?.kind === 'sample' && project.source.id === 'retail') return RETAIL;
  if (project?.source?.id === 'adventureworks-azuresql') return ADVENTUREWORKS;
  return null;
}
