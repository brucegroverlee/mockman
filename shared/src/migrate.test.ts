import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isCurrentVersion, migrateWorkspace } from './migrate.ts';
import { allMocks, findNode, pathLabel, walkTree } from './tree.ts';
import { createFolder, createMock, defaultMatch, defaultResponse } from './mutations.ts';
import { WORKSPACE_VERSION, emptyWorkspace } from './types.ts';

/** The shape the previous release wrote to chrome.storage.local. */
const V1 = {
  version: 1,
  enabled: true,
  targetTabIds: [42],
  tags: [{ id: 'tag_a', name: 'slow', color: '#fff', enabled: false }],
  groups: [
    {
      id: 'grp_2',
      name: 'Second',
      enabled: true,
      tagIds: [],
      order: 1,
      mocks: [],
    },
    {
      id: 'grp_1',
      name: 'First',
      enabled: false,
      tagIds: ['tag_a'],
      order: 0,
      mocks: [
        {
          id: 'mck_1',
          name: 'Users',
          enabled: true,
          tagIds: ['tag_a'],
          order: 0,
          match: { method: 'GET', urlPattern: '*/api/users', patternKind: 'glob' },
          response: { status: 200, headers: { 'x-a': '1' }, body: '{}', bodyKind: 'json' },
        },
      ],
    },
  ],
};

test('a v1 group becomes a top-level folder holding its mocks', () => {
  const workspace = migrateWorkspace(V1);

  assert.equal(workspace.version, WORKSPACE_VERSION);
  assert.deepEqual(workspace.tree.map((n) => [n.kind, n.name]), [
    ['folder', 'First'],
    ['folder', 'Second'],
  ]);
  assert.equal(pathLabel(findNode(workspace.tree, 'mck_1')!), 'First / Users');
});

test('migration preserves ids, flags, tags and response detail', () => {
  const workspace = migrateWorkspace(V1);
  const first = findNode(workspace.tree, 'grp_1')!.node;
  const mock = allMocks(workspace.tree)[0]!.node;

  assert.equal(first.enabled, false);
  assert.deepEqual(first.tagIds, ['tag_a']);
  assert.deepEqual(workspace.tags, [{ id: 'tag_a', name: 'slow', color: '#fff', enabled: false }]);
  assert.equal(mock.match.urlPattern, '*/api/users');
  assert.deepEqual(mock.response.headers, { 'x-a': '1' });
});

test('the v1 group order is honoured, then rewritten as array position', () => {
  const workspace = migrateWorkspace(V1);
  assert.deepEqual(workspace.tree.map((n) => [n.name, n.order]), [
    ['First', 0],
    ['Second', 1],
  ]);
});

test('fields new in v2 get sane defaults', () => {
  const mock = allMocks(migrateWorkspace(V1).tree)[0]!.node;
  assert.equal(mock.response.delayMs, 0, 'a v1 mock had no latency concept');
  assert.equal(mock.match.body, undefined, 'and no body matcher');
  assert.equal(mock.label, undefined);
});

test('tab targeting is never adopted from stored or imported data', () => {
  assert.deepEqual(migrateWorkspace(V1).targetTabIds, [], 'v1');
  assert.deepEqual(
    migrateWorkspace({ ...emptyWorkspace(), targetTabIds: [9] }).targetTabIds,
    [],
    'v2',
  );
});

test('a current-version workspace round-trips unchanged', () => {
  let workspace = emptyWorkspace();
  const folder = createFolder(workspace, null, { name: 'Api' });
  workspace = folder.workspace;
  const mock = createMock(workspace, folder.folder.id, {
    name: 'Save',
    label: 'v2',
    match: { ...defaultMatch(), body: { mode: 'json-subset', value: '{"a":1}' } },
    response: { ...defaultResponse(), delayMs: 250, statusText: 'Yep' },
  });
  workspace = mock.workspace;

  assert.ok(isCurrentVersion(workspace));
  assert.deepEqual(migrateWorkspace(JSON.parse(JSON.stringify(workspace))), workspace);
});

test('garbage in never produces a broken workspace out', () => {
  for (const bad of [null, undefined, 42, 'nope', [], { groups: 'no' }, { tree: { a: 1 } }]) {
    const workspace = migrateWorkspace(bad);
    assert.equal(workspace.version, WORKSPACE_VERSION);
    assert.deepEqual(workspace.tree, []);
    assert.deepEqual(workspace.tags, []);
  }
});

test('a node missing an id still survives, with a synthetic one', () => {
  const workspace = migrateWorkspace({
    version: 2,
    tree: [{ kind: 'folder', name: 'F', children: [{ kind: 'mock', name: 'M' }] }],
  });

  const ids = [...walkTree(workspace.tree)].map((l) => l.node.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, 'synthetic ids are distinct');
  assert.ok(ids.every(Boolean));
});

test('an out-of-range status and an unknown method fall back rather than persisting', () => {
  const workspace = migrateWorkspace({
    version: 2,
    tree: [
      {
        kind: 'mock',
        id: 'm',
        name: 'M',
        match: { method: 'FROB', urlPattern: '*' },
        response: { status: 9999, delayMs: -5 },
      },
    ],
  });

  const mock = allMocks(workspace.tree)[0]!.node;
  assert.equal(mock.match.method, '*');
  assert.equal(mock.response.status, 200);
  assert.equal(mock.response.delayMs, 0, 'negative latency is clamped');
});

test('isCurrentVersion rejects v1 and anything unrecognisable', () => {
  assert.equal(isCurrentVersion(V1), false);
  assert.equal(isCurrentVersion({ version: 2 }), false, 'version alone is not enough');
  assert.equal(isCurrentVersion(emptyWorkspace()), true);
});
