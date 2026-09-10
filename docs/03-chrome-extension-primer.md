# 03 — Chrome extension primer

Written for someone who has never built one. If you have, skip to
[04-architecture](04-architecture.md) — but do read **The four consoles** and
**Execution worlds**, which are where most debugging time goes.

## Manifest V3

An extension is a folder with a `manifest.json` describing what it contains and what
it is allowed to do. Chrome enforces that manifest strictly. Manifest V3 (MV3) is the
current generation; the main consequence for us is that background code is a
**service worker** rather than a persistent page.

Ours declares four kinds of code:

```json
{
  "devtools_page": "devtools/devtools.html",
  "background": { "service_worker": "background/index.js", "type": "module" },
  "content_scripts": [ ... two entries ... ],
  "permissions": ["storage", "unlimitedStorage", "tabs", "scripting"],
  "host_permissions": ["<all_urls>"]
}
```

### Service worker

Event-driven background code. The critical thing to internalise: **it is not
persistent.** Chrome starts it when something needs it and kills it after roughly 30
seconds idle. So:

- Never keep important state in a module-level variable expecting it to survive.
  Ours persists the workspace in `chrome.storage`.
- Our hit log *is* held in memory, accepting that it is lost if the worker restarts.
  It is transient debug data; that is a deliberate trade, not an oversight.
- An open WebSocket keeps it alive (since Chrome 116, socket activity resets the idle
  timer), which is why the MCP bridge does not need heroics.

### Content scripts

Code injected into web pages. Ours are declared statically in the manifest with
`"run_at": "document_start"`, meaning they execute **before the page's own scripts**.
That timing is essential — we must patch `fetch` before the page can call it.

> Static declaration is not a stylistic choice. `chrome.scripting.executeScript`
> cannot inject at `document_start` at all, so the manifest is the only reliable way
> to run first.

### DevTools page

A hidden page Chrome loads whenever DevTools opens. Its only job is to register our
panel:

```js
chrome.devtools.panels.create('Network Mock', '', 'devtools/panel.html');
```

The panel itself is a normal HTML page rendered inside DevTools.

## Execution worlds — the concept that makes this project possible

A content script normally runs in an **ISOLATED world**: same DOM as the page, but a
separate JavaScript universe. The page cannot see your variables, and — crucially —
**you cannot patch the page's `window.fetch`**, because you have a different `window`.

Setting `"world": "MAIN"` runs the script in the page's *own* JavaScript context, so
`window.fetch` is the same object the page uses. That is the only way to substitute a
response body while DevTools is open (see [05](05-interception.md) for why the
obvious alternative is unavailable).

The trade-off is that a MAIN-world script has **no access to any `chrome.*` API**. It
cannot read storage or message the service worker. So we run two content scripts:

| Script | World | Can patch `fetch`? | Can use `chrome.*`? |
|---|---|---|---|
| `injected/intercept.js` | MAIN | **yes** | no |
| `content/relay.js` | ISOLATED | no | **yes** |

They talk to each other over DOM `CustomEvent`s, which both can see. That is the
entire reason `relay.ts` exists.

> There is no guaranteed ordering between the two worlds at `document_start`. The code
> handles both orders: the interceptor announces itself when it loads, *and* the relay
> pushes config unprompted when it loads. Whichever happens first, the page ends up
> configured.

## Loading the extension

1. Build it: `pnpm build` from the repo root.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and choose `extension/dist` — the **built** folder, not
   `extension/`.

## The four consoles

This is the highest-value thing on this page. An extension's code runs in four
separate contexts, each with its **own** console. An error in one is invisible from
the others, and looking in the wrong place makes a working system seem broken.

| Code | Where its logs and errors appear |
|---|---|
| `injected/intercept.js` (MAIN) | The **page's** console (normal F12 → Console) |
| `content/relay.js` (ISOLATED) | Also the page's console, but you must switch the **context dropdown** from `top` to `Network Mock` |
| `background/index.js` | `chrome://extensions` → our card → **Service worker** link |
| The DevTools panel | **Undock DevTools** into its own window, then press F12 *on that window* — DevTools for DevTools |

That last one surprises everyone. A React error in the panel appears nowhere in the
page's console.

## Reloading after a change

What you must do depends on what you changed:

| Changed | Action |
|---|---|
| Panel or DevTools page | Close and reopen DevTools |
| Service worker | Click the **reload icon** on the `chrome://extensions` card |
| Content scripts (`intercept`/`relay`) | Reload the extension **and** reload the page |
| `manifest.json` | Reload the extension |

When in doubt: reload the extension, then reload the page. See
[07](07-development-workflow.md).

## Permissions we ask for, and why

| Permission | Why |
|---|---|
| `storage` | Persist the folder/mock tree and tags |
| `unlimitedStorage` | Mock bodies can be large JSON payloads |
| `tabs` | Broadcast config changes to every tab, drop closed tabs from the target set, and list tabs for the MCP `list_tabs` tool |
| `scripting` | Content script management |
| `host_permissions: <all_urls>` | Content scripts must be able to run on whatever page you are debugging |

`<all_urls>` is broad, and Chrome will say so on the extension card. It is inherent to
a tool that mocks arbitrary sites. Mitigating it: the extension is **inert on every
tab you have not explicitly targeted**, so breadth of access does not mean breadth of
effect.
