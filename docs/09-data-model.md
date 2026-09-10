# 09 — Data model

Defined in `shared/src/types.ts`, used verbatim by the extension and the MCP server.

## Workspace

```ts
interface Workspace {
  version: 2;
  enabled: boolean;        // master switch
  tree: TreeNode[];        // folders and mocks, nested arbitrarily deep
  tags: Tag[];
  targetTabIds: number[];  // only these tabs are mocked; empty = mock nothing
}
```

`targetTabIds` is stored separately from the rest (session storage, not local) and is
excluded from `export_workspace`, because a tab id means nothing outside the browser
session that produced it. In normal use nothing sets it by hand: the DevTools panel
adds its own inspected tab while it is open and drops it on close, so "which tab gets
mocked" is answered by "the one you opened the panel on".

## The tree

A node is either a folder or a mock. Folders nest; mocks are always leaves.

```ts
type TreeNode = Folder | Mock;

interface Folder {
  kind: 'folder';
  id: string;        // "fld_xxxxxxxx"
  name: string;
  enabled: boolean;
  tagIds: string[];  // apply to everything beneath, however deep
  order: number;
  expanded: boolean; // presentational, but persisted
  children: TreeNode[];
}

interface Mock {
  kind: 'mock';
  id: string;        // "mck_xxxxxxxx"
  name: string;
  enabled: boolean;
  tagIds: string[];
  order: number;
  label?: string;    // optional short badge, shown in the tree and the hit log
  match: MockMatch;
  response: MockResponse;
}
```

`order` is kept equal to the array index by every mutation in `mutations.ts`. Two
sources of truth for ordering would drift, so treat `order` as a *serialised* array
index: it exists so JSON round-trips and MCP reordering stay meaningful, not as an
independent field to set.

Evaluation is **depth-first, first match wins** — the order you see in the panel, top
to bottom. Put narrow mocks above catch-alls.

`shared/src/tree.ts` holds the pure helpers (`walkTree`, `findNode`, `moveTreeNode`,
`pathLabel`, …). All of them return new arrays and never mutate their input.

### MockMatch

```ts
interface MockMatch {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | '*';
  urlPattern: string;
  patternKind: 'glob' | 'regex';
  body?: BodyMatch;   // optional extra condition on the REQUEST body
}
```

| `patternKind` | Semantics |
|---|---|
| `glob` | `*` = any run of characters (including `/`), `?` = exactly one. **Anchored to the whole URL.** |
| `regex` | `RegExp`, unanchored, tested against the whole URL — effectively a substring search unless you anchor it. |

`*/api/users` matches `https://example.com/api/users`. Plain `/api/users` does **not**.

### BodyMatch

```ts
interface BodyMatch {
  mode: 'contains' | 'equals' | 'regex' | 'json-subset';
  value: string;
}
```

Absent means "any body". Present, it *narrows* the mock — the panel surfaces it as the
**Request payload** tab. It exists for the common case of one endpoint doing several
things depending on what you post to it.

| `mode` | Fires when the outgoing body… |
|---|---|
| `contains` | contains `value` anywhere |
| `equals` | equals `value`, both trimmed |
| `regex` | matches this unanchored `RegExp` |
| `json-subset` | is JSON containing every key and value in `value`, at the same path; extra keys ignored |

`json-subset` is usually the right choice: ignoring extra keys is what lets a matcher
survive the timestamps and correlation ids real payloads carry.

**Body matching fails closed.** An unreadable body, an uncompilable regex, or JSON that
does not parse on either side all count as "no match". A request body counts as
unreadable when it is a stream, a `Blob` or a `FormData` — see
[05](05-interception.md). Failing closed matters: silently ignoring an unreadable body
would make a deliberately narrow mock behave like a catch-all.

An **empty** `value` is treated as no condition at all, so a half-typed matcher in the
panel does not quietly stop the mock from firing.

### MockResponse

```ts
interface MockResponse {
  status: number;                    // 100–599
  statusText?: string | undefined;   // omitted → standard reason phrase derived
  headers: Record<string, string>;
  body: string;                      // always text; JSON as a JSON string
  bodyKind: 'json' | 'text';
  delayMs: number;                   // artificial latency; 0 = immediate
}
```

`bodyKind` drives the default `content-type` (`application/json` or
`text/plain;charset=UTF-8`) and whether the panel validates the body as JSON. An
explicit `content-type` header always wins.

Statuses 101, 204, 205 and 304 are sent with no body, as the Fetch spec requires.

`delayMs` is applied to `fetch` and async `XMLHttpRequest`, and to the connection
opening for `EventSource`. It is **ignored for synchronous XHR**, where the caller is
blocking on `send()` returning and there is nowhere to yield.

## Tag

```ts
interface Tag {
  id: string;       // "tag_xxxxxxxx"
  name: string;
  color: string;    // any CSS colour
  enabled: boolean;
}
```

**A disabled tag is a veto.** It deactivates every node carrying it *and everything
beneath that node*, regardless of their own `enabled` flags. See
[04](04-architecture.md#the-enablement-rules).

A `tagId` that no longer resolves is ignored, not treated as a veto.

Tag names double as search terms: the panel's one search box matches a bare word
against a node's name, url pattern, label **or** tag names, so a distinctive tag name
is also the fastest way to filter the tree down to a slice.

## Derived types

`CompiledMock` — a mock flattened for the page-side interceptor: already filtered by
the enablement rules and sorted into resolution order, so page code does no reasoning
about the tree or tags.

```ts
interface CompiledMock {
  mockId: string;
  path: string;      // breadcrumb, "Web-edge-API / Jukeboxes / Save Settings"
  label?: string;    // the mock's own label, if it set one
  match: MockMatch;
  response: MockResponse;
}
```

`HitRecord` — one observed request.

```ts
interface HitRecord {
  id: string;
  tabId: number;
  timestamp: number;              // epoch ms
  method: string;
  url: string;
  outcome: 'mocked' | 'passed';
  mockId?: string;                // the following are present when mocked
  path?: string;
  label?: string;
  status?: number;
}
```

## Versioning and migration

Everything read from `chrome.storage`, imported over MCP, or handed to the service
worker by the MCP bridge passes through `migrateWorkspace` in `shared/src/migrate.ts`
first. It is deliberately **total**: it never throws and never returns a
partially-valid workspace, because the alternative is an extension that refuses to
start over one bad field. Unknown methods and out-of-range statuses fall back; nodes
missing an id get a synthetic one rather than being dropped.

**v1 → v2** was the flat `groups: Group[]` model becoming the nested `tree`. Each v1
group becomes a top-level folder holding its mocks, ids and flags intact; `delayMs`
defaults to `0` and no body matcher is added, so migrated mocks behave exactly as
before.

`migrateWorkspace` never carries `targetTabIds` across — adopting a stored or shared
document's tab ids would silently start mocking an unrelated tab. Callers that *do*
hold authoritative ids (a live read from the browser) put them back afterwards.

## Example workspace

```json
{
  "version": 2,
  "enabled": true,
  "targetTabIds": [],
  "tags": [
    { "id": "tag_slow", "name": "slow", "color": "#e5c07b", "enabled": true },
    { "id": "tag_fail", "name": "failures", "color": "#e06c75", "enabled": false }
  ],
  "tree": [
    {
      "kind": "folder",
      "id": "fld_api",
      "name": "Web-edge-API",
      "enabled": true,
      "tagIds": [],
      "order": 0,
      "expanded": true,
      "children": [
        {
          "kind": "folder",
          "id": "fld_auth",
          "name": "Auth",
          "enabled": true,
          "tagIds": [],
          "order": 0,
          "expanded": true,
          "children": [
            {
              "kind": "mock",
              "id": "mck_login_ok",
              "name": "login succeeds",
              "enabled": true,
              "tagIds": [],
              "order": 0,
              "match": { "method": "POST", "urlPattern": "*/api/login", "patternKind": "glob" },
              "response": {
                "status": 200,
                "headers": { "content-type": "application/json" },
                "body": "{\"token\":\"fake-jwt\"}",
                "bodyKind": "json",
                "delayMs": 0
              }
            },
            {
              "kind": "mock",
              "id": "mck_login_500",
              "name": "login explodes",
              "label": "500",
              "enabled": true,
              "tagIds": ["tag_fail"],
              "order": 1,
              "match": { "method": "POST", "urlPattern": "*/api/login", "patternKind": "glob" },
              "response": {
                "status": 500,
                "headers": {},
                "body": "{\"error\":\"boom\"}",
                "bodyKind": "json",
                "delayMs": 1500
              }
            }
          ]
        }
      ]
    }
  ]
}
```

Three things this example demonstrates:

- Both mocks match the same request, but `mck_login_ok` comes first in depth-first
  order, so it wins. Drag it below the other in the panel — or disable it — to
  exercise the failure path.
- `mck_login_500` carries `tag_fail`, which is **disabled**, so it is inert regardless
  of its own `enabled: true`. Flipping that one tag switches on every failure mock in
  the workspace at once.
- Its `delayMs: 1500` makes the failure arrive slowly, which is usually the case worth
  testing: a spinner that never resolves is a different bug from an error that renders.
