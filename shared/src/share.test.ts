import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFolder, createMock, createTag, defaultMatch, defaultResponse } from './mutations.ts';
import { exportFileName, exportNodes, exportText, importNodes, parseImport } from './share.ts';
import type { ImportPlan } from './share.ts';
import { findNode, walkTree } from './tree.ts';
import { emptyWorkspace } from './types.ts';
import type { Folder, Mock, Workspace } from './types.ts';

/**
 *   Service  [tag: checkout]
 *   └── Inner
 *       └── Get user  [tag: slow]
 */
function fixture(): { workspace: Workspace; service: Folder; mock: Mock } {
  let workspace = emptyWorkspace();
  const checkout = createTag(workspace, { name: 'checkout', color: '#111111' });
  workspace = checkout.workspace;
  const slow = createTag(workspace, { name: 'slow', color: '#222222' });
  workspace = slow.workspace;

  const service = createFolder(workspace, null, { name: 'Service', tagIds: [checkout.tag.id] });
  workspace = service.workspace;
  const inner = createFolder(workspace, service.folder.id, { name: 'Inner' });
  workspace = inner.workspace;
  const mock = createMock(workspace, inner.folder.id, {
    name: 'Get user',
    match: { ...defaultMatch(), urlPattern: '*/api/user' },
    response: defaultResponse(),
    tagIds: [slow.tag.id],
  });
  workspace = mock.workspace;

  return { workspace, service: findNode(workspace.tree, service.folder.id)!.node as Folder, mock: mock.mock };
}

function plan(text: string): ImportPlan {
  const result = parseImport(text);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.plan;
}

test('export carries tags by name and drops ids and layout state', () => {
  const { workspace, service } = fixture();
  const doc = exportNodes(workspace, [service]);

  assert.equal(doc.mockman, 1);
  assert.deepEqual(doc.tags.map((t) => t.name).sort(), ['checkout', 'slow']);
  const folder = doc.nodes[0]!;
  assert.equal(folder.kind, 'folder');
  assert.deepEqual(folder.tags, ['checkout']);
  assert.ok(!('id' in folder) && !('order' in folder) && !('expanded' in folder));

  const text = exportText(workspace, [service]);
  assert.ok(!text.includes('"tagIds"') && !text.includes('"id"'));
});

test('export of a single mock only lists the tags it uses', () => {
  const { workspace, mock } = fixture();
  const doc = exportNodes(workspace, [mock]);
  assert.deepEqual(doc.tags, [{ name: 'slow', color: '#222222' }]);
  assert.equal(doc.nodes.length, 1);
});

test('round trip into another workspace re-ids and creates missing tags', () => {
  const { workspace, service } = fixture();
  const text = exportText(workspace, [service]);

  const target = createTag(emptyWorkspace(), { name: 'CHECKOUT', color: '#999999' }).workspace;
  const { workspace: next, nodeIds } = importNodes(target, null, plan(text));

  assert.equal(nodeIds.length, 1);
  const ids = [...walkTree(next.tree)].map(({ node }) => node.id);
  const sourceIds = new Set([...walkTree(workspace.tree)].map(({ node }) => node.id));
  assert.ok(ids.every((id) => !sourceIds.has(id)));

  // "checkout" matched the existing "CHECKOUT"; "slow" was created with its colour.
  assert.equal(next.tags.length, 2);
  const slow = next.tags.find((t) => t.name === 'slow')!;
  assert.equal(slow.color, '#222222');
  const imported = next.tree[0] as Folder;
  assert.deepEqual(imported.tagIds, [target.tags[0]!.id]);
  const mock = (imported.children[0] as Folder).children[0] as Mock;
  assert.equal(mock.match.urlPattern, '*/api/user');
  assert.deepEqual(mock.tagIds, [slow.id]);
});

test('import into a folder appends at the end of its children', () => {
  const { workspace, service, mock } = fixture();
  const text = exportText(workspace, [mock]);
  const { workspace: next, nodeIds } = importNodes(workspace, service.id, plan(text));

  const folder = findNode(next.tree, service.id)!.node as Folder;
  assert.equal(folder.children.length, 2);
  assert.equal(folder.children[1]!.id, nodeIds[0]);
  assert.equal(folder.children[1]!.order, 1);
});

test('accepts a bare mock, a list of nodes and a whole workspace', () => {
  const { workspace, mock } = fixture();

  const bare = plan(JSON.stringify({ kind: 'mock', name: 'x', match: { urlPattern: '*/a' }, response: {} }));
  assert.equal(bare.mocks, 1);

  const list = plan(JSON.stringify([mock, mock]));
  assert.equal(list.mocks, 2);

  // A workspace refers to tags by id; they must come out as names.
  const whole = plan(JSON.stringify(workspace));
  assert.equal(whole.folders, 2);
  assert.deepEqual(whole.tagNames.sort(), ['checkout', 'slow']);
});

test('rejects text that is not a mock, and mocks without a URL pattern', () => {
  const cases: [string, RegExp][] = [
    ['', /nothing/i],
    ['{ nope', /not valid json/i],
    ['{"hello": "world"}', /does not look like/i],
    ['{"mockman": 1, "nodes": []}', /no mocks/i],
    ['[{"kind": "mock", "name": "Broken"}]', /"Broken" has no match\.urlPattern/],
    ['{"kind": "folder", "name": "F", "children": [42]}', /children\[0\] is not a mock/],
  ];
  for (const [text, expected] of cases) {
    const result = parseImport(text);
    assert.equal(result.ok, false, text);
    if (!result.ok) assert.match(result.error, expected);
  }
});

test('refuses to import into a folder that does not exist', () => {
  const { workspace, mock } = fixture();
  assert.throws(() => importNodes(workspace, 'fld_missing', plan(exportText(workspace, [mock]))));
});

test('file names are slugged', () => {
  assert.equal(exportFileName('TT Service'), 'tt-service.mockman.json');
  assert.equal(exportFileName('  !!  '), 'mocks.mockman.json');
});
