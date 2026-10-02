---
name: fabric-demo-model-doctor
description: Demo step 3 - audit an existing Power BI semantic model against modeling best practices and fix it with the Power BI Authoring MCP server - descriptions, naming, formats, hidden keys, display folders, and translations. Use when the user asks to review, document, clean up, standardize, or translate a semantic model (works on customer models too).
---

# Model doctor

Works on the demo `Retail Sales` model **or a customer's own model** – that's the point: show value on day one
without building anything new.

## Steps

1. **Connect** (`powerbi-authoring`): “Connect to semantic model '<model>' in Fabric workspace '<workspace>'.”
   Confirm with a read-only summary: table, column, measure and relationship counts.
2. **Diagnose** – run the server's best-practice analysis and group the findings:
   - Documentation: tables, columns, measures without descriptions.
   - Usability: visible foreign keys, missing format strings, missing display folders, unsorted month names, numeric columns that should not be summed.
   - Modeling: bidirectional or many-to-many relationships, missing date table, ambiguous paths.
   - DAX: measures using `/` instead of `DIVIDE`, repeated logic that should be a base measure, `FILTER(ALL(...))` that could be `KEEPFILTERS`.
3. **Present a scorecard** (finding · count · proposed fix · risk) and ask which groups to fix. Back up first:
   for Fabric models, export the definition with `fabric-core` get_item_definition to `backups/<model>-<timestamp>/`.
4. **Fix in bulk** – one transaction per group when the server supports it:
   - Write descriptions in plain business language, explaining the DAX logic (quote the glossary when it applies).
   - Apply naming conventions consistently (analyze the best table first and propagate its pattern).
   - Set format strings, display folders, `summarizeBy: none`, hide keys, sort-by columns.
5. **Translate** (optional): add cultures `es-MX` and `fr-FR` with translated table, column, measure and display-folder names and descriptions.
6. **Re-run the analysis** and show before/after counts.

## Talk track

"This is the same work a senior modeler does in a day – documentation, consistency, translations – done in
minutes, with every change reviewable and reversible."
