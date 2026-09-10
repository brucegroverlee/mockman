import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allMocks, findNode, isSelfOrDescendant, pathLabel, walkTree } from './tree.ts';
import {
  createFolder,
  createMock,
  defaultMatch,
  defaultResponse,
  deleteNode,
  duplicateNode,
  moveNode,
  reorderChildren,
} from './mutations.ts';
import { emptyWorkspace } from './types.ts';
import type { TreeNode, Workspace } from './types.ts';

/**
 *   a
 *   └── b
 *       └── mock1
 *   c
 *   mock2
 */
function fixture() {
  let workspace = emptyWorkspace();

  const a = createFolder(workspace, null, { name: 'a' });
  workspace = a.workspace;
  const b = createFolder(workspace, a.folder.id, { name: 'b' });
  workspace = b.workspace;
  const mock1 = createMock(workspace, b.folder.id, {
    name: 'mock1',
    match: defaultMatch(),
    response: defaultResponse(),
  });
  workspace = mock1.workspace;
  const c = createFolder(workspace, null, { name: 'c' });
  workspace = c.workspace;
  const mock2 = createMock(workspace, null, {
    name: 'mock2',
    match: defaultMatch(),
    response: defaultResponse(),
  });
  workspace = mock2.workspace;

  return {
    workspace,
    a: a.folder.id,
    b: b.folder.id,
    c: c.folder.id,
    mock1: mock1.mock.id,
    mock2: mock2.mock.id,
  };
}

/** Every mutation must leave `order` equal to array position, at every depth. */
function assertRenumbered(nodes: readonly TreeNode[], where = 'root'): void {
  nodes.forEach((node, index) => {
    assert.equal(node.order, index, `${where}[${index}] (${node.name}) has order ${node.order}`);
    if (node.kind === 'folder') assertRenumbered(node.children, `${where}/${node.name}`);
  });
}

test('walkTree yields depth-first with the ancestor chain', () => {
  const { workspace } = fixture();
  assert.deepEqual(
    [...walkTree(workspace.tree)].map((l) => [l.node.name, l.ancestors.map((x) => x.name)]),
    [
      ['a', []],
      ['b', ['a']],
      ['mock1', ['a', 'b']],
      ['c', []],
      ['mock2', []],
    ],
  );
});

test('pathLabel is the breadcrumb including the node itself', () => {
  const { workspace, mock1 } = fixture();
  assert.equal(pathLabel(findNode(workspace.tree, mock1)!), 'a / b / mock1');
});

test('nesting is arbitrarily deep', () => {
  let workspace: Workspace = emptyWorkspace();
  let parent: string | null = null;
  for (let depth = 0; depth < 6; depth++) {
    const created = createFolder(workspace, parent, { name: `d${depth}` });
    workspace = created.workspace;
    parent = created.folder.id;
  }
  const leaf = createMock(workspace, parent, {
    name: 'deep',
    match: defaultMatch(),
    response: defaultResponse(),
  });
  assert.equal(pathLabel(findNode(leaf.workspace.tree, leaf.mock.id)!), 'd0 / d1 / d2 / d3 / d4 / d5 / deep');
});

test('creating into a folder expands it', () => {
  const { workspace, a } = fixture();
  const folder = workspace.tree.find((n) => n.id === a)!;
  assert.equal(folder.kind === 'folder' && folder.expanded, true);
});

test('creating under a nonexistent parent throws rather than silently landing at the root', () => {
  const workspace = emptyWorkspace();
  assert.throws(() => createFolder(workspace, 'fld_nope', { name: 'x' }), /No such folder/);
  assert.throws(
    () => createMock(workspace, 'fld_nope', { name: 'x', match: defaultMatch(), response: defaultResponse() }),
    /No such folder/,
  );
});

test('deleting a folder takes its whole subtree with it', () => {
  const { workspace, a, mock1 } = fixture();
  const next = deleteNode(workspace, a);
  assert.equal(findNode(next.tree, a), null);
  assert.equal(findNode(next.tree, mock1), null);
  assertRenumbered(next.tree);
});

test('moving reparents and renumbers both sides', () => {
  const { workspace, b, c, mock1 } = fixture();
  const next = moveNode(workspace, mock1, c);

  assert.deepEqual(findNode(next.tree, mock1)?.ancestors.map((f) => f.name), ['c']);
  const bFolder = findNode(next.tree, b)!.node;
  assert.equal(bFolder.kind === 'folder' && bFolder.children.length, 0);
  assertRenumbered(next.tree);
});

test('a node can be moved out to the root', () => {
  const { workspace, mock1 } = fixture();
  const next = moveNode(workspace, mock1, null, 0);
  assert.equal(next.tree[0]!.id, mock1);
  assert.deepEqual(findNode(next.tree, mock1)?.ancestors, []);
  assertRenumbered(next.tree);
});

test('a folder cannot be dropped inside itself or its own descendant', () => {
  const { workspace, a, b } = fixture();
  assert.equal(isSelfOrDescendant(workspace.tree, a, b), true);

  // Both would otherwise detach the subtree from the tree entirely.
  assert.equal(moveNode(workspace, a, b).tree, workspace.tree, 'into a descendant');
  assert.equal(moveNode(workspace, a, a).tree, workspace.tree, 'into itself');
});

test('reorderChildren respects the given order and keeps unnamed siblings', () => {
  const { workspace, a, c, mock2 } = fixture();
  const next = reorderChildren(workspace, null, [mock2, c]);

  assert.deepEqual(next.tree.map((n) => n.id), [mock2, c, a]);
  assertRenumbered(next.tree);
});

test('duplicating a subtree gives every copied node a fresh id', () => {
  const { workspace, a, mock1 } = fixture();
  const { workspace: next, node } = duplicateNode(workspace, a);
  assert.ok(node);

  const ids = [...walkTree(next.tree)].map((l) => l.node.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids anywhere');
  assert.equal(ids.filter((id) => id === mock1).length, 1, 'the original mock id is not reused');
  assert.equal(allMocks(next.tree).length, 3, 'the nested mock came along');
  assert.equal(node.name, 'a copy');
  assertRenumbered(next.tree);
});

test('the duplicate lands directly after its original', () => {
  const { workspace, a } = fixture();
  const { workspace: next, node } = duplicateNode(workspace, a);
  assert.deepEqual(next.tree.map((n) => n.id).slice(0, 2), [a, node!.id]);
});
