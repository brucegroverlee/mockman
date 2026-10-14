---
name: mockman
description: Mock browser network responses in Chrome through the Mockman MCP server — create, organise, toggle and debug fetch/XHR/EventSource mocks on a live tab. Use when the user wants to fake an API response, simulate an error status, slow response or edge-case payload, test loading/empty/error states in a web app, switch groups of mocks on or off, or figure out why a mock is not firing. Requires the `mockman` MCP server to be connected.
---

# Mockman — driving network mocks over MCP

Mockman is a Chrome DevTools extension that answers a page's `fetch`, `XMLHttpRequest`
and `EventSource` calls from mock definitions instead of the network. Its MCP server
gives you every capability the DevTools panel has. Whatever you change shows up in the
user's panel immediately, and the reverse is true too.

Tool names below are the bare MCP names. Your client may add a prefix (for example
`mcp__mockman__get_status`). The server sends **text results containing JSON**, so
parse them.

## Mental model (read this first)

```
Workspace
├── enabled            master switch
├── targetTabIds       ONLY these tabs are mocked. Every other tab uses the real network.
├── tags[]             {id, name, color, enabled}, cross-cutting labels
└── tree[]             folders (nest arbitrarily) and mocks (leaves)
      mock = { name, label?, enabled, tagIds,
               match:    { method, urlPattern, patternKind, body? },
               response: { status, statusText?, headers, body, bodyKind, delayMs } }
```

A mock fires only when **all** of the following are true:

1. the master switch is on,
2. the request comes from a **targeted tab**,
3. **every** ancestor folder is enabled,
4. the mock itself is enabled,
5. **no** tag on the mock or on any ancestor folder is disabled (one disabled tag vetoes the mock),
6. the request matches `method`, `urlPattern` and the optional `body` matcher,
7. no **earlier** mock matched first. Matching is **first-match-wins in depth-first tree order**.

## Rules that prevent most mistakes

- **Globs are anchored to the whole URL.** Write `*/api/users`, not `/api/users`.
  `*` matches any characters, including `/`. `?` matches exactly one character. To
  match a query string, include it in the pattern (`*/api/users?*`) or use
  `patternKind: "regex"`. Regexes are unanchored JavaScript regexes tested against the
  full URL.
- **`response.body` is always a string.** For JSON, pass serialised JSON
  (`"{\"ok\":true}"`), not an object. `bodyKind: "json"` sets
  `content-type: application/json` when you don't set it yourself.
- **`update_mock` replaces `match` and `response` wholesale.** To change one field,
  read the mock first with `get_workspace({full:true})`, then send back the complete
  object with your edit applied. If you leave out a sibling field, it is reset to its
  default.
- **Narrow before broad.** If a catch-all like `*/api/*` sits above
  `*/api/users/42`, the catch-all wins. Fix the order with `reorder_children` or
  `move_node`.
- **A tab is targeted only while the Mockman DevTools panel is open on it** (or after
  `set_target_tabs`). If no panel is open, nothing is mocked. This is the most common
  reason a mock "does not work".
- **Mocked requests never appear in the DevTools Network panel**, because they never
  reach the network. Use `get_hit_log` to prove a mock fired.
- **Never guess ids.** Get them from `get_workspace`, `find_nodes`, or the result of
  a `create_*` call.

## Tool map

| Goal | Tool |
|---|---|
| See everything (ids, tree, tags, targeting) | `get_workspace` (`full:true` adds response bodies and the complete match/response) |
| See which mocks are active, and why not | `get_status` (optional `tabId`) |
| Find a node by name or URL fragment | `find_nodes {query, kind?}` |
| List browser tabs / choose which get mocked | `list_tabs`, `set_target_tabs {tabIds}` |
| Turn things on or off | `set_enabled {kind: workspace\|folder\|mock\|tag, id, enabled}` |
| Create / edit folders | `create_folder {parentId, name, tagIds?}`, `update_folder` |
| Create / edit mocks | `create_mock`, `update_mock` |
| Restructure | `move_node`, `reorder_children`, `duplicate_node`, `rename_node`, `delete_node` |
| Tags | `create_tag`, `update_tag`, `delete_tag` |
| Prove what happened | `get_hit_log {tabId?, limit?}`, `clear_hit_log` |
| Save / load whole setups | `export_workspace`, `import_workspace {json, merge?}` |

## Workflows

### 1. Pre-flight (always do this first)

1. Call `get_status`.
   - `bridgeConnected: false`: Chrome or the extension isn't connected. Tell the user
     to open Chrome with the Mockman extension loaded. The extension reconnects on its
     own; you don't need to restart anything.
   - `targetTabIds: []`: nothing will be mocked. Either ask the user to open DevTools
     (F12) and select the **Mockman** tab on the page, or call `list_tabs`, pick the
     right tab by URL or title, and call `set_target_tabs`.
   - `masterEnabled: false`: ask the user before turning it back on. They may have
     turned it off on purpose.
2. Call `get_workspace` to learn the existing structure. Reuse folders and tags that
   are already there instead of creating duplicates.

### 2. Mock an endpoint

```jsonc
// Optional: group related mocks together
create_folder { "parentId": null, "name": "Checkout" }        // → { id: "F1" }

create_mock {
  "parentId": "F1",
  "name": "payment fails",
  "label": "500",
  "match":    { "method": "POST", "urlPattern": "*/api/pay", "patternKind": "glob" },
  "response": { "status": 500,
                "headers": {},
                "body": "{\"error\":\"card_declined\"}",
                "bodyKind": "json",
                "delayMs": 0 }
}
```

Then verify:

1. `get_status`: the new mock should show `active: true`. If it doesn't, see workflow 4.
2. Ask the user to trigger the request (or reload the page), call `get_hit_log`, and
   check for an entry with `outcome: "mocked"` and the mock's `path`.

### 3. Several responses from one URL (body matching)

When one endpoint does different things depending on what is POSTed to it:

```jsonc
create_mock { "parentId": "F1", "name": "save ok",
  "match": { "method": "POST", "urlPattern": "*/api/settings", "patternKind": "glob",
             "body": { "mode": "json-subset", "value": "{\"action\":\"save\"}" } },
  "response": { "status": 200, "body": "{\"ok\":true}", "bodyKind": "json" } }
// → narrowId
// then a catch-all without a body matcher → catchAllId
reorder_children { "parentId": "F1", "orderedIds": ["<narrowId>", "<catchAllId>"] }
```

Body matcher modes: `json-subset` (the default and usually the right choice; extra
keys in the request are ignored), `contains`, `equals`, `regex`. A request whose body
can't be read (a stream, Blob or FormData) never satisfies a body matcher.

### 4. "Why isn't my mock firing?"

Work through these checks in order:

1. `get_status`, then look at the mock's `inactiveReason`:
   - `workspace-disabled`: the master switch is off. Fix with `set_enabled {kind:"workspace", enabled:true}`.
   - `tab-not-targeted`: no panel is open on the tab and no tab has been set. See the pre-flight.
   - `folder-disabled`: an ancestor folder is off. Its path is in the breadcrumb.
   - `mock-disabled`: the mock itself is off.
   - `tag-disabled`: a tag on the mock or on an ancestor folder is off. Use `get_workspace` to find out which one.
2. If the mock is active but `get_hit_log` shows the request as `passed`, compare the
   logged `url` and `method` against the pattern. The usual causes are a missing
   leading `*` (anchoring), a query string the glob doesn't cover, the wrong method,
   or a body matcher that doesn't match.
3. If the hit log shows `mocked` but the `path` points at a **different** mock, an
   earlier mock won. Reorder.
4. If the request doesn't appear in the hit log at all, it isn't being intercepted.
   It may be an image, script, stylesheet or navigation, it may come from the page's
   own service worker, or it may come from a tab that isn't targeted (see limitations).

### 5. Scenarios with tags

To switch whole groups of mocks on and off as scenarios (for example "empty states" or
"slow network"):

1. `create_tag {name:"slow-network"}`, which returns a tag id.
2. Attach it with `tagIds` on `create_mock` or `update_mock`, or on a folder with
   `update_folder` so that everything inside inherits it.
3. Toggle the whole group with `set_enabled {kind:"tag", id, enabled:false|true}`.

Use folders for structure (one feature, one place in the tree). Use tags for slices
that cut across folders.

### 6. Variants

`duplicate_node` copies a mock or a whole folder with fresh ids, placed as a sibling.
Then `update_mock` the copy, for example to turn a 200 into a 500 or an empty list.
Keep only one variant enabled at a time, or order them on purpose.

### 7. Save and share setups

- `export_workspace` returns JSON you can commit to the repo. Tab ids are left out.
- `import_workspace {json}` **replaces everything** by default. Pass `merge:true` to
  append to what's already there. Before replacing, offer to `export_workspace` first
  as a backup.

## Useful recipes

| Want | Response |
|---|---|
| Loading state | `delayMs: 3000` (or more) on a normal 200 |
| Empty state | `status: 200, body: "[]"` or `"{\"items\":[]}"` |
| Server error | `status: 500` (or 502/503) with an error JSON body |
| Auth expired | `status: 401, body: "{\"error\":\"unauthorized\"}"` |
| Validation error | `status: 422` with field errors |
| Rate limit | `status: 429, headers: {"retry-after":"30"}` |
| Plain text / HTML | `bodyKind: "text"`, and set `content-type` in `headers` if it matters |
| Any method | `method: "*"` |

## Limitations (tell the user rather than retrying)

- Only `fetch`, `XMLHttpRequest` and `EventSource` are intercepted. Images, CSS,
  fonts, `<script>` tags, page navigations and `sendBeacon` are not.
- Requests made by the **page's own service worker** are not caught. An offline-first
  site may bypass mocking entirely.
- `EventSource` mocks replay the body as SSE frames once and then go quiet. They
  can't script a stream.
- Nothing is mocked in a tab that isn't targeted.

## Safety

- `delete_node` on a folder deletes everything inside it, and **can't be undone**.
  `import_workspace` without `merge` replaces the entire workspace. Confirm with the
  user before doing either to mocks you didn't create in this session.
- Mocks change what real pages receive. When you finish a task, offer to disable or
  remove the mocks you added so that the user's normal browsing isn't affected later.
- Report what you changed: the names and paths of created or edited mocks and any
  toggles you flipped.
