/**
 * The three-way enable rule.
 *
 * A mock only fires when the master switch is on, the request's tab is targeted,
 * its group is enabled, it is itself enabled, and no tag it (or its group)
 * carries is disabled. Tags are a *veto*, which is what makes them useful: you
 * can kill an orthogonal slice of mocks with one toggle without touching the
 * groups they live in.
 *
 * Kept as pure functions so it can be unit-tested without a browser, and reused
 * by both the panel (to explain *why* a row is inert) and the compiler that
 * feeds the interceptor.
 */

import type { Group, Mock, Tag, Workspace } from './types.ts';

export type InactiveReason =
  | 'workspace-disabled'
  | 'tab-not-targeted'
  | 'group-disabled'
  | 'mock-disabled'
  | 'tag-disabled';

export interface Activation {
  active: boolean;
  /** Absent when `active` is true. */
  reason?: InactiveReason;
  /** The disabled tag responsible, when `reason === 'tag-disabled'`. */
  vetoingTagId?: string;
}

export function indexTags(tags: readonly Tag[]): Map<string, Tag> {
  return new Map(tags.map((t) => [t.id, t]));
}

/**
 * Returns the id of the first disabled tag among `tagIds`, or undefined.
 *
 * Unknown tag ids are ignored rather than treated as a veto — a dangling
 * reference (say, after a tag is deleted) should not silently disable a mock.
 */
export function findVetoingTag(
  tagIds: readonly string[],
  tagsById: ReadonlyMap<string, Tag>,
): string | undefined {
  for (const id of tagIds) {
    const tag = tagsById.get(id);
    if (tag && !tag.enabled) return id;
  }
  return undefined;
}

/**
 * Why a given mock is or is not active for `tabId`.
 *
 * Reasons are checked from broadest to narrowest so the explanation surfaced in
 * the UI is the most useful one: there is no point telling someone a tag is
 * disabled when the master switch is off.
 */
export function explainMock(
  workspace: Workspace,
  group: Group,
  mock: Mock,
  tabId: number,
  tagsById: ReadonlyMap<string, Tag> = indexTags(workspace.tags),
): Activation {
  if (!workspace.enabled) return { active: false, reason: 'workspace-disabled' };
  if (!workspace.targetTabIds.includes(tabId)) {
    return { active: false, reason: 'tab-not-targeted' };
  }
  if (!group.enabled) return { active: false, reason: 'group-disabled' };
  if (!mock.enabled) return { active: false, reason: 'mock-disabled' };

  // A tag on the group vetoes just as hard as one on the mock itself.
  const vetoingTagId =
    findVetoingTag(group.tagIds, tagsById) ?? findVetoingTag(mock.tagIds, tagsById);
  if (vetoingTagId !== undefined) {
    return { active: false, reason: 'tag-disabled', vetoingTagId };
  }

  return { active: true };
}

export function isMockActive(
  workspace: Workspace,
  group: Group,
  mock: Mock,
  tabId: number,
  tagsById?: ReadonlyMap<string, Tag>,
): boolean {
  return explainMock(workspace, group, mock, tabId, tagsById).active;
}
