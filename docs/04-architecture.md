# 04 — Architecture

## The five components

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Chrome                                                                   │
│                                                                          │
│  ┌───────────────────────────┐        ┌─────────────────────────────┐    │
│  │ DevTools panel (React)    │        │ Web page (a targeted tab)   │    │
│  │  groups · mocks · tags    │        │                             │    │
│  │  tab picker · hit log     │        │  ┌───────────────────────┐  │    │
│  └────────────┬──────────────┘        │  │ intercept.js  MAIN    │  │    │
│               │ runtime messages      │  │ patches fetch / XHR   │  │    │
│               │                       │  └──────────┬────────────┘  │    │
│               │                       │      CustomEvents           │    │
│               │                       │  ┌──────────┴────────────┐  │    │
│               │                       │  │ relay.js   ISOLATED   │  │    │
│               │                       │  └──────────┬────────────┘  │    │
│               │                       └─────────────┼───────────────┘    │
│               │                                     │ runtime messages   │
│         ┌─────▼─────────────────────────────────────▼──────┐             │
│         │ Service worker — the single owner of state        │             │
│         │ chrome.storage.local  +  chrome.storage.session   │             │
│         └───────────────────────┬──────────────────────────┘             │
└─────────────────────────────────┼────────────────────────────────────────┘
                                  │ WebSocket, dialled OUT to 127.0.0.1:8787
                        ┌─────────▼──────────┐
                        │ MCP server (Node)  │◀── stdio / HTTP ── AI agent
                        └────────────────────┘
```

| Component | Runs in | Job |
|---|---|---|
| `injected/intercept.ts` | Page's MAIN world | Patches `fetch`/XHR/`EventSource`. The only code that can substitute a body. |
| `content/relay.ts` | ISOLATED world | Ferries config into MAIN, hit reports back out. Exists solely because MAIN has no `chrome.*`. |
| `background/index.ts` | Service worker | Owns all state. Every read and write goes through it. |
| `devtools/panel/` | DevTools | The UI. Holds no authoritative state. |
| `mcp-server/` | Node process | Exposes everything as MCP tools. |

## Why the service worker owns everything

There is exactly one source of truth and one place that broadcasts change. The panel
does not cache; it reads from the worker and re-reads on every broadcast.

That is what makes a mock created **over MCP** appear in the panel immediately, with
no polling — and equally, a mock created in the panel is instantly visible to an agent.
Both paths are the same path.

## Storage split

| What | Where | Why |
|---|---|---|
| Groups, mocks, tags, master switch | `chrome.storage.local` | Should survive a browser restart |
| `targetTabIds` | `chrome.storage.session` | A tab id is meaningless after a restart, and silently mocking a *recycled* id would be a nasty surprise |
| Hit log | Service worker memory, capped at 500 | Transient debug data. Lost if the worker restarts; an accepted trade. |

A closed tab is removed from `targetTabIds` automatically, for the same
id-recycling reason.

## Message flows

**Page load.** `intercept.js` installs its patches synchronously and holds a `ready`
promise. `relay.js` asks the worker for this tab's config — the worker reads the tab id
from `sender.tab.id`, so a page cannot claim to be a different tab — and pushes it into
MAIN as a `CustomEvent`, which settles `ready`.

There is no ordering guarantee between the two worlds, so the interceptor announces
itself *and* the relay pushes unprompted. Whichever lands first, the page is configured.

**An edit.** Panel or MCP → worker → `saveWorkspace` → broadcast to the panel and to
every tab → each relay re-fetches and pushes fresh config into its page. No reload
needed.

**A request.** Interceptor resolves it, mocks or passes it through, then reports the
outcome → relay → worker → hit log → broadcast to the panel.

## The enablement rules

A mock fires only when **all** of these hold:

1. the master switch is on;
2. the request's tab is in `targetTabIds`;
3. its group is enabled;
4. the mock itself is enabled;
5. **no tag** on the mock *or its group* is disabled.

Rule 5 is the interesting one: **a disabled tag is a veto.** It overrides the
`enabled` flag on everything carrying it. That is what makes tags worth having — you
can kill a cross-cutting slice ("all the slow-response mocks") with one toggle,
without touching the groups those mocks live in.

Reasons are evaluated broadest-first, so the explanation you get is the most useful
one — there is no point being told a tag is disabled when the master switch is off.

| Master | Tab targeted | Group | Mock | Tag | Result |
|---|---|---|---|---|---|
| off | – | – | – | – | `workspace-disabled` |
| on | no | – | – | – | `tab-not-targeted` |
| on | yes | off | – | – | `group-disabled` |
| on | yes | on | off | – | `mock-disabled` |
| on | yes | on | on | one disabled | `tag-disabled` |
| on | yes | on | on | all enabled | **active** |

A tag id that no longer resolves to a tag is **ignored**, not treated as a veto —
deleting a tag must not silently disable every mock that once referenced it.

This lives in `shared/src/enablement.ts` as a pure function, is unit-tested against
every row above, and is the same code the panel uses to grey out a row and tell you
why.

## Resolution order

`compileActiveMocks` flattens the workspace into the mocks that are live for a given
tab, sorted by group order then mock order, and hands that list to the page. So
page-side code never reasons about groups or tags — it just walks a list and takes the
**first match**. Anything unmatched falls through to the real network.
