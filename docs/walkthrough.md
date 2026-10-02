# Walkthrough

A step-by-step guide to build a governed Fabric data foundation with **Fabric MCP Studio** – or with any AI client
connected to the same MCP servers. Allow 30–45 minutes the first time.

## Before you start

- [ ] `Start-Studio.cmd` (Windows) or `./studio/start-studio.sh` – the app opens in your browser
- [ ] Sign in with the Microsoft Entra work account that has Fabric access (top right)
- [ ] **Check setup** shows green for Microsoft Entra, Fabric capacity, your AI provider and the MCP servers
- [ ] Optional: pick your AI provider in **Settings › AI provider** (GitHub Copilot, Azure AI Foundry, OpenAI, Anthropic, local)

Everything below can be done with the quick action buttons **or** by asking Copilot. Copilot asks for your approval
before each change.

## 1. Workspace

**Workspace** tab › *Create new* (name + capacity) or *Use existing*.

> Ask Copilot: *Create a new workspace called "Fabric MCP Demo" on one of my capacities.*

## 2. Data

**Data** tab – pick one path:

| Path | What to do |
|---|---|
| Contoso Retail sample | *Sample data › Load sample* (≈3 min) |
| AdventureWorksLT on Azure SQL | *Sample data › Set up in my Azure subscription*, then *Mirror into Fabric* (≈12 min) |
| Your database | *Your databases* › source › details › Fabric connection (new or existing) › *Start mirroring* |
| Existing Fabric data | *Existing Fabric data* › workspace › item › *Use in place* or *Create shortcuts* |

Mirroring shows live replication status per table. When it finishes, the **Data** card shows the SQL analytics endpoint.

> Ask Copilot: *Describe my data source: tables, row counts, keys and relationships. Then suggest a star schema.*

## 3. Semantic model

**Semantic model** tab › review tables, business names and relationships › *Create semantic model*.
The studio generates a Direct Lake model. With the Contoso Retail sample it also adds 18 business measures from the glossary.

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

Ontology is in preview; the Ontology MCP endpoint (used by agents) needs a paid F2+ or P1+ capacity.

## 5. Ask and share

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

More in [fabric-demo-ask](../.github/skills/fabric-demo-ask/SKILL.md).

## Clean up

**Settings › Clean up** deletes what the studio created (optionally the whole workspace and the AdventureWorksLT
Azure resource group). *Start a new project* clears local state only.

## Without the studio

The same flow works from any MCP client using the repository skills: run `.\scripts\setup.ps1 -Client <client>`,
then ask your agent to use the `fabric-demo-*` skills in order (lakehouse → semantic-model → model-doctor → ontology → ask).
Script equivalents: `deploy-fabric.ps1`, `deploy-ontology.ps1`, `install-teams-agent.ps1`, `reset.ps1`.
