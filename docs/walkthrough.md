# Walkthrough

A step-by-step guide to build a governed Fabric data foundation with **Fabric MCP Studio** – or with any AI client
connected to the same MCP servers. Allow 30–45 minutes the first time.

## Before you start

- [ ] `Start-Studio.cmd` (Windows) or `./studio/start-studio.sh` – the app opens in your browser. On Windows,
      `.\scripts\create-shortcut.ps1` adds a **Fabric MCP Studio** icon to the desktop that runs the studio in the
      background (stop it with **Shut down** in the app).
- [ ] Sign in with the Microsoft Entra work account that has Fabric access (top right)
- [ ] **Check setup** shows green for Microsoft Entra, Fabric capacity, your AI provider and the MCP servers
- [ ] Optional: pick your AI provider in **Settings › AI provider** (GitHub Copilot, Azure AI Foundry, OpenAI, Anthropic, local)

Everything below can be done with the quick action buttons **or** by asking Copilot. Copilot opens inside the tab you
are working in (no separate window) and asks for your approval before each change.

## 1. Workspace

**Workspace** tab › *Create new* (name + capacity) or *Use existing*.

> Ask Copilot: *Create a new workspace called "Fabric MCP Demo" on one of my capacities.*

## 2. Data

**Data** tab – pick one path:

| Path | What to do |
|---|---|
| Contoso Retail sample | *Sample data › Load sample* (≈3 min) |
| AdventureWorksDW2022 | *Sample data › Create in my workspace* (≈5–8 min). Creates a Fabric SQL database, loads Microsoft's AdventureWorksDW install kit and waits until Fabric has replicated every table to OneLake |
| Your database | *Your databases* › source › details › Fabric connection (new or existing) › *Start mirroring* |
| Existing Fabric data | *Existing Fabric data* › workspace › item › *Use in place* or *Create shortcuts* |

Mirroring shows live replication status per table. Once data is connected, the **Data** tab shows the full source: where
it lives, how it lands in Fabric, the SQL analytics endpoint, every table with row counts and keys, and live mirroring
status for mirrored databases. The source tabs below open on the source in use, with its details filled in.

> Ask Copilot: *Describe my data source: tables, row counts, keys and relationships. Then suggest a star schema.*

## 3. Semantic model

**Semantic model** tab › review tables, business names and relationships › *Create semantic model*.
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

## 4. Ontology

**Ontology** tab:

1. Edit or upload your **business glossary** (or *Draft it with Copilot*).
2. Review entities, relationships and business rules (one plain-English sentence each).
3. *Deploy ontology*.

> Ask Copilot: *Read my glossary and propose ontology business rules, then deploy the ontology after I confirm.*

Ontology is in preview; the Ontology MCP endpoint (used by agents) needs a paid F2+ or P1+ capacity. Agents use it to read entities and business rules; ontology questions (`ask_ontology`) are turned off for now, so numbers come from Fabric IQ.

## 5. Reports & apps

**Reports & apps** tab:

1. Review **What we found in your model**: headline KPIs, channels, time (with full years), share and breakdown
   dimensions, the top-10 list and the drill path, plus a few insights from your data.
2. Pick **pages** (Executive summary, Performance drivers, Scorecard) and a **theme**, name the report, *Build report*.
3. *Open in Power BI*, or expand **Preview** to see the rendered pages.

> Ask Copilot: *Recommend the best Power BI report for my semantic model and build it after I confirm.*

## 6. Ask and share

**Ask & share** tab:

- **Ask in the app** – questions are answered through Fabric IQ (DAX over your model) and the ontology.
- **Microsoft 365 Copilot & Teams** – *Install for me* adds the agent for you; *Publish to my organization* submits it for admin approval.
- **Other AI clients** – copy the `setup.ps1` command for VS Code, Copilot CLI, Claude Code or Cursor.
- **Fabric data agent** – let Copilot create one grounded in your model.
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

## Clean up

**Settings › Clean up** deletes what the studio created (lakehouse, SQL database, mirrored database, semantic model,
reports, ontology – or the whole workspace if the studio created it). *Start a new project* clears local state only.

## Without the studio

The same flow works from any MCP client using the repository skills: run `.\scripts\setup.ps1 -Client <client>`,
then ask your agent to use the `fabric-demo-*` skills in order (lakehouse → semantic-model → model-doctor → ontology → ask).
Script equivalents: `deploy-fabric.ps1`, `deploy-ontology.ps1`, `install-teams-agent.ps1`, `reset.ps1`.
