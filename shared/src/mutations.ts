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

import type { Group, Mock, MockMatch, MockResponse, Patch, Tag, Workspace } from './types.ts';

export type EnableKind = 'workspace' | 'group' | 'mock' | 'tag';

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function nextOrder(items: readonly { order: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.order), -1) + 1;
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

/** Also strips the tag from every group and mock, so no dangling ids are left. */
export function deleteTag(workspace: Workspace, tagId: string): Workspace {
  const without = (ids: string[]): string[] => ids.filter((id) => id !== tagId);
  return {
    ...workspace,
    tags: workspace.tags.filter((t) => t.id !== tagId),
    groups: workspace.groups.map((g) => ({
      ...g,
      tagIds: without(g.tagIds),
      mocks: g.mocks.map((m) => ({ ...m, tagIds: without(m.tagIds) })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function createGroup(
  workspace: Workspace,
  input: { name: string; tagIds?: string[] | undefined; enabled?: boolean | undefined },
): { workspace: Workspace; group: Group } {
  const group: Group = {
    id: newId('grp'),
    name: input.name,
    enabled: input.enabled ?? true,
    tagIds: input.tagIds ?? [],
    order: nextOrder(workspace.groups),
    mocks: [],
  };
  return { workspace: { ...workspace, groups: [...workspace.groups, group] }, group };
}

export function updateGroup(
  workspace: Workspace,
  groupId: string,
  patch: Patch<Omit<Group, 'id' | 'mocks'>>,
): Workspace {
  return {
    ...workspace,
    groups: workspace.groups.map((g) => (g.id === groupId ? applyPatch(g, patch) : g)),
  };
}

export function deleteGroup(workspace: Workspace, groupId: string): Workspace {
  return { ...workspace, groups: workspace.groups.filter((g) => g.id !== groupId) };
}

export function reorderGroups(workspace: Workspace, orderedIds: readonly string[]): Workspace {
  const position = new Map(orderedIds.map((id, index) => [id, index]));
  return {
    ...workspace,
    groups: workspace.groups.map((g) => ({ ...g, order: position.get(g.id) ?? g.order })),
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

export interface CreateMockInput {
  name: string;
  match: MockMatch;
  response: MockResponse;
  tagIds?: string[] | undefined;
  enabled?: boolean | undefined;
}

export function createMock(
  workspace: Workspace,
  groupId: string,
  input: CreateMockInput,
): { workspace: Workspace; mock: Mock } {
  const group = workspace.groups.find((g) => g.id === groupId);
  if (!group) throw new Error(`No such group: ${groupId}`);

  const mock: Mock = {
    id: newId('mck'),
    name: input.name,
    enabled: input.enabled ?? true,
    tagIds: input.tagIds ?? [],
    order: nextOrder(group.mocks),
    match: input.match,
    response: input.response,
  };

  return {
    workspace: {
      ...workspace,
      groups: workspace.groups.map((g) =>
        g.id === groupId ? { ...g, mocks: [...g.mocks, mock] } : g,
      ),
    },
    mock,
  };
}

export function updateMock(
  workspace: Workspace,
  mockId: string,
  patch: Patch<Omit<Mock, 'id'>>,
): Workspace {
  return {
    ...workspace,
    groups: workspace.groups.map((g) => ({
      ...g,
      mocks: g.mocks.map((m) => (m.id === mockId ? applyPatch(m, patch) : m)),
    })),
  };
}

export function deleteMock(workspace: Workspace, mockId: string): Workspace {
  return {
    ...workspace,
    groups: workspace.groups.map((g) => ({
      ...g,
      mocks: g.mocks.filter((m) => m.id !== mockId),
    })),
  };
}

export function findMock(
  workspace: Workspace,
  mockId: string,
): { group: Group; mock: Mock } | null {
  for (const group of workspace.groups) {
    const mock = group.mocks.find((m) => m.id === mockId);
    if (mock) return { group, mock };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

/**
 * The single entry point behind every toggle, in the UI and over MCP alike.
 *
 * Note this only flips the requested flag; whether a mock actually *fires* is
 * decided by the enablement rules in enablement.ts, which also account for the
 * group and for tag vetoes.
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
    case 'group':
      return id ? updateGroup(workspace, id, { enabled }) : workspace;
    case 'mock':
      return id ? updateMock(workspace, id, { enabled }) : workspace;
    case 'tag':
      return id ? updateTag(workspace, id, { enabled }) : workspace;
  }
}
