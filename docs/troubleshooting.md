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
| Local authoring can't reach a Fabric model, or `powerbi-authoring` says *Transaction commit failed … the current context is read-only* | XMLA endpoint read-only (the change was rolled back) | Capacity admin: **Admin portal › Capacity settings › Power BI workloads › XMLA endpoint = Read Write**. Creating and redeploying models through item definitions still works |
| Fabric IQ: 404/not available | Region or private link | Use `https://api.fabric.microsoft.com/v1/mcp/fabriciq` with private links; not available in Power BI-only regions or sovereign clouds |
| Ontology MCP 403 / not found | Wrong IDs, trial capacity, or preview not enabled | Check IDs in the ontology URL; paid F2+/P1+ capacity; ontology tenant setting |
| Agent tries to ask the ontology questions | `ask_ontology` enabled in the client | Ontology questions are turned off in this kit for now (the preview agent returned *No answer received from the agent* in testing). Keep only `list_ontology_entities` and `list_ontology_rules`; use Fabric IQ for numbers |

## AdventureWorksDW2022 sample (Fabric SQL database)

| Symptom | Cause | Fix |
|---|---|---|
| *Could not download the AdventureWorksDW install kit* | No internet access to github.com (proxy or firewall) | Allow `github.com` and `objects.githubusercontent.com`, or copy `AdventureWorksDW-data-warehouse-install-script.zip` from the [sql-server-samples release](https://github.com/microsoft/sql-server-samples/releases/tag/adventureworks) to `studio/data/cache/AdventureWorksDW-install-script.zip` |
| Creating the SQL database fails with *Forbidden* | Contributor or Viewer role | You need **Admin** or **Member** on the workspace (or let the studio create a new workspace) |
| *OneLake replication didn't finish in time* | Large capacity backlog | The data is already in the SQL database. Run the sample again: it keeps the verified data and only waits for the replica |
| Log shows *schema change of the target table – retrying* | Fabric started replicating a table while it was being loaded | Retried automatically; no action needed |
| Running the sample again | – | If the database already holds the complete, verified data it's reused; an incomplete load is removed and reloaded |

## Starting the studio

| Symptom | Cause | Fix |
|---|---|---|
| Double-clicking the desktop icon shows *Fabric MCP Studio could not start* | The server stopped during start-up (the dialog shows the last lines of `studio/data/studio.log`) | Fix the error shown, for example install Node.js 20.19+ or free the port. Run `Start-Studio.cmd` to see the full output in a console |
| Nothing opens and there is no message | Windows Script Host is turned off by policy | Run `.\scripts\create-shortcut.ps1` again: it detects this and creates a console shortcut. Or use `Start-Studio.cmd` |
| How do I stop the studio started from the icon? | It runs in the background, without a window | **Shut down** in the app. Starting the icon again while it runs just reopens the browser |
| Copilot chat says *GitHub Copilot isn't signed in*, or *Session was not created with authentication info* | No GitHub sign-in with Copilot access. A `GITHUB_TOKEN` / `GH_TOKEN` environment variable set for other tools (without Copilot access) is skipped automatically and the GitHub CLI sign-in is used instead | **Settings › AI provider › Sign in with GitHub CLI**, or paste a token that has Copilot access, or choose another AI provider. *Check setup* shows which sign-in is used |

## Studio sign-in and tenants

| Symptom | Cause | Fix |
|---|---|---|
| Banner: *This project belongs to another tenant* | You signed in with an account from a different Microsoft Entra tenant than the one the project's workspace lives in | Sign in to the project's tenant, or select **Start a new project here** (nothing is deleted in Fabric) |
| Sign-in fails after setting a tenant ID while the Azure CLI has several accounts | `az account get-access-token --tenant` uses the default account | The studio picks an `az` account that belongs to that tenant; if there is none, run `az login --tenant <id> --allow-no-subscriptions` |

## Tabs that can't run (red or amber dot)

| Symptom | Cause | Fix |
|---|---|---|
| Red dots on most tabs, *The workspace's capacity … is paused* | The Fabric capacity was paused (to save cost) | Resume it in the Azure portal (Microsoft Fabric capacity › Resume), then **Check again** |
| *… isn't on a Fabric capacity* | The workspace runs on Pro or Premium Per User only | Workspace settings › License info › assign a Fabric capacity (F SKU, Premium or trial) |
| *You're a Viewer in …* | Viewers can't create items | Ask a workspace admin for Contributor or higher, or use another workspace |
| *Tenant setting "…" is off* | A Fabric administrator turned the feature off | Ask the administrator to turn it on in Admin portal › Tenant settings; the banner links there |
| *Tenant setting "…" couldn't be checked* | Only Fabric administrators can read tenant settings | Nothing is blocked; confirm the listed settings with your administrator if a step fails |
| A tab stays blocked after you fixed the cause | Results are kept for two minutes | Select **Check again** on the tab, or **Check setup** |

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
| Numbers differ from the expected sample results | Different seed or definitions drifted from the glossary | Regenerate data with seed 42; compare measure DAX to the semantic-model skill |

## Microsoft 365 Copilot agent (install-teams-agent.ps1)

| Symptom | Cause | Fix |
|---|---|---|
| `atk provision` says custom app upload or Copilot access is disabled | Tenant policy | Admin enables custom app upload for the installer (Teams admin center) and confirms a Microsoft 365 Copilot license |
| Agent asks to sign in, then shows *Need admin approval* | User consent restricted | Re-run with `-GrantAdminConsent` as an admin, or `az ad app permission admin-consent --id <appId>` |
| Every tool call returns 404 | OAuth registration bound to a specific app | The installer uses `applicableToApps: AnyApp`; if you edited it in the Teams developer portal, set *Restrict usage by app* to **Any Teams app** |
| Agent answers but can't find "Retail Sales" | User lacks access to the model, or wrong tenant | Grant the user Build/Read on the semantic model; install in the tenant that owns the Fabric workspace |
| Ontology plugin errors | Wrong IDs or capacity too small | Use F2+/P1+; re-run with `-IncludeOntology -OntologyWorkspaceId … -OntologyItemId …`. The plugin exposes only `list_ontology_entities` and `list_ontology_rules` |
| Secret expired | Client secret older than `-SecretValidityMonths` | Delete `agents/contoso-retail-analyst/.deploy/env/.env.<env>.user` and re-run the installer (creates a new secret; the OAuth registration is updated with `oauth/update` in the Teams developer portal) |
| `atk validate` crashes when run from automation | It opens an interactive Microsoft 365 sign-in | Use `python scripts/validate-agent-package.py <zip>` for offline checks |

## Reports & apps

| Symptom | Cause | Fix |
|---|---|---|
| *Create the semantic model first* | Reports are built on the project's semantic model | Create it in **Semantic model** |
| Preview not available / *Export report … is disabled* | Tenant settings for exporting reports turned off | Open the report in Power BI. To get previews, a Fabric admin enables *Export reports as PDF documents* (or *as image files*) |
| A visual shows an error after you renamed measures | The report binds to measure and column names | **Rebuild** the report in **Reports & apps** |
| Month names sort alphabetically in your own model | The month-name column has no *Sort by column* | Set *Sort by column* to the month number in the model; models the studio generates do this automatically |
| Report building fails with *Forbidden* | You need Contributor or higher on the workspace and Build permission on the semantic model | Ask the workspace admin |
| The Business rules page is missing | No ontology rules or rule measures were found | Deploy the ontology (**Ontology** tab), or add measures in a *Business rules* display folder of your model |
| Creating the org app fails | Org apps need a Fabric capacity workspace and Contributor or higher | Check the workspace role; the app shares only reports in the same workspace |
| People can't see the org app | The app has no audience yet | Open it in Fabric, add an audience (people or groups) and publish |

## Real-time

| Symptom | Cause | Fix |
|---|---|---|
| *Create the semantic model first* | Live events are shaped like your model's data | Create it in **Semantic model** (the samples read their reference data from the source tables) |
| Setup fails creating the Eventhouse or Eventstream | Real-Time Intelligence items need a Fabric capacity (F2+ or trial) and Contributor or higher on the workspace | Check the capacity is running and your workspace role |
| *Eventstream … is Warning* | The Eventhouse destination couldn't start | Open the Eventstream in Fabric to see the error, then **Check setup** |
| *The table … already exists with different column types* | An earlier table with the same name but other columns | Use another Eventhouse name in **Set up live data** |
| Events are sent but the Eventhouse shows 0 | The Eventstream destination is still starting (about a minute after setup), or ingestion is catching up | Wait a minute; *In the Eventhouse now* refreshes every 15 seconds |
| *The Eventstream endpoint rejected the events (401)* | The custom endpoint key was rotated | Stop and start the events again (the studio reads the key again) |
| Dashboard tiles say *No results found* | No events in the selected time range | Start events, or widen the time range at the top of the dashboard |
| *No entity type's key matches a column of …* | The events don't carry any ontology entity key | Live properties need events with the entity key (for example `ProductKey`); for other models, bind in the ontology editor |
| Ontology *Instances* says the item kind couldn't be identified | The ontology was created before the studio tagged its tables | **Connect live events** (or re-deploy the ontology) – it tags every table with its source item |
| No Teams messages or emails from the alerts | No rule breaks since the alerts were created, the amount filter is too high, or the recipient isn't in your organization | Start events with some rule breaks; open the Activator › a rule › *History* to see activations; use work addresses in your tenant |
| *The name … is still reserved by a deleted item* | Fabric keeps a deleted item's name for a few minutes | The studio picks a numbered name automatically; or wait a few minutes |

## Planning

| Symptom | Cause | Fix |
|---|---|---|
| *Your semantic model reads a lakehouse … can't write plan values* | Plans are written next to the data, in a Fabric SQL database or a warehouse | Load the data into a SQL database or warehouse (or use the AdventureWorks sample); the preview still works |
| *Planning needs a date table with a year and a month number column* | The model has no date table related to the facts | Add a date table (marked as date table, with year and month number) and relate it to the facts |
| *… has N members – too detailed to plan* | The chosen dimension has more than 300 members | Plan by a higher level (region, category, segment) |
| *The semantic model can't be queried right now* | The workspace's Fabric capacity is paused or overloaded | Resume the capacity in the Azure portal, then try again |
| *The plan values … haven't reached OneLake yet* | The SQL database replica is still catching up | Build again in a few minutes – it continues where it stopped |
| The Fabric plan says *Can't access the semantic model* | The plan's semantic model connection was signed in with an account that can't open the model, or XMLA endpoints are off for the capacity | In the plan, select *Manage Semantic Model Connection* › *Create Connection* and sign in with an account that has Build permission on the model; check the capacity's XMLA endpoint is Read Only or Read Write |

## Repo location

Clone the repo **outside** OneDrive/SharePoint-synced folders. Sync clients and `.git` don't mix well.
