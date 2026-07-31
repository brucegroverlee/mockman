# 09 — Data model

Defined in `shared/src/types.ts`, used verbatim by the extension and the MCP server.

## Workspace

```ts
interface Workspace {
  version: 1;
  enabled: boolean;        // master switch
  groups: Group[];
  tags: Tag[];
  targetTabIds: number[];  // only these tabs are mocked; empty = mock nothing
}
```

`targetTabIds` is stored separately from the rest (session storage, not local) and is
excluded from `export_workspace`, because a tab id means nothing outside the browser
session that produced it.

## Group

```ts
interface Group {
  id: string;        // "grp_xxxxxxxx"
  name: string;
  enabled: boolean;
  tagIds: string[];  // tags applied to every mock inside
  order: number;     // ascending; groups are evaluated in this order
  mocks: Mock[];
}
```

## Mock

```ts
interface Mock {
  id: string;        // "mck_xxxxxxxx"
  name: string;
  enabled: boolean;
  tagIds: string[];
  order: number;     // ascending, within the group
  match: MockMatch;
  response: MockResponse;
}
```

### MockMatch

```ts
interface MockMatch {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | '*';
  urlPattern: string;
  patternKind: 'glob' | 'regex';
}
```

| `patternKind` | Semantics |
|---|---|
| `glob` | `*` = any run of characters (including `/`), `?` = exactly one. **Anchored to the whole URL.** |
| `regex` | `RegExp`, unanchored, tested against the whole URL — effectively a substring search unless you anchor it. |

`*/api/users` matches `https://example.com/api/users`. Plain `/api/users` does **not**.

### MockResponse

```ts
interface MockResponse {
  status: number;                    // 100–599
  statusText?: string | undefined;   // omitted → standard reason phrase derived
  headers: Record<string, string>;
  body: string;                      // always text; JSON as a JSON string
  bodyKind: 'json' | 'text';
}
```

`bodyKind` drives the default `content-type` (`application/json` or
`text/plain;charset=UTF-8`) and whether the panel validates the body as JSON. An
explicit `content-type` header always wins.

Statuses 101, 204, 205 and 304 are sent with no body, as the Fetch spec requires.

## Tag

```ts
interface Tag {
  id: string;       // "tag_xxxxxxxx"
  name: string;
  color: string;    // any CSS colour
  enabled: boolean;
}
```

**A disabled tag is a veto.** It deactivates every group and mock carrying it,
regardless of their own `enabled` flags. See
[04](04-architecture.md#the-enablement-rules).

A `tagId` that no longer resolves is ignored, not treated as a veto.

## Derived types

`CompiledMock` — a mock flattened for the page-side interceptor: already filtered by
the enablement rules and sorted into resolution order, so page code does no reasoning
about groups or tags.

```ts
interface CompiledMock {
  mockId: string;
  groupId: string;
  label: string;    // "group / mock", shown in the hit log
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
  mockId?: string;                // present when mocked
  label?: string;
  status?: number;
}
```

## Example workspace

```json
{
  "version": 1,
  "enabled": true,
  "targetTabIds": [],
  "tags": [
    { "id": "tag_slow", "name": "slow", "color": "#e5c07b", "enabled": true },
    { "id": "tag_fail", "name": "failures", "color": "#e06c75", "enabled": false }
  ],
  "groups": [
    {
      "id": "grp_auth",
      "name": "auth",
      "enabled": true,
      "tagIds": [],
      "order": 0,
      "mocks": [
        {
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
            "bodyKind": "json"
          }
        },
        {
          "id": "mck_login_500",
          "name": "login explodes",
          "enabled": true,
          "tagIds": ["tag_fail"],
          "order": 1,
          "match": { "method": "POST", "urlPattern": "*/api/login", "patternKind": "glob" },
          "response": { "status": 500, "headers": {}, "body": "{\"error\":\"boom\"}", "bodyKind": "json" }
        }
      ]
    }
  ]
}
```

Two things this example demonstrates:

- Both mocks match the same request, but `mck_login_ok` has the lower `order`, so it
  wins. Swap the orders — or disable it — to exercise the failure path.
- `mck_login_500` carries `tag_fail`, which is **disabled**, so it is inert regardless
  of its own `enabled: true`. Flipping that one tag switches on every failure mock in
  the workspace at once.
