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
| *fetch failed*, or *The connection to api.fabric.microsoft.com dropped … not your access* | The network connection to Fabric or Power BI dropped (Wi-Fi, VPN, proxy) – not a permission problem | The studio already tries reads again a few times; try again in a moment, and check the VPN or proxy if it keeps happening |

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
| The desktop shortcut is gone | Uninstalling another copy of the studio (installer 1.42.53 and earlier) removed every shortcut named *Fabric MCP Studio*, even one that opens this copy | Run `.\scripts\create-shortcut.ps1` in this copy (add `-StartMenu` for the Start menu too). Fixed in 1.42.54: an uninstall removes only the shortcuts to its own copy |
| How do I stop the studio started from the icon? | It runs in the background, without a window | **Shut down** in the app. Starting the icon again while it runs just reopens the browser |
| *A newer version is installed – Restart now* at the top, or an action fails with *Not found* / *needs a restart* (for example the data source list) | The studio was updated on disk (git pull, files from another computer) while it was running: the pages are new, the server code is not | **Restart now** (wait for running jobs to finish first). A studio from before this version can't restart itself: **Shut down**, then start it again from the icon or `Start-Studio.cmd` |
| Command windows flash open and closed when you click in the studio | A studio restarted by version 1.30–1.32.24 runs without a hidden console, and each Azure CLI sign-in call opened a window | Fixed in 1.32.25: sign-in calls always run hidden and **Restart now** starts the studio in a hidden console, like the desktop icon. Restart once to get it |
| **Restart now** says *The new copy of the studio didn't start within 45 seconds, so this one keeps running* | The updated code couldn't start (for example a missing dependency after an update) | The studio keeps running the version you had. Look at the end of `studio/data/studio.restart.log` (or `studio.log` – the message names the file), fix the error (for example run `npm install` in `studio`), then **Restart now** again |
| After **Restart now** the studio doesn't come back (*Fabric MCP Studio didn't come back*) – version 1.33 or earlier, started from the desktop icon | The new copy couldn't write to `studio.log`, which the running copy still held open, so it never started, and the old copy stopped anyway | Start it again from the desktop icon. Fixed in 1.34.38: the new copy writes to the free log file, and the running copy stops only once the new one has started |
| *Forbidden: open the studio at http://127.0.0.1:4870/* | The page was opened with another host name (or a web page tried to reach the studio) | Open the studio at `http://127.0.0.1:<port>/` or `http://localhost:<port>/` – the desktop icon does this |
| The installer zip says *The repository or branch can't be read* | The repository is private and the GitHub account you signed in with (Git Credential Manager window) has no access to it | Ask the owner to give your GitHub account read access, or sign in with the right account (`git credential-manager github logout <account>` forgets the old one), then run the installer again |
| The installer says a tool *isn't available yet* after installing it | Windows updates the PATH for new windows only, or the install needs a sign-out | Close the window and run the installer again (it finds the tool then) |
| Binding live events to the ontology fails with *BackingColumnOrphanedByNameCollision* (*… name-collides with an authored property …*) | Studio 1.33 and earlier put every event column on the live table; Fabric now rejects a column with the same name as a property of the entity (Segment, Region, Category…) | Fixed in 1.34.37: the live table has only the key, time and the live measures. Update, then *Connect live events* (or apply the medallion layers) again |
| Chat says the AI provider isn't set up | Azure AI Foundry / Azure OpenAI is the default and needs the endpoint and deployment | **Settings › AI provider**: enter the endpoint and deployment (Microsoft Entra ID needs no key), **Save**, then **Test** |
| Copilot chat says *GitHub Copilot isn't signed in*, or *Session was not created with authentication info* | No GitHub sign-in with Copilot access. A `GITHUB_TOKEN` / `GH_TOKEN` environment variable set for other tools (without Copilot access) is skipped automatically and the GitHub CLI sign-in is used instead | **Settings › AI provider › Sign in with GitHub CLI**, or paste a token that has Copilot access, or choose another AI provider. *Check setup* shows which sign-in is used |
| OpenRouter: *didn't accept the API key*, *out of credits*, *rate-limiting* or *can't serve this model with tools* | The key is wrong or was lost when the studio restarted (it's kept in memory only), the account has no credits, a free model hit its limit, or the model can't call tools right now | Paste the key again, or set `OPENROUTER_API_KEY` once so it's always there. Add credits on openrouter.ai, or pick another model (search *free* for free ones, or use **Auto Router**) |

## Studio sign-in and tenants

| Symptom | Cause | Fix |
|---|---|---|
| Banner: *This project belongs to another tenant* | You signed in with an account from a different Microsoft Entra tenant than the one the project's workspace lives in | Sign in to the project's tenant, or select **Start a new project here** (nothing is deleted in Fabric) |
| Sign-in fails after setting a tenant ID while the Azure CLI has several accounts | `az account get-access-token --tenant` uses the default account | The studio picks an `az` account that belongs to that tenant; if there is none, run `az login --tenant <id> --allow-no-subscriptions` |

## Parts that can't run (red badge on the map)

| Symptom | Cause | Fix |
|---|---|---|
| Red badges on most parts of the map, *The workspace's capacity … is paused* | The Fabric capacity was paused (to save cost) | Resume it in the Azure portal (Microsoft Fabric capacity › Resume). The studio checks a paused capacity every minute and lights up again by itself (a toast says so); **Check again** checks right away |
| *… isn't on a Fabric capacity* | The workspace runs on Pro or Premium Per User only | Workspace settings › License info › assign a Fabric capacity (F SKU, Premium or trial) |
| *You're a Viewer in …* | Viewers can't create items | Ask a workspace admin for Contributor or higher, or use another workspace |
| *Tenant setting "…" is off* | A Fabric administrator turned the feature off | Ask the administrator to turn it on in Admin portal › Tenant settings; the banner links there |
| *Tenant setting "…" couldn't be checked* | Only Fabric administrators can read tenant settings | Nothing is blocked; confirm the listed settings with your administrator if a step fails |
| A part stays blocked after you fixed the cause | Results are kept for two minutes | Select **Check again** on its page, or **Check setup** |

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
| The model and reports disappeared from the map after choosing another data source | Each data source keeps its own items; the new one starts empty | Double-click **Data source** on the map and select *Use this source* on the earlier one – its items come back |
| *… is still running on the current data source* when switching | A job would otherwise write into the wrong source | Wait for the job (or cancel it in the job dock), then switch |
| *contains a duplicate value … not allowed for columns on the one side of a many-to-one relationship* | A dimension table has the same key more than once (often a load that ran twice) | **🩺 Check and fix the data** (Reports & apps) or **🩺 Check data** (model bar): it finds the tables, and removes exact copies in a Fabric warehouse with a backup. Otherwise fix the load (notebook, pipeline, source database) and refresh the model. Drop the `…_backup_…` table once the numbers look right |
| The check says every key is unique, but reports and recommendations still fail with the duplicate-value error | The model still holds the old rows: it was reloaded before the warehouse change reached OneLake | **🩺 Check data** shows *Model has older rows* → **↻ Reload the model**. If it still holds older rows, wait a few minutes and reload again |
| Recommendations say *over 53 years* or use week numbers as years, or *Time* shows numbers that aren't years | The date table's year column is hidden, or its name doesn't say year | The studio uses a hidden year column (it says so under *What we found*) and never takes *Week/Day/Month … of Year* columns. Without a year column in the date table, trend visuals are left out – add one |
| The Map page shows *The Azure Maps visual is disabled* (or an empty frame) | The tenant setting *Use Azure Maps visual* is off | Ask a Fabric admin to turn it on (Admin portal › Tenant settings › Integration settings); the report needs no change |
| Bubbles land in the wrong place (for example a city in another country) | Power BI geocodes the place names; a name alone can be ambiguous | Drill down from the country (the map starts there for this reason). In the model, set the column's data category (Country, State or Province, City…) or add latitude/longitude columns – the studio uses them next time |
| *Map: none* under *What we found*, or the Map page was left out | No location column splits the main measure (for example the geography table isn't related to the facts), or the columns aren't recognized by name | Relate the geography table to the facts, or give the columns a data category or a clear name (Country, State, City, Postal Code, Latitude, Longitude), then **↻ Refresh** |
| Everything is empty after choosing another workspace | Another workspace starts the project over | Choose the earlier workspace again only to start fresh there; its items are still in Fabric. Use **Clean up resources** before switching to delete them |
| A second data source's Eventhouse or plan has the source's name in it (`…_EH_ContosoRetailLive_…`) | Items each source can have once are kept apart by name when the workspace has several sources | Expected – each source keeps its own |

## Microsoft 365 Copilot agent (install-teams-agent.ps1)

| Symptom | Cause | Fix |
|---|---|---|
| `atk provision` says custom app upload or Copilot access is disabled | Tenant policy | Admin enables custom app upload for the installer (Teams admin center) and confirms a Microsoft 365 Copilot license |
| Agent asks to sign in, then shows *Need admin approval* | User consent restricted | Re-run with `-GrantAdminConsent` as an admin, or `az ad app permission admin-consent --id <appId>` |
| Every tool call returns 404 | OAuth registration bound to a specific app | The installer uses `applicableToApps: AnyApp`; if you edited it in the Teams developer portal, set *Restrict usage by app* to **Any Teams app** |
| Agent answers but can't find "Retail_SM_Sales_DEMO" (or your model) | User lacks access to the model, or wrong tenant | Grant the user Build/Read on the semantic model; install in the tenant that owns the Fabric workspace |
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
| The Business rules page is missing | No ontology rules or rule measures were found | Deploy the ontology (**Ontology** page), or add measures in a *Business rules* display folder of your model |
| Creating the org app fails | Org apps need a Fabric capacity workspace and Contributor or higher | Check the workspace role; the app shares only reports in the same workspace |
| People can't see the org app | No one is in its audience yet | Open it in Fabric, add people or groups to its audience and publish |
| The org app shows *No items to show* | The app has no audience: org apps show only what an audience includes. Apps created by studio 1.39.51 and earlier have none | **Reports & apps › Org app › Choose reports › Update app** – the studio adds the audience with the overview and the reports |
| A template upload says the file *isn't a ZIP package* | The file is damaged or isn't really a .pbit/.pbix/.zip (for example a OneDrive placeholder that hasn't downloaded) | Open it in Power BI Desktop and save it again, or make the file available offline first |
| *The file is larger than 300 MB* | A .pbix with a large data model | In Power BI Desktop: *File › Export › Power BI template* – the .pbit has the report without the data |
| *No Power BI report found in the ZIP* | The ZIP doesn't contain a report folder | Zip the project's `.Report` folder (it has `definition.pbir` and `report.json` or `definition/`), or zip a .pbit/.pbix |
| Visuals of a report built from your template show an error | The template uses fields your semantic model doesn't have (listed in *Use template* and in the job log) | Pick other fields for those visuals in Power BI, or add the measures/columns to the model and **Rebuild** |
| Visuals that use the automatic date hierarchy show an error | Direct Lake models don't have Power BI's *Auto date/time* tables | Use your date table's columns (Year, Month…) in those visuals |
| A custom visual from your template doesn't load | Private (organizational) custom visuals may need the tenant setting *Allow visuals created using the Power BI SDK* | Ask a Power BI admin, or use the AppSource version of the visual |

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
| Medallion: *The workspace task flow wasn't updated* | Task flows have no public API; a tenant policy or a portal change can block the studio's update | The layers still work. Select **Update layers** to retry, or apply Fabric's *Event medallion* task flow by hand and assign the items |
| Medallion: *Silver in OneLake* says *Not created yet* | OneLake publishes the Silver Delta table a few minutes after it is turned on | Select **Update layers** in a few minutes to add the lakehouse shortcut |
| Medallion: Gold semantic model says *Sign in needed* | Single sign-on couldn't be set on the model's Eventhouse data source | In Fabric, open the model › *Settings* › *Data source credentials* › *Edit credentials* › OAuth2, and allow report viewers to use their own identity |
| Medallion: *The last removal stopped half way* | Dropping the Silver tables took too long (OneLake copies are cleaned up too) | Select **Finish removing**, or apply the template again |

## Semantic models and task flows

| Symptom | Cause | Fix |
|---|---|---|
| An existing model shows *tables and measures not read yet* | The studio reads it with DAX (INFO.VIEW): you need Build permission on the model and its capacity must be running | Ask the model owner for Build permission (or resume the capacity), then **↻ Read again** on the Semantic model page |
| *"…" is an existing semantic model you added to the project* when creating a model | A model you added has that name; the studio never replaces it | Choose another name for the new model |
| *"…" is a report on another semantic model* | A report with that name belongs to another model in the project | Give this model's report another name (recommended reports already do) |
| *"…" is an existing report … that the studio didn't build* | A report already built on the model in Fabric has that name; the studio never changes it | Choose another name for the new report |
| An existing model shows no reports or data agents that you know are built on it | The studio looks in the model's workspace and the project workspace only; reading a data agent needs Contributor access to it (the job log says how many couldn't be read) | Run **↻ Look again** in the Semantic models pop-up; items in other workspaces aren't shown |
| Adding an existing model didn't set the data source | The project already had data, or the model's definition couldn't be read (needs write access to the model), or it reads more than one item | Connect the lakehouse or warehouse on the Data page (*Use in place*) |
| Planning says it *needs a model the studio built* | The active model is one you added; the Plan table goes next to the data a model reads | Switch to a model the studio built on the project's data |
| A model isn't on the task flow | Only items in the project workspace can be assigned (an existing model in another workspace stays off) | Expected – a task flow belongs to one workspace |
| Your own item didn't move to the box the studio suggests | Items you placed on a task in Fabric stay where you put them | Move it in Fabric, or leave it |
| *The workspace's task flows couldn't be read* | Task flows have no public API; the studio uses the portal's metadata service, which a tenant policy can block | Predesigned flows may still work; otherwise organize the items in Fabric |
| A box in your own task flow gets no items | The studio matches boxes by task type, name (Bronze, Silver, Gold, Semantic…) and position; *General* and *Develop data* boxes are manual only | Move items there with the menu next to each item |
## Planning

| Symptom | Cause | Fix |
|---|---|---|
| *Your semantic model reads … a mirrored database … nowhere to go* | A mirrored database is a read-only copy and the Direct Lake model reads every table from it, so the plan values can't be stored next to the data | Bring the mirrored tables into a lakehouse with OneLake shortcuts (Data page › Existing Fabric data › Create shortcuts), rebuild the model on it and plan again. Lakehouses, warehouses and SQL databases work directly; the preview always works |
| *Planning needs a date table with a year and a month number column* | The model has no date table related to the facts | Add a date table (marked as date table, with year and month number) and relate it to the facts |
| *… has N members – too detailed to plan* | The chosen dimension has more than 300 members | Plan by a higher level (region, category, segment) |
| *The semantic model can't be queried right now* | The workspace's Fabric capacity is paused or overloaded | Resume the capacity in the Azure portal, then try again |
| *The plan values … haven't reached OneLake yet* | The SQL database replica is still catching up | Build again in a few minutes – it continues where it stopped |
| The Fabric plan asks for a shared cloud connection, or says *Can't access the semantic model* or *DMTS connection owner missing* (SM_CONN_0001/0002/0003) | The plan uses the connection-based flow, which Microsoft deprecated for planning: it reads the model as the account saved in the shared connection | Don't use *Manage Connections*. In the plan, open a planning sheet › *Data* › *Add* › pick the model › *Connect* – it uses your own sign-in. A plan bound to a shared connection: **Planning › Plan in Fabric › Recreate without a connection** (only while it has no sheets). You need Read and Build on the model (SM_CONN_1003/0005): Contributor or higher in the workspace (**Who can plan**). *Check the plan* recreates a plan that points to an old model |
| *… is not available yet* when the plan is recreated | Fabric releases a deleted plan's name a minute or two later | The studio waits, then uses a numbered name; run *Check the plan* again later to keep the original name |
| Copilot can't create a data agent (*createItemRequest is a required parameter*) | Data agents were created with a generic Fabric tool | Use **Ask & share › Fabric data agent** (or ask Copilot to *suggest a data agent*) – the studio writes and publishes the definition |

## Repo location

Clone the repo **outside** OneDrive/SharePoint-synced folders. Sync clients and `.git` don't mix well.
