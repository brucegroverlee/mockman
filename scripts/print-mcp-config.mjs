#!/usr/bin/env node
/**
 * Prints ready-to-paste MCP client configuration for this checkout, with real
 * absolute paths already filled in.
 *
 * This exists because hand-assembling the config is the step people get wrong,
 * especially on Windows: clients spawn servers without a shell, so a bare `npx` or
 * `pnpm` (both `.cmd` shims) fails with `spawn ENOENT`/`EINVAL`, and GUI-launched
 * editors often inherit a PATH with no Node on it at all. Pointing at a real
 * `node.exe` by absolute path sidesteps every one of those problems.
 *
 *   pnpm mcp-config          # all clients
 *   pnpm mcp-config codex    # just one
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = join(repo, 'mcp-server', 'dist', 'index.js');

/**
 * Prefer the pnpm-managed node binary in this repo: on Windows it is a genuine
 * `.exe`, so no shell is needed, and it is the exact pinned version. Fall back to
 * whatever is running this script.
 */
function nodeBinary() {
  const local = join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'node.exe' : 'node');
  return existsSync(local) ? local : process.execPath;
}

const node = nodeBinary();

/** JSON string literal — backslashes doubled. Correct inside .json / .toml. */
const j = (value) => JSON.stringify(value);

/**
 * Shell-quoted path — backslashes left alone.
 *
 * Not the same as `j()`: pasting a JSON-escaped Windows path into a terminal gives
 * you a doubled-backslash path that does not exist.
 */
const sh = (value) => (/[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);

const CLIENTS = {
  'claude-code': {
    label: 'Claude Code',
    where: '.mcp.json in the repo root (already committed), or run the command below',
    body: `claude mcp add network-mock -- ${sh(node)} ${sh(serverPath)}

Or the equivalent .mcp.json:

${JSON.stringify({ mcpServers: { 'network-mock': { command: node, args: [serverPath] } } }, null, 2)}`,
  },

  cursor: {
    label: 'Cursor',
    where: '.cursor/mcp.json in the project, or ~/.cursor/mcp.json for every project',
    body: JSON.stringify(
      { mcpServers: { 'network-mock': { command: node, args: [serverPath] } } },
      null,
      2,
    ),
  },

  windsurf: {
    label: 'Windsurf',
    where: '~/.codeium/windsurf/mcp_config.json',
    body: JSON.stringify(
      { mcpServers: { 'network-mock': { command: node, args: [serverPath] } } },
      null,
      2,
    ),
  },

  'claude-desktop': {
    label: 'Claude Desktop',
    where: '%APPDATA%\\Claude\\claude_desktop_config.json',
    body: JSON.stringify(
      { mcpServers: { 'network-mock': { command: node, args: [serverPath] } } },
      null,
      2,
    ),
  },

  codex: {
    label: 'Codex',
    where: '~/.codex/config.toml (or .codex/config.toml in a trusted project)',
    // Codex uses TOML and the key is mcp_servers, not mcpServers.
    body: `[mcp_servers.network-mock]
command = ${j(node)}
args = [${j(serverPath)}]`,
  },

  vscode: {
    label: 'VS Code',
    where: '.vscode/mcp.json',
    // VS Code wraps under "servers", not "mcpServers".
    body: JSON.stringify(
      { servers: { 'network-mock': { command: node, args: [serverPath] } } },
      null,
      2,
    ),
  },

  zed: {
    label: 'Zed',
    where: 'Zed settings',
    body: JSON.stringify(
      { context_servers: { 'network-mock': { command: { path: node, args: [serverPath] } } } },
      null,
      2,
    ),
  },

  http: {
    label: 'Any client that connects by URL (Streamable HTTP)',
    where: 'Start the server yourself, then point the client at the URL',
    body: `Run:
  ${sh(node)} ${sh(serverPath)} --http

Then configure:
${JSON.stringify({ mcpServers: { 'network-mock': { url: 'http://127.0.0.1:8788' } } }, null, 2)}

Codex equivalent:
[mcp_servers.network-mock]
url = "http://127.0.0.1:8788"`,
  },
};

const requested = process.argv[2];

if (!existsSync(serverPath)) {
  console.error(`! ${serverPath} does not exist yet. Run "pnpm build" first.\n`);
}

const chosen = requested ? { [requested]: CLIENTS[requested] } : CLIENTS;

if (requested && !CLIENTS[requested]) {
  console.error(`Unknown client "${requested}". Options: ${Object.keys(CLIENTS).join(', ')}`);
  process.exit(1);
}

for (const [key, client] of Object.entries(chosen)) {
  console.log('='.repeat(72));
  console.log(`${client.label}   (${key})`);
  console.log(`Config location: ${client.where}`);
  console.log('='.repeat(72));
  console.log(client.body);
  console.log();
}
