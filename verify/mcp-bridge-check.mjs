/**
 * End-to-end check of the MCP server against a *simulated* extension.
 *
 * The real extension side cannot easily be automated (it lives in a DevTools panel),
 * but the bridge contract can be: this stands in a WebSocket client that implements
 * the same methods the service worker does, then drives real MCP tool calls through
 * it. That covers the bridge protocol, the tools, and the shared mutation and
 * enablement logic in one pass.
 */

import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'ws';

const [serverPath, portArg] = process.argv.slice(2);
const bridgePort = Number(portArg);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`);
};

// ---------------------------------------------------------------------------
// The stand-in extension: holds a workspace in memory, exactly as the service
// worker holds it in chrome.storage.
// ---------------------------------------------------------------------------
let workspace = { version: 1, enabled: true, groups: [], tags: [], targetTabIds: [] };
const TABS = [
  { id: 101, title: 'App under test', url: 'https://example.com/app', active: true },
  { id: 202, title: 'Docs', url: 'https://example.com/docs', active: false },
];
const hits = [
  { id: 'h1', tabId: 101, timestamp: 1, method: 'GET', url: 'https://example.com/api/users', outcome: 'mocked', mockId: 'x', label: 'g / m', status: 200 },
  { id: 'h2', tabId: 101, timestamp: 2, method: 'GET', url: 'https://example.com/other', outcome: 'passed' },
];

const child = spawn(process.execPath, [serverPath, '--bridge-port', String(bridgePort)], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.resume();

let buffer = '';
const waiters = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && waiters.has(message.id)) {
        waiters.get(message.id)(message);
        waiters.delete(message.id);
      }
    } catch { /* covered by the compliance check */ }
  }
});

let seq = 0;
function request(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

/** Calls a tool and parses the JSON text it returns. */
async function tool(name, args = {}) {
  const reply = await request('tools/call', { name, arguments: args });
  const text = reply.result?.content?.[0]?.text ?? JSON.stringify(reply);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function connectFakeExtension() {
  const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/`);
  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  socket.send(JSON.stringify({ type: 'hello', version: 1 }));

  socket.on('message', (raw) => {
    const call = JSON.parse(String(raw));
    if (typeof call.id !== 'number') return;
    let result;
    try {
      switch (call.method) {
        case 'getWorkspace': result = workspace; break;
        case 'setWorkspace':
          // Mirror the real worker: tab targeting is owned by the browser.
          workspace = { ...call.params.workspace, targetTabIds: workspace.targetTabIds };
          result = { ok: true };
          break;
        case 'listTabs': result = TABS; break;
        case 'setTargetTabs':
          workspace = { ...workspace, targetTabIds: [...new Set(call.params.tabIds)] };
          result = { ok: true };
          break;
        case 'getHits': result = hits; break;
        case 'clearHits': hits.length = 0; result = { ok: true }; break;
        default: throw new Error(`unknown method ${call.method}`);
      }
      socket.send(JSON.stringify({ id: call.id, result }));
    } catch (error) {
      socket.send(JSON.stringify({ id: call.id, error: error.message }));
    }
  });
  return socket;
}

try {
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bridge-check', version: '1.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const socket = await connectFakeExtension();
  await new Promise((r) => setTimeout(r, 200));

  // --- tabs ---
  const tabs = await tool('list_tabs');
  check('list_tabs reaches the extension', Array.isArray(tabs) && tabs.length === 2, JSON.stringify(tabs));

  await tool('set_target_tabs', { tabIds: [101] });
  check('set_target_tabs applied', workspace.targetTabIds.join() === '101', JSON.stringify(workspace.targetTabIds));

  // --- groups and mocks ---
  const group = await tool('create_group', { name: 'checkout' });
  check('create_group returns an id', typeof group.id === 'string' && group.id.startsWith('grp_'), JSON.stringify(group));

  const mock = await tool('create_mock', {
    groupId: group.id,
    name: 'pay fails',
    match: { method: 'POST', urlPattern: '*/api/pay', patternKind: 'glob' },
    response: { status: 500, headers: {}, body: '{"error":"boom"}', bodyKind: 'json' },
  });
  check('create_mock returns an id', typeof mock.id === 'string' && mock.id.startsWith('mck_'), JSON.stringify(mock));
  check('mock persisted into the group', workspace.groups[0]?.mocks?.length === 1, JSON.stringify(workspace.groups[0]));

  // --- activation reasoning ---
  let status = await tool('get_status');
  check('get_status reports the mock active', status.groups?.[0]?.mocks?.[0]?.active === true, JSON.stringify(status.groups?.[0]?.mocks?.[0]));

  // --- the tag veto, the subtlest rule in the system ---
  const tag = await tool('create_tag', { name: 'failures' });
  await tool('update_mock', { mockId: mock.id, tagIds: [tag.id] });
  await tool('set_enabled', { kind: 'tag', id: tag.id, enabled: false });

  status = await tool('get_status');
  const vetoed = status.groups?.[0]?.mocks?.[0];
  check('disabled tag vetoes an otherwise-enabled mock', vetoed?.active === false && vetoed?.inactiveReason === 'tag-disabled', JSON.stringify(vetoed));
  check('the mock itself is still marked enabled', vetoed?.enabled === true, JSON.stringify(vetoed));

  await tool('set_enabled', { kind: 'tag', id: tag.id, enabled: true });
  status = await tool('get_status');
  check('re-enabling the tag restores it', status.groups?.[0]?.mocks?.[0]?.active === true, JSON.stringify(status.groups?.[0]?.mocks?.[0]));

  // --- group and master switches are independent ---
  await tool('set_enabled', { kind: 'group', id: group.id, enabled: false });
  status = await tool('get_status');
  check('group switch deactivates its mocks', status.groups?.[0]?.mocks?.[0]?.inactiveReason === 'group-disabled', JSON.stringify(status.groups?.[0]?.mocks?.[0]));
  await tool('set_enabled', { kind: 'group', id: group.id, enabled: true });

  await tool('set_enabled', { kind: 'workspace', id: null, enabled: false });
  status = await tool('get_status');
  check('master switch overrides everything', status.groups?.[0]?.mocks?.[0]?.inactiveReason === 'workspace-disabled', JSON.stringify(status.groups?.[0]?.mocks?.[0]));
  await tool('set_enabled', { kind: 'workspace', id: null, enabled: true });

  // --- update_mock must not clobber untouched fields ---
  await tool('update_mock', { mockId: mock.id, name: 'renamed' });
  const afterRename = workspace.groups[0].mocks[0];
  check('partial update preserves match and response', afterRename.name === 'renamed' && afterRename.response.status === 500 && afterRename.match.urlPattern === '*/api/pay', JSON.stringify(afterRename));

  // --- hit log ---
  const hitLog = await tool('get_hit_log', { limit: 10 });
  check('get_hit_log returns both mocked and passed', Array.isArray(hitLog) && hitLog.length === 2, JSON.stringify(hitLog).slice(0, 200));

  // --- export / import round trip ---
  const exported = await tool('export_workspace');
  const exportedText = typeof exported === 'string' ? exported : JSON.stringify(exported);
  check('export excludes tab targeting', JSON.parse(exportedText).targetTabIds.length === 0, exportedText.slice(0, 120));

  const before = JSON.stringify(workspace.groups);
  await tool('import_workspace', { json: exportedText });
  check('import round trip preserves the groups', JSON.stringify(workspace.groups) === before, JSON.stringify(workspace.groups).slice(0, 200));
  check('import leaves tab targeting alone', workspace.targetTabIds.join() === '101', JSON.stringify(workspace.targetTabIds));

  // --- disconnect handling ---
  socket.close();
  await new Promise((r) => setTimeout(r, 400));
  const afterClose = await tool('get_workspace');
  check('clear error once the extension disconnects', /not connected/i.test(JSON.stringify(afterClose)), JSON.stringify(afterClose).slice(0, 200));
} catch (error) {
  check('no unexpected failure', false, error.stack);
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 500);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
