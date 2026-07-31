# verify/ — automated checks that need a browser or a live process

`pnpm test` covers the pure logic in `shared/`. These cover the parts that need a real
browser or a real process, and they exist because the delicate code here is easy to
break in ways a type-checker cannot see.

All commands are run from the repo root.

## Interception engine, in a real browser

Loads the **built** `intercept.js` into a plain page exactly as a MAIN-world content
script would be, stands in for the relay by dispatching a config event, then asserts on
real `fetch` and `XMLHttpRequest` behaviour. No extension install, no reload cycle.

```bash
pnpm build
```

```bash
pnpm verify:serve
```

Then open <http://127.0.0.1:8899/> — the page title reads `ALL PASS` or `N FAILED`, with
per-check detail in the body.

Covers: body substitution, custom and defaulted headers, non-200 statuses, derived
`statusText`, text vs JSON bodies, method matching, passthrough to the real network,
XHR `responseText`/`status`/header accessors, and **the XHR event order**
(`rs2,rs3,rs4,load,loadend`) that axios and jQuery depend on.

Also open <http://127.0.0.1:8899/failopen.html>, which loads the interceptor with **no
relay at all**. It must fall back to passthrough after ~2s. If that ever regresses, a
broken extension would hang every page it touched — so this one matters more than its
size suggests.

## MCP protocol compliance, with no vendor client

```bash
pnpm verify:mcp
```

Drives a raw JSON-RPC handshake against the built server. Checks initialize,
`tools/list`, that every tool has a substantive description and an object schema, that
a tool needing the extension **fails fast with a clear message instead of hanging**,
that the process exits on stdin EOF, and — most importantly — that **every line on
stdout parses as JSON**.

That last check is the one to keep. A single stray `console.log` breaks every stdio MCP
client with an opaque "failed to start", and it is very easy to reintroduce.

## MCP end to end, against a simulated extension

```bash
pnpm verify:bridge
```

Stands in a WebSocket client implementing the same methods the service worker does,
then drives real tool calls through it. Covers the bridge protocol, all the mutating
tools, the export/import round trip, disconnect handling, and every branch of the
enablement rules — including that a **disabled tag vetoes an otherwise-enabled mock**
and that a partial `update_mock` does not clobber untouched fields.

## What these do not cover

The **DevTools panel UI** is not automated. Rendering, the toggles, the tab picker and
"Create mock from this" need a human in a live DevTools session. The manual pass:

1. Load `extension/dist` at `chrome://extensions`, open a page that calls `fetch`,
   open the **Network Mock** panel.
2. Tick **This tab**, add a group and a mock, reload — the Hit log should show `MOCKED`.
3. Toggle the mock off, then its group, then a tag on it. Each should independently
   make it inert, and the row should say which.
4. Point the target at a **different** tab and confirm the inspected tab stops being
   mocked.
5. Trigger a real request and use **Create mock from this**.

The **service worker's bridge client** (`extension/src/background/bridge.ts`) is also
not exercised by `verify:bridge` — that test simulates the extension side, so it proves
the server half and the protocol contract, not the in-browser client. Confirm it by
starting the MCP server, loading the extension, and checking `get_status` reports
`bridgeConnected: true`.
