# 04 — Architecture

## The five components

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Chrome                                                                   │
│                                                                          │
│  ┌───────────────────────────┐        ┌─────────────────────────────┐    │
│  │ DevTools panel (React)    │        │ Web page (a targeted tab)   │    │
│  │  folder tree · mock editor│        │                             │    │
│  │  hit log                  │        │  ┌───────────────────────┐  │    │
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
| The folder/mock tree, tags, master switch | `chrome.storage.local` | Should survive a browser restart |
| `targetTabIds` | `chrome.storage.session` | A tab id is meaningless after a restart, and silently mocking a *recycled* id would be a nasty surprise |
| Hit log | Service worker memory, capped at 500 | Transient debug data. Lost if the worker restarts; an accepted trade. |

A closed tab is removed from `targetTabIds` automatically, for the same
id-recycling reason.

Anything read back out of `chrome.storage.local` goes through `migrateWorkspace`
first, so a workspace written by an older build is upgraded on the way in rather than
crashing the worker. See [09](09-data-model.md#versioning-and-migration).

## Tab targeting has no UI

Opening the Mockman panel on a tab *is* how you choose it. The panel holds a
long-lived `chrome.runtime` port open to the worker for as long as it is on screen;
the worker targets the tab on connect and untargets it on `onDisconnect`.

A port rather than a message, because a DevTools window can be closed — or its whole
browser window torn down — without the page getting a chance to say goodbye.
`onDisconnect` always fires. It is reference-counted, since two DevTools windows can
inspect the same tab and a panel reloads constantly during development.

The MCP `set_target_tabs` tool still exists, for driving a tab that has no panel open
on it.

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
3. **every folder above it** is enabled;
4. the mock itself is enabled;
5. **no tag** on the mock *or on any folder above it* is disabled.

Rule 5 is the interesting one: **a disabled tag is a veto.** It overrides the
`enabled` flag on everything carrying it. That is what makes tags worth having — you
can kill a cross-cutting slice ("all the slow-response mocks") with one toggle,
without touching the folders those mocks live in.

Reasons are evaluated broadest-first, so the explanation you get is the most useful
one — there is no point being told a tag is disabled when the master switch is off.

| Master | Tab targeted | Folders above | Mock | Tag | Result |
|---|---|---|---|---|---|
| off | – | – | – | – | `workspace-disabled` |
| on | no | – | – | – | `tab-not-targeted` |
| on | yes | any off | – | – | `folder-disabled` |
| on | yes | all on | off | – | `mock-disabled` |
| on | yes | all on | on | one disabled | `tag-disabled` |
| on | yes | all on | on | all enabled | **active** |

When several folders above a mock are disabled, the **outermost** one is reported —
that is the one you actually have to turn back on.

A tag id that no longer resolves to a tag is **ignored**, not treated as a veto —
deleting a tag must not silently disable every mock that once referenced it.

This lives in `shared/src/enablement.ts` as a pure function, is unit-tested against
every row above, and is the same code the panel uses to grey out a row and tell you
why.

## Resolution order

`compileActiveMocks` flattens the workspace into the mocks that are live for a given
tab in **depth-first tree order** — exactly the order the panel shows, top to bottom —
and hands that list to the page. So page-side code never reasons about the tree or
tags: it just walks a list and takes the **first match**. Anything unmatched falls
through to the real network.

Each compiled entry carries its breadcrumb `path` (`"Web-edge-API / Jukeboxes / Save
Settings"`), which is what the hit log shows so you can tell *which* mock answered.
