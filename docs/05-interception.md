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

The interceptor's `passed` records are used too, and this matters more than it sounds.
The two sources see genuinely different things:

- **DevTools** reports what the *network stack* did. It has the response, and it covers
  every resource type — but a CORS preflight is a first-class row here, and a request
  answered from the **memory cache** is not reported at all.
- **The interceptor** reports what the *page* asked for. It patched `fetch`, `XHR` and
  `EventSource` itself, so it cannot miss a call and always has the true method. It
  reports a passed request once the response arrives, so it carries the status too —
  but timestamped when the request went out, since that is what the pairing below
  matches on and what the log sorts by.

Relying on DevTools alone produced a log full of `OPTIONS` preflights with none of the
`GET`s that caused them. So entries from the two are **paired** — matched on method and
url within a few seconds, since neither carries a request id — and each request is
listed once. A DevTools entry always wins the pairing, because it is the one carrying
the response *body* — a request only the interceptor saw still shows its status, but
**mock it** on that row starts with an empty body.

A `–` in the status column means there is genuinely no status: the request failed at
the network level, or it is an `EventSource` stream rather than a request that
completes.

The DevTools source is itself two calls. `onRequestFinished` only reports what happens
*from now on*, so a panel opened after browsing for a while would show an almost-empty
log while Chrome's own Network panel was full. `getHAR()` returns what DevTools has
already recorded, so the log opens with the same history the Network panel is showing
and the listener takes it from there; the two are deduplicated on start time, method
and url.

Both sources are scoped to the inspected tab, so the log only ever shows the tab you
opened the panel on. Over MCP, `get_hit_log` returns the same records.

**CORS preflights are hidden by default.** The `OPTIONS` the browser sends before a
cross-origin call is not something the page asked for or can mock, and an API needing
CORS emits one per call — so they double the length of the log with rows nobody can act
on. The header says how many are hidden and gives them back in one click; the setting
is remembered. A *mocked* `OPTIONS` is never hidden, since hiding the proof that your
own mock fired would be perverse.

Its filter bar mirrors Chrome's Network panel — same buckets, same wording, and the
same click behaviour (a plain click picks one type, ctrl/cmd-click adds or removes
one). It defaults to **Fetch/XHR**, because those are the only requests this extension
can mock; everything else in the log is page furniture you cannot act on from here.
**Invert** flips the type chips and the text query together, which is the quickest way
to answer "what *else* is this page doing?". The "Mocked only" checkbox is a separate
outcome switch and is deliberately not inverted along with them.

Buckets come from Chrome's `_resourceType` on each HAR entry. Three mappings are
judgement calls rather than transcription, and all three exist to keep the default
filter useful:

- **`preflight` counts as Fetch/XHR.** The CORS `OPTIONS` Chrome sends ahead of a
  cross-origin call is its own resource type with no body at all. An API that needs
  CORS can emit more preflights than real calls, so filing them under "Other" empties
  the default filter of exactly the traffic you came to look at.
- **`eventsource` counts as Fetch/XHR**, being one of the three APIs this extension
  can mock.
- **`texttrack` counts as Media.**

A type Chrome reports that this build does not recognise falls through to a mime-type
heuristic rather than dropping straight into "Other" — Chrome adds resource types over
time, and an unrecognised one carrying `application/json` is API traffic whatever it
is called. The heuristic reads `content.mimeType`, then the `content-type` header,
which matters for bodiless responses where the former is empty.

Mocked rows are always Fetch/XHR, and that is not a guess: the interceptor patches
exactly three APIs, so anything mocked was an API call by construction.

Each row reads `outcome · type · method · status · url`. The type column carries the
bucket, so an `OPTIONS` preflight sitting under Fetch/XHR reads as deliberate rather
than as a mistake; hovering it names the exact resource type Chrome reported. Fetch/XHR
is drawn in the accent colour and the rest are dimmed, since that bucket is the only
one this extension can act on.

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
