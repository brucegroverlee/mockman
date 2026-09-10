/**
 * Reading workspaces that were written by an older build, or by hand.
 *
 * Anything that reaches `chrome.storage`, the MCP `import_workspace` tool, or a
 * checked-in JSON file goes through `migrateWorkspace` first. It is deliberately
 * total: it never throws and never returns a partially-valid workspace, because
 * the alternative is an extension that refuses to start over one bad field.
 *
 * v1 → v2 was the flat `groups: Group[]` model becoming an arbitrarily nested
 * `tree: TreeNode[]`. Each v1 group becomes a top-level folder holding its mocks.
 */

import { renumber } from './tree.ts';
import { WORKSPACE_VERSION, emptyWorkspace } from './types.ts';
import type {
  BodyMatch,
  BodyMatchMode,
  Folder,
  HttpMethod,
  Mock,
  MockMatch,
  MockResponse,
  Tag,
  TreeNode,
  Workspace,
} from './types.ts';

const METHODS: readonly string[] = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_MODES: readonly string[] = ['contains', 'equals', 'regex', 'json-subset'];

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

let fallbackSeq = 0;

/**
 * Ids are load-bearing (selection, MCP addressing, move/delete), so a node that
 * arrives without one gets a synthetic one rather than being dropped.
 */
function id(value: unknown, prefix: string): string {
  return typeof value === 'string' && value ? value : `${prefix}_m${++fallbackSeq}`;
}

function migrateBodyMatch(value: unknown): BodyMatch | undefined {
  if (!isDict(value)) return undefined;
  const raw = str(value['value'], '');
  if (!raw) return undefined;
  const mode = str(value['mode'], 'contains');
  return {
    mode: (BODY_MODES.includes(mode) ? mode : 'contains') as BodyMatchMode,
    value: raw,
  };
}

function migrateMatch(value: unknown): MockMatch {
  const source = isDict(value) ? value : {};
  const method = str(source['method'], 'GET').toUpperCase();
  const body = migrateBodyMatch(source['body']);

  const match: MockMatch = {
    method: (METHODS.includes(method) ? method : '*') as HttpMethod | '*',
    urlPattern: str(source['urlPattern'], '*'),
    patternKind: source['patternKind'] === 'regex' ? 'regex' : 'glob',
  };
  if (body) match.body = body;
  return match;
}

function migrateHeaders(value: unknown): Record<string, string> {
  if (!isDict(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(value)) {
    if (typeof header === 'string') headers[key] = header;
  }
  return headers;
}

function migrateResponse(value: unknown): MockResponse {
  const source = isDict(value) ? value : {};
  const status = int(source['status'], 200);

  const response: MockResponse = {
    status: status >= 100 && status <= 599 ? status : 200,
    headers: migrateHeaders(source['headers']),
    body: str(source['body'], ''),
    bodyKind: source['bodyKind'] === 'text' ? 'text' : 'json',
    // New in v2; a v1 mock had no concept of latency, so it stays instant.
    delayMs: Math.max(0, int(source['delayMs'], 0)),
  };
  if (typeof source['statusText'] === 'string') response.statusText = source['statusText'];
  return response;
}

function migrateMock(value: unknown, order: number): Mock {
  const source = isDict(value) ? value : {};
  const mock: Mock = {
    kind: 'mock',
    id: id(source['id'], 'mck'),
    name: str(source['name'], 'Untitled mock'),
    enabled: bool(source['enabled'], true),
    tagIds: strArray(source['tagIds']),
    order,
    match: migrateMatch(source['match']),
    response: migrateResponse(source['response']),
  };
  if (typeof source['label'] === 'string' && source['label']) mock.label = source['label'];
  return mock;
}

function migrateNode(value: unknown, order: number): TreeNode | null {
  if (!isDict(value)) return null;

  // `kind` is v2's discriminator. A node without one came from v1 (or from a
  // hand-written file), where the presence of `mocks`/`children` is the only
  // signal — so fall back to structure rather than refusing the node.
  const kind = value['kind'] ?? (Array.isArray(value['children']) || Array.isArray(value['mocks']) ? 'folder' : 'mock');
  if (kind !== 'folder') return migrateMock(value, order);

  const rawChildren = Array.isArray(value['children'])
    ? value['children']
    : Array.isArray(value['mocks'])
      ? value['mocks']
      : [];

  const folder: Folder = {
    kind: 'folder',
    id: id(value['id'], 'fld'),
    name: str(value['name'], 'Untitled folder'),
    enabled: bool(value['enabled'], true),
    tagIds: strArray(value['tagIds']),
    order,
    expanded: bool(value['expanded'], true),
    children: migrateNodes(rawChildren),
  };
  return folder;
}

function migrateNodes(value: unknown): TreeNode[] {
  if (!Array.isArray(value)) return [];

  // Honour any `order` the source carried before discarding it for array
  // position, so a file written by `reorder_children` round-trips faithfully.
  const ordered = [...value].sort((a, b) => {
    const left = isDict(a) ? int(a['order'], 0) : 0;
    const right = isDict(b) ? int(b['order'], 0) : 0;
    return left - right;
  });

  const nodes: TreeNode[] = [];
  for (const item of ordered) {
    const node = migrateNode(item, nodes.length);
    if (node) nodes.push(node);
  }
  return renumber(nodes);
}

function migrateTags(value: unknown): Tag[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isDict).map((tag) => ({
    id: id(tag['id'], 'tag'),
    name: str(tag['name'], 'tag'),
    color: str(tag['color'], '#61afef'),
    enabled: bool(tag['enabled'], true),
  }));
}

/**
 * Normalises any stored or imported value into a current-version workspace.
 *
 * `targetTabIds` is intentionally *not* carried across from the input: tab ids
 * are session state owned by the browser, and adopting someone else's would
 * silently start mocking an unrelated tab.
 */
export function migrateWorkspace(value: unknown): Workspace {
  if (!isDict(value)) return emptyWorkspace();

  // v2 keeps its nodes under `tree`; v1 kept them under `groups`.
  const source = Array.isArray(value['tree']) ? value['tree'] : value['groups'];

  return {
    version: WORKSPACE_VERSION,
    enabled: bool(value['enabled'], true),
    tree: migrateNodes(source),
    tags: migrateTags(value['tags']),
    targetTabIds: [],
  };
}

/** True when `value` is already in the current shape and needs no rewrite. */
export function isCurrentVersion(value: unknown): boolean {
  return isDict(value) && value['version'] === WORKSPACE_VERSION && Array.isArray(value['tree']);
}
