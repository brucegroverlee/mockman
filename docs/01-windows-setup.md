# 01 — Windows setup, from nothing

This machine started with **no Node.js and no npm**. This page records exactly how
the toolchain was built, including the traps that cost real time.

## PowerShell survival guide

The default shell here is **Windows PowerShell 5.1**. It is *not* bash, and several
habits transfer badly:

| You might type | It fails because | Use instead |
|---|---|---|
| `cmd1 && cmd2` | `&&` is not a PowerShell 5.1 operator | `cmd1; if ($?) { cmd2 }` |
| `ls -la` | `ls` is an alias for `Get-ChildItem`, which has no `-la` | `Get-ChildItem` |
| `cat file \| head -5` | no `head` | `Get-Content file -TotalCount 5` |
| `export FOO=bar` | no `export` | `$env:FOO = 'bar'` |
| `which node` | no `which` | `(Get-Command node).Source` |
| `rm -rf dir` | different flags | `Remove-Item -Recurse -Force dir` |
| `$x ? a : b` | no ternary in 5.1 | `if ($x) { a } else { b }` |
| `mkdir -p a/b` | `-p` is not a flag | `New-Item -ItemType Directory -Force a/b` |

Paths use backslashes, but forward slashes work almost everywhere too. Quote any
path containing spaces.

## The trap that will get you first: PATH is not refreshed

When `winget` installs something, it updates the PATH stored in the **registry** —
but your *already-open* shell keeps the copy it started with. So you install a tool,
type its name, and get "not recognized". The tool is fine; your shell is stale.

Either open a new terminal, or re-read the environment in place:

```bash
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
```

Note it concatenates **Machine** then **User** — that is the order Windows itself
uses, and it matters: a Machine PATH entry always wins over a User one. That detail
caused a real problem, described at the bottom of this page.

## Step 1 — install pnpm

```bash
winget install --id pnpm.pnpm --exact --accept-package-agreements --accept-source-agreements
```

pnpm is our package manager *and* our Node version manager. It ships as a
self-contained binary with its own Node bundled inside, so it runs before Node is
installed at all.

Refresh PATH (see above), then confirm:

```bash
pnpm --version
```

## Step 2 — point pnpm's global bin at your PATH

pnpm needs two environment settings. Set them once, permanently:

```bash
[Environment]::SetEnvironmentVariable('PNPM_HOME', "$env:LOCALAPPDATA\pnpm", 'User')
```

```bash
$p = "$env:LOCALAPPDATA\pnpm\bin"; $u = [Environment]::GetEnvironmentVariable('Path','User'); if ($u -notlike "*$p*") { [Environment]::SetEnvironmentVariable('Path', "$p;$u", 'User') }
```

> Do **not** run `pnpm setup`. On this setup it tries to reinstall the pnpm CLI into
> its own global store and fails with an `ENOENT` on `@pnpm/exe`. The two commands
> above are all `pnpm setup` was needed for.

## Step 3 — install dependencies, and Node comes with them

```bash
pnpm install
```

That is genuinely all. The repo's `package.json` contains:

```json
"devEngines": { "runtime": { "name": "node", "version": "24.18.1", "onFail": "download" } }
```

`onFail: "download"` means pnpm fetches that exact Node version automatically if it
is missing. A teammate who clones this repo needs **only pnpm** — no Node install,
no version manager, no instructions to follow.

Two pins, two mechanisms, both in `package.json`:

- **Node** — pinned by `devEngines.runtime`, enforced by pnpm.
- **pnpm itself** — pinned by `packageManager`, which pnpm 10+ honours natively
  (`manage-package-manager-versions` is on by default). No Corepack needed.

Verify:

```bash
pnpm exec node --version
```

`pnpm exec` is how you run Node tooling. It puts the project's pinned Node and the
local `node_modules/.bin` on PATH for that one command.

## Step 4 — approve esbuild's install script

pnpm blocks dependency install scripts by default, which is a good default. esbuild
genuinely needs its own — it downloads the platform-native binary that Vite and tsup
both depend on. It is already approved in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: true
```

If you ever see `ERR_PNPM_IGNORED_BUILDS`, that file is where to add the package.

## Do you need Node on your PATH?

For this repo, no — `pnpm exec node` covers it, and it always uses the pinned
version. If you want a bare `node` command available everywhere:

```bash
pnpm runtime set node lts -g
```

> On pnpm 11.15.1 this global install currently fails on Windows with an `ENOENT`
> under `pnpm\global\v11\...\node_modules\node`. It is a pnpm bug, not a
> misconfiguration, and it does not affect this project — `pnpm exec` and
> `pnpm run` both work regardless. Skip it unless you need a global `node`.

## Execution policy

If a `.ps1` script refuses to run ("running scripts is disabled"), allow local
scripts for your user only:

```bash
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Nothing in this repo requires it — our scripts are `.mjs`, run through Node.

## A warning: do not add Volta alongside pnpm

This project originally used [Volta](https://volta.sh) to manage Node. It was
removed after hitting a hard conflict, recorded here so nobody reintroduces it.

**The symptom:** everything looks installed, `node -v` works in your terminal, but
any `pnpm` script that shells out to Node dies with `'node' is not recognized`.

**The cause:** Volta installs shims into `C:\Program Files\Volta`, which is on the
**Machine** PATH and therefore beats every User PATH entry — so `pnpm` resolves to
*Volta's* `pnpm.exe` shim. Because Volta does not manage pnpm (that support is
experimental and gated behind `VOLTA_FEATURE_PNPM`), its shim runs the real pnpm
with Volta's own directories **stripped from the child environment**. The result:
pnpm works, but every process pnpm spawns has no `node` at all.

Diagnose it by comparing:

```bash
pnpm exec cmd /c "echo %PATH%"
```

If that output has no Volta directory in it while your own `$env:Path` does, this is
what you are looking at.

**The fix:** use one manager, not two. pnpm does both jobs.

```bash
winget uninstall --id Volta.Volta --exact
```

That uninstall needs **administrator rights** and will raise a UAC prompt, because
it edits the Machine PATH. If the command appears to hang, look for the UAC dialog —
it may be behind another window. Reordering your User PATH cannot fix this, because
Machine PATH is always searched first.
