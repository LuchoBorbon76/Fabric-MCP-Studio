# Adventure Works – Business Glossary

> Business definitions for the **AdventureWorksDW2022** sample (Microsoft's classic data warehouse sample, loaded into
> a Fabric SQL database by Fabric MCP Studio). Copilot reads this glossary to name measures, describe entities and
> write ontology rules. All data is fictitious.

## Entities

| Term | Definition |
|---|---|
| **Customer** | A person who buys from the Adventure Works website. Identified by `CustomerKey` (business key `CustomerAlternateKey`). Lives in one *Geography*. |
| **Reseller** | A bike shop, warehouse or specialty store that buys from Adventure Works sales representatives. Identified by `ResellerKey`. |
| **Product** | A bike, component, clothing item or accessory. Identified by `ProductKey`. Belongs to one *Product Subcategory*, which belongs to one *Product Category* (Bikes, Components, Clothing, Accessories). |
| **Internet Sale** | One product line on an online order from a customer (`FactInternetSales`). An *Internet Order* is the set of lines that share a `SalesOrderNumber`. |
| **Reseller Sale** | One product line on an order from a reseller (`FactResellerSales`). |
| **Sales Territory** | A sales region (for example Northwest, Canada, France) grouped into *Groups* (North America, Europe, Pacific). |
| **Geography** | A city, state or province and country where a customer or reseller is located. |
| **Promotion** | A discount offer (for example Volume Discount, Seasonal Discount) that can apply to a sales line. |

## Measures

| Term | Definition |
|---|---|
| **Internet Sales Amount** | Sum of `SalesAmount` on Internet Sales. The default "online sales" number. |
| **Reseller Sales Amount** | Sum of `SalesAmount` on Reseller Sales. |
| **Total Sales Amount** | `Internet Sales Amount + Reseller Sales Amount`. |
| **Total Product Cost** | Sum of `TotalProductCost` (standard cost × quantity). |
| **Gross Profit** | `Sales Amount − Total Product Cost` (per channel or in total). |
| **Gross Profit Margin** | `Gross Profit ÷ Sales Amount`. |
| **Orders** | Distinct count of `SalesOrderNumber`. |
| **Average Order Value** | `Internet Sales Amount ÷ Internet Orders`. |
| **Internet Customers** | Distinct count of customers with at least one internet sale. |

## Customer and product classifications

| Term | Definition |
|---|---|
| **High-Value Customer** | A customer whose **lifetime Internet Sales Amount is at least 5,000**. |
| **Discontinued Product** | A product whose `Status` is not **Current**. |

## Business rules

1. **Minimum margin** – A product's `ListPrice` must be at least **50% above** its `StandardCost`. Products that break this rule must be reviewed by product management.
2. **Sales below cost** – A reseller sale must not be priced below the cost of its products (`SalesAmount < TotalProductCost`). Reseller sales below cost need approval from the sales director.
3. **Discount approval** – Reseller line discounts (`UnitPriceDiscountPct`) of **30% or more** require approval from the sales director.
4. **High-value customer** – A customer is high value when their lifetime internet sales amount is at least **5,000**.
5. **Discontinued products** – A product is discontinued when its status is not **Current**. Discontinued products must not be sold on new orders.

## Calendar

Sales data runs from **December 2010 to January 2014**. Compare years with **CalendarYear** (2011–2013 are complete).
The sample's `FiscalYear` column is not a regular July–June calendar (fiscal years 2010 and 2011 each cover about
18 months), so avoid it for year-over-year comparisons.
