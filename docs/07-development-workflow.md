# 07 — Development workflow

## Commands

From the repo root:

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm test
```

```bash
pnpm typecheck
```

Watch mode while working on the extension:

```bash
pnpm --filter @network-mock/extension dev
```

Then reload the extension in Chrome after each rebuild (see below).

## Why the extension needs two bundlers

`extension/build.mjs` runs **esbuild and then Vite**, which looks redundant until you
hit the constraint. MV3 imposes two incompatible output formats:

| Code | Format required | Built by |
|---|---|---|
| Service worker | ES module (`"type": "module"`) | Vite |
| DevTools pages | HTML entries with JSX | Vite |
| Content scripts | **Classic script** — a single self-contained IIFE, no imports | esbuild |

Chrome loads content scripts as classic scripts, so `import` is a syntax error there.
And you cannot get both formats out of one Rollup output config: Rollup refuses
`format: 'iife'` with more than one input.

esbuild does the IIFE bundling in a few lines, so `build.mjs` runs it for the two
content scripts and lets Vite handle everything else.

Two ordering details that will bite if you change this:

- `emptyOutDir` is **false** in `vite.config.ts`. Otherwise Vite would delete the
  content scripts esbuild just wrote. `build.mjs` cleans `dist/` itself instead.
- `manifest.json` is copied by `build.mjs`, not by Vite.

Sanity check after a build — content scripts must contain no module syntax:

```bash
Select-String -Path extension\dist\injected\intercept.js -Pattern '^(import|export)\s'
```

No output is correct.

## Reloading after a change

| Changed | What to do |
|---|---|
| Panel / DevTools page | Close and reopen DevTools |
| Service worker | Reload icon on the `chrome://extensions` card |
| `intercept.ts` / `relay.ts` | Reload the extension **and** reload the page |
| `manifest.json` | Reload the extension |
| `shared/` | Rebuild, then whichever of the above applies |

When in doubt: reload the extension, then reload the page.

## Debugging: find the right console

An extension runs in four contexts with four separate consoles. This is where most
time gets lost — see [03](03-chrome-extension-primer.md#the-four-consoles).

| Code | Console |
|---|---|
| `intercept.js` | Page console (F12 → Console) |
| `relay.js` | Page console, with the **context dropdown** switched from `top` to `Network Mock` |
| Service worker | `chrome://extensions` → **Service worker** link |
| Panel | Undock DevTools, then F12 **on the DevTools window** |

## Tests

`shared/` has unit tests for the pure logic — matching and the enablement rules:

```bash
pnpm --filter @network-mock/shared test
```

These run TypeScript **directly**, with no build step: Node 24 strips types natively,
which is why imports carry explicit `.ts` extensions.

Add a test whenever you touch matching or enablement. Both are small, pure and
cheap to cover, and both are places where a subtle mistake produces a confusing
"my mock does not fire".

## Verifying the MCP server without a client

Protocol compliance can be checked with the official inspector, no vendor involved:

```bash
pnpm --filter @network-mock/mcp-server exec mcp-inspector node ./dist/index.js
```

Confirm the handshake succeeds, every tool lists with a full schema, and calls return
well-formed results.

Two things specifically worth re-checking if you touch the server:

- **stdout hygiene.** Every line on stdout must parse as JSON. Use `log.*` from
  `src/logger.ts`, never `console.*`. See [06](06-mcp.md#stdout-is-sacred-in-stdio-mode).
- **Clean exit.** The process must exit on stdin EOF and on Ctrl-C, or clients leak
  orphaned processes holding the bridge port.

## Verifying the interception engine

The engine can be exercised in a real browser without installing the extension at
all: serve `extension/dist` over http, load `dist/injected/intercept.js` into a plain
page, dispatch a `network-mock:config` CustomEvent with some mocks, then assert on
`fetch` and XHR behaviour.

This is the cheapest way to test the delicate parts — the XHR event ordering, the
`statusText` derivation, and the fail-open timeout — because it needs no extension
reload cycle and no DevTools interaction.

## Coding conventions

- **Strict TypeScript**, including `exactOptionalPropertyTypes`. When patch objects
  cross a JSON boundary use the `Patch<T>` helper from `shared/src/types.ts`, which
  tolerates explicitly-`undefined` keys.
- **Pure logic lives in `shared/`.** If both the panel and the MCP server need it, it
  belongs there — a second implementation will drift.
- **Comment the non-obvious, not the obvious.** The reason `emptyOutDir` is false, or
  why `NoInfer` is needed, is worth a line. `// increment i` is not.
- **In the panel, read `e.target.*` synchronously.** `update()` awaits the worker
  before applying a change, and React restores a controlled input's DOM state as soon
  as the handler returns. So this looks right and is broken:

  ```tsx
  // WRONG — reads the value React already reverted; the toggle never changes
  onChange={(e) => void update((w) => setEnabled(w, 'mock', id, e.target.checked))}
  ```

  ```tsx
  // RIGHT — capture first, then await
  onChange={(e) => { const next = e.target.checked; void update((w) => setEnabled(w, 'mock', id, next)); }}
  ```

  The failure mode is a checkbox that visibly ticks and then springs back, with no
  error anywhere. Panel writes are also serialised through a promise chain in
  `useWorkspace`, so overlapping edits cannot lose each other's changes.
