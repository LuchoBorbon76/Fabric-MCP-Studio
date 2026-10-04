# Fabric MCP Studio – semantic models and ontologies from natural language

Build a **Microsoft Fabric workspace, data foundation, Power BI semantic model and Fabric IQ ontology by chatting
with an AI agent**, then get governed answers anywhere. Everything goes through Model Context Protocol (MCP)
servers, so every customer **uses the AI they already license** – GitHub Copilot, Azure AI Foundry / Azure OpenAI,
OpenAI, Anthropic, a local model, Microsoft 365 Copilot, Claude Code or Cursor.

> Several Fabric components used here are in preview – see [status](docs/architecture.md#server-status-october-2026).
> This is a sample, provided as-is, not an official Microsoft product.

## Fabric MCP Studio (the app)

A local web app the customer installs and runs. One place to:

| Step | What you can do |
|---|---|
| **Choose your AI** | GitHub Copilot (any plan) or bring your own key: Azure AI Foundry/Azure OpenAI (Entra ID, no keys), OpenAI, Anthropic, local OpenAI-compatible model |
| **Workspace** | Create a new workspace on any capacity, or use an existing one |
| **Data** | Sample data (Contoso Retail lakehouse, or **AdventureWorksDW2022 created as a Fabric SQL database**) · mirror **Azure SQL DB, SQL Managed Instance, SQL Server on-premises, Azure PostgreSQL** · reuse **Fabric lakehouses, warehouses, mirrored databases, SQL databases** (in place or shortcuts) |
| **Semantic model** | Direct Lake model generated from your tables and keys, then enriched by Copilot: measures from your glossary, descriptions, RLS, translations, best-practice review |
| **Ontology** | Entities, relationships and plain-English business rules from your glossary |
| **Reports & apps** | Professional Power BI reports generated from your semantic model: the studio reads your measures, dates and dimensions, recommends reports with reasons from your data, fills page templates (executive summary, performance drivers, scorecard, **business rules dashboard** from your ontology) with one of 6 themes, deploys them, and bundles them into a **Fabric org app** |
| **Real-time** | An **Eventhouse** table fed by an **Eventstream** (custom endpoint), a live event simulator shaped like your data (real products, customers, regions and prices, with business-rule breaks), a generated, auto-refreshing **Real-Time Dashboard**, live **time-series properties in the ontology**, and **Activator alerts** (Teams or email) on rule breaks; Copilot answers "what is happening right now" with KQL |
| **Planning** | A **budget and rolling forecast** derived from your actuals (growth by region or category, run-rate forecast), stored next to your data with a **Plan table** of variance measures in the semantic model, a **Plan vs actual** report, and the **Fabric plan** item for planning sheets; Copilot answers "are we on plan?" |
| **Ask & share** | Chat with governed answers (Fabric IQ), install the Microsoft 365 Copilot / Teams agent, connect other AI clients, create a Fabric data agent, export the audit log |

Every step has a quick action **and** a Copilot path. Copilot calls the Fabric MCP servers as the signed-in user and
**asks for approval before every change**; database credentials never go through the chat.

```powershell
git clone https://github.com/luisbor_microsoft/Fabric-MCP-Studio.git
cd Fabric-MCP-Studio
.\Start-Studio.cmd            # Windows  (macOS/Linux: ./studio/start-studio.sh)
.\scripts\create-shortcut.ps1 # optional: "Fabric MCP Studio" desktop icon, runs in the background (-StartMenu adds it to the Start menu)
```

Requirements: Node.js 20.19+, a Microsoft Entra work account with Fabric access, and one AI provider.
Details: [studio/README.md](studio/README.md) · Step-by-step: [docs/walkthrough.md](docs/walkthrough.md).

## Bring your own Copilot – other clients

The same MCP servers and skills work in the customer's existing tools:

| Client | Customer license | Setup |
|---|---|---|
| **Fabric MCP Studio** | GitHub Copilot or any BYOK model | `Start-Studio.cmd` |
| GitHub Copilot in VS Code | Copilot Free / Pro / Pro+ / Business / Enterprise | `.\scripts\setup.ps1 -Client vscode` |
| GitHub Copilot CLI | Copilot Pro / Pro+ / Business / Enterprise | `.\scripts\setup.ps1 -Client copilot-cli` |
| Claude Code | Anthropic plan / API key | `.\scripts\setup.ps1 -Client claude-code` |
| Cursor | Cursor plan | `.\scripts\setup.ps1 -Client cursor` |
| **Microsoft 365 Copilot / Teams** (ready-made agent) | Microsoft 365 Copilot | Studio › Ask & share, or `.\scripts\install-teams-agent.ps1` |
| Copilot Studio | Copilot Studio (+ M365 Copilot) | [portal guide](clients/copilot-studio/README.md) |
| Azure AI Foundry agent | Azure + any model deployment | [portal guide](clients/azure-ai-foundry/README.md) |

Details: [clients/README.md](clients/README.md).

## MCP servers used

| Key | Endpoint | Role |
|---|---|---|
| `fabric-core` | `https://api.fabric.microsoft.com/v1/mcp/core` | Workspaces, items, item definitions |
| `fabric-local` | `npx @microsoft/fabric-mcp` | API specs, schemas, best practices, OneLake files |
| `powerbi-authoring` | `https://api.fabric.microsoft.com/v1/mcp/powerbi/authoring` | Semantic model authoring (saving changes needs XMLA endpoint **Read Write**) |
| `fabric-iq` | `https://fabriciq.svc.cloud.microsoft/v1/mcp/fabriciq` | Read-only Q&A over semantic models |
| `fabric-ontology` | `…/workspaces/<ws>/items/<ontology>/ontologyEndpoint` | Ontology context for agents (paid F2+/P1+) |

Single source of truth: [config/mcp-servers.json](config/mcp-servers.json). Architecture: [docs/architecture.md](docs/architecture.md).

## Repository layout

```text
Start-Studio.cmd       Double-click to run Fabric MCP Studio (Windows)
studio/                Fabric MCP Studio: Node.js server (Copilot SDK + Fabric APIs) and web UI
.github/skills/        Agent Skills used by VS Code, Copilot CLI and Claude Code
AGENTS.md              Routing rules, modeling conventions, ontology TMDL rules, safety
agents/                Microsoft 365 Copilot declarative agent (Fabric IQ + Ontology MCP)
clients/               Per-client guides; copilot-cli template
config/                MCP server catalog; demo.state.json (git-ignored, shared by studio and scripts)
data/retail/           Synthetic CSV + typed Parquet, business glossary
docs/                  Walkthrough, architecture, prerequisites, troubleshooting
ontology/retail/       Reference ontology (TMDL) – 5 entities, 4 relationships, 5 rules
scripts/               setup, prereq-check, deploy-fabric, deploy-ontology, reset, install-teams-agent,
                       create-shortcut, generate-sample-data, validate-agent-package
.vscode/ .cursor/ .mcp.json   Default client configs (hosted authoring, no ontology)
```

## Scripts

| Script | Does |
|---|---|
| `setup.ps1` | Write MCP config for VS Code, Copilot CLI, Claude Code or Cursor |
| `prereq-check.ps1` | Local tools, Azure sign-in, Fabric capacities |
| `deploy-fabric.ps1` | Workspace + lakehouse + Contoso Retail tables without an agent |
| `deploy-ontology.ps1` | Deploy `ontology/<domain>` TMDL as a Fabric Ontology item |
| `install-teams-agent.ps1` | Install/publish/uninstall the Microsoft 365 Copilot agent in any tenant |
| `create-shortcut.ps1` | Desktop (and optional Start menu) shortcut that starts Fabric MCP Studio without a console window; `-ShowConsole` for a minimized console, `-Remove` to delete it |
| `reset.ps1` | Delete what the scripts created |

All scripts run on Windows PowerShell 5.1 and PowerShell 7.

## Adapting to a customer

1. Connect their data in the studio (mirroring or existing Fabric items) – no code changes needed.
2. Paste or upload their business glossary in **Ontology › Business glossary**; Copilot uses it for measures and rules.
3. Run the model review on one of their existing semantic models – the fastest path to value.
4. Rename and customize the Microsoft 365 agent in `agents/contoso-retail-analyst`.
