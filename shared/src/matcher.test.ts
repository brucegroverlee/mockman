import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compileActiveMocks,
  compilePattern,
  globToRegExp,
  matchesRequest,
  methodMatches,
  resolveMock,
} from './matcher.ts';
import type { Group, Mock, Workspace } from './types.ts';

const TAB = 7;

function mock(over: Partial<Mock> = {}): Mock {
  return {
    id: 'm',
    name: 'm',
    enabled: true,
    tagIds: [],
    order: 0,
    match: { method: '*', urlPattern: '*', patternKind: 'glob' },
    response: { status: 200, headers: {}, body: '{}', bodyKind: 'json' },
    ...over,
  };
}

function workspace(groups: Group[]): Workspace {
  return { version: 1, enabled: true, groups, tags: [], targetTabIds: [TAB] };
}

describe('globToRegExp', () => {
  it('matches the whole URL, not a substring', () => {
    // The anchoring footgun, pinned deliberately: a bare path does not match a
    // full URL, which is why the panel ships a live pattern tester.
    assert.equal(globToRegExp('/api/users').test('https://x.com/api/users'), false);
    assert.equal(globToRegExp('*/api/users').test('https://x.com/api/users'), true);
  });

  it('lets * span slashes', () => {
    assert.equal(globToRegExp('https://x.com/*').test('https://x.com/a/b/c'), true);
  });

  it('matches exactly one character with ?', () => {
    assert.equal(globToRegExp('https://x.com/v?').test('https://x.com/v1'), true);
    assert.equal(globToRegExp('https://x.com/v?').test('https://x.com/v12'), false);
  });

  it('treats regex metacharacters literally', () => {
    assert.equal(globToRegExp('https://x.com/a.b').test('https://x.com/a.b'), true);
    assert.equal(globToRegExp('https://x.com/a.b').test('https://x.com/axb'), false);
    assert.equal(globToRegExp('https://x.com/a+b').test('https://x.com/a+b'), true);
  });
});

describe('compilePattern', () => {
  it('returns null for an invalid regex instead of throwing', () => {
    // A half-typed regex in the panel must never break interception page-wide.
    assert.equal(compilePattern('([', 'regex'), null);
  });

  it('treats a regex as unanchored', () => {
    assert.equal(compilePattern('/api/', 'regex')?.test('https://x.com/api/users'), true);
  });
});

describe('methodMatches', () => {
  it('matches any method with *', () => {
    assert.equal(methodMatches('*', 'DELETE'), true);
  });

  it('is case insensitive', () => {
    assert.equal(methodMatches('GET', 'get'), true);
  });

  it('rejects a different method', () => {
    assert.equal(methodMatches('GET', 'POST'), false);
  });
});

describe('matchesRequest', () => {
  it('requires both method and URL to match', () => {
    const match = { method: 'POST', urlPattern: '*/login', patternKind: 'glob' } as const;
    assert.equal(matchesRequest(match, { method: 'POST', url: 'https://x.com/login' }), true);
    assert.equal(matchesRequest(match, { method: 'GET', url: 'https://x.com/login' }), false);
    assert.equal(matchesRequest(match, { method: 'POST', url: 'https://x.com/logout' }), false);
  });
});

describe('compileActiveMocks', () => {
  it('orders by group order then mock order', () => {
    const ws = workspace([
      {
        id: 'g2',
        name: 'second',
        enabled: true,
        tagIds: [],
        order: 1,
        mocks: [mock({ id: 'b', name: 'b', order: 0 })],
      },
      {
        id: 'g1',
        name: 'first',
        enabled: true,
        tagIds: [],
        order: 0,
        mocks: [mock({ id: 'a2', name: 'a2', order: 1 }), mock({ id: 'a1', name: 'a1', order: 0 })],
      },
    ]);
    assert.deepEqual(
      compileActiveMocks(ws, TAB).map((m) => m.mockId),
      ['a1', 'a2', 'b'],
    );
  });

  it('omits inactive mocks', () => {
    const ws = workspace([
      {
        id: 'g1',
        name: 'g',
        enabled: true,
        tagIds: [],
        order: 0,
        mocks: [mock({ id: 'on' }), mock({ id: 'off', enabled: false })],
      },
    ]);
    assert.deepEqual(
      compileActiveMocks(ws, TAB).map((m) => m.mockId),
      ['on'],
    );
  });

  it('returns nothing for an untargeted tab', () => {
    const ws = workspace([
      { id: 'g1', name: 'g', enabled: true, tagIds: [], order: 0, mocks: [mock()] },
    ]);
    assert.deepEqual(compileActiveMocks(ws, 999), []);
  });

  it('builds a "group / mock" label for the hit log', () => {
    const ws = workspace([
      {
        id: 'g1',
        name: 'auth',
        enabled: true,
        tagIds: [],
        order: 0,
        mocks: [mock({ name: 'login' })],
      },
    ]);
    assert.equal(compileActiveMocks(ws, TAB)[0]?.label, 'auth / login');
  });
});

describe('resolveMock', () => {
  const ws = workspace([
    {
      id: 'g1',
      name: 'g',
      enabled: true,
      tagIds: [],
      order: 0,
      mocks: [
        mock({
          id: 'specific',
          order: 0,
          match: { method: 'GET', urlPattern: '*/api/users', patternKind: 'glob' },
        }),
        mock({
          id: 'catchall',
          order: 1,
          match: { method: '*', urlPattern: '*', patternKind: 'glob' },
        }),
      ],
    },
  ]);

  it('returns the first match in order, not the most specific', () => {
    const hit = resolveMock(ws, TAB, { method: 'GET', url: 'https://x.com/api/users' });
    assert.equal(hit?.mock.id, 'specific');
  });

  it('falls through to a later mock when the earlier one does not match', () => {
    const hit = resolveMock(ws, TAB, { method: 'GET', url: 'https://x.com/other' });
    assert.equal(hit?.mock.id, 'catchall');
  });

  it('returns null when nothing matches, so the request hits the network', () => {
    const narrow = workspace([
      {
        id: 'g1',
        name: 'g',
        enabled: true,
        tagIds: [],
        order: 0,
        mocks: [
          mock({ match: { method: 'GET', urlPattern: '*/nope', patternKind: 'glob' } }),
        ],
      },
    ]);
    assert.equal(resolveMock(narrow, TAB, { method: 'GET', url: 'https://x.com/yes' }), null);
  });
});
