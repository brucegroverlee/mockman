# Network Mock — documentation

A Chrome DevTools extension for mocking network responses, with a **nested folder
tree**, **tags**, independent **enable/disable** at every level, **request-body
matching**, **artificial latency**, automatic **per-tab scoping**, and **MCP access**
so AI agents can drive all of it.

These docs assume **no prior knowledge** of PowerShell, Chrome extensions, or MCP.
If a page uses a term without explaining it, that is a bug — please fix it.

## Read in this order

| # | Page | What it covers |
|---|------|----------------|
| 01 | [Windows setup](01-windows-setup.md) | PowerShell survival guide, installing the toolchain from nothing |
| 02 | [Project structure](02-project-structure.md) | What every folder is for, how the pnpm workspace fits together |
| 03 | [Chrome extension primer](03-chrome-extension-primer.md) | MV3 from zero: service workers, content scripts, worlds, the four consoles |
| 04 | [Architecture](04-architecture.md) | The five components, how they talk, the enablement rules |
| 05 | [Interception](05-interception.md) | How mocking actually works — **and its limits** |
| 06 | [MCP](06-mcp.md) | What MCP is, the tool reference, config for every client |
| 07 | [Development workflow](07-development-workflow.md) | Build, reload, debug |
| 08 | [Troubleshooting](08-troubleshooting.md) | Symptom → cause → fix |
| 09 | [Data model](09-data-model.md) | Schema reference |

## Five-minute quickstart

Already have the toolchain? From the repo root:

```bash
pnpm install; pnpm build
```

Then:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select `extension/dist`.
3. Open any web page, press **F12**, and pick the **Network Mock** tab.
4. That tab is now being mocked, and stays so while the panel is open.
5. Use the toolbar above the tree to add a folder and a mock, and set the URL pattern
   to something like `*/api/*`. Folders nest as deep as you like.
6. Reload the page. The **Hit log** at the bottom shows what was mocked — and offers
   **mock it** on every real request, which captures it response and all.

> **The single most surprising thing:** a mocked request never reaches the
> network, so it does **not** appear in the DevTools **Network** panel at all. The
> Hit log is where you see it. See [05-interception](05-interception.md).

## Three things that will save you an hour

1. **Only tabs with the panel open are mocked.** This is deliberate — it stops the
   extension quietly altering every tab in your browser. Close the panel and that tab
   goes back to the real network.
2. **A glob is matched against the whole URL.** `/api/users` will not match
   `https example.com/api/users`; write `*/api/users`. The panel has a live
   pattern tester for exactly this reason.
3. **A disabled tag beats everything.** If a mock looks enabled but is not firing,
   check whether a tag on it — or on a folder above it — is switched off. The greyed
   row carries a `!`; hover it for the reason.
