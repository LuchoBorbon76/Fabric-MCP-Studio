# Fabric MCP Studio

An interactive app, installed by the customer, that builds a governed data foundation in **Microsoft Fabric** by
chatting with the **AI the customer already licenses**:

- **Workspace** – create a new one on any capacity, or use an existing workspace.
- **Data** – start from sample data (Contoso Retail, or AdventureWorksDW2022 created as a Fabric SQL database), mirror
  your databases (Azure SQL Database, Azure SQL Managed Instance, SQL Server on-premises via gateway, Azure Database
  for PostgreSQL), or reuse Fabric lakehouses, warehouses, mirrored databases and SQL databases (in place or with
  OneLake shortcuts).
- **Semantic model** – Direct Lake model generated from your tables and relationships, then enriched by Copilot
  (business measures from your glossary, descriptions, RLS, translations, best-practice review).
- **Ontology** – Fabric IQ entities, relationships and plain-English business rules.
- **Reports & apps** – polished Power BI reports built on your semantic model from page templates and themes.
- **Real-time** – live events shaped like your data streamed through an Eventstream into an Eventhouse, with an
  auto-refreshing Real-Time Dashboard, live time-series properties in the ontology and Activator alerts on rule breaks.
- **Planning** – a budget and rolling forecast from your actuals, a Plan table with variance measures in the model, a
  Plan vs actual report, and the Fabric plan for planning sheets.
- **Ask & share** – governed answers in the app chat, Microsoft 365 Copilot / Teams agent, other AI clients, Fabric data agent.

Everything runs on the customer's computer, signs in to Fabric as the customer, and **asks before every change**.

## Start

| OS | Command |
|---|---|
| Windows | Run `.\scripts\create-shortcut.ps1` once for a **Fabric MCP Studio** desktop icon (`-StartMenu` adds it to the Start menu), or double-click `Start-Studio.cmd` (repository root or this folder) |
| macOS / Linux | `./studio/start-studio.sh` |
| Any | `cd studio && npm install && npm start` |

The first run installs dependencies (~150 MB, includes the GitHub Copilot runtime). The app opens at
`http://127.0.0.1:4870`. Launching it again while it is running just reopens the running copy in your browser.
Options: `--port 5000`, `--no-open`, `--check` (readiness checks only), `--new-instance` (start another copy).

The desktop icon starts the studio in the background, with no console window (`Start-Studio-Silent.wsf`, Windows
Script Host). Stop it with **Shut down** in the app header; server output goes to `studio/data/studio.log`.
`Start-Studio.cmd` runs it in a console window instead (`create-shortcut.ps1 -ShowConsole` makes the icon do the same,
and it is used automatically when Windows Script Host is turned off).

**Requirements:** Node.js 20.19+ (LTS), a Microsoft Entra work account with access to Microsoft Fabric, and one AI
provider (below). Optional: Azure CLI (sign-in reuse), PowerShell (Teams agent installer). The AdventureWorksDW2022 sample
downloads Microsoft's install kit (17 MB) from github.com once.

## Choose your AI (bring your own Copilot)

| Provider | What the customer needs |
|---|---|
| **GitHub Copilot** (default) | A Copilot seat (Free, Pro, Pro+, Business, Enterprise). Sign in with GitHub CLI (`gh auth login`) or paste a token in Settings |
| **Azure AI Foundry / Azure OpenAI** | Endpoint + deployment. Microsoft Entra ID (recommended, no keys) or API key |
| **OpenAI** | API key |
| **Anthropic Claude** | API key |
| **Local model** | Any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM) with tool calling |

The agent engine is the [GitHub Copilot SDK](https://github.com/github/copilot-sdk). With GitHub Copilot it uses the
customer's Copilot plan; with the other providers it runs in *bring your own key* mode, so no GitHub license is needed.
API keys stay in memory (or environment variables `AZURE_OPENAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).

## How it works

```mermaid
flowchart LR
  UI["Studio UI<br/>(browser, 127.0.0.1)"] --> S["Studio server<br/>(Node.js)"]
  S --> AG["Copilot SDK agent<br/>+ customer's model"]
  AG --> MCP["Fabric MCP servers<br/>Core · Power BI Authoring · Fabric IQ · Ontology · Fabric local"]
  AG --> T["Studio tools<br/>(workspace, data, model, ontology)"]
  S --> F["Fabric REST APIs<br/>OneLake · Mirroring · Connections"]
  MCP --> FAB[("Microsoft Fabric<br/>as the signed-in user")]
  F --> FAB
  T --> F
```

- **Solution map**: the app opens on a lineage map of everything it builds, from the data source through OneLake,
  the semantic model and the ontology to reports, the plan, Copilot answers, the Microsoft 365 agent and the
  real-time items (live events → Eventstream → Eventhouse → Real-Time Dashboard, Activator alerts, live ontology
  properties). Parts stay greyed out until they are configured, then light up with their names and details; the
  edges show what is built from what, the suggested next part pulses, running jobs and live streams animate, and
  parts that can't run show a badge. On the overview, select a part to see its details, what it is built from and
  what it feeds, with *Open*, *Let Copilot do it* and *Open in Fabric*; elsewhere the map stays on top in a compact
  form (or hidden with *Hide map*) and selecting a part opens its page.
- **Two ways to do every step**: quick actions (deterministic, using Fabric REST APIs) or Copilot (MCP servers +
  studio tools). Both update the same project state.
- **Copilot inside every step**: Copilot opens right in the page you are working in (for example below the tables and
  relationships in *Semantic model*), never in a separate window. The **Copilot** page shows the same conversation full size.
- **Approvals**: every tool call that creates or changes something opens a review dialog with the exact request.
  Modes: *Ask every time* (default), *Auto-approve*, *Read-only*. When Copilot suggests a semantic model design, an
  **Apply suggestions** button reviews and creates it in one click – no need to type a confirmation.
- **Secrets never reach the AI**: database credentials are entered in the Data page and sent straight to Fabric to
  create a connection; Copilot only sees the connection ID.
- **Identity**: Microsoft Entra tokens (Azure CLI sign-in or browser) are minted locally and passed to the MCP
  servers. Fabric permissions, RLS and OLS always apply.
- **Audit**: the Activity page lists created items with links, jobs, and every approval or denial. Export as JSON.
- **Up-front checks**: the studio reads the workspace's capacity (running or paused, SKU, trial), your workspace role,
  the tenant settings each step needs (when you are a Fabric administrator) and what your data source supports. Parts
  that can't run get a red badge on the map and their page a banner with the reason and the fix, and their actions
  are disabled; parts that run with limits say so. Jobs and Copilot tools stop before changing anything when their
  step can't run. *Check setup* and `npm run check` show the same list.

## Data source scenarios

| Source | How it lands | Notes |
|---|---|---|
| Contoso Retail sample | Parquet → Lakehouse tables | Includes glossary, 18 business measures and 5 ontology rules |
| AdventureWorksDW2022 sample | Fabric SQL database in the project workspace → OneLake (automatic replication) | Microsoft's official install kit: 28 tables, 1.05M rows, real primary and foreign keys. Includes a glossary, 24 measures and 5 ontology rules. Needs the Admin or Member workspace role |
| Azure SQL Database | Fabric Mirroring | New connection (SQL login, service principal, workspace identity) or existing |
| Azure SQL Managed Instance | Fabric Mirroring | Public endpoint or VNet data gateway |
| SQL Server 2016–2025 | Fabric Mirroring via on-premises data gateway | Create the gateway connection in Fabric, then select it |
| Azure Database for PostgreSQL | Fabric Mirroring | Flexible server prerequisites shown in the wizard |
| Fabric Lakehouse / Warehouse | In place, or OneLake shortcuts into the project lakehouse | No data copy |
| Fabric mirrored database | In place | |
| Fabric SQL database | In place (its SQL analytics endpoint) | |

Schema discovery reads tables, keys and foreign keys (from the source when reachable, or from the Fabric SQL
analytics endpoint) and infers relationships from naming conventions when no foreign keys exist.

## Reports

**Reports & apps** builds Power BI reports (PBIR format) on the project's semantic model and deploys them with the
Fabric REST API – no Power BI Desktop needed.

1. **What we found in your model** – read-only DAX (`INFO.VIEW` functions and a short data profile) picks the headline
   KPIs, channel measures, the time grain and full years, a share dimension, a breakdown, the top-10 entity and a drill
   path. It works for any model you can query, including models the studio didn't create.
2. **Pages** – executive summary, performance drivers (drill-down matrix, year by segment, top contributors),
   scorecard (segment × year, ratio trend, ranked table) and **business rules** – the ontology dashboard: every
   ontology rule in plain English next to its live count, rule breaks by year and by segment, and where they happen.
   Rule measures the semantic model doesn't have yet are added to the report as report-level measures, so no model
   change is needed. Layouts follow Microsoft's Power BI report design guidance:
   1280×720, 24 px margins, header band, KPI row, hero visual, sorted bars, top-N lists.
3. **Themes** – Fabric Studio, Executive Navy, Teal Modern, Slate Minimal, Accessible (color-blind safe) and Midnight.
   All formatting lives in a custom report theme, so you can switch themes later in Power BI.
4. **Build** – creates or updates the Report item, then renders a PDF preview with Power BI export (if your tenant turns
   export off, open the report in Power BI instead). Partial years are filtered out so comparisons use full years.

Copilot can recommend pages and a theme for your audience (`studio_describe_report_options`) and suggest the report
(`studio_propose_report`); **Apply suggestions** reviews and builds it in one click. The page also shows
**Recommended for your data** – ready-made report recommendations with the reasons from your model.

**Org app** – *Create app* bundles the studio's reports into a Fabric org app: an overview page, a *Reports* section
and a *Business rules* section, in the report theme's colors. People get the app without access to the workspace: open
it in Fabric, add an audience and publish it. Rebuilding updates the app in place (`studio_create_org_app` for Copilot).

## Real-time

**Real-time** streams live events into Real-Time Intelligence, builds a dashboard over them, adds them to the
ontology and alerts people when a business rule is broken.

1. **Set up live data** – creates (or reuses) an Eventhouse and a table shaped like the project's data, and an
   Eventstream with a **custom endpoint** source and the Eventhouse as destination. For the samples the table holds
   order lines (`SalesEvents`: products, customers or resellers, territories, quantity, price, discount, cost, margin,
   rule broken); for any other model it holds `BusinessEvents` with the model's main measure and top dimensions.
2. **Live events** – the simulator sends events to the custom endpoint (Event Hubs protocol over HTTPS). Events use
   real keys, names and prices read from your data, and a share of them break the business rules (for AdventureWorks:
   *discount needs approval* at 30% or more, *sold below cost*). Choose events per minute, the share of rule breaks and
   when to stop (it always stops on its own). When the table has no recent data, the last hour is filled first so the
   charts aren't empty. The endpoint key stays in memory in the studio – it is never saved or shown to Copilot.
3. **Real-Time Dashboard** – a *Live overview* page (orders, amount, margin and rule-break KPIs, amount per minute by
   channel, mix, regions, top items, latest events) and a *Business rules* page (a count per rule, share of events
   breaking a rule, loss below cost, breaks per minute, who breaks the rules, latest breaks). It refreshes every 30
   seconds; every tile query is checked against the Eventhouse before the dashboard is deployed.
4. **Live ontology** – binds the live table to the ontology. Every entity type whose key the events carry (for
   AdventureWorks: Product, Customer, Reseller, Sales territory) gets time-series properties – `LiveSalesAmount`,
   `LiveQuantity`, `LiveDiscountPct`, `LiveMargin`, `LiveRuleBreak` and more, ordered by event time and read live from
   the Eventhouse (no copy) – plus a link to the Real-Time Dashboard. The ontology's tables are also tagged with their
   source item so Fabric can preview instances. Re-running replaces the earlier bindings; *Remove live properties*
   takes them off again, and re-deploying the ontology from the Ontology page keeps them.
5. **Alerts on rule breaks** – a Fabric **Activator** queries the live table every minute and, for each business-rule
   break, sends a Teams message or an email with the order, buyer, region, amount, discount and margin. One Activator
   rule per business rule; pick the rules, the recipients and an optional minimum amount. The card estimates how many
   messages to expect at the current event rate.
6. **Stream your own events** – copy the custom endpoint's connection string and send JSON events with the same columns
   from any app; they land in the same table, dashboard, ontology properties and alerts.

Copilot tools: `studio_realtime_status`, `studio_query_live_events` (read-only KQL), `studio_setup_live_data`,
`studio_start_live_events`, `studio_stop_live_events`, `studio_create_realtime_dashboard`,
`studio_connect_live_ontology` and `studio_create_live_alerts`.

## Planning

**Planning** starts a budget and a rolling forecast from your actuals and connects them to Fabric planning (Fabric IQ).

1. **Design the plan** – the studio reads the semantic model (main measure, date table, regions and categories) and
   recommends a plan year, a growth target (last year's growth, kept between -10% and 25%) and a forecast cut-off.
   Change the measure, the year, up to two dimensions, the growth, or a growth per region or category; the preview
   shows the budget, forecast and actuals by month and by member before anything is written.
2. **Build the plan** – budget = base-year actuals × (1 + growth) month by month, so seasonality is kept; forecast =
   actuals up to the cut-off, then the budget × each member's run rate (actual ÷ budget so far, kept between 80% and
   125%). The rows go to `planning.PlanValues` next to your data (Fabric SQL database or warehouse; for a SQL database
   the studio waits until the OneLake replica has them), and a **Plan** table is added to the semantic model with
   *Actual, Budget, Forecast, Budget to Date, Variance to Budget, Variance to Budget %, Budget Attainment %, Forecast vs
   Budget* and *Forecast vs Budget %*. The totals are checked through the model. Rebuilding the semantic model keeps the
   Plan table; *Remove…* takes it out again.
3. **Plan vs actual report** – a Power BI page with actual, budget, variance and forecast KPIs, the monthly trend of
   all three, and the variance by region and category (also a page template in Reports & apps).
4. **Plan in Fabric** – creates the Fabric plan item for planning sheets, connected to the model when a shared
   semantic model connection (Power BI semantic models, organizational account) exists. Planners add rows like
   *Region › Category*, columns *Year › Month* and values *Budget, Forecast, Actual*, adjust the numbers, comment,
   approve and write back to a SQL database.

Planning needs a date table with year and month number columns related to your facts. Plans are written to Fabric
SQL databases and warehouses; for lakehouse or mirrored sources the page previews the plan but can't build it yet.

Copilot tools: `studio_planning_status`, `studio_preview_plan`, `studio_create_plan` and `studio_create_plan_item`.

## Files

| Path | Purpose |
|---|---|
| `server/main.mjs` | HTTP server (127.0.0.1 only, per-launch token), routes, SSE |
| `server/agent.mjs` | Copilot SDK client, providers, MCP servers, studio tools, approvals |
| `server/pipelines.mjs` | Workspace, sample, mirroring, shortcuts, semantic model, ontology, Teams agent, clean-up |
| `server/fabric.mjs` | Fabric REST client (LRO, pagination, OneLake, connections, mirroring) |
| `server/sql.mjs`, `server/pg.mjs` | Schema discovery for SQL Server family, Fabric SQL endpoints and PostgreSQL |
| `server/generators/tmdl.mjs` | Direct Lake semantic model and ontology TMDL generators |
| `server/generators/pbir.mjs` | Power BI report (PBIR) generator: pages, visuals, filters, theme registration |
| `server/reports/` | Model profile (`profile.mjs`), page templates, report themes and the report build/preview pipeline |
| `server/powerbi.mjs` | Power BI REST: DAX queries, model metadata (`INFO.VIEW`), report export for previews |
| `server/realtime/` | Live data: Eventhouse/Eventstream setup, live ontology and alerts (`index.mjs`), event scenarios shaped like the data (`scenarios.mjs`), simulator sending to the custom endpoint (`simulator.mjs`), Real-Time Dashboard generator (`dashboard.mjs`), Activator alert definition (`alerts.mjs`), KQL client (`kusto.mjs`) |
| `server/generators/ontology-live.mjs` | Adds or removes Eventhouse time-series bindings and dashboard links on an existing TMDL ontology |
| `server/planning/` | Budgets and forecasts: plan design and calculation (`design.mjs`), plan values in the SQL database or warehouse (`store.mjs`), the Plan table patch for the semantic model (`model.mjs`), jobs, plan item and summary (`index.mjs`) |
| `server/readiness.mjs` | Up-front checks: capacity, workspace role, tenant settings and data-source limits per step, and the guard that stops jobs of steps that can't run |
| `server/presets.mjs` | Sample presets (names, relationships, measures, rules) |
| `server/samples/adventureworks-dw.mjs` | AdventureWorksDW2022 loader for Fabric SQL database (install kit → tables, keys, bulk load, verification) |
| `server/agent-instructions.md` | System instructions for the agent |
| `web/` | UI (vanilla ES modules, MSX Command Center design, 9 themes); `web/js/lineage.js` draws the solution map |
| `assets/` | App icon (`fabric-mcp-studio.ico` / `.png`) used by the desktop shortcut |
| `Start-Studio-Silent.wsf` | Windows launcher used by the desktop shortcut: starts the studio without a console window, reuses a running copy, reports start-up errors |
| `data/` | Local state (git-ignored): project, activity log, chat transcripts, Copilot runtime home, `studio.log` |

## Troubleshooting

Run `npm run check` (or *Check setup* in the app). See [docs/troubleshooting.md](../docs/troubleshooting.md).
