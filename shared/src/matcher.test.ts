import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compileActiveMocks,
  compilePattern,
  globToRegExp,
  jsonSubset,
  matchesBody,
  matchesRequest,
  methodMatches,
  resolveMock,
} from './matcher.ts';
import { createFolder, createMock, defaultMatch, defaultResponse, setEnabled } from './mutations.ts';
import { emptyWorkspace } from './types.ts';
import type { BodyMatch, MockMatch, Workspace } from './types.ts';

const TAB = 3;

function match(overrides: Partial<MockMatch> = {}): MockMatch {
  return { ...defaultMatch(), ...overrides };
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

test('a glob is anchored to the whole url', () => {
  const re = globToRegExp('*/api/users');
  assert.ok(re.test('https://example.com/api/users'));
  assert.ok(!re.test('https://example.com/api/users/1'), 'no implicit trailing wildcard');
});

test('* spans slashes and ? matches exactly one character', () => {
  assert.ok(globToRegExp('https://x.test/*').test('https://x.test/a/b/c'));
  assert.ok(globToRegExp('*/item/?').test('https://x.test/item/4'));
  assert.ok(!globToRegExp('*/item/?').test('https://x.test/item/42'));
});

test('glob metacharacters from a query string are literal', () => {
  const re = globToRegExp('https://x.test/a.b+c(d)?e=1');
  assert.ok(re.test('https://x.test/a.b+c(d)Xe=1'), '? is the only wildcard here');
  assert.ok(!re.test('https://x.test/aXbXcXdXeX1'), '. + ( ) stay literal');
});

test('a backslash in a glob is escaped rather than starting an escape sequence', () => {
  const re = globToRegExp('*/a\\d');
  assert.ok(re.test('https://x.test/a\\d'));
  assert.ok(!re.test('https://x.test/a5'), 'must not become the \\d character class');
});

test('compilePattern returns null for a broken regex instead of throwing', () => {
  assert.equal(compilePattern('[unclosed', 'regex'), null);
  assert.ok(compilePattern('[unclosed', 'glob'), 'a glob escapes it, so it still compiles');
});

test('a regex pattern is unanchored', () => {
  assert.ok(matchesRequest(match({ urlPattern: 'api/users', patternKind: 'regex' }), {
    method: 'GET',
    url: 'https://example.com/api/users/1',
  }));
});

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

test('* matches any method and comparison is case-insensitive', () => {
  assert.ok(methodMatches('*', 'DELETE'));
  assert.ok(methodMatches('POST', 'post'));
  assert.ok(!methodMatches('POST', 'GET'));
});

// ---------------------------------------------------------------------------
// Request body matching
// ---------------------------------------------------------------------------

test('jsonSubset ignores extra keys but requires the ones named', () => {
  assert.ok(jsonSubset({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(jsonSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 } }));
  assert.ok(!jsonSubset({ a: 1 }, { a: 2 }));
  assert.ok(!jsonSubset({ a: 1 }, { b: 1 }));
});

test('jsonSubset compares arrays element-wise and by length', () => {
  assert.ok(jsonSubset([1, 2], [1, 2]));
  assert.ok(!jsonSubset([1], [1, 2]), 'a shorter pattern is not a prefix match');
  assert.ok(!jsonSubset({ a: [] }, { a: {} }), 'an array is not an object');
});

test('every body mode behaves as advertised', () => {
  const body = '{"user":"ada","n":1}';
  assert.ok(matchesBody({ mode: 'contains', value: 'ada' }, body));
  assert.ok(matchesBody({ mode: 'equals', value: `  ${body}  ` }, body), 'equals trims');
  assert.ok(matchesBody({ mode: 'regex', value: '"n":\\s*1' }, body));
  assert.ok(matchesBody({ mode: 'json-subset', value: '{"user":"ada"}' }, body));
  assert.ok(!matchesBody({ mode: 'json-subset', value: '{"user":"bob"}' }, body));
});

test('a body matcher fails closed on anything it cannot evaluate', () => {
  const cases: BodyMatch[] = [
    { mode: 'contains', value: 'x' },
    { mode: 'json-subset', value: '{"a":1}' },
    { mode: 'regex', value: 'x' },
  ];
  for (const matcher of cases) {
    assert.equal(matchesBody(matcher, undefined), false, `${matcher.mode} with an unreadable body`);
  }
  assert.equal(matchesBody({ mode: 'json-subset', value: 'not json' }, '{}'), false);
  assert.equal(matchesBody({ mode: 'regex', value: '[' }, 'anything'), false);
});

test('a mock with a body matcher only fires when the body agrees', () => {
  const withBody = match({
    method: 'POST',
    urlPattern: '*/api/login',
    body: { mode: 'json-subset', value: '{"user":"ada"}' },
  });

  assert.ok(
    matchesRequest(withBody, {
      method: 'POST',
      url: 'https://x.test/api/login',
      body: '{"user":"ada","pw":"x"}',
    }),
  );
  assert.ok(
    !matchesRequest(withBody, {
      method: 'POST',
      url: 'https://x.test/api/login',
      body: '{"user":"bob"}',
    }),
  );
  assert.ok(
    !matchesRequest(withBody, { method: 'POST', url: 'https://x.test/api/login' }),
    'an unreadable body must not satisfy a body matcher',
  );
});

test('an empty body matcher value imposes no condition', () => {
  const halfTyped = match({ urlPattern: '*', body: { mode: 'contains', value: '' } });
  assert.ok(matchesRequest(halfTyped, { method: 'GET', url: 'https://x.test/' }));
});

// ---------------------------------------------------------------------------
// Compilation and resolution
// ---------------------------------------------------------------------------

function tree(): { workspace: Workspace; ids: Record<string, string> } {
  let workspace = emptyWorkspace();
  workspace.targetTabIds = [TAB];

  const outer = createFolder(workspace, null, { name: 'Web-edge-API' });
  workspace = outer.workspace;
  const inner = createFolder(workspace, outer.folder.id, { name: 'Jukeboxes' });
  workspace = inner.workspace;

  const specific = createMock(workspace, inner.folder.id, {
    name: 'Save settings',
    match: match({ method: 'POST', urlPattern: '*/api/jukeboxes/settings' }),
    response: { ...defaultResponse(), status: 201 },
  });
  workspace = specific.workspace;

  const catchAll = createMock(workspace, null, {
    name: 'Catch all',
    match: match({ method: '*', urlPattern: '*' }),
    response: defaultResponse(),
  });
  workspace = catchAll.workspace;

  return {
    workspace,
    ids: { outer: outer.folder.id, inner: inner.folder.id, specific: specific.mock.id, catchAll: catchAll.mock.id },
  };
}

test('compiled mocks carry the full breadcrumb and keep tree order', () => {
  const { workspace, ids } = tree();
  const compiled = compileActiveMocks(workspace, TAB);

  assert.deepEqual(
    compiled.map((m) => m.path),
    ['Web-edge-API / Jukeboxes / Save settings', 'Catch all'],
  );
  assert.equal(compiled[0]!.mockId, ids.specific);
});

test('first match wins, so depth-first order decides between overlapping mocks', () => {
  const { workspace, ids } = tree();
  const hit = resolveMock(workspace, TAB, {
    method: 'POST',
    url: 'https://x.test/api/jukeboxes/settings',
  });
  assert.equal(hit?.node.id, ids.specific);
  assert.deepEqual(hit?.ancestors.map((a) => a.name), ['Web-edge-API', 'Jukeboxes']);
});

test('a request matching nothing specific falls through to the catch-all', () => {
  const { workspace, ids } = tree();
  const hit = resolveMock(workspace, TAB, { method: 'GET', url: 'https://x.test/anything' });
  assert.equal(hit?.node.id, ids.catchAll);
});

test('inactive mocks are compiled out entirely', () => {
  const { workspace, ids } = tree();
  const off = setEnabled(workspace, 'folder', ids.outer!, false);

  assert.deepEqual(
    compileActiveMocks(off, TAB).map((m) => m.mockId),
    [ids.catchAll],
  );
});

test('an untargeted tab compiles to nothing at all', () => {
  const { workspace } = tree();
  assert.deepEqual(compileActiveMocks(workspace, TAB + 1), []);
});
