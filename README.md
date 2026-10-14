# Mockman

A Chrome DevTools extension for mocking network responses — with a **nested folder
tree**, **tags**, independent enable/disable at every level, **request-body matching**,
**artificial latency**, automatic **per-tab scoping**, and **MCP access** so AI agents
can drive every feature.

Built because DevTools' own Local Overrides has none of that: no organisation, no
tagging, no way to switch a slice of mocks on and off, no tab scoping, and no
programmatic access.

## Quickstart

```bash
pnpm install; pnpm build
```

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `extension/dist`.
2. Open a page, press **F12**, choose the **Mockman** tab.
3. That tab is now mocked, for as long as the panel stays open.
4. Add a folder and a mock with the toolbar buttons, and set a pattern like `*/api/*`.
   Or hit **mock it** on any row in the log at the bottom to capture a real request —
   url, status, headers and the response body it actually returned — so you start by
   editing reality instead of retyping it.

No Node installed? You only need pnpm — see
[docs/01-windows-setup.md](docs/01-windows-setup.md). The repo pins its own Node
version and pnpm downloads it for you.

## MCP

```bash
pnpm mcp-config
```

Prints ready-to-paste config for Claude Code, Codex, Cursor, Windsurf, VS Code, Zed
and Claude Desktop, with real absolute paths filled in. A project-scoped `.mcp.json`
is already committed for Claude Code.

Full tool reference: [docs/06-mcp.md](docs/06-mcp.md).

Agent skill: [skills/mockman/SKILL.md](skills/mockman/SKILL.md) is a vendor-neutral
prompt that teaches any AI client how to use these tools well. Drop the `mockman`
folder into your client's skills directory (e.g. `.claude/skills/`), or paste the file
into a system or project prompt.

## Three things that will surprise you

- **Mocked requests do not appear in the DevTools Network panel.** They never reach
  the network, so Chrome has nothing to display. Use the panel's **Hit log**.
- **Globs are anchored to the whole URL.** `*/api/users`, not `/api/users`. The panel
  has a live pattern tester for this.
- **A tab is mocked only while its panel is open.** There is no tab picker: opening
  the panel on a tab is how you choose it, and closing it stops the mocking.

## Documentation

Start at [docs/README.md](docs/README.md). Written for someone new to PowerShell,
Chrome extensions and MCP alike.

| Page | |
|---|---|
| [01 Windows setup](docs/01-windows-setup.md) | Toolchain from nothing, PowerShell survival guide |
| [02 Project structure](docs/02-project-structure.md) | Folders, the pnpm workspace |
| [03 Chrome extension primer](docs/03-chrome-extension-primer.md) | MV3 from zero, execution worlds, the four consoles |
| [04 Architecture](docs/04-architecture.md) | Components, message flows, enablement rules |
| [05 Interception](docs/05-interception.md) | How mocking works — and its limits |
| [06 MCP](docs/06-mcp.md) | Tool reference, per-client config |
| [07 Development workflow](docs/07-development-workflow.md) | Build, reload, debug, test |
| [08 Troubleshooting](docs/08-troubleshooting.md) | Symptom → cause → fix |
| [09 Data model](docs/09-data-model.md) | Schema reference |

## Layout

```
shared/       data model, tree, matcher, enablement, mutations, search, migration
              (used verbatim by both sides)
extension/    the MV3 extension: panel, service worker, interception
mcp-server/   vendor-neutral MCP server + WebSocket bridge
docs/         the above
```

## How it works, in one paragraph

`chrome.debugger` cannot attach to a tab that already has DevTools open, and
`declarativeNetRequest` cannot supply a response body — so mocking is done by patching
`fetch`, `XMLHttpRequest` and `EventSource` inside the page's own JavaScript world at
`document_start`. A second content script in the isolated world ferries config in,
because main-world code has no access to `chrome.*`. The service worker owns all state;
the panel and the MCP server are both just clients of it, which is why a mock created
by an agent shows up in the UI instantly. Details in
[docs/04](docs/04-architecture.md) and [docs/05](docs/05-interception.md).
