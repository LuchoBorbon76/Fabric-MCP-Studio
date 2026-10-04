# Microsoft Copilot Studio

Use Copilot Studio to give **business users** the governed "ask" experience (demo step 5) without installing anything.
Authoring (lakehouse, semantic model, ontology) stays with a builder client.

## 1. Register an Entra ID app (once per tenant)

Copilot Studio needs OAuth 2.0 settings for Fabric endpoints. Fastest path – let the installer for the Microsoft 365
agent create it for you (it creates a single-tenant app with the right permissions and prints nothing secret):

```powershell
.\scripts\install-teams-agent.ps1 -DryRun   # shows exactly what will be created
```

Or create it by hand ([reference](https://learn.microsoft.com/fabric/iq/connectors/fabric-iq-mcp#clients-that-require-an-app-registration)):

1. Entra admin center → **App registrations** → **New registration** → single tenant.
2. **API permissions** → *Power BI Service* → **Delegated**: `Item.Read.All`, `Item.Execute.All`, `Dataset.Read.All`.
3. Create a client secret. Add the redirect URI that Copilot Studio shows in the MCP wizard (step 2 below).

## 2. Add the MCP servers as tools

Agent → **Tools** → **Add a tool** → **New tool** → **Model Context Protocol**
([docs](https://learn.microsoft.com/microsoft-copilot-studio/mcp-add-existing-server-to-agent)).

| Server name | Server URL | Description to give the orchestrator |
|---|---|---|
| Fabric IQ | `https://fabriciq.svc.cloud.microsoft/v1/mcp/fabriciq` | Answers numeric business questions by querying the Retail_SM_Sales_DEMO Power BI semantic model with DAX. |
| Contoso Retail Ontology | `https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/<workspaceId>/items/<ontologyId>/ontologyEndpoint` | Explains Contoso Retail business entities, relationships and rules (at-risk customer, return window, minimum margin). |

After adding the ontology server, open its tool list and keep only **list_ontology_entities** and
**list_ontology_rules**. Turn off **ask_ontology**: ontology questions are turned off in this kit for now, and
every number comes from Fabric IQ.

Authentication: **OAuth 2.0 → Manual** (Microsoft Entra ID doesn't support dynamic client registration)

| Field | Value |
|---|---|
| Client ID / secret | From step 1 |
| Authorization URL | `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/authorize` |
| Token URL / Refresh URL | `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token` |
| Scope (both servers) | `https://api.fabric.microsoft.com/.default offline_access` |

> The scope comes from each endpoint's OAuth protected-resource metadata
> (`/.well-known/oauth-protected-resource/...` advertises `https://api.fabric.microsoft.com/.default`). The
> `.default` scope requests the delegated Power BI permissions granted to the app in step 1.

## 3. Instructions for the agent

```text
You are the Contoso Retail analyst. Use the Fabric IQ tool for any number and always use the existing measures
of the "Retail_SM_Sales_DEMO" semantic model. Use the Retail_ONT_Sales_DEMO tool to explain business definitions and
rules. Show which measure or rule you used. Never invent numbers.
```

## 4. Test and publish

Ask the sample questions from [the ask skill](../../.github/skills/fabric-demo-ask/SKILL.md), then publish to
Teams and Microsoft 365 Copilot.

> Prefer code over portal clicks? The repo also ships a ready-made **Microsoft 365 Copilot declarative agent** with
> the same tools that any tenant can install with one command – see [m365-copilot](../m365-copilot/README.md).
