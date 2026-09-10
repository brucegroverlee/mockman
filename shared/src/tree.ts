/**
 * Pure helpers for the nested folder/mock tree.
 *
 * Everything here returns new arrays and never mutates its input, so the panel
 * can hand a result straight to React and the MCP server can reuse the same
 * functions without worrying about aliasing the workspace it just read.
 *
 * The one invariant every mutation upholds: within a parent, `order` equals the
 * array index. `renumber` is how that is enforced, and it is called on every
 * path that changes a sibling list.
 */

import type { Folder, Mock, TreeNode } from './types.ts';
import { isFolder } from './types.ts';

/** A node together with where it sits. `ancestors` is outermost-first. */
export interface Located<T extends TreeNode = TreeNode> {
  node: T;
  ancestors: Folder[];
  parentId: string | null;
}

/** Rewrites `order` to match array position. */
export function renumber(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.map((node, index) => (node.order === index ? node : { ...node, order: index }));
}

/** Sorts by `order`, ties broken by current position. Use when reading foreign JSON. */
export function sortNodes(nodes: readonly TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => a.order - b.order);
}

/** Depth-first, in evaluation order. Folders are yielded before their children. */
export function* walkTree(
  nodes: readonly TreeNode[],
  ancestors: Folder[] = [],
  parentId: string | null = null,
): Generator<Located> {
  for (const node of nodes) {
    yield { node, ancestors, parentId };
    if (isFolder(node)) {
      yield* walkTree(node.children, [...ancestors, node], node.id);
    }
  }
}

export function findNode(nodes: readonly TreeNode[], id: string): Located | null {
  for (const located of walkTree(nodes)) {
    if (located.node.id === id) return located;
  }
  return null;
}

export function findMockNode(nodes: readonly TreeNode[], id: string): Located<Mock> | null {
  const located = findNode(nodes, id);
  return located && located.node.kind === 'mock' ? (located as Located<Mock>) : null;
}

export function findFolder(nodes: readonly TreeNode[], id: string): Located<Folder> | null {
  const located = findNode(nodes, id);
  return located && isFolder(located.node) ? (located as Located<Folder>) : null;
}

/** The breadcrumb segments for a located node, ending with the node's own name. */
export function pathSegments(located: Located): string[] {
  return [...located.ancestors.map((folder) => folder.name), located.node.name];
}

export function pathLabel(located: Located, separator = ' / '): string {
  return pathSegments(located).join(separator);
}

/**
 * Replaces one node in place, leaving structure untouched.
 *
 * `fn` receives the node and returns its replacement; returning the same object
 * is fine and skips the copy.
 */
export function updateNode(
  nodes: readonly TreeNode[],
  id: string,
  fn: (node: TreeNode) => TreeNode,
): TreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.id === id) {
      changed = true;
      return fn(node);
    }
    if (isFolder(node)) {
      const children = updateNode(node.children, id, fn);
      if (children !== node.children) {
        changed = true;
        return { ...node, children };
      }
    }
    return node;
  });
  return changed ? next : (nodes as TreeNode[]);
}

/** Appends into `parentId`'s children, or the root when `parentId` is null. */
export function insertNode(
  nodes: readonly TreeNode[],
  parentId: string | null,
  node: TreeNode,
  index?: number,
): TreeNode[] {
  if (parentId === null) {
    const next = [...nodes];
    next.splice(index ?? next.length, 0, node);
    return renumber(next);
  }

  return updateNode(nodes, parentId, (parent) => {
    if (!isFolder(parent)) throw new Error(`Cannot insert into a mock: ${parentId}`);
    const children = [...parent.children];
    children.splice(index ?? children.length, 0, node);
    // A folder that just received a child should be showing it.
    return { ...parent, expanded: true, children: renumber(children) };
  });
}

export function removeNode(
  nodes: readonly TreeNode[],
  id: string,
): { tree: TreeNode[]; removed: TreeNode | null } {
  let removed: TreeNode | null = null;

  const strip = (list: readonly TreeNode[]): TreeNode[] => {
    const kept: TreeNode[] = [];
    let changed = false;
    for (const node of list) {
      if (node.id === id) {
        removed = node;
        changed = true;
        continue;
      }
      if (isFolder(node)) {
        const children = strip(node.children);
        if (children !== node.children) {
          changed = true;
          kept.push({ ...node, children });
          continue;
        }
      }
      kept.push(node);
    }
    return changed ? renumber(kept) : (list as TreeNode[]);
  };

  return { tree: strip(nodes), removed };
}

/** True when `nodeId` is `ancestorId` itself or lives somewhere beneath it. */
export function isSelfOrDescendant(
  nodes: readonly TreeNode[],
  ancestorId: string,
  nodeId: string,
): boolean {
  if (ancestorId === nodeId) return true;
  const located = findNode(nodes, nodeId);
  return located ? located.ancestors.some((folder) => folder.id === ancestorId) : false;
}

/**
 * Moves a node under a new parent at a given index.
 *
 * Refuses to drop a folder inside itself — without that guard the subtree would
 * simply vanish from the tree, which is a confusing way to lose work. The index
 * is interpreted against the sibling list *after* removal, so dragging a node
 * down within its own parent lands where the drop indicator was.
 */
export function moveTreeNode(
  nodes: readonly TreeNode[],
  id: string,
  parentId: string | null,
  index?: number,
): TreeNode[] {
  if (parentId !== null && isSelfOrDescendant(nodes, id, parentId)) return nodes as TreeNode[];

  const { tree, removed } = removeNode(nodes, id);
  if (!removed) return nodes as TreeNode[];
  return insertNode(tree, parentId, removed, index);
}

/** Every mock in the tree, in evaluation order, with its ancestor chain. */
export function allMocks(nodes: readonly TreeNode[]): Located<Mock>[] {
  const out: Located<Mock>[] = [];
  for (const located of walkTree(nodes)) {
    if (located.node.kind === 'mock') out.push(located as Located<Mock>);
  }
  return out;
}

export function countNodes(nodes: readonly TreeNode[]): { folders: number; mocks: number } {
  let folders = 0;
  let mocks = 0;
  for (const { node } of walkTree(nodes)) {
    if (isFolder(node)) folders++;
    else mocks++;
  }
  return { folders, mocks };
}
