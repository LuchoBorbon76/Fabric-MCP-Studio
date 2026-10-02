---
name: fabric-demo-ask
description: Demo step 5 - answer business questions with governed definitions, using Fabric IQ MCP (DAX over the Retail Sales semantic model) and the Ontology MCP endpoint (entities, relationships, rules). Use when the user asks business questions about Contoso Retail sales, customers, stores, products, returns, or rule violations.
---

# Ask governed questions

## How to answer

1. Pick the source:
   - **Numbers** (sales, margin, growth, counts) → `fabric-iq`: DiscoverArtifacts("Retail Sales") →
     GetSemanticModelSchema → ValueSearch (for exact member names) → ExecuteQuery. Prefer the model's
     **existing measures** over writing new math.
   - **Business meaning, rules, relationships** ("what is an at-risk customer?", "which rule applies to returns?") →
     `fabric-ontology`.
   - Questions that need both (e.g. rule violations) → read the rule from the ontology, then query data with `fabric-iq`
     using the existing measures/columns that implement it.
2. Always show: the answer, the measure(s)/rule(s) used, the DAX you ran (collapsed), and which server answered.
3. If the data can't answer it, say so. Never invent numbers. RLS applies – different users may see different results.

## Sample questions and expected results (Contoso Retail sample data)

| Question | Expected |
|---|---|
| What were net sales and gross margin % overall? | 3,849,588 · 37.3% |
| How did Jan–Sep 2026 compare with Jan–Sep 2025? | Total +3.8%, but same-store −12.5% – growth comes from 3 stores opened in 2025 and Digital, which are pulling sales from existing stores |
| Which region is declining this year? | Central, −11.6% YoY (Jan–Sep) |
| How many at-risk customers do we have, and what does "at risk" mean? | 105 · no purchase in 120 days and lifetime net sales ≥ 3,000 (rule `AtRiskCustomer`) |
| Where should the win-back campaign start? | East (30 at-risk customers; then South 26, Central 25, West 24) · ~580K lifetime net sales at risk |
| Which products break the minimum margin rule? | 6: P008, P027, P050, P054, P075, P090 |
| How many returns were outside the return window? | 117 of 1,025 |
| How many sales lines broke the discount cap? | 937 |
| Which category has the highest return rate? | Electronics (4.34%) |
| Top category by 2026 net sales? | Electronics (292,880) |
| Most common return reason? | "Not as described" (187) |
