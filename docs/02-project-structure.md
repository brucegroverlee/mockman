# 02 — Project structure

```
mockman/
├─ package.json              # root scripts, Node pin (devEngines), pnpm pin (packageManager)
├─ pnpm-workspace.yaml       # which folders are packages + allowBuilds
├─ tsconfig.base.json        # one strict TS config, extended by each package
├─ .mcp.json                 # ready-made MCP registration for this repo
├─ scripts/
│  └─ print-mcp-config.mjs   # prints client-specific MCP config with real paths
├─ docs/                     # you are here
├─ shared/                   # @mockman/shared
├─ extension/                # @mockman/extension  → the Chrome extension
└─ mcp-server/               # @mockman/mcp-server → the MCP server
```

## Why three packages instead of one folder

`shared/` holds the data model, the request matcher, the enablement rules and the
mutation helpers. Both the extension **and** the MCP server import it.

That is the whole reason it is a real package: the MCP server must apply the *same*
definition of "create a mock" and "is this mock active" that the extension does. Two
copies of that logic would drift, and the drift would surface as an agent and a human
disagreeing about what the workspace contains — a miserable bug to chase.

## How the pnpm workspace works, if you have only used npm

`pnpm-workspace.yaml` lists the package folders. Each has its own `package.json`.
When one depends on another you write:

```json
"dependencies": { "@mockman/shared": "workspace:*" }
```

The `workspace:*` protocol means "the copy in this repo", never the registry. pnpm
links it, so an edit in `shared/` is visible immediately with no rebuild.

Useful commands:

```bash
pnpm --filter @mockman/extension build
```

```bash
pnpm -r typecheck
```

`-r` means recursive (every package). `--filter` targets one. pnpm orders recursive
tasks by dependency automatically.

### Two pnpm behaviours worth knowing

- **`node_modules` is not flat.** A package can only import what it actually
  declares. This is stricter than npm and catches a real class of bug: extension
  code is bundled and shipped to a browser, so an accidental import of some
  transitive dependency would otherwise get silently baked into the artefact.
- **Install scripts are blocked by default.** Approve them in `allowBuilds:`
  (esbuild is already there — it needs to fetch its native binary).

## `shared/` is consumed as source, not as a build output

`shared/package.json` points its export straight at TypeScript:

```json
"exports": { ".": "./src/index.ts" }
```

There is deliberately no build step. Both consumers are bundlers (Vite for the
extension, tsup for the MCP server) and compile the TypeScript themselves. This
removes a whole category of confusion — there is no stale `dist/` that can disagree
with the source you are reading.

The cost is that `tsconfig.base.json` needs `"moduleResolution": "bundler"` and
`"allowImportingTsExtensions": true`, and that imports carry explicit `.ts`
extensions. That extension is also what lets Node run the test files directly, with
no compile step (see [07](07-development-workflow.md)).

## Inside `extension/`

```
extension/
├─ manifest.json             # the extension's declaration to Chrome
├─ build.mjs                 # orchestrates TWO bundlers — see 07 for why
├─ vite.config.ts            # service worker + DevTools pages (ES modules)
└─ src/
   ├─ background/
   │  ├─ index.ts            # service worker: owns all state
   │  └─ bridge.ts           # WebSocket client that dials the MCP server
   ├─ content/relay.ts       # ISOLATED world: carries config into the page
   ├─ injected/intercept.ts  # MAIN world: the actual fetch/XHR patching
   └─ devtools/
      ├─ devtools.html/.ts   # registers the panel
      ├─ panel.html
      └─ panel/
         ├─ App.tsx          # shell: app bar, resizable split, hit log
         ├─ Tree.tsx         # the folder/mock explorer, search and drag-drop
         ├─ Detail.tsx       # breadcrumb, name, url, the three payload tabs
         ├─ HitLog.tsx       # what the tab did, and the "mock it" capture
         ├─ CodeEditor.tsx   # line-numbered textarea
         ├─ messaging.ts     # worker messaging + the React hooks
         ├─ network.ts       # merges devtools.network with the mocked-hit stream
         └─ labels.ts        # strings shared across components
```

If you read only one file, read `src/injected/intercept.ts` — it is where the
mocking happens, and it carries the most subtle constraints.

## Inside `mcp-server/`

```
mcp-server/
├─ tsup.config.ts            # bundles to one file: dist/index.js
└─ src/
   ├─ index.ts               # CLI, transports, lifecycle
   ├─ bridge.ts              # WebSocket SERVER the extension dials into
   ├─ tools.ts               # every MCP tool
   └─ logger.ts              # stderr-only logging (see 06 for why that matters)
```

It bundles to a single `dist/index.js` on purpose: MCP client configs can then point
at one absolute path with no dependency resolution to go wrong.
