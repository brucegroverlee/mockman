/**
 * Exporting mocks and folders to share with other people, and importing theirs.
 *
 * The exported document is meant to be pasted into a chat or saved as a file,
 * so it is written for a human reader as much as for this code:
 *
 *   - **No ids, no `order`, no `expanded`.** Ids are meaningless in someone
 *     else's workspace (an import always re-ids, see `importNodes`), and the
 *     other two are layout state. Leaving them out keeps the document short.
 *   - **Tags travel by name.** A node lists `tags: ["checkout"]`; the top-level
 *     `tags` array only carries their colours. On import a name is matched
 *     case-insensitively against the tags already there, so two people who both
 *     tag things "checkout" end up sharing one tag rather than two.
 *
 * Import is deliberately forgiving about what it is given — the export
 * envelope, a bare node, an array of nodes, or a whole workspace from the MCP
 * `export_workspace` tool — but strict about one thing: every mock must carry a
 * URL pattern. `migrateNodes` fills a missing one with `*`, which is right for a
 * damaged stored workspace and very wrong for a pasted one: a typo would import
 * as a catch-all that answers every request in the tab.
 */

import { migrateNodes } from './migrate.ts';
import { TAG_COLORS, newId } from './mutations.ts';
import { findFolder, insertNode, walkTree } from './tree.ts';
import { isFolder } from './types.ts';
import type { MockMatch, MockResponse, Tag, TreeNode, Workspace } from './types.ts';

/** Bumped only if the document shape changes incompatibly. */
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportedTag {
  name: string;
  color: string;
}

interface ExportedCommon {
  name: string;
  enabled: boolean;
  /** Tag names. Omitted when empty. */
  tags?: string[];
}

export interface ExportedMock extends ExportedCommon {
  kind: 'mock';
  label?: string;
  match: MockMatch;
  response: MockResponse;
}

export interface ExportedFolder extends ExportedCommon {
  kind: 'folder';
  children: ExportedNode[];
}

export type ExportedNode = ExportedMock | ExportedFolder;

export interface ExportDocument {
  mockman: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  tags: ExportedTag[];
  nodes: ExportedNode[];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Builds the shareable document for `nodes` (and everything beneath them). */
export function exportNodes(workspace: Workspace, nodes: readonly TreeNode[]): ExportDocument {
  const tagsById = new Map(workspace.tags.map((tag) => [tag.id, tag]));
  const used = new Map<string, Tag>();

  const tagNames = (tagIds: readonly string[]): string[] => {
    const names: string[] = [];
    for (const id of tagIds) {
      const tag = tagsById.get(id);
      if (!tag) continue; // a dangling id is not worth carrying to someone else
      used.set(tag.id, tag);
      names.push(tag.name);
    }
    return names;
  };

  const convert = (node: TreeNode): ExportedNode => {
    const tags = tagNames(node.tagIds);
    const common: ExportedCommon = {
      name: node.name,
      enabled: node.enabled,
      ...(tags.length > 0 && { tags }),
    };
    if (isFolder(node)) {
      return { kind: 'folder', ...common, children: node.children.map(convert) };
    }
    return {
      kind: 'mock',
      ...common,
      ...(node.label ? { label: node.label } : {}),
      match: node.match,
      response: node.response,
    };
  };

  const exported = nodes.map(convert);
  return {
    mockman: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    tags: [...used.values()].map(({ name, color }) => ({ name, color })),
    nodes: exported,
  };
}

/** The document as the formatted text shown, copied and downloaded. */
export function exportText(workspace: Workspace, nodes: readonly TreeNode[]): string {
  return JSON.stringify(exportNodes(workspace, nodes), null, 2);
}

/** A file name for the download, e.g. `tt-service.mockman.json`. */
export function exportFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'mocks'}.mockman.json`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * A parsed, validated import, ready to be placed with `importNodes`.
 *
 * Until then its nodes still carry the source's ids, and their `tagIds` hold tag
 * **names** — both are resolved against the destination workspace only when the
 * import is applied, so the same plan can be previewed and then applied to a
 * workspace that changed in between.
 */
export interface ImportPlan {
  nodes: TreeNode[];
  /** Colours for tag names, where the source said. Keyed by lowercased name. */
  tagColors: Map<string, string>;
  mocks: number;
  folders: number;
  /** Every distinct tag name the nodes use, as spelled in the source. */
  tagNames: string[];
}

export type ParseResult = { ok: true; plan: ImportPlan } | { ok: false; error: string };

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeNode(value: Dict): boolean {
  return (
    value['kind'] === 'mock' ||
    value['kind'] === 'folder' ||
    isDict(value['match']) ||
    Array.isArray(value['children'])
  );
}

/**
 * Checks what `migrateNodes` would otherwise paper over. Returns an error
 * message naming the offending node, or null.
 */
function validateNodes(nodes: readonly unknown[], path: string): string | null {
  for (const [index, node] of nodes.entries()) {
    const where = `${path}[${index}]`;
    if (!isDict(node) || !looksLikeNode(node)) {
      return `${where} is not a mock or a folder.`;
    }
    const name = typeof node['name'] === 'string' ? `"${node['name']}"` : where;
    const isFolderNode = node['kind'] === 'folder' || (node['kind'] === undefined && Array.isArray(node['children']));
    if (isFolderNode) {
      const children = node['children'];
      if (children !== undefined && !Array.isArray(children)) {
        return `Folder ${name} has a "children" value that is not a list.`;
      }
      const error = validateNodes(Array.isArray(children) ? children : [], `${where}.children`);
      if (error) return error;
      continue;
    }
    const match = node['match'];
    if (!isDict(match) || typeof match['urlPattern'] !== 'string' || !match['urlPattern'].trim()) {
      return `Mock ${name} has no match.urlPattern.`;
    }
  }
  return null;
}

/**
 * Rewrites each raw node's tags as a list of names under `tagIds`, whichever way
 * the source expressed them: names under `tags` (an export document) or ids
 * under `tagIds` resolved through the source's own tag table (a workspace).
 */
function tagsToNames(nodes: readonly unknown[], idToName: ReadonlyMap<string, string>): unknown[] {
  return nodes.map((raw) => {
    if (!isDict(raw)) return raw;
    const names = Array.isArray(raw['tags'])
      ? raw['tags'].filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
      : Array.isArray(raw['tagIds'])
        ? raw['tagIds'].flatMap((id) => {
            const name = typeof id === 'string' ? idToName.get(id) : undefined;
            return name ? [name] : [];
          })
        : [];
    const next: Dict = { ...raw, tagIds: names };
    if (Array.isArray(raw['children'])) next['children'] = tagsToNames(raw['children'], idToName);
    return next;
  });
}

/**
 * Parses pasted or uploaded text into an `ImportPlan`.
 *
 * Accepts, in order of preference:
 *   1. an export document — `{ "mockman": 1, "nodes": [...] }`
 *   2. a whole workspace — `{ "tree": [...], "tags": [...] }`
 *   3. a list of nodes
 *   4. a single mock or folder
 */
export function parseImport(text: string): ParseResult {
  if (!text.trim()) return { ok: false, error: 'Nothing to import yet.' };

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : error}` };
  }

  let rawNodes: unknown[];
  let rawTags: unknown[] = [];
  if (isDict(value) && Array.isArray(value['nodes'])) {
    rawNodes = value['nodes'];
    rawTags = Array.isArray(value['tags']) ? value['tags'] : [];
  } else if (isDict(value) && Array.isArray(value['tree'])) {
    rawNodes = value['tree'];
    rawTags = Array.isArray(value['tags']) ? value['tags'] : [];
  } else if (Array.isArray(value)) {
    rawNodes = value;
  } else if (isDict(value) && looksLikeNode(value)) {
    rawNodes = [value];
  } else {
    return { ok: false, error: 'This JSON does not look like a Mockman export, a mock or a folder.' };
  }

  if (rawNodes.length === 0) return { ok: false, error: 'The document contains no mocks or folders.' };

  const invalid = validateNodes(rawNodes, 'nodes');
  if (invalid) return { ok: false, error: invalid };

  const idToName = new Map<string, string>();
  const tagColors = new Map<string, string>();
  for (const tag of rawTags) {
    if (!isDict(tag) || typeof tag['name'] !== 'string' || !tag['name'].trim()) continue;
    if (typeof tag['id'] === 'string') idToName.set(tag['id'], tag['name']);
    if (typeof tag['color'] === 'string') tagColors.set(tag['name'].toLowerCase(), tag['color']);
  }

  const nodes = migrateNodes(tagsToNames(rawNodes, idToName));

  let mocks = 0;
  let folders = 0;
  const tagNames = new Map<string, string>();
  for (const { node } of walkTree(nodes)) {
    if (isFolder(node)) folders++;
    else mocks++;
    for (const name of node.tagIds) {
      if (!tagNames.has(name.toLowerCase())) tagNames.set(name.toLowerCase(), name);
    }
  }

  return { ok: true, plan: { nodes, tagColors, mocks, folders, tagNames: [...tagNames.values()] } };
}

/**
 * Places an import's nodes at the end of `parentId` (null for the top level),
 * with fresh ids, and with tag names resolved to the workspace's tags —
 * creating any that do not exist yet.
 */
export function importNodes(
  workspace: Workspace,
  parentId: string | null,
  plan: ImportPlan,
): { workspace: Workspace; nodeIds: string[] } {
  if (parentId !== null && !findFolder(workspace.tree, parentId)) {
    throw new Error(`No such folder: ${parentId}`);
  }

  const tags = [...workspace.tags];
  const byName = new Map(tags.map((tag) => [tag.name.toLowerCase(), tag.id]));

  const resolveTag = (name: string): string => {
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) return existing;
    const tag: Tag = {
      id: newId('tag'),
      name,
      color: plan.tagColors.get(key) ?? TAG_COLORS[tags.length % TAG_COLORS.length]!,
      enabled: true,
    };
    tags.push(tag);
    byName.set(key, tag.id);
    return tag.id;
  };

  const reId = (node: TreeNode): TreeNode => {
    const tagIds = [...new Set(node.tagIds.map(resolveTag))];
    return isFolder(node)
      ? { ...node, id: newId('fld'), tagIds, children: node.children.map(reId) }
      : { ...node, id: newId('mck'), tagIds };
  };

  let tree = workspace.tree;
  const nodeIds: string[] = [];
  for (const node of plan.nodes) {
    const placed = reId(node);
    tree = insertNode(tree, parentId, placed);
    nodeIds.push(placed.id);
  }

  return { workspace: { ...workspace, tree, tags }, nodeIds };
}
