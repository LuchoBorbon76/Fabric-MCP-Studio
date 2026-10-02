# Bring your own Copilot

The MCP servers are identical for every customer. **The AI client – and therefore the license – is the customer's
choice.** Fabric capacity runs the data; the client's model does the reasoning. No Fabric Copilot capacity is
required for this demo.

| Client | License the customer needs | Config | Set up | Best for |
|---|---|---|---|---|
| **GitHub Copilot in VS Code** | GitHub Copilot Free, Pro, Pro+, Business or Enterprise | `.vscode/mcp.json` (committed) | `.\scripts\setup.ps1 -Client vscode` | Builders; the full demo |
| **GitHub Copilot CLI** | GitHub Copilot Pro, Pro+, Business or Enterprise | `~/.copilot/mcp-config.json` ([template](copilot-cli/mcp-config.json)) | `.\scripts\setup.ps1 -Client copilot-cli` | Terminal-first builders, Skills for Fabric plugins |
| **Claude Code** | Anthropic plan or API key | `.mcp.json` (committed) | `.\scripts\setup.ps1 -Client claude-code` | Teams standardised on Claude |
| **Cursor** | Cursor plan with agent mode | `.cursor/mcp.json` (committed) | `.\scripts\setup.ps1 -Client cursor` | Teams standardised on Cursor |
| **Copilot Studio** | Copilot Studio (capacity or pay-as-you-go) | Portal | [copilot-studio/](copilot-studio/README.md) | Business-facing agents built in the portal |
| **Microsoft 365 Copilot** (Teams, Outlook, Copilot app) | Microsoft 365 Copilot | Ready-made agent in [agents/](../agents/contoso-retail-analyst/README.md) | `.\scripts\install-teams-agent.ps1` | "Ask anywhere" finale – one command, any tenant |
| **Azure AI Foundry agent** | Azure subscription + any deployed model | Portal / SDK | [azure-ai-foundry/](azure-ai-foundry/README.md) | Customers who want their own model, network and compliance controls |

## Which servers each client gets

| Server | Builders (VS Code, CLI, Claude Code, Cursor) | Consumers (Copilot Studio, M365 Copilot, Foundry) |
|---|---|---|
| `fabric-core` | ✅ | optional (admin scenarios) |
| `fabric-local` | ✅ (stdio – needs Node.js) | ❌ (portal clients need remote servers) |
| `powerbi-authoring` | ✅ hosted *or* local | ❌ (authoring is a builder task) |
| `fabric-iq` | ✅ | ✅ |
| `fabric-ontology` | ✅ after step 4 | ✅ |

## Choosing a model

Pick a **deep-reasoning** model from whatever the license offers. Model choice has a large effect on result
quality for semantic modeling. Cheaper/faster models are fine for the read-only "ask" step.

## License and policy gotchas

- **GitHub Copilot Business/Enterprise:** an org or enterprise admin must enable the **MCP servers in Copilot**
  policy, otherwise MCP tools don't appear.
- **Copilot Free** works for individual evaluation within its monthly limits; use a paid plan for live customer demos.
- Every client signs in to Fabric as the **user** (Microsoft Entra ID). Fabric permissions, RLS and OLS always apply,
  regardless of which AI client is used.
- Clients that can't use dynamic client registration with Entra ID need a single-tenant app registration – see
  [docs/troubleshooting.md](../docs/troubleshooting.md#oauth-and-app-registrations).
