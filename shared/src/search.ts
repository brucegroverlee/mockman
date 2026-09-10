/**
 * The tree's search box.
 *
 * One box does everything, because a DevTools panel has no room for a filter
 * bar. Typing a bare word matches a node's name, its URL pattern, its label
 * *or* one of its tag names — a tag name is usually distinctive enough that a
 * bare word does the right thing, and nothing is hidden behind syntax you have
 * to know about.
 *
 * The prefixes exist for when a bare word is too broad:
 *
 *   tag:auth        only nodes carrying a tag whose name contains "auth"
 *   method:post     only mocks with that method
 *   status:404      only mocks responding with that status
 *   url:/jukeboxes  only the URL pattern
 *
 * Terms are ANDed. Quotes group a term containing spaces.
 */

import { isFolder } from './types.ts';
import type { Tag, TreeNode } from './types.ts';

export type TermField = 'any' | 'tag' | 'method' | 'status' | 'url' | 'name';

export interface SearchTerm {
  field: TermField;
  value: string;
  /** `-foo` excludes rather than includes. */
  negated: boolean;
}

export interface SearchQuery {
  terms: SearchTerm[];
}

const FIELDS: Record<string, TermField> = {
  tag: 'tag',
  method: 'method',
  status: 'status',
  url: 'url',
  name: 'name',
};

/**
 * Splits on whitespace, but keeps `"quoted phrases"` together.
 *
 * The first alternative allows an unquoted head before the quote so that
 * `tag:"two words"` stays one token; without it the bare-run alternative would
 * claim `tag:"two` and leave `words"` stranded.
 */
function tokenize(input: string): string[] {
  return input.match(/[^\s"]*"[^"]*"|\S+/g) ?? [];
}

export function parseSearch(input: string): SearchQuery {
  const terms: SearchTerm[] = [];

  for (const rawToken of tokenize(input)) {
    let token = rawToken;

    const negated = token.startsWith('-') && token.length > 1;
    if (negated) token = token.slice(1);

    let field: TermField = 'any';
    const colon = token.indexOf(':');
    if (colon > 0) {
      const candidate = FIELDS[token.slice(0, colon).toLowerCase()];
      if (candidate) {
        field = candidate;
        token = token.slice(colon + 1);
      }
    }

    // Strip quotes only after prefix handling, so `tag:"two words"` works.
    if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
      token = token.slice(1, -1);
    }

    if (token) terms.push({ field, value: token.toLowerCase(), negated });
  }

  return { terms };
}

export function isEmptyQuery(query: SearchQuery): boolean {
  return query.terms.length === 0;
}

function tagNames(node: TreeNode, tagsById: ReadonlyMap<string, Tag>): string[] {
  return node.tagIds.map((id) => tagsById.get(id)?.name.toLowerCase()).filter((n): n is string => !!n);
}

/**
 * Whether a single node satisfies one term, ignoring its ancestors and children.
 *
 * Field-scoped terms that make no sense for a folder (method, status, url) never
 * match one — a folder has no method, and pretending otherwise would make
 * `method:post` list every folder in the tree.
 */
function nodeMatchesTerm(
  node: TreeNode,
  term: SearchTerm,
  tagsById: ReadonlyMap<string, Tag>,
): boolean {
  const name = node.name.toLowerCase();
  const tags = tagNames(node, tagsById);
  const mock = isFolder(node) ? null : node;

  switch (term.field) {
    case 'name':
      return name.includes(term.value);
    case 'tag':
      return tags.some((tag) => tag.includes(term.value));
    case 'method':
      return mock !== null && mock.match.method.toLowerCase().includes(term.value);
    case 'status':
      return mock !== null && String(mock.response.status).includes(term.value);
    case 'url':
      return mock !== null && mock.match.urlPattern.toLowerCase().includes(term.value);
    case 'any':
      return (
        name.includes(term.value) ||
        tags.some((tag) => tag.includes(term.value)) ||
        (mock !== null &&
          (mock.match.urlPattern.toLowerCase().includes(term.value) ||
            (mock.label ?? '').toLowerCase().includes(term.value)))
      );
  }
}

export function nodeMatchesQuery(
  node: TreeNode,
  query: SearchQuery,
  tagsById: ReadonlyMap<string, Tag>,
): boolean {
  return query.terms.every((term) => {
    const hit = nodeMatchesTerm(node, term, tagsById);
    return term.negated ? !hit : hit;
  });
}

export interface FilterResult {
  /** The tree with non-matching branches pruned. */
  tree: TreeNode[];
  /** Ids of the nodes that matched in their own right, for highlighting. */
  matched: Set<string>;
  /** Folders that must be shown open because a match lives inside them. */
  expand: Set<string>;
}

/**
 * Prunes the tree to the branches worth showing.
 *
 * A node survives when it matches, or when a descendant matches. A folder that
 * matches keeps **all** of its children: once you have found "Jukeboxes" you
 * want to see what is in it, not a version of it emptied by the same query that
 * led you there.
 */
export function filterTree(
  nodes: readonly TreeNode[],
  query: SearchQuery,
  tagsById: ReadonlyMap<string, Tag>,
): FilterResult {
  const matched = new Set<string>();
  const expand = new Set<string>();

  if (isEmptyQuery(query)) {
    return { tree: nodes as TreeNode[], matched, expand };
  }

  const prune = (list: readonly TreeNode[]): TreeNode[] => {
    const kept: TreeNode[] = [];

    for (const node of list) {
      const self = nodeMatchesQuery(node, query, tagsById);
      if (self) matched.add(node.id);

      if (!isFolder(node)) {
        if (self) kept.push(node);
        continue;
      }

      if (self) {
        kept.push(node);
        // Still walk in, so descendants that also match get highlighted.
        prune(node.children);
        continue;
      }

      const children = prune(node.children);
      if (children.length > 0) {
        expand.add(node.id);
        kept.push({ ...node, children });
      }
    }

    return kept;
  };

  return { tree: prune(nodes), matched, expand };
}
