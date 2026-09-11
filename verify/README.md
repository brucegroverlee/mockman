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

Also covers `delayMs`, and request-body matching — including that a narrow body
matcher beats a catch-all, that a non-matching body falls through, and that an
**unreadable** body (a `Blob`) fails closed rather than matching.

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
enablement rules — including that a **disabled tag vetoes an otherwise-enabled mock**,
that a tag on an **ancestor folder** vetoes just as hard, that a folder cannot be
moved inside its own descendant, that an unknown node id is an error rather than a
silent no-op, and that a partial `update_mock` does not clobber untouched fields.

It also imports a **v1** document and asserts the old flat groups come back as
top-level folders with their mocks intact — the migration, end to end.

## The DevTools panel, in a real browser

```bash
pnpm build
```

```bash
pnpm verify:serve
```

Then open <http://127.0.0.1:8899/panel.html>. This renders the **built** panel bundle
against a stubbed `chrome`, so the UI can be looked at and driven without installing
the extension or opening DevTools. The stub holds a workspace in memory, answers the
same messages the service worker does, and fires a few fake `onRequestFinished`
entries so the hit log has something in it.

Good for: layout at any window size, light and dark themes, the tree, search, the
detail panel, drag-and-drop, **mock it**, and the log's resource-type filter — the
fake traffic covers every bucket the filter bar offers, including a wasm file served
as `fetch` (which must still land under **Wasm**, since that bucket goes by mime type).
It is a harness for eyeballing and smoke-testing, not a substitute for the manual pass
below.

Two query parameters make the DevTools API misbehave on purpose. **Check both after
touching `network.ts`** — the failure they model is a log that captures nothing at
all, which is invisible until someone reports it:

| URL | Models | Must still |
|---|---|---|
| `panel.html?har=throw` | `getHAR()` throwing | capture live traffic — seeding is a nicety, subscribing is not |
| `panel.html?har=junk` | malformed HAR entries | drop the bad entries and keep the rest |

## What these do not cover

The panel **inside real DevTools** is still not automated — in particular the panel
port that targets the inspected tab, which has no analogue outside a real DevTools
session. The manual pass:

1. Load `extension/dist` at `chrome://extensions`, open a page that calls `fetch`,
   open the **Mockman** panel.
2. Add a folder and a mock, reload — the Hit log should show `MOCKED`. Note that you
   never had to target the tab: opening the panel did it.
3. **Close the DevTools window** and reload the page. Nothing should be mocked. Reopen
   the panel and it should be mocked again. This is the port lifecycle, and it is the
   part most likely to break silently.
4. Toggle the mock off, then a folder above it, then a tag on it. Each should
   independently make it inert, and hovering the `!` should say which.
5. Trigger a real request and use **mock it** — the new mock should carry the real
   status, headers and body.
6. Open a **second** DevTools window on the same tab, close one, and confirm the tab
   is still mocked (the targeting is reference-counted).

The **service worker's bridge client** (`extension/src/background/bridge.ts`) is also
not exercised by `verify:bridge` — that test simulates the extension side, so it proves
the server half and the protocol contract, not the in-browser client. Confirm it by
starting the MCP server, loading the extension, and checking `get_status` reports
`bridgeConnected: true`.
