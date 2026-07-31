import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { explainMock, findVetoingTag, indexTags } from './enablement.ts';
import type { Group, Mock, Tag, Workspace } from './types.ts';

const TAB = 42;

function mock(over: Partial<Mock> = {}): Mock {
  return {
    id: 'm1',
    name: 'users',
    enabled: true,
    tagIds: [],
    order: 0,
    match: { method: 'GET', urlPattern: '*/api/users', patternKind: 'glob' },
    response: { status: 200, headers: {}, body: '{}', bodyKind: 'json' },
    ...over,
  };
}

function group(over: Partial<Group> = {}): Group {
  return { id: 'g1', name: 'auth', enabled: true, tagIds: [], order: 0, mocks: [], ...over };
}

function tag(over: Partial<Tag> = {}): Tag {
  return { id: 't1', name: 'slow', color: '#f00', enabled: true, ...over };
}

function workspace(over: Partial<Workspace> = {}): Workspace {
  return { version: 1, enabled: true, groups: [], tags: [], targetTabIds: [TAB], ...over };
}

describe('explainMock', () => {
  it('activates when everything is enabled and the tab is targeted', () => {
    const m = mock();
    const g = group({ mocks: [m] });
    assert.deepEqual(explainMock(workspace({ groups: [g] }), g, m, TAB), { active: true });
  });

  it('reports the master switch before anything else', () => {
    // Deliberately broken in several ways at once: the most useful explanation is
    // the broadest one, not the narrowest.
    const m = mock({ enabled: false });
    const g = group({ enabled: false, mocks: [m] });
    const ws = workspace({ enabled: false, groups: [g], targetTabIds: [] });
    assert.equal(explainMock(ws, g, m, TAB).reason, 'workspace-disabled');
  });

  it('deactivates a tab that is not targeted', () => {
    const m = mock();
    const g = group({ mocks: [m] });
    const ws = workspace({ groups: [g], targetTabIds: [999] });
    assert.equal(explainMock(ws, g, m, TAB).reason, 'tab-not-targeted');
  });

  it('deactivates when the group is off even though the mock is on', () => {
    const m = mock({ enabled: true });
    const g = group({ enabled: false, mocks: [m] });
    assert.equal(explainMock(workspace({ groups: [g] }), g, m, TAB).reason, 'group-disabled');
  });

  it('deactivates when the mock is off even though the group is on', () => {
    const m = mock({ enabled: false });
    const g = group({ enabled: true, mocks: [m] });
    assert.equal(explainMock(workspace({ groups: [g] }), g, m, TAB).reason, 'mock-disabled');
  });

  it("vetoes via a disabled tag on the mock, despite the mock's own enabled flag", () => {
    const t = tag({ id: 'off', enabled: false });
    const m = mock({ enabled: true, tagIds: ['off'] });
    const g = group({ mocks: [m] });
    const result = explainMock(workspace({ groups: [g], tags: [t] }), g, m, TAB);
    assert.equal(result.reason, 'tag-disabled');
    assert.equal(result.vetoingTagId, 'off');
  });

  it('vetoes via a disabled tag inherited from the group', () => {
    const t = tag({ id: 'off', enabled: false });
    const m = mock({ tagIds: [] });
    const g = group({ tagIds: ['off'], mocks: [m] });
    const result = explainMock(workspace({ groups: [g], tags: [t] }), g, m, TAB);
    assert.equal(result.reason, 'tag-disabled');
    assert.equal(result.vetoingTagId, 'off');
  });

  it('stays active when a referenced tag is enabled', () => {
    const t = tag({ id: 'on', enabled: true });
    const m = mock({ tagIds: ['on'] });
    const g = group({ mocks: [m] });
    assert.equal(explainMock(workspace({ groups: [g], tags: [t] }), g, m, TAB).active, true);
  });

  it('ignores dangling tag references rather than treating them as a veto', () => {
    // Deleting a tag must not silently disable every mock that referenced it.
    const m = mock({ tagIds: ['deleted-tag'] });
    const g = group({ mocks: [m] });
    assert.equal(explainMock(workspace({ groups: [g], tags: [] }), g, m, TAB).active, true);
  });
});

describe('findVetoingTag', () => {
  it('returns the first disabled tag in order', () => {
    const tags = indexTags([
      tag({ id: 'a', enabled: true }),
      tag({ id: 'b', enabled: false }),
      tag({ id: 'c', enabled: false }),
    ]);
    assert.equal(findVetoingTag(['a', 'b', 'c'], tags), 'b');
  });

  it('returns undefined when all tags are enabled', () => {
    const tags = indexTags([tag({ id: 'a' }), tag({ id: 'b' })]);
    assert.equal(findVetoingTag(['a', 'b'], tags), undefined);
  });
});
