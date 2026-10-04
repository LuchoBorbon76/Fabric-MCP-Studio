# Microsoft 365 Copilot (Teams, Outlook, Copilot app)

The repo ships **Contoso Retail Analyst**, a Microsoft 365 Copilot *declarative agent* that calls the Fabric IQ MCP
server (and optionally the Ontology MCP server). Any customer can install it in their own tenant with one command – no
portal clicks, nothing tenant-specific in the repo.

Source: [agents/contoso-retail-analyst](../../agents/contoso-retail-analyst/README.md)

## Install

```powershell
az login                                          # an account in the target tenant
.\scripts\install-teams-agent.ps1 -DryRun         # preview + offline package validation, no changes
.\scripts\install-teams-agent.ps1                 # create Entra app, register OAuth, sideload the agent for you
```

After the ontology exists (act 4):

```powershell
.\scripts\install-teams-agent.ps1 -IncludeOntology
```

Roll out to everyone (tenant app catalog, admin approves in the Microsoft 365 admin center):

```powershell
.\scripts\install-teams-agent.ps1 -Publish
```

Remove it:

```powershell
.\scripts\install-teams-agent.ps1 -Uninstall -DeleteEntraApp
```

## Use

1. Open <https://m365.cloud.microsoft/chat> (or Teams → Copilot) and pick **Contoso Retail Analyst** under *Agents*.
2. Choose a conversation starter, for example *"How many at-risk customers do we have…"*.
3. On first use select **Sign in** and accept the Power BI permissions.

## Requirements

| Requirement | Why |
|---|---|
| Microsoft 365 Copilot license | Run declarative agents |
| *Custom app upload* and *Copilot access* enabled for the installer | Sideload (`atk provision`) |
| Permission to create Entra app registrations (or pass `-ClientId` for an existing app) | OAuth client for the agent |
| Admin consent for the delegated Power BI permissions, if user consent is restricted | `-GrantAdminConsent` or an admin runs `az ad app permission admin-consent --id <appId>` |
| Access to the Retail_SM_Sales_DEMO semantic model (and ontology) | Fabric permissions and RLS apply to every answer |
