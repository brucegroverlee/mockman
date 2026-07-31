/**
 * The data model, shared verbatim by the extension and the MCP server.
 *
 * This lives in one place on purpose: the MCP server must validate against the
 * exact same shape the extension enforces, and a drifting duplicate would be a
 * very quiet source of bugs.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** `'*'` matches any method. */
export type MethodMatcher = HttpMethod | '*';

/**
 * How `urlPattern` is interpreted.
 *
 * - `glob`  — `*` matches any run of characters, `?` matches exactly one, and the
 *             pattern is anchored to the **whole** URL. So `/api/users` will not
 *             match `https://example.com/api/users`; write `*​/api/users` instead.
 *             The panel's live pattern tester exists so this is obvious rather
 *             than surprising.
 * - `regex` — passed to `RegExp` unanchored and tested against the whole URL,
 *             so it behaves as a substring search unless you anchor it yourself.
 */
export type PatternKind = 'glob' | 'regex';

export interface MockMatch {
  method: MethodMatcher;
  urlPattern: string;
  patternKind: PatternKind;
}

/**
 * Like `Partial<T>`, but tolerant of keys explicitly set to `undefined`.
 *
 * Needed because this project runs with `exactOptionalPropertyTypes`, while the
 * patch objects arriving from JSON and from Zod-validated MCP input do carry
 * explicit `undefined` values for absent optional fields.
 */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export interface MockResponse {
  status: number;
  /** Omitted means "derive the standard reason phrase for `status`". */
  statusText?: string | undefined;
  headers: Record<string, string>;
  /** Always stored as text; `bodyKind` says how to interpret and validate it. */
  body: string;
  bodyKind: 'json' | 'text';
}

export interface Mock {
  id: string;
  name: string;
  enabled: boolean;
  tagIds: string[];
  /** Ascending. Ties broken by array position. */
  order: number;
  match: MockMatch;
  response: MockResponse;
}

export interface Group {
  id: string;
  name: string;
  enabled: boolean;
  tagIds: string[];
  order: number;
  mocks: Mock[];
}

export interface Tag {
  id: string;
  name: string;
  /** CSS colour for the panel's chips. */
  color: string;
  /**
   * A disabled tag is a **veto**: it deactivates every mock and group carrying
   * it, regardless of that mock's or group's own `enabled` flag.
   */
  enabled: boolean;
}

export interface Workspace {
  version: 1;
  /** Master switch. When false nothing is mocked anywhere. */
  enabled: boolean;
  groups: Group[];
  tags: Tag[];
  /** Only these tabs get mocked. Empty means "mock nothing". */
  targetTabIds: number[];
}

export function emptyWorkspace(): Workspace {
  return { version: 1, enabled: true, groups: [], tags: [], targetTabIds: [] };
}

/**
 * A mock flattened for the page-side interceptor: already filtered by the
 * enablement rules and sorted into resolution order, so the code running in the
 * page only has to do matching and never has to reason about groups or tags.
 */
export interface CompiledMock {
  mockId: string;
  groupId: string;
  /** `"group / mock"`, shown in the hit log. */
  label: string;
  match: MockMatch;
  response: MockResponse;
}

/** What the interceptor needs to know about the tab it is running in. */
export interface TabConfig {
  /** False when this tab is not targeted, or the master switch is off. */
  active: boolean;
  mocks: CompiledMock[];
}

export interface HitRecord {
  id: string;
  tabId: number;
  /** Epoch ms. */
  timestamp: number;
  method: string;
  url: string;
  outcome: 'mocked' | 'passed';
  /** Present only when `outcome === 'mocked'`. */
  mockId?: string;
  label?: string;
  status?: number;
}
