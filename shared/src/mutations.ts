/**
 * Workspace mutations.
 *
 * These live in `shared` rather than in the panel because the MCP server has to
 * perform the *same* operations. Two implementations of "create a mock" would
 * drift, and the drift would show up as an agent and a human disagreeing about
 * what the workspace contains.
 *
 * All functions are pure: they return a new workspace and never mutate the input.
 */

import {
  findFolder,
  findMockNode,
  findNode,
  insertNode,
  moveTreeNode,
  removeNode,
  renumber,
  updateNode,
  walkTree,
} from './tree.ts';
import type { Located } from './tree.ts';
import { isFolder } from './types.ts';
import type {
  Folder,
  Mock,
  MockMatch,
  MockResponse,
  Patch,
  Tag,
  TreeNode,
  Workspace,
} from './types.ts';

export type EnableKind = 'workspace' | 'folder' | 'mock' | 'tag';

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Applies a patch, ignoring keys whose value is `undefined`.
 *
 * A plain spread would write those `undefined`s straight into the record. That is
 * wrong on both counts: it breaks the types, and semantically an absent field in
 * a patch means "leave this alone", not "clear it".
 */
// `NoInfer` on the patch is load-bearing: without it TypeScript infers T from the
// patch (an `Omit<...>`) instead of from `base`, and the result loses `id`.
function applyPatch<T extends object>(base: T, patch: Patch<NoInfer<T>>): T {
  const next = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return next as T;
}

function withTree(workspace: Workspace, tree: TreeNode[]): Workspace {
  return tree === workspace.tree ? workspace : { ...workspace, tree };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function defaultResponse(): MockResponse {
  return {
    status: 200,
    headers: {},
    body: '{\n  "mocked": true\n}',
    bodyKind: 'json',
    delayMs: 0,
  };
}

export function defaultMatch(): MockMatch {
  return { method: 'GET', urlPattern: '*/api/*', patternKind: 'glob' };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const TAG_COLORS = ['#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd'];

export function createTag(
  workspace: Workspace,
  input: { name: string; color?: string | undefined; enabled?: boolean | undefined },
): { workspace: Workspace; tag: Tag } {
  const tag: Tag = {
    id: newId('tag'),
    name: input.name,
    color: input.color ?? TAG_COLORS[workspace.tags.length % TAG_COLORS.length]!,
    enabled: input.enabled ?? true,
  };
  return { workspace: { ...workspace, tags: [...workspace.tags, tag] }, tag };
}

export function updateTag(
  workspace: Workspace,
  tagId: string,
  patch: Patch<Omit<Tag, 'id'>>,
): Workspace {
  return {
    ...workspace,
    tags: workspace.tags.map((t) => (t.id === tagId ? applyPatch(t, patch) : t)),
  };
}

/** Also strips the tag from every node, so no dangling ids are left. */
export function deleteTag(workspace: Workspace, tagId: string): Workspace {
  const strip = (nodes: readonly TreeNode[]): TreeNode[] =>
    nodes.map((node) => {
      const tagIds = node.tagIds.includes(tagId)
        ? node.tagIds.filter((id) => id !== tagId)
        : node.tagIds;
      return isFolder(node)
        ? { ...node, tagIds, children: strip(node.children) }
        : { ...node, tagIds };
    });

  return {
    ...workspace,
    tags: workspace.tags.filter((t) => t.id !== tagId),
    tree: strip(workspace.tree),
  };
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export interface CreateFolderInput {
  name: string;
  tagIds?: string[] | undefined;
  enabled?: boolean | undefined;
}

/** `parentId` of null creates a top-level folder. */
export function createFolder(
  workspace: Workspace,
  parentId: string | null,
  input: CreateFolderInput,
): { workspace: Workspace; folder: Folder } {
  if (parentId !== null && !findFolder(workspace.tree, parentId)) {
    throw new Error(`No such folder: ${parentId}`);
  }

  const folder: Folder = {
    kind: 'folder',
    id: newId('fld'),
    name: input.name,
    enabled: input.enabled ?? true,
    tagIds: input.tagIds ?? [],
    order: 0, // insertNode renumbers
    expanded: true,
    children: [],
  };

  return { workspace: withTree(workspace, insertNode(workspace.tree, parentId, folder)), folder };
}

export function updateFolder(
  workspace: Workspace,
  folderId: string,
  patch: Patch<Omit<Folder, 'id' | 'kind' | 'children' | 'order'>>,
): Workspace {
  return withTree(
    workspace,
    updateNode(workspace.tree, folderId, (node) => {
      if (!isFolder(node)) throw new Error(`Not a folder: ${folderId}`);
      return applyPatch(node, patch);
    }),
  );
}

export function setExpanded(workspace: Workspace, folderId: string, expanded: boolean): Workspace {
  return updateFolder(workspace, folderId, { expanded });
}

/** Expands or collapses every folder at once, for the tree toolbar. */
export function setAllExpanded(workspace: Workspace, expanded: boolean): Workspace {
  const walk = (nodes: readonly TreeNode[]): TreeNode[] =>
    nodes.map((node) =>
      isFolder(node) ? { ...node, expanded, children: walk(node.children) } : node,
    );
  return { ...workspace, tree: walk(workspace.tree) };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

export interface CreateMockInput {
  name: string;
  match: MockMatch;
  response: MockResponse;
  label?: string | undefined;
  tagIds?: string[] | undefined;
  enabled?: boolean | undefined;
}

/** `parentId` of null creates a top-level mock, outside any folder. */
export function createMock(
  workspace: Workspace,
  parentId: string | null,
  input: CreateMockInput,
): { workspace: Workspace; mock: Mock } {
  if (parentId !== null && !findFolder(workspace.tree, parentId)) {
    throw new Error(`No such folder: ${parentId}`);
  }

  const mock: Mock = {
    kind: 'mock',
    id: newId('mck'),
    name: input.name,
    enabled: input.enabled ?? true,
    tagIds: input.tagIds ?? [],
    order: 0, // insertNode renumbers
    label: input.label,
    match: input.match,
    response: input.response,
  };

  return { workspace: withTree(workspace, insertNode(workspace.tree, parentId, mock)), mock };
}

export function updateMock(
  workspace: Workspace,
  mockId: string,
  patch: Patch<Omit<Mock, 'id' | 'kind' | 'order'>>,
): Workspace {
  return withTree(
    workspace,
    updateNode(workspace.tree, mockId, (node) => {
      if (node.kind !== 'mock') throw new Error(`Not a mock: ${mockId}`);
      return applyPatch(node, patch);
    }),
  );
}

// ---------------------------------------------------------------------------
// Nodes (folder or mock)
// ---------------------------------------------------------------------------

/** Renames any node. Convenience for inline editing in the tree. */
export function renameNode(workspace: Workspace, nodeId: string, name: string): Workspace {
  return withTree(
    workspace,
    updateNode(workspace.tree, nodeId, (node) => ({ ...node, name })),
  );
}

export function setNodeTags(workspace: Workspace, nodeId: string, tagIds: string[]): Workspace {
  return withTree(
    workspace,
    updateNode(workspace.tree, nodeId, (node) => ({ ...node, tagIds })),
  );
}

/** Deletes a node and, for a folder, everything inside it. */
export function deleteNode(workspace: Workspace, nodeId: string): Workspace {
  return withTree(workspace, removeNode(workspace.tree, nodeId).tree);
}

/**
 * Reparents a node. A folder cannot be moved inside itself; that is a no-op.
 *
 * `index` is a position among the destination's children *after* the node has
 * been removed from wherever it was.
 */
export function moveNode(
  workspace: Workspace,
  nodeId: string,
  parentId: string | null,
  index?: number,
): Workspace {
  if (parentId !== null && !findFolder(workspace.tree, parentId)) {
    throw new Error(`No such folder: ${parentId}`);
  }
  return withTree(workspace, moveTreeNode(workspace.tree, nodeId, parentId, index));
}

/**
 * Reorders one sibling list, given every id in it in the desired order.
 *
 * Ids that are not actually siblings under `parentId` are ignored, and siblings
 * missing from the list keep their relative order at the end — so a partial or
 * stale list degrades rather than dropping nodes.
 */
export function reorderChildren(
  workspace: Workspace,
  parentId: string | null,
  orderedIds: readonly string[],
): Workspace {
  const reorder = (children: readonly TreeNode[]): TreeNode[] => {
    const byId = new Map(children.map((child) => [child.id, child]));
    const next: TreeNode[] = [];
    for (const id of orderedIds) {
      const child = byId.get(id);
      if (child) {
        next.push(child);
        byId.delete(id);
      }
    }
    return renumber([...next, ...byId.values()]);
  };

  if (parentId === null) return { ...workspace, tree: reorder(workspace.tree) };

  return withTree(
    workspace,
    updateNode(workspace.tree, parentId, (node) => {
      if (!isFolder(node)) throw new Error(`Not a folder: ${parentId}`);
      return { ...node, children: reorder(node.children) };
    }),
  );
}

/**
 * Duplicates a node (and its subtree) as a sibling, with fresh ids.
 *
 * Ids must be regenerated rather than copied: two nodes sharing an id would make
 * every id-keyed operation ambiguous.
 */
export function duplicateNode(
  workspace: Workspace,
  nodeId: string,
): { workspace: Workspace; node: TreeNode | null } {
  const located = findNode(workspace.tree, nodeId);
  if (!located) return { workspace, node: null };

  const clone = (node: TreeNode): TreeNode =>
    isFolder(node)
      ? { ...node, id: newId('fld'), children: node.children.map(clone) }
      : { ...node, id: newId('mck') };

  const copy = { ...clone(located.node), name: `${located.node.name} copy` };
  return {
    workspace: withTree(
      workspace,
      insertNode(workspace.tree, located.parentId, copy, located.node.order + 1),
    ),
    node: copy,
  };
}

export function findMock(workspace: Workspace, mockId: string): Located<Mock> | null {
  return findMockNode(workspace.tree, mockId);
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

/**
 * The single entry point behind every toggle, in the UI and over MCP alike.
 *
 * Note this only flips the requested flag; whether a mock actually *fires* is
 * decided by the enablement rules in enablement.ts, which also account for the
 * folders above it and for tag vetoes.
 */
export function setEnabled(
  workspace: Workspace,
  kind: EnableKind,
  id: string | null,
  enabled: boolean,
): Workspace {
  switch (kind) {
    case 'workspace':
      return { ...workspace, enabled };
    case 'tag':
      return id ? updateTag(workspace, id, { enabled }) : workspace;
    case 'folder':
    case 'mock':
      return id
        ? withTree(
            workspace,
            updateNode(workspace.tree, id, (node) => ({ ...node, enabled })),
          )
        : workspace;
  }
}

/** Ids of every node currently in the tree — used to validate incoming edits. */
export function allNodeIds(workspace: Workspace): Set<string> {
  const ids = new Set<string>();
  for (const { node } of walkTree(workspace.tree)) ids.add(node.id);
  return ids;
}
