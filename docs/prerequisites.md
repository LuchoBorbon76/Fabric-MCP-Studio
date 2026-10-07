# Prerequisites

Run `.\scripts\prereq-check.ps1 -CheckFabric` for the parts that can be checked automatically.

## Microsoft Fabric

| Requirement | Why | Notes |
|---|---|---|
| Fabric capacity (trial or paid) | Lakehouse, semantic model | A Fabric trial is enough for steps 1–3. |
| **Paid F2+ or P1+** capacity | Ontology MCP endpoint (entities and rules for agents) | Ontology questions (`ask_ontology`) are turned off in this kit for now; numbers come from Fabric IQ. |
| Workspace **Contributor** (or higher) | Create items | `deploy-fabric.ps1` can create a new workspace for you. |
| Workspace **Admin** or **Member** | AdventureWorksDW2022 sample (creates a Fabric SQL database) | SQL database in Fabric is enabled by default. Workspaces the studio creates make you Admin. |
| Internet access to `github.com` | AdventureWorksDW2022 sample | The studio downloads Microsoft's AdventureWorksDW install kit (17 MB) once and caches it in `studio/data/cache`. |
| **Write** permission on the semantic model | Power BI authoring | Build-only permission allows DAX queries only. |
| Tenant home region supports all Fabric workloads | Fabric IQ MCP | Not available in Power BI-only regions or sovereign clouds. |

### Tenant settings (Fabric admin portal)

The studio checks these for you when you are a Fabric administrator (*Check setup*, the overview and a badge on each part
of the solution map that can't run); otherwise each page lists the settings to confirm with your administrator.

| Setting | Needed for |
|---|---|
| Users can create Fabric items | SQL database sample, ontology, Eventhouse, Eventstream, Activator, plan |
| Users can create Ontology (preview) items | Ontology steps |
| Semantic Model Execute Queries REST API | Reports, planning, Copilot answers from the model |
| **Users can use the Power BI Model Context Protocol server endpoint** | Hosted Power BI Authoring MCP |
| Allow non-Entra ID auth in Eventstream | Live events (simulator and your own apps send with an Eventstream key) |
| Allow XMLA endpoints and Analyze in Excel with on-premises semantic models | The plan in Fabric planning |
| Export reports as PowerPoint presentations or PDF documents | Report previews |
| Users can use Copilot, AI Agents and other AI experiences powered by Azure OpenAI | Fabric IQ answers and agents |
| Enable Microsoft Teams integration | Teams agent |
| XMLA endpoint = **Read Write** on the capacity | Saving changes to existing semantic models with Power BI authoring (hosted **and** local), and the plan in Fabric planning (Read Only is enough there). Reading, DAX queries and creating models work with Read Only. Not readable through an API – check Admin portal › Capacity settings |

The workspace's capacity must be **running**: a paused capacity blocks every step that reads or changes Fabric, and the
studio says so up front. It checks a paused capacity every minute and lights up again by itself once it is resumed.

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
| Node.js LTS (20.19+) | Fabric MCP Studio, `fabric-local` and local Power BI authoring servers (`npx`) |
| Git | Ontology-as-code step, cloning the repo |
| PowerShell 5.1+ (7 recommended) | Scripts |
| Azure CLI (`az login`) | `deploy-*.ps1` / `reset.ps1` fallbacks and the `az rest` Load Table call |
| Python 3.10+ and `pyarrow` | Only to regenerate the sample data |
| Microsoft 365 Agents Toolkit CLI (`atk`) | Teams agent install – `install-teams-agent.ps1` installs it with npm if missing |

## Identity

All servers use **delegated Microsoft Entra ID** – the agent acts as the signed-in user. Service principals are not
supported by Fabric IQ MCP or the Ontology MCP endpoint. Use a demo account that only has access to demo workspaces.
