---
name: fabric-demo-semantic-model
description: Demo step 2 - build the "Retail Sales" Direct Lake semantic model over the demo lakehouse with the Power BI Authoring MCP server - star schema, relationships, business measures from the glossary, descriptions, and DAX validation. Use when the user asks to create or extend the semantic model.
---

# Build the Retail Sales semantic model

## Before you start

- Read [AGENTS.md](../../../AGENTS.md) conventions and [the business glossary](../../../data/retail/business-glossary.md).
- Get `workspaceId` / `lakehouseId` from `config/demo.state.json`; confirm the six lakehouse tables exist.
- Show the target design below and wait for confirmation.

## Target design

| Table | Source | Role | Key |
|---|---|---|---|
| `Sales` | `sales` | Fact (sales line grain) | `SalesLineId` |
| `Returns` | `returns` | Fact | `ReturnId` |
| `Customer` | `customers` | Dimension | `CustomerId` |
| `Product` | `products` | Dimension | `ProductId` |
| `Store` | `stores` | Dimension | `StoreId` |
| `Date` | `dates` | Date dimension (mark as date table) | `Date` |

Relationships (single direction, many-to-one): `Sales[CustomerId]→Customer`, `Sales[ProductId]→Product`,
`Sales[StoreId]→Store`, `Sales[OrderDate]→Date[Date]`, `Returns[SalesLineId]→Sales[SalesLineId]`,
`Returns[ReturnDate]→Date[Date]` **inactive**.

## Steps

1. **Create the model.** If the Power BI Authoring server can create a new Direct Lake model on the lakehouse,
   use it. Otherwise create a minimal `SemanticModel` item with `fabric-core` (get the definition schema from
   `fabric-local` item-definitions for `semanticModel`) containing the Direct Lake expression and the six tables,
   then continue with Power BI Authoring.
2. **Connect**: “Connect to semantic model 'Retail Sales' in Fabric workspace '<workspace>'.”
3. Rename tables to business names, create relationships, mark `Date` as date table, sort `MonthName` by `MonthNumber`.
4. Create the measures below (display folders in brackets). Add a plain-English description and format string to each.
5. Hide foreign keys on facts; `summarizeBy: none` on IDs, `Year`, `MonthNumber`, `WeekOfYear`.
6. **Validate** with DAX queries and compare to the expected results below (sample data). Report any mismatch – don't silently change the definition.

## Reference measures

```dax
-- [Sales]
Gross Sales = SUMX ( Sales, Sales[Quantity] * Sales[UnitPrice] )
Net Sales = SUMX ( Sales, Sales[Quantity] * Sales[UnitPrice] * ( 1 - Sales[DiscountPct] ) )
COGS = SUMX ( Sales, Sales[Quantity] * Sales[UnitCost] )
Gross Margin = [Net Sales] - [COGS]
Gross Margin % = DIVIDE ( [Gross Margin], [Net Sales] )
Units Sold = SUM ( Sales[Quantity] )
Orders = DISTINCTCOUNT ( Sales[OrderId] )
Average Order Value = DIVIDE ( [Net Sales], [Orders] )

-- [Returns]
Units Returned = SUM ( Returns[Quantity] )
Return Rate = DIVIDE ( [Units Returned], [Units Sold] )

-- [Time Intelligence]
Net Sales PY = CALCULATE ( [Net Sales], SAMEPERIODLASTYEAR ( 'Date'[Date] ) )
Net Sales YoY % = DIVIDE ( [Net Sales] - [Net Sales PY], [Net Sales PY] )
Net Sales FYTD = TOTALYTD ( [Net Sales], 'Date'[Date], "6/30" )

-- [Customers]
Active Customers =
VAR LastSale = CALCULATE ( MAX ( Sales[OrderDate] ), REMOVEFILTERS () )
VAR AsOf = MIN ( MAX ( 'Date'[Date] ), LastSale )
RETURN CALCULATE ( DISTINCTCOUNT ( Sales[CustomerId] ), DATESINPERIOD ( 'Date'[Date], AsOf, -90, DAY ) )

At-Risk Customers =
VAR LastSale = CALCULATE ( MAX ( Sales[OrderDate] ), REMOVEFILTERS () )
VAR AsOf = MIN ( MAX ( 'Date'[Date] ), LastSale )
RETURN
    COUNTROWS (
        FILTER (
            VALUES ( Customer[CustomerId] ),
            VAR LastPurchase = CALCULATE ( MAX ( Sales[OrderDate] ), REMOVEFILTERS ( 'Date' ), 'Date'[Date] <= AsOf )
            VAR Lifetime = CALCULATE ( [Net Sales], REMOVEFILTERS ( 'Date' ), 'Date'[Date] <= AsOf )
            RETURN NOT ISBLANK ( LastPurchase ) && DATEDIFF ( LastPurchase, AsOf, DAY ) > 120 && Lifetime >= 3000
        )
    )

-- [Same-Store]
Same-Store Sales =
VAR PriorStart = EDATE ( MIN ( 'Date'[Date] ), -12 )
VAR Comparable = FILTER ( ALL ( Store[StoreId], Store[Channel], Store[OpenDate] ), Store[Channel] = "Store" && Store[OpenDate] <= PriorStart )
RETURN CALCULATE ( [Net Sales], KEEPFILTERS ( Comparable ) )

Same-Store Sales PY =
VAR PriorStart = EDATE ( MIN ( 'Date'[Date] ), -12 )
VAR Comparable = FILTER ( ALL ( Store[StoreId], Store[Channel], Store[OpenDate] ), Store[Channel] = "Store" && Store[OpenDate] <= PriorStart )
RETURN CALCULATE ( [Net Sales], KEEPFILTERS ( Comparable ), SAMEPERIODLASTYEAR ( 'Date'[Date] ) )

Same-Store Sales Growth % = DIVIDE ( [Same-Store Sales] - [Same-Store Sales PY], [Same-Store Sales PY] )
```

## Expected results (Contoso Retail sample data, seed 42)

| Check | Expected |
|---|---|
| Net Sales (all dates) | 3,849,588 |
| Gross Margin % | 37.3% |
| Orders / Average Order Value | 10,349 / 371.98 |
| Return Rate | 3.89% |
| Net Sales FY26 (Jul 2025–Jun 2026) | 1,442,081 |
| Active Customers (as of 2026-09-30) | 475 |
| At-Risk Customers (as of 2026-09-30) | 105 |
| Jan–Sep 2026 vs 2025: total growth / same-store growth | +3.8% / −12.5% |
| Central region Jan–Sep YoY | −11.6% |
