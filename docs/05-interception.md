# 05 — How interception works, and what it cannot do

## Why not the obvious approach

Chrome has an API built for exactly this: `chrome.debugger`, which exposes the Chrome
DevTools Protocol and can fulfil a request with any body you like. It is what you
would reach for first.

**It is unusable here.** Chrome permits only one debugger client per tab, and an open
DevTools window always wins. Since our panel *lives inside* the DevTools of the tab
you are working on, a CDP-based engine could never mock that tab — the one tab you
actually care about. `chrome.debugger.attach` would simply fail.

The other candidate, `declarativeNetRequest`, can block, redirect and rewrite headers
on any request type — but it **cannot supply a response body**, which is the entire
feature.

That leaves patching `fetch` and `XMLHttpRequest` inside the page. It works with
DevTools open, shows no "being debugged" banner, and gives complete control over
status, headers and body.

## The mechanism

`extension/src/injected/intercept.ts` runs in the page's **MAIN world** at
`document_start` — before any page script — and replaces:

- `window.fetch`
- `XMLHttpRequest.prototype.open` / `.send`
- `window.EventSource` (minimally, see below)

On every call it resolves the request against the mock list. No match means the
original function is called and the request goes to the network exactly as normal.

### The config race, and why requests briefly wait

The interceptor must install its patches *synchronously* at `document_start`, but it
has no config yet — it cannot read `chrome.storage`, because MAIN-world code has no
`chrome.*` access. Config has to arrive asynchronously from the relay.

So each intercepted call awaits a `ready` promise before deciding. This is nearly free:
`fetch` and XHR both deliver asynchronously anyway, so we add a few milliseconds, and
once config has arrived awaiting a settled promise costs a microtask.

**It fails open.** A 2-second timeout releases every waiter into passthrough. If the
relay never answers — extension reloaded, service worker wedged, bug in our code — the
page still works, just unmocked. A debugging tool must never be able to hang the thing
you are debugging. This behaviour is verified explicitly, not assumed.

### Faking an XHR response is the fiddly part

Because no request is sent, none of the browser's native XHR machinery runs. Every
observable member has to be redefined on the instance — `status`, `statusText`,
`response`, `responseText`, `responseURL`, `getAllResponseHeaders`,
`getResponseHeader` — and the event sequence replayed by hand in the exact order the
spec mandates:

```
readyState 2 → readystatechange
readyState 3 → readystatechange
readyState 4 → readystatechange, progress, load, loadend
```

That order is not cosmetic. axios, jQuery and plenty of older SDKs depend on it, and
getting it wrong produces bugs that look like the *library's* fault. It is covered by
a browser test.

`responseType` is honoured too: `json` parses the body (yielding `null` on invalid
JSON, as the spec requires, rather than throwing), `arraybuffer` and `blob` encode it,
`document` runs it through `DOMParser`.

### Synchronous XHR

A synchronous XHR must have its response ready when `send()` returns, so there is no
opportunity to await config. If config has already arrived it is mocked normally;
if not, it passes through. Synchronous XHR is deprecated and rare, so this is a
reasonable place to accept a limitation rather than add risk.

## Matching rules

Resolution is **first match wins**, in depth-first tree order — exactly the order the
panel shows, top to bottom. Put specific mocks above catch-alls. An unmatched request
always falls through to the real network.

| `patternKind` | Semantics |
|---|---|
| `glob` | `*` matches any run of characters *including* `/`; `?` matches exactly one. Anchored to the **whole** URL. |
| `regex` | Passed to `RegExp` unanchored and tested against the whole URL, so it behaves as a substring search unless you anchor it. |

**The glob anchoring footgun:** `/api/users` does **not** match
`https://example.com/api/users`. Write `*/api/users`. This is pinned by a test and is
why the panel ships a live pattern tester — paste a real URL and it tells you
immediately whether it matches.

An invalid regex never throws. It compiles to `null` and matches nothing, so a
half-typed pattern in the editor cannot break interception for the whole page.

### Matching on the request body

A mock may carry an optional `match.body` condition — the panel's **Request payload**
tab. It only fires when the *outgoing* body satisfies it, which is how you give one
endpoint different answers depending on what is posted to it.

Reading that body is not free, and not always possible:

| Source | Read as |
|---|---|
| `fetch(url, {body})` — string, `URLSearchParams`, `ArrayBuffer`, typed array | text |
| `fetch(new Request(...))` with a body | text, via `request.clone()` |
| `xhr.send(body)` — string, `URLSearchParams`, `ArrayBuffer`, typed array | text |
| A `ReadableStream`, `Blob`, `FormData` or `Document` body | **unreadable** |

A stream is left alone deliberately: draining it would break the very request we are
about to let through. `Blob` and `FormData` would need an await that changes `fetch`'s
timing for every caller, mocked or not, so they are not read either.

**An unreadable body never satisfies a body matcher.** Failing closed is the point —
treating "I could not read it" as a match would make a deliberately narrow mock behave
like a catch-all.

For `fetch`, the clone-and-read only happens when some live mock actually has a body
matcher; pages that use none pay nothing. XHR hands us the body synchronously, so
there is no such gate.

### Artificial latency

`response.delayMs` holds the mocked response back before delivering it, for testing
spinners and timeouts. It applies to `fetch`, to async XHR, and to the connection
opening for `EventSource`. It is **ignored for synchronous XHR**, where the caller is
blocked on `send()` returning and there is nowhere to yield.

## Mocked requests do not appear in the Network panel

This is the single most surprising consequence of the design, and it is not a bug.

A mocked response is manufactured inside the page. **No network request is made**, so
Chrome's Network panel has nothing to show — the request is simply absent.

That is why the panel has its own **Hit log** at the bottom. It is stitched from two
sources, because neither is enough alone:

- `MOCKED` rows come from the interceptor's own hit stream, carrying the breadcrumb
  path of the mock that answered. Nothing else can see these.
- `passed` rows come from `chrome.devtools.network`, which sees every real request the
  tab made *and* its full response — which is what lets the **mock it** button
  pre-fill a new mock from what actually came back.

Both sources are scoped to the inspected tab, so the log only ever shows the tab you
opened the panel on. Over MCP, `get_hit_log` returns the same records.

If you are wondering whether a mock fired, the hit log is where to look — never the
Network panel.

## Limitations, stated plainly

- **Only `fetch`, `XMLHttpRequest` and `EventSource` are intercepted.** Not images,
  stylesheets, fonts, top-level navigations, `<script>` tags, or `sendBeacon`. In
  practice you are mocking JSON APIs, which is what these cover.
- **Requests made from the page's own service worker are not caught.** They originate
  in a different context we do not inject into. A site with an offline-first service
  worker may bypass mocking entirely.
- **`EventSource` support is minimal by design.** A matching mock replays the body as
  one or more SSE frames and then goes quiet. It is not a stream-scripting facility.
- **A page that captures `window.fetch` before us would evade mocking.** We run at
  `document_start`, so this needs a page to grab the reference in an earlier
  document-start content script from another extension. Not observed in practice, but
  possible.
- **Recording real traffic only sees the inspected tab**, because
  `chrome.devtools.network` is scoped to it — even though mocking itself can target a
  different tab.
- **Nothing is mocked in a tab you have not targeted.** Intentional, and the first
  thing to check when a mock "does not work".
