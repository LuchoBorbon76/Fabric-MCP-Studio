# Microsoft Copilot Studio

Use Copilot Studio to give **business users** the governed "ask" experience (demo step 5) without installing anything.
Authoring (lakehouse, semantic model, ontology) stays with a builder client.

## 1. Register an Entra ID app (once per tenant)

Copilot Studio needs OAuth 2.0 settings for Fabric endpoints. Follow
[Fabric IQ MCP – clients that require an app registration](https://learn.microsoft.com/fabric/iq/connectors/fabric-iq-mcp#clients-that-require-an-app-registration):

1. Entra admin center → **App registrations** → **New registration** → single tenant.
2. **API permissions** → *Power BI Service* → **Delegated**: `Item.Read.All`, `Item.Execute.All`, `Dataset.Read.All`.
3. Create a client secret. Add the redirect URI that Copilot Studio shows in the MCP wizard (step 2 below).

## 2. Add the MCP servers as tools

Agent → **Tools** → **Add a tool** → **New tool** → **Model Context Protocol**
([docs](https://learn.microsoft.com/microsoft-copilot-studio/mcp-add-existing-server-to-agent)).

| Server name | Server URL | Description to give the orchestrator |
|---|---|---|
| Fabric IQ | `https://fabriciq.svc.cloud.microsoft/v1/mcp/fabriciq` | Answers numeric business questions by querying the Retail Sales Power BI semantic model with DAX. |
| Contoso Retail Ontology | `https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/<workspaceId>/items/<ontologyId>/ontologyEndpoint` | Explains Contoso Retail business entities, relationships and rules (at-risk customer, return window, minimum margin). |

Authentication: **OAuth 2.0 → Manual**

| Field | Value |
|---|---|
| Client ID / secret | From step 1 |
| Authorization URL | `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/authorize` |
| Token URL / Refresh URL | `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token` |
| Scopes – Fabric IQ | `https://analysis.windows.net/powerbi/api/Item.Read.All https://analysis.windows.net/powerbi/api/Item.Execute.All https://analysis.windows.net/powerbi/api/Dataset.Read.All offline_access` |
| Scopes – Ontology | `https://api.fabric.microsoft.com/.default offline_access` |

> Validate the scopes in your tenant before a customer session; endpoints and consent behaviour are still evolving
> for preview features. If your tool catalog already lists a first-party Fabric / Power BI MCP connector, prefer it.

## 3. Instructions for the agent

```text
You are the Contoso Retail analyst. Use the Fabric IQ tool for any number and always use the existing measures
of the "Retail Sales" semantic model. Use the Contoso Retail Ontology tool to explain business definitions and
rules. Show which measure or rule you used. Never invent numbers.
```

## 4. Test and publish

Ask the questions from [the ask skill answer key](../../.github/skills/fabric-demo-ask/SKILL.md), then publish to
Teams and Microsoft 365 Copilot ([m365-copilot](../m365-copilot/README.md)).
