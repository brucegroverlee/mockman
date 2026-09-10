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

/**
 * How the "Request payload" tab narrows a match.
 *
 * - `contains`    — the outgoing body contains this substring.
 * - `equals`      — the bodies are identical after trimming.
 * - `regex`       — an unanchored JavaScript regular expression.
 * - `json-subset` — both sides parse as JSON and every key/value written here is
 *                   present in the request, at the same path. Extra keys in the
 *                   request are ignored, which is what makes it usable against
 *                   real payloads that carry timestamps and correlation ids.
 */
export type BodyMatchMode = 'contains' | 'equals' | 'regex' | 'json-subset';

export interface BodyMatch {
  mode: BodyMatchMode;
  value: string;
}

export interface MockMatch {
  method: MethodMatcher;
  urlPattern: string;
  patternKind: PatternKind;
  /**
   * Optional extra condition on the *request* body. Absent means "any body".
   *
   * A request whose body could not be read (a stream, a `Blob`, a `FormData`)
   * never satisfies a body matcher — see `matchesBody`. Failing closed here is
   * deliberate: silently ignoring an unreadable body would make a narrow mock
   * behave like a catch-all.
   */
  body?: BodyMatch | undefined;
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
  /** Artificial latency before the mocked response is delivered. 0 = immediate. */
  delayMs: number;
}

/** Fields every node in the tree carries, folder or mock alike. */
interface NodeCommon {
  id: string;
  name: string;
  enabled: boolean;
  tagIds: string[];
  /**
   * Position among siblings, kept equal to the array index by every mutation in
   * mutations.ts. Two sources of truth for ordering would drift, so `order` is
   * really a *serialised* array index — it exists so JSON round-trips and MCP
   * reordering stay meaningful.
   */
  order: number;
}

export interface Folder extends NodeCommon {
  kind: 'folder';
  /** Purely presentational, but persisted so the tree looks the same tomorrow. */
  expanded: boolean;
  children: TreeNode[];
}

export interface Mock extends NodeCommon {
  kind: 'mock';
  /** Optional short badge shown in the tree and the hit log. */
  label?: string | undefined;
  match: MockMatch;
  response: MockResponse;
}

/** Folders nest arbitrarily deep; mocks are always leaves. */
export type TreeNode = Folder | Mock;

export function isFolder(node: TreeNode): node is Folder {
  return node.kind === 'folder';
}

export function isMock(node: TreeNode): node is Mock {
  return node.kind === 'mock';
}

export interface Tag {
  id: string;
  name: string;
  /** CSS colour for the panel's chips. */
  color: string;
  /**
   * A disabled tag is a **veto**: it deactivates every node carrying it, and
   * everything beneath that node, regardless of their own `enabled` flags.
   */
  enabled: boolean;
}

export const WORKSPACE_VERSION = 2;

export interface Workspace {
  version: typeof WORKSPACE_VERSION;
  /** Master switch. When false nothing is mocked anywhere. */
  enabled: boolean;
  /** Top-level nodes, in evaluation order. */
  tree: TreeNode[];
  tags: Tag[];
  /**
   * Only these tabs get mocked. Empty means "mock nothing".
   *
   * The panel adds its own inspected tab on open and drops it on close, so in
   * normal use this tracks "wherever DevTools is showing the Network Mock
   * panel". The MCP server can still target tabs explicitly.
   */
  targetTabIds: number[];
}

export function emptyWorkspace(): Workspace {
  return { version: WORKSPACE_VERSION, enabled: true, tree: [], tags: [], targetTabIds: [] };
}

/**
 * A mock flattened for the page-side interceptor: already filtered by the
 * enablement rules and sorted into resolution order, so the code running in the
 * page only has to do matching and never has to reason about the tree or tags.
 */
export interface CompiledMock {
  mockId: string;
  /** Breadcrumb, e.g. `"Web-edge-API / Jukeboxes / Settings / Save Settings"`. */
  path: string;
  /** The mock's own optional label, if it set one. */
  label?: string | undefined;
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
  /** The following are present only when `outcome === 'mocked'`. */
  mockId?: string;
  /** Breadcrumb of the mock that answered. */
  path?: string;
  /** The mock's own label, if it set one. */
  label?: string;
  status?: number;
}
