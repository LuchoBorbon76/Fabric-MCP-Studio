# Walkthrough

A step-by-step guide to build a governed Fabric data foundation with **Fabric MCP Studio** – or with any AI client
connected to the same MCP servers. Allow 30–45 minutes the first time.

> For people without a technical background, the [User Guide (PDF)](Fabric-MCP-Studio-User-Guide.pdf) covers the same
> steps in plain language with screenshots, from installing the app to cleaning up. Its source is in
> [user-guide/](user-guide/) – after changing it, run `.\docs\user-guide\build-pdf.ps1` to rebuild the PDF.

## Before you start

- [ ] `Start-Studio.cmd` (Windows) or `./studio/start-studio.sh` – the app opens in your browser. On Windows,
      `.\scripts\create-shortcut.ps1` adds a **Fabric MCP Studio** icon to the desktop that runs the studio in the
      background (stop it with **Shut down** in the app).
- [ ] Sign in with the Microsoft Entra work account that has Fabric access (top right)
- [ ] **Check setup** shows green for Microsoft Entra, Fabric capacity, your AI provider and the MCP servers
- [ ] Optional: pick your AI provider in **Settings › AI provider** (Azure AI Foundry / Azure OpenAI by default, OpenAI, Anthropic, local; GitHub Copilot in developer mode)

The app opens on the **solution map**: every part below is a box on the map, greyed out until it is configured,
with lines showing what is built from what. Select a part to see its details and the suggested next step, and
**Open** it (or double-click it) to work on it; while you work, the map stays on top in a compact form and selecting
a part goes straight to its page. **Overview**, **Copilot**, **Activity** and **Settings** are at the top right of
the map.

Everything below can be done with the quick action buttons **or** by asking Copilot. Copilot opens inside the page you
are working in (no separate window) and asks for your approval before each change.

## 1. Workspace

First tell the studio **what this environment is for** (Overview or Workspace page): demo, proof of concept,
development, test, user acceptance, production, training or sandbox, and the business domain (for example Sales). Every
item it creates is then named `[Domain]_[Object]_[Purpose]_[Environment]` – `Sales_WS_Analytics_PROD`,
`Sales_SM_Revenue_PROD`, `Sales_RPT_Executive_PROD` – and the page previews the names. Items that already exist keep
their names.

**Workspace** page (the frame around the Fabric parts of the map) › *Create new* (purpose + capacity; the name follows
the standard) or *Use existing*. Choosing another workspace later starts the project over there (the studio asks first;
the items stay in the old workspace).

> Ask Copilot: *Ask me what this environment is for, then create a workspace on one of my capacities.*

## 2. Data

**Data** page – pick one path:

| Path | What to do |
|---|---|
| Contoso Retail sample | *Sample data › Load sample* (≈3 min) |
| AdventureWorksDW2022 | *Sample data › Create in my workspace* (≈5–8 min). Creates a Fabric SQL database, loads Microsoft's AdventureWorksDW install kit and waits until Fabric has replicated every table to OneLake |
| Your database | *Your databases* › source › details › Fabric connection (new or existing) › *Start mirroring* |
| Existing Fabric data | *Existing Fabric data* › workspace › item › *Use in place* or *Create shortcuts* |

Mirroring shows live replication status per table. Once data is connected, the **Data** page shows the full source: where
it lives, how it lands in Fabric, the SQL analytics endpoint, every table with row counts and keys, and live mirroring
status for mirrored databases. The source tabs below open on the source in use, with its details filled in.

**Data prep notebook (lakehouse sources).** Tick *Also create a data prep notebook* when you load the Contoso Retail
sample or pick a lakehouse, or use the **Data prep notebook** card once a lakehouse is connected (≈2 min to run). The
studio creates a Fabric Python notebook that works everything out from your lakehouse when it runs – clearer column
names, logged data fixes, keys and relationships, measures with DAX, curated tables in a new curated lakehouse
(`<Domain>_LH_Curated_<Env>`) and charts (bar, pie, trend, Pareto, heatmap, distribution, box plot, treemap,
correlation, model diagram). The card shows the results and charts; *Use … as the data source* builds the model on the
curated tables.

**Another data source in the same workspace.** Load or connect a different source at any time: it becomes the active
one and starts with nothing built (the map greys out the parts it doesn't have yet), while the previous source keeps its
model, reports and the rest. Double-click **Data source** on the map to see the data in the project workspace and switch
between sources – nothing changes in Fabric; the workspace list at the top shows the data in any other workspace, to use
an item from there in place. Double-click the **workspace name** to see the workspaces on the capacity.

> Ask Copilot: *Describe my data source: tables, row counts, keys and relationships. Then suggest a star schema.*

## 3. Semantic model

**Semantic model** page › review tables, business names and relationships › *Create semantic model*.
The studio generates a Direct Lake model. With the samples it also adds business measures from the glossary
(18 for Contoso Retail, 24 for AdventureWorksDW2022 – a star schema of internet and reseller sales).

Or select *Design it with Copilot*: Copilot suggests the tables, business names, relationships and measures, then shows
an **Apply suggestions** button (in the chat and above *Create semantic model*). It opens a review of exactly what will
be created; confirm it to deploy the model. With the samples, Copilot's measures are added to the glossary measures.

Then improve it with Copilot (Power BI Authoring MCP):

- *Add business measures from my glossary*
- *Document every table, column and measure*
- *Run a best-practice review*
- *Add Spanish translations*
- *Create a row-level security role*

**Several models, new or existing.** **Double-click Semantic model** on the map (or select *⇄ Switch or add a model*)
to open the **Semantic models** pop-up with every model in the project.
*+ New model from my data* designs another model next to the ones you have; *+ Add an existing model* brings a model
from any workspace you can read (Direct Lake, Import or DirectQuery). The active model is the one reports, the data
agent, the org app and Copilot use – switch it with *Use this model* in the pop-up or the **Semantic model** bar at the top of Reports
& apps, Planning and Ask & share. The studio never changes or deletes a model you added.

When you add an existing model, the studio also looks in Fabric for what is already built on it: its Power BI reports
appear on the map and on Reports & apps as *Existing report*, the data agents that answer from it on Copilot answers,
and – when the project has no data yet – the lakehouse or warehouse it reads becomes the data source (in place). The
studio never changes these items; *↻ Look again* in the Semantic models pop-up refreshes the list.

If a model you add fails with a *duplicate value … one side of a relationship* error, select **🩺 Check and fix the data**:
the studio finds the table with repeated keys and, when they are exact copies in a warehouse, removes them (with a
backup) and reloads the model until it holds the fixed data. If the check says *Model has older rows*, select
**↻ Reload the model**.

> Ask Copilot: *Use the Sales model from the Finance workspace and build an executive report on it.*

## 4. Ontology

**Ontology** page:

1. Edit or upload your **business glossary** (or *Draft it with Copilot*).
2. Review entities, relationships and business rules (one plain-English sentence each).
3. *Deploy ontology*.

> Ask Copilot: *Read my glossary and propose ontology business rules, then deploy the ontology after I confirm.*

Ontology is in preview; the Ontology MCP endpoint (used by agents) needs a paid F2+ or P1+ capacity. Agents use it to read entities and business rules; ontology questions (`ask_ontology`) are turned off for now, so numbers come from Fabric IQ.

## 5. Reports & apps

**Reports & apps** page:

1. Review **Recommended for your data**: reports picked for your model and audience (for example an executive report
   in the Executive Navy theme, a **business rules dashboard** built from your ontology rules with their live counts,
   and a performance scorecard), each with the reasons from your data. *Build* it in one
   click, or *Customize* it in the designer.
2. Review **What we found in your model**: headline KPIs, channels, time (with full years), share and breakdown
   dimensions, the top-10 list, the drill path and the **map** (country › state › city, or latitude/longitude), plus a
   few insights from your data.
3. Or pick **pages** (Executive summary, Performance drivers, Scorecard, Business rules, Map) and a **theme** yourself, name the report, *Build report*.
   With location columns in the model, the **Map** page shows an Azure Maps visual with bubbles sized by your main
   measure – drill down from country to state to city – next to the biggest places, and a **Regional report** is
   recommended.
   **Your own templates**: *Upload template* (or drop files on the box) takes your organization's Power BI files –
   a template (.pbit), a report (.pbix), a zipped Power BI project, a report.json layout or a theme (.json). *Use template*
   checks the report's fields against your model (found, matched by name, missing – with the visuals that would show an
   error) and builds it on your semantic model with its own look, filters and bookmarks. Uploaded themes appear in the
   **Theme** list with a *Yours* tag.
4. *Open in Power BI*, or expand **Preview** to see the rendered pages.
5. **Org app for your organization** › *Create app*: choose the reports for the app, and the studio builds one app with
   an overview page and those reports in sections. Then
   *Publish in Fabric*: add people to its audience and publish – people don't need access to the workspace. *Choose
   reports* changes what is in it; *Delete app* removes it (the reports stay).

> Ask Copilot: *Recommend the best Power BI report for my semantic model.* Copilot explains its choice and shows
> **Apply suggestions**, which opens a review and builds the report in one click.

## 5b. Real-time

**Real-time** page:

1. **Set up live data** (about 2 minutes): an Eventhouse with a table shaped like your data, and an Eventstream whose
   custom endpoint feeds it.
2. **Live events** › *Start events*: pick events per minute, the share of business-rule breaks and when to stop. The
   cards show what was sent and what has landed in the Eventhouse in the last 15 minutes (usually within 30 seconds).
3. **Real-Time Dashboard** › *Build dashboard*, then *Open dashboard*: a live overview page and a business rules page,
   refreshed every 30 seconds.
4. **Live ontology** › *Connect live events* (needs the ontology): Product, Customer, Reseller and Sales territory get
   live time-series properties and a link to the dashboard. In Fabric, open the ontology › an entity type › *Configure*
   to see the *Timeseries* properties, or *Instances* to browse them.
5. **Alerts on rule breaks** › pick Teams or email, the recipients and the rules, then *Create alerts*. The Activator
   checks the live events every minute; open it to see each rule running and its activation history.
6. Optional: **Stream your own events** – copy the connection string and send events with the same columns from your app.
7. **Medallion architecture** › *Apply medallion template* (about 2 minutes): Bronze keeps the raw events, Silver checks,
   enriches and deduplicates them (rejects go to quarantine with the reason), Gold keeps per-minute, daily and latest
   aggregates fresh. Open the workspace in Fabric (*Open task flow*): the **Event medallion** task flow shows each layer
   with its item – Eventstream, Eventhouse, the Bronze → Silver queryset, the Silver lakehouse, the Silver → Gold
   queryset, the Gold semantic model, the dashboard, the Activator and the ontology. Raise **Data issues** on the live
   events card to watch the quarantine and the duplicates removed on the dashboard's *Medallion layers* page.

## 5c. Planning

**Planning** page (needs the semantic model; plans are stored next to your data – in a Fabric SQL database or warehouse, or for a lakehouse in a planning warehouse the lakehouse reads through a OneLake shortcut):

1. **Design the plan** shows a recommended plan year, growth and forecast cut-off, with a preview by month and by
   region. Change the growth for one region in the table and select *Apply growth targets* to see the effect.
2. **Build the plan** (about 4 minutes for a SQL database, most of it waiting for the OneLake replica): budget and
   forecast rows go to `planning.PlanValues`, and the semantic model gets a Plan table with budget, forecast and variance
   measures. *Plan vs actual* then shows actual, budget to date, variance and forecast through the model.
3. **Plan vs actual report** › *Build report*: one Power BI page with KPIs, the monthly trend and the variance by region.
4. **Plan in Fabric** › *Create the Fabric plan*, then *Open plan*: *New Planning Sheet* (Planning) › in the *Data* pane
   *Add* › pick the model › *Add* › *Connect* – it uses your own sign-in (Contributor or higher in the workspace; no
   shared connection). Then rows *Region › Category*, columns *Year › Month* and values *Budget, Forecast, Actual*.

> Ask Copilot: *Are we on plan?* Copilot reads the Plan measures through the model and explains where actual is ahead
> of or behind budget, and what the forecast says for the year.

> Ask Copilot: *What is happening in my live data right now?* Copilot queries the Eventhouse with KQL and points out
> rule breaks and where they come from. Simulated events are labeled `Studio simulator` in the `Source` column.

## 5d. Task flow

**Workspace** page › **Task flow**: pick the task flow already in your workspace (for example a Medallion flow you
applied in Fabric and renamed) or one of Fabric's predesigned flows – **Medallion**, **Basic data analytics**, **Event
analytics**, **Event medallion**, **Lambda**, **Basic machine learning models**. The card draws the flow like Fabric's
canvas and lists each box's items: raw data in **Bronze**, the data prep notebook in **Initial process**, the curated
lakehouse in **Silver**, the semantic models (and plan values) in **Gold**, reports in **Visualize**, the org app in
**Distribute**, the ontology and data agents in the AI box. Move an item with the small menu next to it. *Apply*
assigns the items (in your own task flow the studio only adds its items – your boxes, connectors and assignments stay);
it's updated automatically as you add or remove items. *Open in Fabric* shows it above the workspace item list.

> Ask Copilot: *Organize my workspace with the task flow that fits best.* Copilot compares the flows, shows where each
> item goes and offers an **Apply** button.

## 6. Ask and share

**Ask & share** page:

- **Ask in the app** – questions are answered through Fabric IQ (DAX over your model) and the ontology. Suggested
  questions are grouped (key numbers & trends, compare & rank, your reports, business rules, plan vs actual, live data,
  explore the data) and use your model's own measures, dimensions and years; each page shows the ones that fit it.
- **Microsoft 365 Copilot & Teams** – *Install for me* adds the agent for you; *Publish to my organization* submits it for admin approval.
- **Other AI clients** – copy the `setup.ps1` command for VS Code, Copilot CLI, Claude Code or Cursor.
- **Fabric data agent** – *Create data agent*, or *Suggest it with Copilot* and **Apply suggestions** to review and
  edit the instructions first. The studio creates and publishes the agent on your semantic model.
- **Export** – project and audit log as JSON.

### Sample questions (Contoso Retail)

| Question | Expected |
|---|---|
| What were total net sales and gross margin %? | 3,849,588 · 37.3% |
| How did same-store sales growth compare with total growth for Jan–Sep 2026 vs 2025? | Total +3.8%, same-store −12.5% |
| Which region is declining this year? | Central, −11.6% |
| How many at-risk customers do we have, and where should a win-back campaign start? | 105 · East (30) |
| Which products break the minimum margin rule? | P008, P027, P050, P054, P075, P090 |

### Sample questions (AdventureWorksDW2022)

| Question | Expected |
|---|---|
| What were total internet and reseller sales, and the gross profit margin of each channel? | Internet 29,358,677.22 (41.1%) · Reseller 80,450,596.98 (0.6%) |
| Why is the reseller margin so low? How much did we lose on sales below cost? | 21,829 reseller lines below cost · 3,320,274.60 lost · top products Touring-1000 Yellow 60, Touring-1000 Yellow 46, Road-650 Red 44 |
| Which product categories grew the most in calendar year 2013 compared with 2012? | Accessories +611%, Clothing +58%, Bikes +49%, Components +13% |
| Who is our top internet customer? | Nichole Nara (France), 13,295.38 |
| Which products break the minimum margin rule? | 9 products (Long-Sleeve Logo Jersey S–XL, Short-Sleeve Classic Jersey S–XL, AWC Logo Cap) |

More in [fabric-demo-ask](../.github/skills/fabric-demo-ask/SKILL.md).

## Remove one item

**Overview › Items in this project** lists everything the project built with what uses it. **Remove** deletes an item
in Fabric; it's disabled while something uses the item (remove the org app before its reports, the reports and data
agent before the semantic model…). The map's inspector has the same Remove button for the selected part.

## Clean up

**Settings › Clean up** deletes what the studio created (lakehouse, SQL database, mirrored database, semantic model,
reports, org app, ontology, live data, alerts and the Fabric plan – or the whole workspace if the studio created it).
Before anything is deleted it lists every item, shows which ones go to the workspace recycle bin and which are gone for
good, and asks you to type the workspace name. When it finishes, the project is empty: the map and every page start
over and you choose a workspace again (the workspace stays in Fabric unless you chose to delete it). *Start a new
project* clears local state only.

## Without the studio

The same flow works from any MCP client using the repository skills: run `.\scripts\setup.ps1 -Client <client>`,
then ask your agent to use the `fabric-demo-*` skills in order (lakehouse → semantic-model → model-doctor → ontology → ask).
Script equivalents: `deploy-fabric.ps1`, `deploy-ontology.ps1`, `install-teams-agent.ps1`, `reset.ps1`.
