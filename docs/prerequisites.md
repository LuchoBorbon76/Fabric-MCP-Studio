# Prerequisites

Run `.\scripts\prereq-check.ps1 -CheckFabric` for the parts that can be checked automatically.

## Microsoft Fabric

| Requirement | Why | Notes |
|---|---|---|
| Fabric capacity (trial or paid) | Lakehouse, semantic model | A Fabric trial is enough for steps 1–3. |
| **Paid F2+ or P1+** capacity | Ontology MCP endpoint | Required for step 5 against the ontology. |
| Workspace **Contributor** (or higher) | Create items | `deploy-fabric.ps1` can create a new workspace for you. |
| **Write** permission on the semantic model | Power BI authoring | Build-only permission allows DAX queries only. |
| Tenant home region supports all Fabric workloads | Fabric IQ MCP | Not available in Power BI-only regions or sovereign clouds. |

### Tenant settings (Fabric admin portal)

| Setting | Needed for |
|---|---|
| Users can create Fabric items | Lakehouse, semantic model, ontology |
| Ontology (preview) item creation enabled | Ontology steps |
| **Users can use the Power BI Model Context Protocol server endpoint** | Hosted Power BI Authoring MCP |
| XMLA endpoint = **Read Write** on the capacity | Only for the *local* Power BI authoring server |

> No Fabric Copilot / Azure OpenAI tenant setting is needed: the language model runs in the customer's chosen client.

## AI client (pick one – see [clients/README.md](../clients/README.md))

| Client | License | Admin policy |
|---|---|---|
| GitHub Copilot (VS Code / CLI) | Free, Pro, Pro+, Business, Enterprise | Business/Enterprise: enable **MCP servers in Copilot** |
| Claude Code / Cursor | Vendor plan | Allow MCP servers in the vendor admin console if restricted |
| Copilot Studio / Microsoft 365 Copilot | Copilot Studio (+ M365 Copilot for Teams/Outlook) | App registration with delegated Power BI Service permissions (`install-teams-agent.ps1` creates it) |
| Microsoft 365 Copilot agent (`install-teams-agent.ps1`) | Microsoft 365 Copilot | Custom app upload + Copilot access for the installer; Entra app creation rights; admin consent if user consent is restricted |
| Azure AI Foundry | Azure subscription + model deployment | Review Fabric IQ data-boundary notes |

## Local tools (builder clients)

| Tool | Needed for |
|---|---|
| Node.js LTS (20+) | `fabric-local` and local Power BI authoring servers (`npx`) |
| Git | Ontology-as-code step, cloning the repo |
| PowerShell 5.1+ (7 recommended) | Scripts |
| Azure CLI (`az login`) | `deploy-*.ps1` / `reset.ps1` fallbacks and the `az rest` Load Table call |
| Python 3.10+ and `pyarrow` | Only to regenerate the sample data |
| Microsoft 365 Agents Toolkit CLI (`atk`) | Teams agent install – `install-teams-agent.ps1` installs it with npm if missing |

## Identity

All servers use **delegated Microsoft Entra ID** – the agent acts as the signed-in user. Service principals are not
supported by Fabric IQ MCP or the Ontology MCP endpoint. Use a demo account that only has access to demo workspaces.
