# 06 — MCP access

## What MCP is

The Model Context Protocol is an open standard that lets an AI agent call tools in
another program. A **server** exposes tools; a **client** (Claude Code, Codex, Cursor,
Windsurf, VS Code, Zed, or something you wrote) connects and calls them.

Our server is deliberately **vendor-neutral**. Nothing in it is specific to any
assistant; it speaks the standard protocol over the standard transports.

## Why the connection runs backwards

An MV3 service worker **cannot listen on a port**. So the usual arrangement is
inverted:

```
   MCP client  ──stdio/HTTP──▶  MCP server  ◀──WebSocket──  Chrome extension
   (the agent)                  (Node)          (dials in)   (service worker)
```

The MCP server owns a WebSocket server on `127.0.0.1:8787`, and the extension dials
*out* to it, retrying with exponential backoff.

Consequences worth knowing:

- Either side works alone. No MCP server? The extension is fully functional. No
  Chrome? The server starts and every tool returns a clear "not connected" error
  rather than hanging.
- The extension reconnects by itself. Restart the server and you do not need to touch
  Chrome.

## Setting it up

Build first — the config points at a built file:

```bash
pnpm build
```

Then print the config for your client, with real absolute paths filled in:

```bash
pnpm mcp-config
```

Or for just one:

```bash
pnpm mcp-config codex
```

Valid names: `claude-code`, `cursor`, `windsurf`, `claude-desktop`, `codex`,
`vscode`, `zed`, `http`.

### Where each client keeps its config

Most clients share the same `mcpServers` shape, so it is the same snippet in different
files. **Two differ** — those are called out:

| Client | Location | Shape |
|---|---|---|
| Claude Code | `.mcp.json` in the repo (**already committed here**) or `claude mcp add` | `mcpServers` |
| Cursor | `.cursor/mcp.json`, or `~/.cursor/mcp.json` globally | `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` |
| **Codex** | `~/.codex/config.toml`, or `.codex/config.toml` in a trusted project | **TOML**, and the key is **`mcp_servers`** |
| **VS Code** | `.vscode/mcp.json` | **`servers`**, not `mcpServers` |
| Zed | Zed settings | `context_servers` |

Because a project-scoped `.mcp.json` is committable, this repo ships one. Clone,
`pnpm build`, and Claude Code picks it up with no hand-editing. (The absolute paths in
it are specific to this checkout — regenerate with `pnpm mcp-config` if you move the
repo.)

### Windows: why the config points at `node.exe` by absolute path

This is the most common reason an MCP server "will not start" on Windows, and it is
worth understanding rather than cargo-culting.

- MCP clients spawn the server **without a shell**. Node's mitigation for
  CVE-2024-27980 refuses to execute `.bat`/`.cmd` files that way, so a `command` of
  `npx`, `pnpm` or `yarn` — all `.cmd` shims — fails with `spawn EINVAL` or
  `spawn ENOENT`.
- GUI-launched editors inherit a **different, often truncated PATH** from your
  terminal, frequently with no Node on it at all.

Pointing at a real `.exe` by absolute path sidesteps both. `pnpm mcp-config` emits
`node_modules\.bin\node.exe` from this repo — a genuine executable, and the exact
pinned Node version.

That file exists only after `pnpm install`. If you move or re-clone the repo,
regenerate the config.

## Transports

**stdio** (default) — the client launches the server as a child process and talks over
its stdin/stdout. Universally supported; use this unless you have a reason not to.

**Streamable HTTP** — for clients configured by `url`, or to attach several agents at
once:

```bash
node mcp-server/dist/index.js --http
```

Listens on `127.0.0.1:8788`. Loopback only.

### stdout is sacred in stdio mode

In stdio mode **stdout carries JSON-RPC framing and nothing else**. One stray
`console.log` desynchronises the stream, and clients report an opaque "failed to
start" with no hint as to the cause.

The server therefore routes all diagnostics to **stderr** through `src/logger.ts`, and
`guardStdout()` reassigns the console methods as a backstop so an accidental log in
any dependency is redirected instead of fatal. If you add code here, use `log.*`, not
`console.*`. There is a test that asserts every line on stdout parses as JSON.

## Command-line options

| Flag | Env var | Default | Meaning |
|---|---|---|---|
| `--http` | — | off | Serve Streamable HTTP instead of stdio |
| `--http-port N` | `NETWORK_MOCK_HTTP_PORT` | 8788 | HTTP port |
| `--bridge-port N` | `NETWORK_MOCK_BRIDGE_PORT` | 8787 | Where the extension dials in |
| `--token SECRET` | `NETWORK_MOCK_TOKEN` | none | Require the extension to present this token |
| `--log-level LEVEL` | `NETWORK_MOCK_LOG_LEVEL` | info | `silent`/`error`/`warn`/`info`/`debug` |

### A note on security

The bridge binds to `127.0.0.1`, so nothing off your machine can reach it. It does
**not** authenticate by default, which means *any local process* could connect and
change your mocks — and, since mocks alter what pages you are viewing receive, that is
not entirely trivial.

If that matters in your environment, set a token on both ends: pass `--token SECRET`
to the server, and set `bridgeToken` in the extension's `chrome.storage.local`. The
`Origin` header a browser sends is deliberately **not** treated as authorisation,
because any local program can forge it.

## Tool reference

### Inspection

| Tool | Purpose |
|---|---|
| `get_workspace` | The whole workspace: groups, mocks, tags, master switch, targeted tabs. Start here to discover ids. |
| `get_status` | Compact summary, and **per mock whether it is ACTIVE or why not**. The fastest answer to "why is my mock not firing?". |

### Tabs

| Tool | Purpose |
|---|---|
| `list_tabs` | Tabs the extension can see, with ids, titles, urls |
| `set_target_tabs` | Replace the set of tabs that get mocked. Nothing is mocked outside these. |

### Enable / disable

| Tool | Purpose |
|---|---|
| `set_enabled` | Flip the master switch, a group, a mock, or a tag — `{kind, id, enabled}` |

### Groups, mocks, tags

`create_group`, `update_group`, `delete_group`, `reorder_groups`,
`create_mock`, `update_mock`, `delete_mock`,
`create_tag`, `update_tag`, `delete_tag`.

`reorder_groups` matters because resolution is first-match-wins: put narrow mocks
before catch-alls.

### Observability

| Tool | Purpose |
|---|---|
| `get_hit_log` | Requests seen, each `mocked` (with which mock) or `passed`. **The only place mocked requests are visible** — they never reach the network, so the Network panel cannot show them. |
| `clear_hit_log` | Discard it |

### Import / export

| Tool | Purpose |
|---|---|
| `export_workspace` | Serialise to JSON for committing or sharing. Tab ids are excluded — they mean nothing outside the session that made them. |
| `import_workspace` | Load it back. Replaces by default; `merge: true` appends instead. |

## A typical agent session

```
list_tabs                     → find the tab you are working in
set_target_tabs {tabIds:[N]}  → nothing is mocked until you do this
create_group {name:"checkout failures"}
create_mock  {groupId, name:"payment 500",
              match:{method:"POST", urlPattern:"*/api/pay", patternKind:"glob"},
              response:{status:500, body:"{\"error\":\"nope\"}", bodyKind:"json"}}
get_status                    → confirm it says active
get_hit_log                   → after exercising the page, confirm it fired
```

## Concurrency

Every mutating tool is a read-modify-write against the extension's state, so the
server serialises them. Without that, two clients could each read the same workspace
and the second write would silently discard the first one's change.
