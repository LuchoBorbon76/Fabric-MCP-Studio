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
| **Workspace** | Create a new workspace on any capacity, or use an existing one · set the naming standard here · organize it with a **task flow**: the one already in your workspace or one of Fabric's predesigned flows (Medallion, Basic data analytics, Event analytics, Event medallion, Lambda, Basic machine learning models), with every item the studio builds in its box and kept up to date |
| **Data** | Sample data (Contoso Retail lakehouse, or **AdventureWorksDW2022 created as a Fabric SQL database**) · mirror **Azure SQL DB, SQL Managed Instance, SQL Server on-premises, Azure PostgreSQL** · reuse **Fabric lakehouses, warehouses, mirrored databases, SQL databases** (in place or shortcuts) · for any lakehouse, a **data prep notebook** (Fabric Python notebook) that renames, fixes, finds relationships, adds measures, writes curated tables and draws charts |
| **Semantic model** | Direct Lake models generated from your tables and keys, then enriched by Copilot: measures from your glossary, descriptions, RLS, translations, best-practice review · or **existing semantic models** from any workspace (Direct Lake, Import, DirectQuery) · **several models per project**: switch the active one and reports, data agent, org app, ontology, plan, real-time items and answers follow when related artifacts are found |
| **Ontology** | Entities, relationships and plain-English business rules from your glossary |
| **Reports & apps** | Professional Power BI reports generated from your semantic model: the studio reads your measures, dates and dimensions, recommends reports with reasons from your data, fills page templates (executive summary, performance drivers, scorecard, **business rules dashboard** from your ontology) with one of 6 themes, deploys them, and bundles them into a **Fabric org app** |
| **Real-time** | An **Eventhouse** table fed by an **Eventstream** (custom endpoint), a live event simulator shaped like your data (real products, customers, regions and prices, with business-rule breaks), a generated, auto-refreshing **Real-Time Dashboard**, live **time-series properties in the ontology**, and **Activator alerts** (Teams or email) on rule breaks; the **medallion architecture** (Bronze → Silver → Gold with update policies, quarantine, deduplication and materialized views) applied to the stream and shown in Fabric as an **Event medallion task flow**; Copilot answers "what is happening right now" with KQL |
| **Planning** | A **budget and rolling forecast** derived from your actuals (growth by region or category, run-rate forecast), stored next to your data with a **Plan table** of variance measures in the semantic model, a **Plan vs actual** report, and the **Fabric plan** item. The plan item opens as a container; create a Planning Sheet in Fabric and connect the semantic model with your own sign-in. |
| **Ask & share** | Chat with governed answers (Fabric IQ), install the Microsoft 365 Copilot / Teams agent, connect other AI clients, create a Fabric data agent, export the audit log |

Every step has a quick action **and** a Copilot path. Copilot calls the Fabric MCP servers as the signed-in user and
**asks for approval before every change**; database credentials never go through the chat.

The app opens on a **solution map**: a lineage diagram of every part above – from the data source through OneLake and
the semantic model to reports, plans, answers, agents and the real-time items – showing what is built from what.
Parts stay greyed out until they are configured and light up as you build; select one to see its details or open it.

## Install for external users

For customers, partners or anyone who should not work from a Git clone, share the **Windows installer zip**:

```powershell
.\installer\build-installer.ps1 -RepoUrl https://github.com/<your-org>/Fabric-MCP-Studio.git
```

This creates `dist\Fabric-MCP-Studio-Installer.zip`. The external user:

1. Downloads and extracts the zip (right-click **Extract All**; don't run it from inside the zip).
2. Opens `README.txt` in the extracted folder for the install instructions.
3. Double-clicks **Install Fabric MCP Studio.cmd**.
4. Lets the installer check/install prerequisites:
   - required: Git with Git Credential Manager, Node.js LTS with npm;
   - optional: Azure CLI (reuse `az login`) and GitHub CLI (private repo / GitHub Copilot sign-in).
5. Starts the app from the **Fabric MCP Studio** desktop shortcut.
6. Signs in with their Microsoft Entra work account, chooses an AI provider in **Settings › AI provider**, and runs
   **Check setup**. If something is blocked or limited, **Settings › Fix prerequisites** shows the exact fix and link.

If this repository is private, the installer opens a GitHub sign-in window once; the user needs read access to this repo.
If you want non-technical users to avoid GitHub entirely, publish/share a release package or zip from a location they can
read, or run the installer with `-GitHubToken` for controlled unattended installs.

**Instruction files included with the installer:**

- `README.txt` – quick install, update, uninstall and troubleshooting instructions for the extracted installer folder.
- `Fabric-MCP-Studio-User-Guide.pdf` – full step-by-step user guide with screenshots for non-technical users.

Developers can still run from source:

```powershell
git clone https://github.com/<your-org>/Fabric-MCP-Studio.git
cd Fabric-MCP-Studio
.\Start-Studio.cmd            # Windows  (macOS/Linux: ./studio/start-studio.sh)
.\scripts\create-shortcut.ps1 # optional: "Fabric MCP Studio" desktop icon, runs in the background (-StartMenu adds it to the Start menu)
```

Requirements: Node.js 20.19+, a Microsoft Entra work account with Fabric access, and one AI provider.
Details: [studio/README.md](studio/README.md) · Step-by-step: [docs/walkthrough.md](docs/walkthrough.md).

**New to the app?** The [User Guide (PDF)](docs/Fabric-MCP-Studio-User-Guide.pdf) explains installing, starting and
using it step by step with screenshots, for people without a technical background.

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
installer/             Shareable Windows installer (build-installer.ps1 -> dist/Fabric-MCP-Studio-Installer.zip)
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
| `../installer/build-installer.ps1` | Build the shareable installer zip. Pass `-RepoUrl` with the organization-owned repository URL so the zip does not include a personal clone URL; supports `-Branch`, `-OutDir` |
| `reset.ps1` | Delete what the scripts created |

All scripts run on Windows PowerShell 5.1 and PowerShell 7.

## Adapting to a customer

1. Connect their data in the studio (mirroring or existing Fabric items) – no code changes needed.
2. Paste or upload their business glossary in **Ontology › Business glossary**; Copilot uses it for measures and rules.
3. Run the model review on one of their existing semantic models – the fastest path to value.
4. Rename and customize the Microsoft 365 agent in `agents/contoso-retail-analyst`.

## Disclaimer

Fabric MCP Studio and this kit are a **sample** for demos, learning and proofs of concept. They aren't an official
Microsoft product or service, aren't supported by Microsoft Support and aren't covered by any Microsoft service-level
agreement. They're provided **as is, without warranty of any kind**.

- The studio acts in Microsoft Fabric and Power BI with the user's own sign-in and permissions, and asks before every
  change. Everything it creates lives in the user's tenant, runs on their Fabric capacity and may incur costs; the
  user is responsible for reviewing, securing and removing it.
- AI suggestions can be incomplete or wrong – review them before applying or relying on them. Prompts, and data in
  answers, go to the AI provider the user chooses, under that provider's terms.
- Several Fabric capabilities used here are in preview and subject to preview terms.
- **Sharing inside Microsoft:** share it as a sample with this disclaimer; don't present it as a supported Microsoft
  offering. **Sharing with customers and partners:** it's sample code, not a Microsoft product – review it with their
  security and compliance teams and install it only in tenants they're allowed to change.

The app shows this disclaimer once per installation (again when it changes), in the footer and in **Settings › About**.
