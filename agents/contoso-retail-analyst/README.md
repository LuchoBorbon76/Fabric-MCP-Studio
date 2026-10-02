# Contoso Retail Analyst – Microsoft 365 Copilot agent

A declarative agent for Microsoft 365 Copilot (Teams, Outlook, Microsoft 365 Copilot app) that answers governed
business questions through **MCP**:

| Action | MCP server | Always on? |
|---|---|---|
| `fabric-iq-plugin.json` | Fabric IQ – `https://fabriciq.svc.cloud.microsoft/v1/mcp/fabriciq` | Yes |
| `ontology-plugin.json` | Ontology – `…/workspaces/<ws>/items/<ontology>/ontologyEndpoint` | Added with `-IncludeOntology` |

Both use **dynamic tool discovery** (`run_for_functions: ["*"]`), so new server tools appear without republishing,
and **OAuth (static registration)** with delegated Microsoft Entra ID – the agent queries Fabric *as the user*.

## Install (any tenant)

Use the installer from the repo root – it does everything below for you:

```powershell
.\scripts\install-teams-agent.ps1 -DryRun
.\scripts\install-teams-agent.ps1
```

What it does:

1. Creates a single-tenant Entra app *Contoso Retail Analyst (Fabric MCP demo)* with delegated Power BI Service
   permissions `Item.Read.All`, `Item.Execute.All`, `Dataset.Read.All`, redirect URI
   `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect`, and a client secret.
2. Copies this folder to `.deploy/` (git-ignored), adds the ontology plugin if requested, and writes
   `env/.env.<env>` (IDs) and `env/.env.<env>.user` (secret).
3. Runs `atk provision`: creates the Teams app registration, registers the OAuth configuration in the tenant's
   Enterprise token store (`oauth/register`, PKCE on, any app, home tenant), packages, validates and sideloads.

## Files

| File | Purpose |
|---|---|
| `m365agents.yml` | Microsoft 365 Agents Toolkit lifecycle (provision / publish) |
| `appPackage/manifest.json` | Microsoft 365 app manifest v1.30 |
| `appPackage/declarativeAgent.json` | Declarative agent v1.8: name, conversation starters, actions |
| `appPackage/instruction.txt` | Agent instructions (governed answers, cite measures/rules, no invented numbers) |
| `appPackage/*-plugin.json` | Plugin manifests v2.4 with `RemoteMCPServer` runtimes |
| `env/.env.dev` | Non-secret defaults (publisher name, URLs). Override per environment. |
| `evals/prompts.json` | Expected answers for Agents Toolkit evaluations |

## Customize for a customer

- Rename the agent and change conversation starters in `declarativeAgent.json` and `manifest.json`.
- Point `instruction.txt` at the customer's semantic model name and glossary.
- Set publisher info with `-PublisherName` / `-ContactEmail` or in `env/.env.<env>`.
- Replace `appPackage/color.png` (192×192) and `outline.png` (32×32, white on transparent).

## Validate without signing in

```powershell
python scripts/validate-agent-package.py agents/contoso-retail-analyst/.deploy/appPackage/build/appPackage.dev.zip
```

`atk validate` uses the Teams Developer Portal and needs a Microsoft 365 sign-in; the script above checks the package
offline against the published JSON schemas.
