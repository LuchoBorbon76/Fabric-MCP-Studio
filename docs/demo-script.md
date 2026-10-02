# Demo script

**Audience:** data and analytics leaders, BI teams, platform owners · **Length:** 30 min (15-min variant below)
**Story:** *"Describe your business in plain language – the agent builds the lakehouse, the semantic model and the
ontology through MCP, governed like code – and everyone gets the same answer in whatever Copilot they already use."*

## T-1 day checklist

- [ ] `.\scripts\prereq-check.ps1 -CheckFabric`
- [ ] `.\scripts\setup.ps1 -Client <client>` and sign in to every server
- [ ] Ask: *"Use the fabric-demo-verify skill to check my MCP connections."* – all ✅
- [ ] Full dry run of acts 1–5, then `.\scripts\reset.ps1`
- [ ] Optional safety net: `.\scripts\deploy-fabric.ps1 -Stage Files` (pre-uploads raw files only)
- [ ] Second client ready for the finale (Copilot Studio agent in Teams, or Copilot CLI)

## Run of show

| # | Act | Min | Skill | Wow moment |
|---|---|---|---|---|
| 0 | Why | 2 | – | Semantic layers and ontologies are the bottleneck for trustworthy AI |
| 1 | Napkin to lakehouse | 5 | `fabric-demo-lakehouse` | One sentence → workspace, lakehouse, 6 typed tables |
| 2 | Semantic model in plain English | 8 | `fabric-demo-semantic-model` | Star schema + glossary-accurate measures, validated with DAX |
| 3 | Model doctor | 4 | `fabric-demo-model-doctor` | Every object documented and translated in one prompt |
| 4 | Ontology as code | 7 | `fabric-demo-ontology` | Glossary → business rules → pull request → deployed ontology |
| 5 | Ask anywhere | 4 | `fabric-demo-ask` | Same governed answer in two different Copilots |

### Act 1 – Napkin to lakehouse

> We're Contoso Retail: stores in four US regions plus web and app channels, a product catalog, customers with
> loyalty tiers, sales lines and returns. Use the fabric-demo-lakehouse skill to set up a workspace called
> "Fabric MCP Demo - Retail" with a lakehouse and load the files in data/retail/parquet as tables.

Point out: the plan before acting, the server picked per step, the Fabric API docs lookup. *Plan B:* `deploy-fabric.ps1`.

### Act 2 – Semantic model

> Use the fabric-demo-semantic-model skill to build the "Retail Sales" Direct Lake model. Follow the glossary
> exactly, then prove it: show net sales, gross margin %, and same-store sales growth for Jan–Sep 2026 vs 2025.

Expected: 3,849,588 · 37.3% · same-store **−12.5%** while total is **+3.8%**. Pause here – "the agent just found
that new stores are cannibalizing existing ones."

### Act 3 – Model doctor

> Use the fabric-demo-model-doctor skill on Retail Sales. Show me the scorecard first, then fix documentation and
> formatting, and add Spanish (Mexico) translations.

Bridge: "Run this on *your* model next week – no rebuild needed."

### Act 4 – Ontology as code

> Use the fabric-demo-ontology skill, path B. Read data/retail/business-glossary.md and make sure every business
> rule exists in ontology/retail. Create a branch, show me the diff, and deploy it after I approve.

Tip: before the demo, delete `rules/DiscountCap.tmdl` (and its `ref rule` line) on a branch so the agent has a real
gap to find. Show the PR – governance is the point. Then run `.\scripts\setup.ps1 -Client <client> -IncludeOntology`.

### Act 5 – Ask anywhere

> How many at-risk customers do we have, what exactly does at-risk mean, and which region should the win-back
> campaign start in?

Ask the same question in a second client (Copilot Studio agent in Teams or Copilot CLI). Expected: **105** customers,
definition quoted from rule `AtRiskCustomer`, start in **East** (30 of 105; ~580K lifetime net sales at risk overall).
More questions and answers: [fabric-demo-ask](../.github/skills/fabric-demo-ask/SKILL.md).

### Close (BYO Copilot)

Show [clients/README.md](../clients/README.md): same servers, any client; Fabric security applies to every answer.
Offer a pilot: model doctor on one of their production models, then an ontology for one domain.

## 15-minute variant

Run acts 1–2 beforehand (`deploy-fabric.ps1` + semantic model skill), then present acts 3, 4 and 5 live.

## Reset

`.\scripts\reset.ps1` deletes the demo workspace (only if the script created it) and clears `config/demo.state.json`.
