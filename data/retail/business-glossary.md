# Contoso Retail – Business Glossary

> Source document for the **glossary → ontology** demo. The agent reads this file and turns
> each definition into ontology entity descriptions, metrics, and business rules.
> All data in this repo is synthetic.

## Entities

| Term | Definition |
|---|---|
| **Customer** | A person or business that has an account with Contoso Retail. Identified by `CustomerId`. Belongs to one *Segment* (Consumer, Small Business, Corporate) and one *Loyalty Tier* (Bronze, Silver, Gold, Platinum). |
| **Product** | A sellable item (SKU) in the catalog. Identified by `ProductId`. Classified by *Category* and *Subcategory* and sold under one *Brand*. |
| **Store** | A point of sale. Physical stores belong to a sales *Region* (West, Central, South, East). The two online channels (Online Web, Online App) belong to the *Digital* region. |
| **Sale** (sales line) | One product on one customer order, at one store, on one date. An *Order* is the set of sales lines that share an `OrderId`. |
| **Return** | Units from a single sales line that the customer brought back. A return always references exactly one sales line. |

## Measures

| Term | Definition |
|---|---|
| **Gross Sales** | `Quantity × UnitPrice` before discounts. |
| **Net Sales** | `Quantity × UnitPrice × (1 − DiscountPct)`. The default "sales" or "revenue" number. |
| **Cost of Goods Sold (COGS)** | `Quantity × UnitCost`. |
| **Gross Margin** | `Net Sales − COGS`. |
| **Gross Margin %** | `Gross Margin ÷ Net Sales`. |
| **Orders** | Distinct count of `OrderId`. |
| **Average Order Value (AOV)** | `Net Sales ÷ Orders`. |
| **Units Sold** | Sum of `Quantity`. |
| **Units Returned** | Sum of returned `Quantity`. |
| **Return Rate** | `Units Returned ÷ Units Sold`. |
| **Same-Store Sales** | Net Sales from physical stores that were open for the **entire** comparison period and the same period of the prior year. Stores opened during either period are excluded. Online channels are excluded. |
| **Same-Store Sales Growth %** | Year-over-year change in Same-Store Sales. |

## Customer classifications

| Term | Definition |
|---|---|
| **Active Customer** | A customer with at least one purchase in the **last 90 days**. |
| **At-Risk Customer** | A customer with **no purchase in the last 120 days** whose **lifetime Net Sales are at least 3,000**. These customers are prioritized for win-back campaigns. |
| **New Customer** | A customer whose first purchase falls in the selected period. |

## Business rules

1. **Minimum margin** – A product's `ListPrice` must be at least **20% above** its `UnitCost`. Products that break this rule must be reviewed by Merchandising.
2. **Return window** – A return is only valid if `ReturnDate` is **within 30 days** of the sale's `OrderDate`. Returns outside the window require a manager override.
3. **Discount cap** – Line discounts above **20%** are only allowed in November and December (holiday promotions).
4. **Fiscal calendar** – The fiscal year starts on **July 1** (for example, FY26 = July 1, 2025 – June 30, 2026).
