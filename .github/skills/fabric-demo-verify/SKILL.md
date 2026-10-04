---
name: fabric-demo-verify
description: Verify that the Fabric demo MCP servers (fabric-core, fabric-local, powerbi-authoring, fabric-iq, fabric-ontology) are connected and authenticated. Use before a demo, after running scripts/setup.ps1, or when a Fabric/Power BI MCP tool call fails.
---

# Verify the demo MCP connections

Run one **read-only** call per configured server and report a status table. Do not create or change anything.

## Steps

1. Read the MCP configuration your client is using (for example `.vscode/mcp.json`, `.mcp.json`,
   `.cursor/mcp.json`, or `~/.copilot/mcp-config.json`) and list the demo servers that are configured.
2. For each configured server, make one harmless call:

   | Server | Call | Pass when |
   |---|---|---|
   | `fabric-core` | List my workspaces | A list (or empty list) returns |
   | `fabric-local` | List the Fabric item types with public API specs | Returns item types such as `lakehouse`, `semanticModel`, `ontology` |
   | `powerbi-authoring` | Describe the available authoring operations (do **not** connect to a model yet) | Tool list returns |
   | `fabric-iq` | DiscoverArtifacts for "Retail_SM_Sales_DEMO" | Returns results or "none found" without an auth error |
   | `fabric-ontology` (optional) | List entity types | Returns `Customer`, `Product`, `Store`, `Sale`, `ProductReturn` |

3. If `config/demo.state.json` exists, show the workspace, lakehouse and ontology IDs it contains.
4. Output a table: server · status (✅/⚠️/❌) · evidence (one line) · fix.

## Common fixes

- **Sign-in prompt never appears / 401** – restart the server from the client's MCP panel and sign in with the
  Entra ID **work** account that has Fabric access.
- **`fabric-local` fails to start** – Node.js LTS is missing or `npx` is blocked by a proxy. Run `scripts/prereq-check.ps1`.
- **`powerbi-authoring` 403** – tenant setting *Users can use the Power BI Model Context Protocol server endpoint* is off.
- **GitHub Copilot Business/Enterprise shows no MCP tools** – an org admin must enable the *MCP servers in Copilot* policy.
- **Two authoring tool sets visible** – both hosted and local authoring servers are registered; re-run
  `scripts/setup.ps1` and pick one.

See [docs/troubleshooting.md](../../../docs/troubleshooting.md) for more.
