# GitHub Copilot CLI

`mcp-config.json` in this folder is the rendered template. Copilot CLI reads MCP servers from the **user** config
(`%USERPROFILE%\.copilot\mcp-config.json` on Windows, `~/.copilot/mcp-config.json` on macOS/Linux), so don't copy it
by hand – merge it safely:

```powershell
.\scripts\setup.ps1 -Client copilot-cli                       # hosted Power BI authoring
.\scripts\setup.ps1 -Client copilot-cli -PowerBIAuthoring plugin   # if you install the powerbi-authoring plugin
```

The script keeps your existing servers, replaces only the demo keys, and writes a timestamped backup.

## Recommended add-ons

```text
/plugin marketplace add microsoft/skills-for-fabric
/plugin install fabric-skills@fabric-collection
/plugin install powerbi-authoring@fabric-collection
```

The `powerbi-authoring` plugin bundles the **local** Power BI authoring server. If you install it, run setup with
`-PowerBIAuthoring plugin` so the hosted server isn't registered as well (two overlapping tool sets confuse routing).

## Verify

```text
copilot          # from the repo root - .github/skills are picked up automatically
/mcp             # authenticate each HTTP server with your Entra ID work account
Use the fabric-demo-verify skill to check my MCP connections.
```
