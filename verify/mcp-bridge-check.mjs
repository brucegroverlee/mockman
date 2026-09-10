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
let workspace = { version: 2, enabled: true, tree: [], tags: [], targetTabIds: [] };
const TABS = [
  { id: 101, title: 'App under test', url: 'https://example.com/app', active: true },
  { id: 202, title: 'Docs', url: 'https://example.com/docs', active: false },
];
const hits = [
  { id: 'h1', tabId: 101, timestamp: 1, method: 'GET', url: 'https://example.com/api/users', outcome: 'mocked', mockId: 'x', path: 'f / m', status: 200 },
  { id: 'h2', tabId: 101, timestamp: 2, method: 'GET', url: 'https://example.com/other', outcome: 'passed' },
];

/** Every mock in the tree, depth first — the same order the extension resolves in. */
function flatMocks(nodes = workspace.tree, out = []) {
  for (const node of nodes) {
    if (node.kind === 'folder') flatMocks(node.children, out);
    else out.push(node);
  }
  return out;
}

function findNode(id, nodes = workspace.tree) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === 'folder') {
      const hit = findNode(id, node.children);
      if (hit) return hit;
    }
  }
  return null;
}

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

  // --- nested folders ---
  const outer = await tool('create_folder', { name: 'Web-edge-API' });
  check('create_folder returns an id', typeof outer.id === 'string' && outer.id.startsWith('fld_'), JSON.stringify(outer));

  const inner = await tool('create_folder', { parentId: outer.id, name: 'Checkout' });
  check('a folder can be created inside another', findNode(outer.id)?.children?.[0]?.id === inner.id, JSON.stringify(workspace.tree));

  const deep = await tool('create_folder', { parentId: inner.id, name: 'Payments' });
  check('nesting goes deeper than two levels', findNode(deep.id) !== null, JSON.stringify(workspace.tree).slice(0, 200));

  // --- mocks, with the v2 fields ---
  const mock = await tool('create_mock', {
    parentId: deep.id,
    name: 'pay fails',
    label: 'boom',
    match: {
      method: 'POST',
      urlPattern: '*/api/pay',
      patternKind: 'glob',
      body: { mode: 'json-subset', value: '{"amount":100}' },
    },
    response: { status: 500, headers: {}, body: '{"error":"boom"}', bodyKind: 'json', delayMs: 750 },
  });
  check('create_mock returns an id', typeof mock.id === 'string' && mock.id.startsWith('mck_'), JSON.stringify(mock));

  const stored = findNode(mock.id);
  check('mock persisted three folders deep', stored !== null && stored.kind === 'mock', JSON.stringify(workspace.tree).slice(0, 200));
  check('delayMs round-trips', stored?.response?.delayMs === 750, JSON.stringify(stored?.response));
  check('the body matcher round-trips', stored?.match?.body?.mode === 'json-subset', JSON.stringify(stored?.match));
  check('the label round-trips', stored?.label === 'boom', JSON.stringify(stored?.label));

  // --- activation reasoning, now with a breadcrumb ---
  let status = await tool('get_status');
  check('get_status reports the mock active', status.mocks?.[0]?.active === true, JSON.stringify(status.mocks?.[0]));
  check(
    'get_status reports the full breadcrumb path',
    status.mocks?.[0]?.path === 'Web-edge-API / Checkout / Payments / pay fails',
    JSON.stringify(status.mocks?.[0]?.path),
  );

  // --- the tag veto, the subtlest rule in the system ---
  const tag = await tool('create_tag', { name: 'failures' });
  await tool('update_mock', { mockId: mock.id, tagIds: [tag.id] });
  await tool('set_enabled', { kind: 'tag', id: tag.id, enabled: false });

  status = await tool('get_status');
  let subject = status.mocks?.[0];
  check('disabled tag vetoes an otherwise-enabled mock', subject?.active === false && subject?.inactiveReason === 'tag-disabled', JSON.stringify(subject));
  check('the mock itself is still marked enabled', subject?.enabled === true, JSON.stringify(subject));

  await tool('set_enabled', { kind: 'tag', id: tag.id, enabled: true });
  status = await tool('get_status');
  check('re-enabling the tag restores it', status.mocks?.[0]?.active === true, JSON.stringify(status.mocks?.[0]));

  // A tag on an ANCESTOR must veto too — the rule that makes tags worth having
  // on folders at all.
  await tool('update_mock', { mockId: mock.id, tagIds: [] });
  await tool('update_folder', { folderId: outer.id, tagIds: [tag.id] });
  await tool('set_enabled', { kind: 'tag', id: tag.id, enabled: false });
  status = await tool('get_status');
  check('a disabled tag on an ancestor folder vetoes the mock', status.mocks?.[0]?.inactiveReason === 'tag-disabled', JSON.stringify(status.mocks?.[0]));
  await tool('set_enabled', { kind: 'tag', id: tag.id, enabled: true });

  // --- folder and master switches are independent ---
  await tool('set_enabled', { kind: 'folder', id: outer.id, enabled: false });
  status = await tool('get_status');
  check('an ancestor folder switch deactivates the mocks beneath it', status.mocks?.[0]?.inactiveReason === 'folder-disabled', JSON.stringify(status.mocks?.[0]));
  await tool('set_enabled', { kind: 'folder', id: outer.id, enabled: true });

  await tool('set_enabled', { kind: 'workspace', id: null, enabled: false });
  status = await tool('get_status');
  check('master switch overrides everything', status.mocks?.[0]?.inactiveReason === 'workspace-disabled', JSON.stringify(status.mocks?.[0]));
  await tool('set_enabled', { kind: 'workspace', id: null, enabled: true });

  // --- update_mock must not clobber untouched fields ---
  await tool('update_mock', { mockId: mock.id, name: 'renamed' });
  const afterRename = findNode(mock.id);
  check(
    'partial update preserves match and response',
    afterRename.name === 'renamed' && afterRename.response.status === 500 && afterRename.match.urlPattern === '*/api/pay' && afterRename.response.delayMs === 750,
    JSON.stringify(afterRename),
  );

  // --- tree structure ---
  await tool('move_node', { nodeId: mock.id, parentId: outer.id });
  check('move_node reparents', findNode(outer.id).children.some((c) => c.id === mock.id), JSON.stringify(workspace.tree).slice(0, 200));
  check('move_node removes it from the old parent', findNode(deep.id).children.length === 0, JSON.stringify(findNode(deep.id)));

  const badMove = await tool('move_node', { nodeId: outer.id, parentId: deep.id });
  check('a folder cannot be moved inside its own descendant', /inside itself/i.test(JSON.stringify(badMove)), JSON.stringify(badMove).slice(0, 200));
  check('and the tree is left intact', findNode(outer.id) !== null && findNode(deep.id) !== null, 'tree damaged');

  const dup = await tool('duplicate_node', { nodeId: mock.id });
  check('duplicate_node gives the copy a fresh id', typeof dup.newId === 'string' && dup.newId !== mock.id, JSON.stringify(dup));
  check('both the original and the copy exist', findNode(mock.id) !== null && findNode(dup.newId) !== null, JSON.stringify(dup));
  await tool('delete_node', { nodeId: dup.newId });

  await tool('rename_node', { nodeId: outer.id, name: 'Edge API' });
  check('rename_node applies', findNode(outer.id).name === 'Edge API', JSON.stringify(findNode(outer.id)?.name));

  // --- ordering decides which of two overlapping mocks wins ---
  const catchAll = await tool('create_mock', {
    parentId: outer.id,
    name: 'catch all',
    match: { method: '*', urlPattern: '*', patternKind: 'glob' },
    response: { status: 200, headers: {}, body: '{}', bodyKind: 'json', delayMs: 0 },
  });
  await tool('reorder_children', { parentId: outer.id, orderedIds: [catchAll.id, mock.id] });
  check('reorder_children puts the catch-all first', flatMocks()[0]?.id === catchAll.id, JSON.stringify(flatMocks().map((m) => m.name)));
  await tool('reorder_children', { parentId: outer.id, orderedIds: [mock.id, catchAll.id] });
  check('and can put it back', flatMocks()[0]?.id === mock.id, JSON.stringify(flatMocks().map((m) => m.name)));

  // --- searching ---
  const found = await tool('find_nodes', { query: 'api/pay', kind: 'mock' });
  check('find_nodes locates a mock by url pattern', found.hits?.[0]?.id === mock.id, JSON.stringify(found));

  // --- bad ids must fail loudly, not silently succeed ---
  const bogus = await tool('delete_node', { nodeId: 'mck_nope' });
  check('an unknown node id is an error, not a silent no-op', /no such node/i.test(JSON.stringify(bogus)), JSON.stringify(bogus).slice(0, 200));

  // --- hit log ---
  const hitLog = await tool('get_hit_log', { limit: 10 });
  check('get_hit_log returns both mocked and passed', Array.isArray(hitLog) && hitLog.length === 2, JSON.stringify(hitLog).slice(0, 200));

  // --- export / import round trip ---
  const exported = await tool('export_workspace');
  const exportedText = typeof exported === 'string' ? exported : JSON.stringify(exported);
  check('export excludes tab targeting', JSON.parse(exportedText).targetTabIds.length === 0, exportedText.slice(0, 120));

  const before = JSON.stringify(workspace.tree);
  await tool('import_workspace', { json: exportedText });
  check('import round trip preserves the tree', JSON.stringify(workspace.tree) === before, JSON.stringify(workspace.tree).slice(0, 200));
  check('import leaves tab targeting alone', workspace.targetTabIds.join() === '101', JSON.stringify(workspace.targetTabIds));

  // --- importing a v1 document upgrades it ---
  const v1 = JSON.stringify({
    version: 1,
    enabled: true,
    tags: [{ id: 'tag_old', name: 'legacy', color: '#fff', enabled: true }],
    groups: [
      {
        id: 'grp_old',
        name: 'Legacy group',
        enabled: true,
        tagIds: [],
        order: 0,
        mocks: [
          {
            id: 'mck_old',
            name: 'Old mock',
            enabled: true,
            tagIds: [],
            order: 0,
            match: { method: 'GET', urlPattern: '*/api/legacy', patternKind: 'glob' },
            response: { status: 200, headers: {}, body: '{}', bodyKind: 'json' },
          },
        ],
      },
    ],
  });
  await tool('import_workspace', { json: v1 });
  const upgraded = findNode('grp_old');
  check('importing a v1 export upgrades the group to a folder', upgraded?.kind === 'folder', JSON.stringify(workspace.tree).slice(0, 200));
  check('its mocks come with it', upgraded?.children?.[0]?.id === 'mck_old', JSON.stringify(upgraded).slice(0, 200));
  check('and gain the v2 defaults', findNode('mck_old')?.response?.delayMs === 0, JSON.stringify(findNode('mck_old')?.response));

  const emptyImport = await tool('import_workspace', { json: '{"groups":[],"tags":[]}' });
  check('importing an empty document is refused rather than wiping the workspace', /no mocks/i.test(JSON.stringify(emptyImport)), JSON.stringify(emptyImport).slice(0, 200));

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
