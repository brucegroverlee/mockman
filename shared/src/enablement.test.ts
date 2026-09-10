import assert from 'node:assert/strict';
import { test } from 'node:test';

import { explainMock, indexTags } from './enablement.ts';
import { findMockNode } from './tree.ts';
import { createFolder, createMock, createTag, defaultMatch, defaultResponse, setEnabled } from './mutations.ts';
import { emptyWorkspace } from './types.ts';
import type { Folder, Mock, Workspace } from './types.ts';

const TAB = 7;

/** A workspace with one folder holding one mock, both enabled and targeted. */
function fixture(): { workspace: Workspace; folderId: string; mockId: string } {
  let workspace = emptyWorkspace();
  workspace.targetTabIds = [TAB];

  const folder = createFolder(workspace, null, { name: 'Api' });
  workspace = folder.workspace;

  const mock = createMock(workspace, folder.folder.id, {
    name: 'Users',
    match: defaultMatch(),
    response: defaultResponse(),
  });

  return { workspace: mock.workspace, folderId: folder.folder.id, mockId: mock.mock.id };
}

function locate(workspace: Workspace, mockId: string): { ancestors: Folder[]; mock: Mock } {
  const located = findMockNode(workspace.tree, mockId);
  assert.ok(located, 'mock should still be in the tree');
  return { ancestors: located.ancestors, mock: located.node };
}

function explain(workspace: Workspace, mockId: string, tabId = TAB) {
  const { ancestors, mock } = locate(workspace, mockId);
  return explainMock(workspace, ancestors, mock, tabId);
}

test('a targeted, enabled mock is active', () => {
  const { workspace, mockId } = fixture();
  assert.deepEqual(explain(workspace, mockId), { active: true });
});

test('the master switch wins over everything', () => {
  const { workspace, mockId } = fixture();
  const off = setEnabled(workspace, 'workspace', null, false);
  assert.equal(explain(off, mockId).reason, 'workspace-disabled');
});

test('an untargeted tab is not mocked', () => {
  const { workspace, mockId } = fixture();
  assert.equal(explain(workspace, mockId, TAB + 1).reason, 'tab-not-targeted');
});

test('a disabled folder deactivates the mocks inside it', () => {
  const { workspace, folderId, mockId } = fixture();
  const off = setEnabled(workspace, 'folder', folderId, false);
  const activation = explain(off, mockId);
  assert.equal(activation.reason, 'folder-disabled');
  assert.equal(activation.disabledFolderId, folderId);
});

test('a disabled folder anywhere up the chain deactivates the mock', () => {
  let workspace = emptyWorkspace();
  workspace.targetTabIds = [TAB];

  const outer = createFolder(workspace, null, { name: 'Outer' });
  workspace = outer.workspace;
  const inner = createFolder(workspace, outer.folder.id, { name: 'Inner' });
  workspace = inner.workspace;
  const mock = createMock(workspace, inner.folder.id, {
    name: 'Deep',
    match: defaultMatch(),
    response: defaultResponse(),
  });
  workspace = mock.workspace;

  assert.equal(explain(workspace, mock.mock.id).active, true);

  // The outermost disabled folder is the one reported, since that is the one
  // you have to turn back on.
  const off = setEnabled(workspace, 'folder', outer.folder.id, false);
  const activation = explain(off, mock.mock.id);
  assert.equal(activation.reason, 'folder-disabled');
  assert.equal(activation.disabledFolderId, outer.folder.id);
});

test('a disabled mock is inert even inside an enabled folder', () => {
  const { workspace, mockId } = fixture();
  const off = setEnabled(workspace, 'mock', mockId, false);
  assert.equal(explain(off, mockId).reason, 'mock-disabled');
});

test('a disabled tag on the mock vetoes it', () => {
  const { workspace, mockId } = fixture();
  const { workspace: tagged, tag } = createTag(workspace, { name: 'slow' });

  let next = tagged;
  next = { ...next, tree: next.tree };
  const located = findMockNode(next.tree, mockId)!;
  located.node.tagIds.push(tag.id); // direct push is fine: fresh objects from the fixture

  assert.equal(explain(next, mockId).active, true, 'an enabled tag changes nothing');

  const vetoed = setEnabled(next, 'tag', tag.id, false);
  const activation = explain(vetoed, mockId);
  assert.equal(activation.reason, 'tag-disabled');
  assert.equal(activation.vetoingTagId, tag.id);
});

test('a disabled tag on an ancestor folder vetoes the mocks beneath it', () => {
  const { workspace, folderId, mockId } = fixture();
  const { workspace: tagged, tag } = createTag(workspace, { name: 'wip' });

  const folder = tagged.tree.find((node) => node.id === folderId)!;
  folder.tagIds.push(tag.id);

  const vetoed = setEnabled(tagged, 'tag', tag.id, false);
  const activation = explain(vetoed, mockId);
  assert.equal(activation.reason, 'tag-disabled');
  assert.equal(activation.vetoingTagId, tag.id);
});

test('an unknown tag id is ignored rather than treated as a veto', () => {
  const { workspace, mockId } = fixture();
  const located = findMockNode(workspace.tree, mockId)!;
  located.node.tagIds.push('tag_deleted');

  assert.equal(explain(workspace, mockId).active, true);
});

test('the broadest reason is reported first', () => {
  const { workspace, folderId, mockId } = fixture();
  let off = setEnabled(workspace, 'workspace', null, false);
  off = setEnabled(off, 'folder', folderId, false);
  off = setEnabled(off, 'mock', mockId, false);

  assert.equal(explain(off, mockId).reason, 'workspace-disabled');
});
