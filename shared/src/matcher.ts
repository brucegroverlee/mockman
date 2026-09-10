/**
 * Request → mock resolution.
 *
 * Pure and browser-free so it can be unit-tested directly, then bundled into the
 * page-side interceptor unchanged.
 */

import { explainMock, indexTags } from './enablement.ts';
import { allMocks, pathLabel } from './tree.ts';
import type { BodyMatch, CompiledMock, Mock, MockMatch, Workspace } from './types.ts';
import type { Located } from './tree.ts';

export interface RequestInfo {
  method: string;
  url: string;
  /**
   * The outgoing request body as text, when it could be read.
   *
   * `undefined` means "not readable" (a stream, a Blob, a FormData), which is
   * different from `''` meaning "empty body". A mock with a body matcher never
   * matches an unreadable body.
   */
  body?: string | undefined;
}

/**
 * Translates a glob to an anchored RegExp.
 *
 * `*` becomes "any run of characters" (including `/`, which is what you want for
 * URLs) and `?` becomes "exactly one character". Everything else is escaped, so
 * a pattern containing `.` or `?` from a query string behaves literally.
 *
 * Note the escape character class deliberately omits `*` and `?` so they survive
 * to be translated below.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Compiles a pattern, returning null if it is invalid.
 *
 * Never throws: a user halfway through typing a regex must not be able to break
 * interception for the whole page. The panel validates separately so it can show
 * a proper error message.
 */
export function compilePattern(pattern: string, kind: MockMatch['patternKind']): RegExp | null {
  try {
    return kind === 'glob' ? globToRegExp(pattern) : new RegExp(pattern);
  } catch {
    return null;
  }
}

export function methodMatches(matcher: MockMatch['method'], method: string): boolean {
  return matcher === '*' || matcher.toUpperCase() === method.toUpperCase();
}

/**
 * Deep "is `expected` contained in `actual`" for parsed JSON.
 *
 * Objects match on the keys `expected` names and ignore the rest; arrays must be
 * the same length and match element-wise. Primitives compare with `Object.is`,
 * so `NaN` matches `NaN` and `0` does not match `-0`.
 */
export function jsonSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => jsonSubset(item, actual[index]))
    );
  }

  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const target = actual as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>).every(
      ([key, value]) => key in target && jsonSubset(value, target[key]),
    );
  }

  return Object.is(expected, actual);
}

/**
 * Whether a request body satisfies a body matcher.
 *
 * Fails closed on anything it cannot evaluate — an unreadable body, an
 * uncompilable regex, unparseable JSON on either side. A body matcher exists to
 * *narrow* a mock, so when in doubt the safest answer is "this is not the
 * request you meant".
 */
export function matchesBody(matcher: BodyMatch, body: string | undefined): boolean {
  if (body === undefined) return false;

  switch (matcher.mode) {
    case 'contains':
      return body.includes(matcher.value);
    case 'equals':
      return body.trim() === matcher.value.trim();
    case 'regex': {
      try {
        return new RegExp(matcher.value).test(body);
      } catch {
        return false;
      }
    }
    case 'json-subset': {
      try {
        return jsonSubset(JSON.parse(matcher.value), JSON.parse(body));
      } catch {
        return false;
      }
    }
  }
}

export function matchesRequest(match: MockMatch, request: RequestInfo): boolean {
  if (!methodMatches(match.method, request.method)) return false;

  const re = compilePattern(match.urlPattern, match.patternKind);
  if (re === null || !re.test(request.url)) return false;

  // An empty matcher value is treated as "no body condition", so a half-typed
  // matcher in the panel does not silently stop the mock from firing.
  if (match.body && match.body.value !== '') return matchesBody(match.body, request.body);

  return true;
}

/**
 * Flattens the workspace into the ordered list of mocks that are live for
 * `tabId`, ready to hand to the interceptor.
 *
 * Doing the enablement filtering here means the page-side code never has to know
 * about folders, tags or the master switch — it just walks the list.
 */
export function compileActiveMocks(workspace: Workspace, tabId: number): CompiledMock[] {
  const tagsById = indexTags(workspace.tags);
  const compiled: CompiledMock[] = [];

  for (const located of allMocks(workspace.tree)) {
    const { node: mock, ancestors } = located;
    if (!explainMock(workspace, ancestors, mock, tabId, tagsById).active) continue;
    compiled.push({
      mockId: mock.id,
      path: pathLabel(located),
      label: mock.label,
      match: mock.match,
      response: mock.response,
    });
  }

  return compiled;
}

/** First match wins, so an unmatched request always falls through to the network. */
export function resolveCompiled(
  mocks: readonly CompiledMock[],
  request: RequestInfo,
): CompiledMock | null {
  for (const mock of mocks) {
    if (matchesRequest(mock.match, request)) return mock;
  }
  return null;
}

/**
 * Convenience path used by tests and the MCP server: resolve straight from a
 * workspace without pre-compiling.
 */
export function resolveMock(
  workspace: Workspace,
  tabId: number,
  request: RequestInfo,
): Located<Mock> | null {
  const hit = resolveCompiled(compileActiveMocks(workspace, tabId), request);
  if (!hit) return null;
  return allMocks(workspace.tree).find((located) => located.node.id === hit.mockId) ?? null;
}
