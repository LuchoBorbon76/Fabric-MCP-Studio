---
name: fabric-demo-lakehouse
description: Demo step 1 - create a Fabric workspace and lakehouse, upload the synthetic Contoso Retail files to OneLake, and load them as Delta tables, all from natural language. Use when the user asks to set up demo data, create the lakehouse, or "go from napkin to lakehouse".
---

# Napkin to lakehouse

Turn a one-paragraph business description into a populated lakehouse.

## Inputs (ask only for what is missing)

- Workspace name – default `Retail_WS_Analytics_DEMO` (naming standard, see AGENTS.md). Check `config/demo.state.json` first.
- Capacity – needed only when creating a new workspace. List the capacities the user can see and let them pick.
- Lakehouse name – default `Retail_LH_Raw_DEMO`.

## Steps

1. **Plan first.** Summarise what you will create (workspace? lakehouse? 6 tables) and wait for a "go".
2. **Workspace** (`fabric-core`): find by name; create on the chosen capacity if missing.
3. **Lakehouse** (`fabric-core`): find or create item type `Lakehouse` (schemas not enabled).
4. **Upload files** (`fabric-local` → `onelake_upload-file`): for each file in `data/retail/parquet/`, upload
   with `local-file-path` to `Files/raw/retail/<file>.parquet`. Use Parquet, not CSV – it keeps column types.
5. **Load tables**: there is no MCP tool for the Lakehouse *Load Table* API, so call it from the terminal for each
   file (table name = file name without extension):

   ```powershell
   az rest --method post --resource https://api.fabric.microsoft.com `
     --url "https://api.fabric.microsoft.com/v1/workspaces/<workspaceId>/lakehouses/<lakehouseId>/tables/<table>/load" `
     --body '{"relativePath":"Files/raw/retail/<table>.parquet","pathType":"File","mode":"Overwrite","formatOptions":{"format":"Parquet"}}'
   ```

   It returns 202 (long-running). Wait a few seconds per table before verifying.
   Fallback that does steps 2–5 idempotently: `.\scripts\deploy-fabric.ps1 -WorkspaceName "<name>"`.
6. **Verify** (`fabric-local` → `onelake_list-tables`): expect `customers, dates, products, returns, sales, stores`.
7. **Record state**: write `workspaceId`, `workspaceName`, `lakehouseId`, `lakehouseName` (and `createdWorkspace: true`
   if you created it) to `config/demo.state.json`.

## Expected row counts

customers 800 · products 94 · stores 18 · sales 22,812 · returns 1,025 · dates 1,461
