# Troubleshooting

## Connections

| Symptom | Likely cause | Fix |
|---|---|---|
| No MCP tools in GitHub Copilot (Business/Enterprise) | Org policy off | Admin enables **MCP servers in Copilot** |
| Two sets of Power BI authoring tools | Hosted and local both registered (or the `powerbi-authoring` plugin + hosted) | Re-run `setup.ps1` with one `-PowerBIAuthoring` option |
| `fabric-local` won't start | Node.js missing, proxy blocks npm | Install Node LTS; set `npm config set proxy …`; run `prereq-check.ps1` |
| Claude Code on Windows can't start `npx` servers | Needs a shell wrapper | `setup.ps1 -Client claude-code` writes `cmd /c npx …` automatically |
| Local Power BI server blocks every tool | EULA not accepted | Approve the `accept_eula` tool call once |
| `powerbi-authoring` 403 | Tenant setting off or no Write permission | Enable *Users can use the Power BI Model Context Protocol server endpoint*; get Write on the model |
| Local authoring can't reach a Fabric model | XMLA endpoint read-only | Capacity setting → XMLA endpoint **Read Write** |
| Fabric IQ: 404/not available | Region or private link | Use `https://api.fabric.microsoft.com/v1/mcp/fabriciq` with private links; not available in Power BI-only regions or sovereign clouds |
| Ontology MCP 403 / not found | Wrong IDs, trial capacity, or preview not enabled | Check IDs in the ontology URL; paid F2+ capacity; ontology tenant setting |

## OAuth and app registrations

Some MCP clients can't use dynamic client registration with Microsoft Entra ID. Symptoms: the sign-in window never
opens, or it fails with an invalid client error. Fix: create a **single-tenant app registration**
([steps](https://learn.microsoft.com/fabric/iq/connectors/fabric-iq-mcp#clients-that-require-an-app-registration)),
add the client's redirect URI and delegated permissions, then give the client ID (and tenant ID) to the client.
GitHub Copilot (VS Code and CLI) uses a preregistered app and doesn't need this.

Never put a bearer token in an MCP config – a static `Authorization` header overrides interactive OAuth and breaks
when it expires.

## Data and items

| Symptom | Cause | Fix |
|---|---|---|
| Load Table fails | Lakehouse created with schemas enabled, or path typo | Use a lakehouse without schemas; path must be `Files/raw/retail/<table>.parquet` |
| Columns typed as string | CSV loaded instead of Parquet | Load `data/retail/parquet/*.parquet` |
| Semantic model can't see tables | SQL endpoint still syncing | Wait 1–2 minutes, refresh metadata |
| Fabric IQ answers don't change after edits | Model not refreshed / reframed | Refresh the semantic model |
| `deploy-ontology.ps1`: SQL endpoint not provisioned | New lakehouse | Wait a minute and re-run |
| Ontology update rejected (parse error) | Spaces instead of tabs, missing `ref` in `model.tmdl`, colon in a rule statement | `deploy-ontology.ps1 -DryRun`, decode the part, fix, redeploy |
| Numbers differ from the answer key | Different seed or definitions drifted from the glossary | Regenerate data with seed 42; compare measure DAX to the semantic-model skill |

## Repo location

Clone the repo **outside** OneDrive/SharePoint-synced folders. Sync clients and `.git` don't mix well.
