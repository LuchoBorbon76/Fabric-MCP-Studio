# Demo control panel

A single, self-contained HTML page for presenters and customers: run of show with copy-ready prompts, a "choose your
Copilot" picker that tailors setup steps, the answer key, and the MCP server list. No server, no sign-in, no external
requests – it works offline and in any modern browser.

## Open it

```powershell
.\scripts\open-control-panel.ps1                    # links buttons to your workspace from config/demo.state.json
.\scripts\open-control-panel.ps1 -Client m365-copilot
```

The script writes `control-panel/local.html` (git-ignored) with your workspace, lakehouse and ontology IDs so the
**Open workspace / lakehouse / ontology** buttons and the Ontology MCP URL point at your tenant. You can also open
`index.html` directly – it works without IDs.

## Features

- **Run of show** – five acts with timing, the skill used, MCP servers involved, prompt (copy button), wow moment,
  expected result, and the script fallback. Tick acts as done; progress and the selected client persist in the URL.
- **Choose your Copilot** – GitHub Copilot (VS Code / CLI), Claude Code, Cursor, Microsoft 365 Copilot / Teams,
  Copilot Studio, Azure AI Foundry. Ask-only clients are flagged on the acts that need a builder client.
- **Setup** – prerequisites, client-specific commands, the Teams agent installer, plan B and tenant checklist.
- **Answer key** – 15 questions with expected values and the measure or rule behind each.
- **MCP servers** – endpoints and roles; the Ontology URL is filled in when IDs are available.
- Presenter timer, light/dark theme, print-friendly layout.

## Customize

Edit the `CLIENTS`, `ACTS`, `ANSWERS` and `SERVERS` arrays at the bottom of `index.html`.
