# 08 — Troubleshooting

## Toolchain

| Symptom | Cause | Fix |
|---|---|---|
| `'pnpm' is not recognized` right after installing it | Your shell has the PATH it started with; winget updated the registry copy | Open a new terminal, or re-read PATH — see [01](01-windows-setup.md#the-trap-that-will-get-you-first-path-is-not-refreshed) |
| `'node' is not recognized` **inside** a pnpm script, while `node -v` works in your terminal | Volta's `pnpm` shim is intercepting and stripping Volta's dirs from the child environment | Uninstall Volta. Full explanation in [01](01-windows-setup.md#a-warning-do-not-add-volta-alongside-pnpm) |
| `ERR_PNPM_IGNORED_BUILDS` | pnpm blocks dependency install scripts by default | Add the package under `allowBuilds:` in `pnpm-workspace.yaml` |
| `pnpm setup` fails with `ENOENT ... @pnpm/exe` | It tries to reinstall the pnpm CLI into its own global store | Do not run it; set `PNPM_HOME` and PATH manually per [01](01-windows-setup.md) |
| `pnpm runtime set node lts -g` fails with `ENOENT ... node_modules\node` | A pnpm 11.15.1 bug on Windows | Skip it. `pnpm exec node` and `pnpm run` work regardless |
| Cannot find module `@network-mock/shared` | Workspace links missing | `pnpm install` from the **repo root** |

## Loading the extension

| Symptom | Cause | Fix |
|---|---|---|
| "Manifest file is missing or unreadable" | Selected `extension/` instead of `extension/dist` | Load the **built** folder. Run `pnpm build` first |
| No **Network Mock** tab in DevTools | DevTools was already open when the extension loaded | Close and reopen DevTools |
| Service worker shows "inactive" | Normal — MV3 workers are event-driven and idle out | Not a fault. It wakes when messaged |
| `Cannot use import statement outside a module` in a content script | A content script got built as an ES module | Content scripts must be IIFEs; see [07](07-development-workflow.md#why-the-extension-needs-two-bundlers) |

## Mocking

| Symptom | Cause | Fix |
|---|---|---|
| **Nothing is mocked at all** | A tab is targeted only while its Network Mock panel is open | Open the panel on the tab you are testing, and leave it open. Check the **Mocking on** switch too |
| Nothing is mocked *from an agent* | Same cause: with no panel open, no tab is targeted | Open the panel, or call `set_target_tabs` explicitly |
| A mock looks enabled but does not fire | A **tag** on it — or on a folder above it — is disabled, which vetoes it | The greyed row shows a `!`; hover it, or call `get_status` |
| A whole branch went inert at once | A folder above it is disabled, or carries a disabled tag | The breadcrumb in the detail pane strikes through any disabled folder |
| Glob does not match | Globs are anchored to the **whole** URL | `*/api/users`, not `/api/users`. Use the panel's pattern tester |
| Mocked request missing from the **Network** panel | **Expected.** A mocked request never reaches the network, so there is nothing for Chrome to show | Use the panel's **Hit log**, or `get_hit_log`. See [05](05-interception.md) |
| The Network panel shows requests the **Hit log** does not | The type filter is hiding them, or they are neither `fetch`/XHR nor reported by DevTools | Click **All** in the log's filter bar; hover a row to see which bucket it landed in |
| A row shows `–` instead of a status | Either there genuinely is not one (the request failed at the network level, or is an `EventSource` stream), or the **page** has not been reloaded since the extension was rebuilt | Reload the *page*, not just the extension — content scripts only swap on navigation, so an open tab keeps running the old interceptor |
| Only `OPTIONS` rows appear for an endpoint | Preflights are hidden by default, so this means the real request is missing — usually the stale-content-script case above | Reload the page. If it persists, the requests are not page-level `fetch`/XHR — a service worker making them is the usual culprit |
| **mock it** produced a mock with an empty body | Only the interceptor saw that request, so the response body was never captured | Fill the body in by hand, or trigger the request again with DevTools open on the tab |
| The wrong mock fires | First-match-wins in depth-first tree order | Drag the specific mock above the catch-all, or call `reorder_children` |
| A mock with a **Request payload** condition never fires | The request body could not be read — a `Blob`, `FormData` or stream body never satisfies a body matcher | Match on URL and method instead. See [05](05-interception.md#matching-on-the-request-body) |
| `Delay by (ms)` seems ignored | Synchronous XHR cannot be delayed — the caller is blocked on `send()` | Expected; use async XHR or `fetch` |
| Images / CSS / page navigation not mocked | Only `fetch`, XHR and `EventSource` are patched | A real limitation — see [05](05-interception.md#limitations-stated-plainly) |
| A site ignores mocks entirely | Its own service worker is making the requests, in a context we do not inject into | Unregister the site's service worker in Application → Service Workers |
| Every request stalls ~2 seconds, then works unmocked | The relay never delivered config, so the fail-open timeout is firing each load | Check the service worker console for errors; reload the extension |
| Sync XHR is not mocked | A synchronous XHR cannot wait for config to arrive | Known limitation; use async XHR or `fetch` |
| Mocks vanished after restarting Chrome | Mocks persist, but **tab targeting does not** — tab ids are session-scoped | Reopen the panel on the tab; that re-targets it |

## MCP

| Symptom | Cause | Fix |
|---|---|---|
| Client reports the server failed to start, no detail | Almost always a `spawn` problem, or something wrote to stdout | See the two rows below |
| `spawn ENOENT` / `spawn EINVAL` | `command` points at a `.cmd` shim (`npx`, `pnpm`), which cannot be spawned without a shell; or the editor's PATH has no Node | Point at a real `node.exe` by absolute path — run `pnpm mcp-config` |
| Handshake fails or messages look corrupt | Something wrote to **stdout**, which carries JSON-RPC framing | Use `log.*` from `src/logger.ts`, never `console.*` |
| Every tool says "extension is not connected" | Chrome is closed, the extension is not loaded, or it is dialling a different port | Load the extension; check `--bridge-port` matches |
| `EADDRINUSE` on 8787 | An earlier server is still holding the bridge port | Kill it, or pass `--bridge-port` |
| Tools work but the panel does not update | Should not happen — the panel re-renders on broadcast | Reopen DevTools; check the service worker console |
| Codex does not see the server | Codex uses **TOML** and the key `mcp_servers`, not JSON `mcpServers` | `pnpm mcp-config codex` |
| VS Code does not see the server | VS Code wraps under **`servers`** | `pnpm mcp-config vscode` |
| Server exits immediately when run by hand | Correct: with no client, stdin closes at once and it shuts down cleanly | Run it via a client, or use `--http` |

## Diagnostics worth knowing

Which pnpm is actually running, and does its child see Node:

```bash
(Get-Command pnpm).Source; pnpm exec node --version
```

What PATH a pnpm child process gets — if this lacks a directory your own shell has,
something is rewriting the environment:

```bash
pnpm exec cmd /c "echo %PATH%"
```

Confirm the built content scripts are IIFEs, not modules:

```bash
Select-String -Path extension\dist\injected\intercept.js -Pattern '^(import|export)\s'
```

Ask the extension why a mock is inert — this is usually faster than reading the UI:

```
get_status
```
