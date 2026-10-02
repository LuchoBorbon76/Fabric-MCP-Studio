# Fabric MCP demo kit – semantic models and ontologies from natural language

Build a **Microsoft Fabric lakehouse, Power BI semantic model and Fabric IQ ontology by talking to an AI agent**,
then ask governed business questions from any Copilot. Everything goes through Model Context Protocol (MCP) servers,
so customers **use the AI client and license they already have** – GitHub Copilot, Claude, Cursor, Copilot Studio,
Microsoft 365 Copilot or an Azure AI Foundry agent.

> Synthetic "Contoso Retail" data. Several components are in preview – see [status](docs/architecture.md#server-status-october-2026).
> This is a sample, provided as-is, not an official Microsoft product.

## What the demo shows

| # | Demo | MCP servers | Skill |
|---|---|---|---|
| 1 | **Napkin to lakehouse** – one paragraph → workspace, lakehouse, typed Delta tables | Fabric Core, Fabric local | `fabric-demo-lakehouse` |
| 2 | **Semantic model in plain English** – star schema, glossary-accurate DAX, validated | Power BI Authoring | `fabric-demo-semantic-model` |
| 3 | **Model doctor** – best-practice audit, documentation, translations (works on customer models) | Power BI Authoring | `fabric-demo-model-doctor` |
| 4 | **Ontology as code** – semantic model or glossary → entities, relationships, rules → PR → deploy | Fabric Core + Git | `fabric-demo-ontology` |
| 5 | **Ask anywhere** – same governed answer in every client | Fabric IQ, Ontology MCP | `fabric-demo-ask` |

## Bring your own Copilot

| Client | Customer license | One-line setup |
|---|---|---|
| GitHub Copilot in VS Code | Copilot Free / Pro / Pro+ / Business / Enterprise | `.\scripts\setup.ps1 -Client vscode` |
| GitHub Copilot CLI | Copilot Pro / Pro+ / Business / Enterprise | `.\scripts\setup.ps1 -Client copilot-cli` |
| Claude Code | Anthropic plan / API key | `.\scripts\setup.ps1 -Client claude-code` |
| Cursor | Cursor plan | `.\scripts\setup.ps1 -Client cursor` |
| Copilot Studio → Teams / Microsoft 365 Copilot | Copilot Studio (+ M365 Copilot) | [portal guide](clients/copilot-studio/README.md) |
| Azure AI Foundry agent | Azure + any model deployment | [portal guide](clients/azure-ai-foundry/README.md) |

Run `.\scripts\setup.ps1` with no arguments for an interactive menu. Details: [clients/README.md](clients/README.md).

## Quick start

```powershell
git clone https://github.com/luisbor_microsoft/fabric-mcp-server-luisbor.git
cd fabric-mcp-server-luisbor
.\scripts\prereq-check.ps1 -CheckFabric      # tools, Azure sign-in, Fabric capacities
.\scripts\setup.ps1                          # choose your AI client / Copilot license
```

Then open your client in the repo folder, sign in to the MCP servers with your Entra ID work account, and ask:

```text
Use the fabric-demo-verify skill to check my MCP connections.
```

Follow [docs/demo-script.md](docs/demo-script.md) for the 30-minute run of show with copy-paste prompts and an answer key.

## MCP servers used

| Key | Endpoint | Role |
|---|---|---|
| `fabric-core` | `https://api.fabric.microsoft.com/v1/mcp/core` | Workspaces, items, item definitions |
| `fabric-local` | `npx @microsoft/fabric-mcp` | API specs, schemas, best practices, OneLake files |
| `powerbi-authoring` | `https://api.fabric.microsoft.com/v1/mcp/powerbi/authoring` | Semantic model authoring |
| `fabric-iq` | `https://fabriciq.svc.cloud.microsoft/v1/mcp/fabriciq` | Read-only Q&A over semantic models |
| `fabric-ontology` | `…/workspaces/<ws>/items/<ontology>/ontologyEndpoint` | Ontology context for agents |

Single source of truth: [config/mcp-servers.json](config/mcp-servers.json). Architecture: [docs/architecture.md](docs/architecture.md).

## Repository layout

```text
.github/skills/        Demo skills (portable Agent Skills: VS Code, Copilot CLI, Claude Code via setup.ps1)
AGENTS.md              Routing rules, modeling conventions, ontology TMDL rules, safety
clients/               Per-client guides; copilot-cli template
config/                MCP server catalog; demo.state.json (git-ignored, written by scripts)
data/retail/           Synthetic CSV + typed Parquet, business glossary
docs/                  Architecture, prerequisites, demo script, troubleshooting
ontology/retail/       Reference ontology (TMDL) – 5 entities, 4 relationships, 5 rules
scripts/               setup, prereq-check, deploy-fabric, deploy-ontology, reset, generate-sample-data
.vscode/ .cursor/ .mcp.json   Default client configs (hosted authoring, no ontology)
```

## Fallback scripts (plan B for live demos)

| Script | Does |
|---|---|
| `deploy-fabric.ps1` | Find-or-create workspace + lakehouse, upload Parquet, load tables (`-Stage Files` to upload only) |
| `deploy-ontology.ps1` | Pack `ontology/<domain>` TMDL and create/update the Ontology item (`-DryRun` to inspect) |
| `reset.ps1` | Delete what the demo created |

All scripts run on Windows PowerShell 5.1 and PowerShell 7 and use your `az login` identity.

## Adapting to a customer

1. Replace `data/retail` with a synthetic extract of their domain (or point the skills at their lakehouse).
2. Replace `business-glossary.md` with their definitions – it drives measures and ontology rules.
3. Copy `ontology/retail` to `ontology/<domain>` and let the ontology skill evolve it.
4. Run the model doctor on one of their existing models – fastest path to value.
