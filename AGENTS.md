# AGENTS.md – Fabric MCP demo kit

Guidance for any AI agent (GitHub Copilot, Claude Code, Cursor, Codex…) working in this repository.
The goal of this repo is to **show customers how an agent builds Microsoft Fabric semantic models and
ontologies from natural language through MCP servers**, using whichever AI client they already license.

## MCP server routing

Pick the server by intent. Never guess an API when a tool exists; never call a write tool without first
telling the user what will change.

| Intent | Server (key in mcp config) | Notes |
|---|---|---|
| Workspaces, items, folders, roles; get/update **item definitions** (Ontology TMDL, SemanticModel TMDL) | `fabric-core` | Remote. Writes are real – confirm first. |
| Fabric API specs, item JSON schemas, best practices, OneLake upload/list, tables, pipelines, Dataflow Gen2 | `fabric-local` | Local (npx). Docs tools work offline. Use `onelake_upload-file` with `local-file-path` for data files. |
| Create/modify **semantic model** objects (tables, columns, measures, relationships, RLS, calc groups, translations), best-practice analysis, DAX queries | `powerbi-authoring` | Hosted or local – never both. Start with “Connect to semantic model '<name>' in Fabric workspace '<workspace>'”. |
| Answer business questions over a published semantic model (read-only DAX as the signed-in user) | `fabric-iq` | DiscoverArtifacts → GetSemanticModelSchema → ValueSearch → ExecuteQuery. Does not query ontologies. |
| Answer questions grounded in the **ontology** (entities, relationships, rules) | `fabric-ontology` | Only present after the ontology exists (`scripts/setup.ps1 -IncludeOntology`). |

If a capability has no MCP tool (for example the Lakehouse *Load Table* API), use the terminal:
`az rest --resource https://api.fabric.microsoft.com ...` or the idempotent scripts in `scripts/`.

## Demo state

`config/demo.state.json` (git-ignored) holds `workspaceId`, `lakehouseId`, `sqlEndpointId`,
`sqlEndpointServer`, `ontologyId`. Read it before asking the user for IDs; update it when you create items.

## Naming and modeling conventions

- Workspace: `Fabric MCP Demo - Retail` · Lakehouse: `RetailLakehouse` · Semantic model: `Retail Sales` ·
  Ontology: `Contoso Retail Ontology` (unless the user says otherwise).
- Lakehouse tables keep source names (`sales`, `customers`, …). Semantic model tables use business names
  (`Sales`, `Customer`, `Product`, `Store`, `Date`, `Returns`).
- Star schema, single-direction relationships from dimensions to facts, `Date` marked as date table.
- Every measure gets a description in plain business language, a format string, and a display folder.
- Hide surrogate/foreign keys on fact tables; set `summarizeBy: none` on IDs and year columns.
- Business definitions live in [data/retail/business-glossary.md](data/retail/business-glossary.md). Measures
  and ontology rules must match it exactly – quote the glossary when you explain a number.
- Fiscal year starts July 1.

## Ontology TMDL rules

- Reference implementation: [ontology/retail](ontology/retail). Copy its structure for new domains.
- Format reference: <https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/ontology-definition>.
- One file per entity (`entities/<Entity>.tmdl`), rule (`rules/<Rule>.tmdl`) and backing table (`tables/<table>.tmdl`);
  `relationships.tmdl` (table joins) and `entityRelationships.tmdl` (business relationships) are flat files.
- Indent with **tabs**. Every entity, property, relationship and rule needs a `lineageTag` (new GUID for new objects; keep existing ones).
- Add every new table/entity/rule to `model.tmdl` with `ref table|entity|rule <name>`.
- Rule `statement:` is plain English on one line, without colons. Reference the entities, properties and relationships it uses.
- `expressions.tmdl` keeps the `{{SQL_ENDPOINT_SERVER}}` / `{{SQL_ENDPOINT_ID}}` placeholders; `scripts/deploy-ontology.ps1` fills them.
- Deploy with `scripts/deploy-ontology.ps1` (packs base64 parts deterministically). Use `fabric-core`
  `update_item_definition` only when no terminal is available.

## Safety

- All data in this repo is synthetic. Never upload customer data to a demo workspace without the user asking.
- Show a plan before any create/update/delete in Fabric and wait for confirmation. Prefer idempotent steps
  (find-or-create). Never delete a workspace you did not create; `scripts/reset.ps1` handles teardown.
- Do not register both the hosted and local Power BI authoring servers at the same time.
- Never paste access tokens into files, chat, or commits.

## Repository map

| Path | What it is |
|---|---|
| `.github/skills/` | Demo skills (verify, lakehouse, semantic-model, model-doctor, ontology, ask) |
| `agents/contoso-retail-analyst/` | Microsoft 365 Copilot declarative agent (Fabric IQ + Ontology MCP plugins) |
| `config/mcp-servers.json` | Catalog of MCP endpoints – source of truth for client configs |
| `control-panel/index.html` | Self-contained presenter control panel |
| `scripts/` | `setup.ps1` (choose client), `prereq-check.ps1`, `deploy-fabric.ps1`, `deploy-ontology.ps1`, `reset.ps1`, `install-teams-agent.ps1`, `open-control-panel.ps1` |
| `data/retail/` | Synthetic CSV + typed Parquet, business glossary |
| `ontology/retail/` | Reference ontology TMDL |
| `docs/` | Architecture, prerequisites, demo script, troubleshooting |
