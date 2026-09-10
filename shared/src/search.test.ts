import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterTree, isEmptyQuery, parseSearch } from './search.ts';
import { indexTags } from './enablement.ts';
import { walkTree } from './tree.ts';
import { createFolder, createMock, createTag, defaultMatch, defaultResponse } from './mutations.ts';
import { emptyWorkspace } from './types.ts';
import type { Workspace } from './types.ts';

// The tree under test (glob patterns written without their leading `*` so this
// comment does not close itself):
//
//   Web-edge-API              [tag: edge]
//   └── Jukeboxes
//       ├── Save settings     POST  */api/jukeboxes/settings   201
//       └── Get settings      GET   */api/jukeboxes/settings   200  [tag: slow]
//   Staff
//   └── Health                GET   */health                   200
function fixture() {
  let workspace: Workspace = emptyWorkspace();

  const edge = createTag(workspace, { name: 'edge' });
  workspace = edge.workspace;
  const slow = createTag(workspace, { name: 'slow' });
  workspace = slow.workspace;

  const api = createFolder(workspace, null, { name: 'Web-edge-API', tagIds: [edge.tag.id] });
  workspace = api.workspace;
  const jukeboxes = createFolder(workspace, api.folder.id, { name: 'Jukeboxes' });
  workspace = jukeboxes.workspace;

  workspace = createMock(workspace, jukeboxes.folder.id, {
    name: 'Save settings',
    match: { ...defaultMatch(), method: 'POST', urlPattern: '*/api/jukeboxes/settings' },
    response: { ...defaultResponse(), status: 201 },
  }).workspace;

  workspace = createMock(workspace, jukeboxes.folder.id, {
    name: 'Get settings',
    tagIds: [slow.tag.id],
    match: { ...defaultMatch(), method: 'GET', urlPattern: '*/api/jukeboxes/settings' },
    response: defaultResponse(),
  }).workspace;

  const staff = createFolder(workspace, null, { name: 'Staff' });
  workspace = staff.workspace;
  workspace = createMock(workspace, staff.folder.id, {
    name: 'Health',
    match: { ...defaultMatch(), urlPattern: '*/health' },
    response: defaultResponse(),
  }).workspace;

  return { workspace, tagsById: indexTags(workspace.tags) };
}

function names(input: string): string[] {
  const { workspace, tagsById } = fixture();
  const { tree } = filterTree(workspace.tree, parseSearch(input), tagsById);
  return [...walkTree(tree)].map((l) => l.node.name);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('an empty or whitespace-only query filters nothing', () => {
  assert.ok(isEmptyQuery(parseSearch('')));
  assert.ok(isEmptyQuery(parseSearch('   ')));
});

test('prefixes, negation and quoting parse as expected', () => {
  assert.deepEqual(parseSearch('tag:auth -POST url:/x').terms, [
    { field: 'tag', value: 'auth', negated: false },
    { field: 'any', value: 'post', negated: true },
    { field: 'url', value: '/x', negated: false },
  ]);
  assert.deepEqual(parseSearch('tag:"two words"').terms, [
    { field: 'tag', value: 'two words', negated: false },
  ]);
});

test('an unknown prefix stays part of the search text', () => {
  assert.deepEqual(parseSearch('http://x.test/a').terms, [
    { field: 'any', value: 'http://x.test/a', negated: false },
  ]);
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test('a bare word matches a tag name, which is the whole point of the box', () => {
  // "edge" is on the top folder, so its subtree comes along.
  assert.deepEqual(names('edge'), ['Web-edge-API', 'Jukeboxes', 'Save settings', 'Get settings']);
  assert.deepEqual(names('slow'), ['Web-edge-API', 'Jukeboxes', 'Get settings']);
});

test('a bare word also matches names and url patterns', () => {
  assert.deepEqual(names('health'), ['Staff', 'Health']);
  assert.deepEqual(names('/api/jukeboxes'), [
    'Web-edge-API',
    'Jukeboxes',
    'Save settings',
    'Get settings',
  ]);
});

test('ancestors of a match are kept so the result is still a tree', () => {
  assert.deepEqual(names('Health'), ['Staff', 'Health']);
});

test('a matching folder keeps all of its children', () => {
  assert.deepEqual(names('Jukeboxes'), [
    'Web-edge-API',
    'Jukeboxes',
    'Save settings',
    'Get settings',
  ]);
});

test('field-scoped terms narrow to what they name', () => {
  assert.deepEqual(names('method:post'), ['Web-edge-API', 'Jukeboxes', 'Save settings']);
  assert.deepEqual(names('status:201'), ['Web-edge-API', 'Jukeboxes', 'Save settings']);
  assert.deepEqual(names('tag:slow'), ['Web-edge-API', 'Jukeboxes', 'Get settings']);
});

test('tag: does not fall back to matching names', () => {
  assert.deepEqual(names('tag:Health'), []);
});

test('terms are ANDed', () => {
  assert.deepEqual(names('settings method:get'), ['Web-edge-API', 'Jukeboxes', 'Get settings']);
  assert.deepEqual(names('settings method:delete'), []);
});

test('a negated term excludes', () => {
  assert.deepEqual(names('settings -tag:slow'), ['Web-edge-API', 'Jukeboxes', 'Save settings']);
});

test('a query matching nothing yields an empty tree, not the whole one', () => {
  assert.deepEqual(names('zzzz'), []);
});

test('matched and expand report why each node is on screen', () => {
  const { workspace, tagsById } = fixture();
  const { matched, expand } = filterTree(workspace.tree, parseSearch('Health'), tagsById);

  const staff = workspace.tree.find((n) => n.name === 'Staff')!;
  assert.equal(matched.has(staff.id), false, 'Staff is context, not a match');
  assert.equal(expand.has(staff.id), true, 'but it must be open to show the match');
});
