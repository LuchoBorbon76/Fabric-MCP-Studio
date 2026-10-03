// Presets for the bundled sample datasets: business names, relationships, measures and rules from the glossary.
export const RETAIL = {
  lakehouseName: 'RetailLakehouse',
  semanticModelName: 'Retail Sales',
  ontologyName: 'Contoso_Retail_Ontology',
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

const dbo = (fromTable, fromColumn, toTable, toColumn, label, active = true) => ({
  from: { schema: 'dbo', table: fromTable, column: fromColumn },
  to: { schema: 'dbo', table: toTable, column: toColumn },
  ...(label ? { label } : {}),
  ...(active ? {} : { active: false }),
});
const IS = "'Internet Sales'";
const RS = "'Reseller Sales'";

// AdventureWorksDW2022 in a Fabric SQL database: a curated star schema over the internet and reseller channels.
export const ADVENTUREWORKS = {
  semanticModelName: 'AdventureWorks Sales',
  ontologyName: 'AdventureWorks_Ontology',
  glossaryFile: 'data/adventureworks/business-glossary.md',
  include: ['dbo.FactInternetSales', 'dbo.FactResellerSales', 'dbo.DimDate', 'dbo.DimProduct', 'dbo.DimProductSubcategory', 'dbo.DimProductCategory', 'dbo.DimCustomer', 'dbo.DimGeography', 'dbo.DimSalesTerritory', 'dbo.DimPromotion', 'dbo.DimReseller'],
  names: {
    FactInternetSales: 'Internet Sales', FactResellerSales: 'Reseller Sales', DimDate: 'Date', DimProduct: 'Product',
    DimProductSubcategory: 'Product Subcategory', DimProductCategory: 'Product Category', DimCustomer: 'Customer',
    DimGeography: 'Geography', DimSalesTerritory: 'Sales Territory', DimPromotion: 'Promotion', DimReseller: 'Reseller',
  },
  descriptions: {
    FactInternetSales: 'One product line on an online order placed by a customer on the Adventure Works website.',
    FactResellerSales: 'One product line on an order placed by a reseller through an Adventure Works sales representative.',
    DimDate: 'Calendar (2005–2014). Use CalendarYear for year comparisons; the sample\'s FiscalYear column has two 18-month years (2010 and 2011).',
    DimProduct: 'A bike, component, clothing item or accessory sold by Adventure Works.',
    DimProductSubcategory: 'A group of similar products, for example Mountain Bikes or Helmets.',
    DimProductCategory: 'Top-level product group: Bikes, Components, Clothing or Accessories.',
    DimCustomer: 'A person who buys from the Adventure Works website.',
    DimGeography: 'A city, state or province and country where customers and resellers are located.',
    DimSalesTerritory: 'A sales region, grouped into North America, Europe and Pacific.',
    DimPromotion: 'A discount offer that can apply to a sales line.',
    DimReseller: 'A bike shop, warehouse or specialty store that resells Adventure Works products.',
  },
  relationships: [
    dbo('FactInternetSales', 'ProductKey', 'DimProduct', 'ProductKey', 'Internet Sale Of Product'),
    dbo('FactInternetSales', 'CustomerKey', 'DimCustomer', 'CustomerKey', 'Internet Sale By Customer'),
    dbo('FactInternetSales', 'PromotionKey', 'DimPromotion', 'PromotionKey', 'Internet Sale With Promotion'),
    dbo('FactInternetSales', 'SalesTerritoryKey', 'DimSalesTerritory', 'SalesTerritoryKey', 'Internet Sale In Territory'),
    dbo('FactInternetSales', 'OrderDateKey', 'DimDate', 'DateKey'),
    dbo('FactInternetSales', 'DueDateKey', 'DimDate', 'DateKey', null, false),
    dbo('FactInternetSales', 'ShipDateKey', 'DimDate', 'DateKey', null, false),
    dbo('FactResellerSales', 'ProductKey', 'DimProduct', 'ProductKey', 'Reseller Sale Of Product'),
    dbo('FactResellerSales', 'ResellerKey', 'DimReseller', 'ResellerKey', 'Reseller Sale By Reseller'),
    dbo('FactResellerSales', 'PromotionKey', 'DimPromotion', 'PromotionKey', 'Reseller Sale With Promotion'),
    dbo('FactResellerSales', 'SalesTerritoryKey', 'DimSalesTerritory', 'SalesTerritoryKey', 'Reseller Sale In Territory'),
    dbo('FactResellerSales', 'OrderDateKey', 'DimDate', 'DateKey'),
    dbo('FactResellerSales', 'DueDateKey', 'DimDate', 'DateKey', null, false),
    dbo('FactResellerSales', 'ShipDateKey', 'DimDate', 'DateKey', null, false),
    dbo('DimProduct', 'ProductSubcategoryKey', 'DimProductSubcategory', 'ProductSubcategoryKey', 'Product In Subcategory'),
    dbo('DimProductSubcategory', 'ProductCategoryKey', 'DimProductCategory', 'ProductCategoryKey', 'Subcategory In Category'),
    dbo('DimCustomer', 'GeographyKey', 'DimGeography', 'GeographyKey', 'Customer Located In Geography'),
    dbo('DimReseller', 'GeographyKey', 'DimGeography', 'GeographyKey', 'Reseller Located In Geography'),
    // Inactive: sales already reach Sales Territory directly; an active path through Geography would be ambiguous.
    dbo('DimGeography', 'SalesTerritoryKey', 'DimSalesTerritory', 'SalesTerritoryKey', 'Geography In Territory', false),
  ],
  dateTable: { table: 'Date', column: 'FullDateAlternateKey' },
  measures: [
    { table: 'Internet Sales', name: 'Internet Sales Amount', expression: `SUM ( ${IS}[SalesAmount] )`, formatString: '#,0.00', displayFolder: 'Internet', description: 'Sum of SalesAmount on internet orders. The default online sales number.' },
    { table: 'Internet Sales', name: 'Internet Total Product Cost', expression: `SUM ( ${IS}[TotalProductCost] )`, formatString: '#,0.00', displayFolder: 'Internet', description: 'Standard cost of the products sold online.' },
    { table: 'Internet Sales', name: 'Internet Gross Profit', expression: '[Internet Sales Amount] - [Internet Total Product Cost]', formatString: '#,0.00', displayFolder: 'Internet', description: 'Internet Sales Amount minus Internet Total Product Cost.' },
    { table: 'Internet Sales', name: 'Internet Gross Profit Margin', expression: 'DIVIDE ( [Internet Gross Profit], [Internet Sales Amount] )', formatString: '0.0%', displayFolder: 'Internet', description: 'Internet Gross Profit ÷ Internet Sales Amount.' },
    { table: 'Internet Sales', name: 'Internet Order Quantity', expression: `SUM ( ${IS}[OrderQuantity] )`, formatString: '#,0', displayFolder: 'Internet', description: 'Units sold online.' },
    { table: 'Internet Sales', name: 'Internet Orders', expression: `DISTINCTCOUNT ( ${IS}[SalesOrderNumber] )`, formatString: '#,0', displayFolder: 'Internet', description: 'Distinct count of internet sales orders.' },
    { table: 'Internet Sales', name: 'Internet Customers', expression: `DISTINCTCOUNT ( ${IS}[CustomerKey] )`, formatString: '#,0', displayFolder: 'Internet', description: 'Customers with at least one internet sale.' },
    { table: 'Internet Sales', name: 'Internet Average Order Value', expression: 'DIVIDE ( [Internet Sales Amount], [Internet Orders] )', formatString: '#,0.00', displayFolder: 'Internet', description: 'Internet Sales Amount ÷ Internet Orders.' },
    { table: 'Internet Sales', name: 'Internet Sales Amount PY', expression: "CALCULATE ( [Internet Sales Amount], SAMEPERIODLASTYEAR ( 'Date'[FullDateAlternateKey] ) )", formatString: '#,0.00', displayFolder: 'Time Intelligence', description: 'Internet Sales Amount for the same period of the prior year.' },
    { table: 'Internet Sales', name: 'Internet Sales YoY %', expression: 'DIVIDE ( [Internet Sales Amount] - [Internet Sales Amount PY], [Internet Sales Amount PY] )', formatString: '0.0%', displayFolder: 'Time Intelligence', description: 'Year-over-year change in Internet Sales Amount.' },
    { table: 'Reseller Sales', name: 'Reseller Sales Amount', expression: `SUM ( ${RS}[SalesAmount] )`, formatString: '#,0.00', displayFolder: 'Reseller', description: 'Sum of SalesAmount on reseller orders.' },
    { table: 'Reseller Sales', name: 'Reseller Total Product Cost', expression: `SUM ( ${RS}[TotalProductCost] )`, formatString: '#,0.00', displayFolder: 'Reseller', description: 'Standard cost of the products sold to resellers.' },
    { table: 'Reseller Sales', name: 'Reseller Gross Profit', expression: '[Reseller Sales Amount] - [Reseller Total Product Cost]', formatString: '#,0.00', displayFolder: 'Reseller', description: 'Reseller Sales Amount minus Reseller Total Product Cost.' },
    { table: 'Reseller Sales', name: 'Reseller Gross Profit Margin', expression: 'DIVIDE ( [Reseller Gross Profit], [Reseller Sales Amount] )', formatString: '0.0%', displayFolder: 'Reseller', description: 'Reseller Gross Profit ÷ Reseller Sales Amount.' },
    { table: 'Reseller Sales', name: 'Reseller Order Quantity', expression: `SUM ( ${RS}[OrderQuantity] )`, formatString: '#,0', displayFolder: 'Reseller', description: 'Units sold to resellers.' },
    { table: 'Reseller Sales', name: 'Reseller Orders', expression: `DISTINCTCOUNT ( ${RS}[SalesOrderNumber] )`, formatString: '#,0', displayFolder: 'Reseller', description: 'Distinct count of reseller sales orders.' },
    { table: 'Reseller Sales', name: 'Reseller Sales Below Cost', expression: `COALESCE ( COUNTROWS ( FILTER ( ${RS}, ${RS}[SalesAmount] < ${RS}[TotalProductCost] ) ), 0 )`, formatString: '#,0', displayFolder: 'Business rules', description: 'Reseller sales lines priced below product cost (sales below cost rule).' },
    { table: 'Reseller Sales', name: 'Reseller Loss Below Cost', expression: `SUMX ( FILTER ( ${RS}, ${RS}[SalesAmount] < ${RS}[TotalProductCost] ), ${RS}[SalesAmount] - ${RS}[TotalProductCost] )`, formatString: '#,0.00', displayFolder: 'Business rules', description: 'Gross loss on reseller sales lines priced below product cost.' },
    { table: 'Reseller Sales', name: 'Discounts Needing Approval', expression: `COALESCE ( COUNTROWS ( FILTER ( ${RS}, ${RS}[UnitPriceDiscountPct] >= 0.3 ) ), 0 )`, formatString: '#,0', displayFolder: 'Business rules', description: 'Reseller sales lines with a discount of 30% or more (discount approval rule).' },
    { table: 'Internet Sales', name: 'Total Sales Amount', expression: '[Internet Sales Amount] + [Reseller Sales Amount]', formatString: '#,0.00', displayFolder: 'Total', description: 'Internet Sales Amount plus Reseller Sales Amount.' },
    { table: 'Internet Sales', name: 'Total Gross Profit', expression: '[Internet Gross Profit] + [Reseller Gross Profit]', formatString: '#,0.00', displayFolder: 'Total', description: 'Gross profit across both channels.' },
    { table: 'Internet Sales', name: 'Total Gross Profit Margin', expression: 'DIVIDE ( [Total Gross Profit], [Total Sales Amount] )', formatString: '0.0%', displayFolder: 'Total', description: 'Total Gross Profit ÷ Total Sales Amount.' },
    {
      table: 'Customer', name: 'High-Value Customers', formatString: '#,0', displayFolder: 'Business rules',
      description: 'Customers whose lifetime Internet Sales Amount is at least 5,000.',
      expression: "COALESCE ( COUNTROWS ( FILTER ( VALUES ( Customer[CustomerKey] ), CALCULATE ( [Internet Sales Amount], REMOVEFILTERS ( 'Date' ) ) >= 5000 ) ), 0 )",
    },
    {
      table: 'Product', name: 'Products Below Minimum Margin', formatString: '#,0', displayFolder: 'Business rules',
      description: 'Products whose list price is less than 50% above standard cost (minimum margin rule).',
      expression: 'COALESCE ( COUNTROWS ( FILTER ( Product, NOT ISBLANK ( Product[ListPrice] ) && NOT ISBLANK ( Product[StandardCost] ) && Product[ListPrice] < Product[StandardCost] * 1.5 ) ), 0 )',
    },
  ],
  ontology: {
    include: ['dbo.FactInternetSales', 'dbo.FactResellerSales', 'dbo.DimProduct', 'dbo.DimProductSubcategory', 'dbo.DimProductCategory', 'dbo.DimCustomer', 'dbo.DimGeography', 'dbo.DimSalesTerritory', 'dbo.DimPromotion', 'dbo.DimReseller'],
    entityNames: {
      FactInternetSales: 'InternetSale', FactResellerSales: 'ResellerSale', DimProduct: 'Product', DimProductSubcategory: 'ProductSubcategory',
      DimProductCategory: 'ProductCategory', DimCustomer: 'Customer', DimGeography: 'Geography', DimSalesTerritory: 'SalesTerritory',
      DimPromotion: 'Promotion', DimReseller: 'Reseller',
    },
    rules: [
      { name: 'MinimumMargin', statement: "A product's list price must be at least 50% above its standard cost. Products that break this rule must be reviewed by product management.", entities: [{ entity: 'Product', properties: ['ListPrice', 'StandardCost'] }] },
      { name: 'SalesBelowCost', statement: 'A reseller sale must not be priced below the cost of its products. Reseller sales below cost need approval from the sales director.', entities: [{ entity: 'ResellerSale', properties: ['SalesAmount', 'TotalProductCost'] }] },
      { name: 'DiscountApproval', statement: 'Reseller line discounts of 30 percent or more require approval from the sales director.', entities: [{ entity: 'ResellerSale', properties: ['UnitPriceDiscountPct'] }] },
      { name: 'HighValueCustomer', statement: 'A customer is high value when their lifetime internet sales amount is at least 5000.', entities: [{ entity: 'Customer' }, { entity: 'InternetSale', properties: ['SalesAmount'] }], relationships: ['Internet Sale By Customer'] },
      { name: 'DiscontinuedProduct', statement: 'A product is discontinued when its status is not Current. Discontinued products must not be sold on new orders.', entities: [{ entity: 'Product', properties: ['Status'] }] },
    ],
  },
  starterQuestions: [
    'What were total internet and reseller sales, and the gross profit margin of each channel?',
    'Why is the reseller margin so low? How much did we lose on reseller sales below cost, and which products drove it?',
    'Which product categories grew the most in calendar year 2013 compared with 2012?',
    'Who are our top 10 internet customers by sales amount, and which countries are they in?',
    'Which products break the minimum margin rule?',
  ],
};

export function presetFor(project) {
  if (project?.source?.kind === 'sample' && project.source.id === 'retail') return RETAIL;
  if (project?.source?.kind === 'sample' && project.source.id === 'adventureworks-dw') return ADVENTUREWORKS;
  return null;
}

// Business-rule metrics for the rules dashboard: which measure shows each ontology rule. A measure missing from the
// semantic model is added to the report as a report-level measure (expression below or the preset measure's DAX).
RETAIL.ruleMetrics = {
  MinimumMargin: [{ table: 'Product', name: 'Products Below Minimum Margin', label: 'Products below minimum margin', type: 'count', kind: 'violation', dataType: 'Integer', formatString: '#,0', expression: 'COALESCE ( COUNTROWS ( FILTER ( Product, Product[ListPrice] < Product[UnitCost] * 1.2 ) ), 0 )' }],
  DiscountCap: [{ table: 'Sales', name: 'Discounts Above Cap', label: 'Discounts above 20% outside Nov–Dec', type: 'count', kind: 'violation', dataType: 'Integer', formatString: '#,0', expression: 'COALESCE ( COUNTROWS ( FILTER ( Sales, Sales[DiscountPct] > 0.2 && NOT ( MONTH ( Sales[OrderDate] ) IN { 11, 12 } ) ) ), 0 )' }],
  ReturnWindow: [{ table: 'Returns', name: 'Returns Outside Window', label: 'Returns after 30 days', type: 'count', kind: 'violation', dataType: 'Integer', formatString: '#,0', expression: 'COALESCE ( COUNTROWS ( FILTER ( Returns, DATEDIFF ( RELATED ( Sales[OrderDate] ), Returns[ReturnDate], DAY ) > 30 ) ), 0 )' }],
  AtRiskCustomer: [{ table: 'Customer', name: 'At-Risk Customers', label: 'At-risk customers', type: 'count', kind: 'watch' }],
  ActiveCustomer: [{ table: 'Customer', name: 'Active Customers', label: 'Active customers', type: 'count', kind: 'segment' }],
};
ADVENTUREWORKS.ruleMetrics = {
  SalesBelowCost: [
    { table: 'Reseller Sales', name: 'Reseller Sales Below Cost', label: 'Reseller lines below cost', type: 'count', kind: 'violation', dataType: 'Integer' },
    { table: 'Reseller Sales', name: 'Reseller Loss Below Cost', label: 'Loss on sales below cost', type: 'amount', kind: 'violation', dataType: 'Decimal' },
  ],
  DiscountApproval: [{ table: 'Reseller Sales', name: 'Discounts Needing Approval', label: 'Discounts needing approval', type: 'count', kind: 'violation', dataType: 'Integer' }],
  MinimumMargin: [{ table: 'Product', name: 'Products Below Minimum Margin', label: 'Products below minimum margin', type: 'count', kind: 'violation', dataType: 'Integer' }],
  DiscontinuedProduct: [{ table: 'Product', name: 'Discontinued Products', label: 'Discontinued products', type: 'count', kind: 'watch', dataType: 'Integer', formatString: '#,0', expression: 'COALESCE ( COUNTROWS ( FILTER ( Product, Product[Status] <> "Current" ) ), 0 )' }],
  HighValueCustomer: [{ table: 'Customer', name: 'High-Value Customers', label: 'High-value customers', type: 'count', kind: 'segment', dataType: 'Integer' }],
};

/** What the UI needs from a sample preset (curated tables, business names, model name, measures, questions). */
export function presetSummary(project) {
  const p = presetFor(project);
  if (!p) return null;
  return {
    label: p === RETAIL ? 'Contoso Retail' : 'AdventureWorksDW2022',
    include: p.include || null,
    names: p.names || {},
    semanticModelName: p.semanticModelName,
    ontologyName: p.ontologyName,
    measureCount: p.measures?.length || 0,
    measureNames: (p.measures || []).map((m) => m.name),
    starterQuestions: p.starterQuestions || [],
  };
}
