/**
 * Request → mock resolution.
 *
 * Pure and browser-free so it can be unit-tested directly, then bundled into the
 * page-side interceptor unchanged.
 */

import { explainMock, indexTags } from './enablement.ts';
import type { CompiledMock, Group, Mock, MockMatch, Workspace } from './types.ts';

export interface RequestInfo {
  method: string;
  url: string;
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

export function matchesRequest(match: MockMatch, request: RequestInfo): boolean {
  if (!methodMatches(match.method, request.method)) return false;
  const re = compilePattern(match.urlPattern, match.patternKind);
  return re !== null && re.test(request.url);
}

/** Ascending by `order`, stable for equal values. */
function byOrder<T extends { order: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order);
}

/**
 * Flattens the workspace into the ordered list of mocks that are live for
 * `tabId`, ready to hand to the interceptor.
 *
 * Doing the enablement filtering here means the page-side code never has to know
 * about groups, tags or the master switch — it just walks the list.
 */
export function compileActiveMocks(workspace: Workspace, tabId: number): CompiledMock[] {
  const tagsById = indexTags(workspace.tags);
  const compiled: CompiledMock[] = [];

  for (const group of byOrder(workspace.groups)) {
    for (const mock of byOrder(group.mocks)) {
      if (!explainMock(workspace, group, mock, tabId, tagsById).active) continue;
      compiled.push({
        mockId: mock.id,
        groupId: group.id,
        label: `${group.name} / ${mock.name}`,
        match: mock.match,
        response: mock.response,
      });
    }
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
): { group: Group; mock: Mock } | null {
  const hit = resolveCompiled(compileActiveMocks(workspace, tabId), request);
  if (!hit) return null;

  const group = workspace.groups.find((g) => g.id === hit.groupId);
  const mock = group?.mocks.find((m) => m.id === hit.mockId);
  return group && mock ? { group, mock } : null;
}
