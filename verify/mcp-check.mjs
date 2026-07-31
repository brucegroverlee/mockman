/**
 * Protocol-compliance check for the Network Mock MCP server, with no vendor client
 * in the loop.
 *
 * Verifies the things that actually break interoperability:
 *  - the initialize/tools-list handshake works
 *  - EVERY line on stdout is valid JSON-RPC (a stray console.log is fatal to
 *    every stdio client, and produces an opaque error)
 *  - tools have complete schemas
 *  - a tool needing the extension fails fast with a clear message instead of hanging
 *  - the process exits when stdin closes, so clients don't leak orphans
 */

import { spawn } from 'node:child_process';

const [serverPath, bridgePort] = process.argv.slice(2);

const child = spawn(process.execPath, [serverPath, '--bridge-port', bridgePort], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

const stdoutLines = [];
const stderrText = [];
let buffer = '';
const waiters = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    stdoutLines.push(line);
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && waiters.has(message.id)) {
        waiters.get(message.id)(message);
        waiters.delete(message.id);
      }
    } catch {
      /* recorded below as a hygiene failure */
    }
  }
});

child.stderr.on('data', (chunk) => stderrText.push(chunk.toString()));

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n');
}

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    waiters.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`);
};

try {
  // --- handshake ---
  const init = await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'compliance-check', version: '1.0.0' },
  });
  check('initialize succeeds', !!init.result, JSON.stringify(init).slice(0, 300));
  check(
    'server identifies itself',
    init.result?.serverInfo?.name === 'network-mock',
    JSON.stringify(init.result?.serverInfo),
  );
  check('negotiates a protocol version', !!init.result?.protocolVersion, init.result?.protocolVersion);
  check('advertises tools capability', !!init.result?.capabilities?.tools, JSON.stringify(init.result?.capabilities));

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // --- tools ---
  const list = await request(2, 'tools/list', {});
  const tools = list.result?.tools ?? [];
  check('tools/list returns tools', tools.length > 0, `got ${tools.length}`);

  const expected = [
    'get_workspace', 'get_status', 'list_tabs', 'set_target_tabs', 'set_enabled',
    'create_group', 'update_group', 'delete_group', 'reorder_groups',
    'create_mock', 'update_mock', 'delete_mock',
    'create_tag', 'update_tag', 'delete_tag',
    'get_hit_log', 'clear_hit_log', 'export_workspace', 'import_workspace',
  ];
  const names = tools.map((t) => t.name);
  const missing = expected.filter((n) => !names.includes(n));
  check('all planned tools are registered', missing.length === 0, `missing: ${missing.join(', ')}`);

  const undescribed = tools.filter((t) => !t.description || t.description.length < 20);
  check('every tool has a substantive description', undescribed.length === 0, undescribed.map((t) => t.name).join(', '));

  const schemaless = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object');
  check('every tool has an object inputSchema', schemaless.length === 0, schemaless.map((t) => t.name).join(', '));

  // --- graceful failure when the extension is absent ---
  const call = await request(3, 'tools/call', { name: 'get_workspace', arguments: {} });
  const text = JSON.stringify(call);
  check(
    'tool needing the extension fails fast with a clear message',
    /not connected/i.test(text),
    text.slice(0, 300),
  );

  // --- stdout hygiene: the single most common interop killer ---
  const badLines = stdoutLines.filter((line) => {
    try {
      JSON.parse(line);
      return false;
    } catch {
      return true;
    }
  });
  check('stdout carries only valid JSON-RPC', badLines.length === 0, badLines.slice(0, 3).join(' | '));
  check('server logs to stderr', stderrText.join('').includes('network-mock'), stderrText.join('').slice(0, 200));

  // --- clean exit on stdin close ---
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
    child.stdin.end();
  });
  check('exits when stdin closes (no orphaned process)', exited, 'still running after 8s');
} catch (error) {
  check('no unexpected failure', false, error.message);
} finally {
  if (child.exitCode === null) child.kill();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
