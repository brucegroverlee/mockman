/**
 * The enable rule.
 *
 * A mock only fires when the master switch is on, the request's tab is targeted,
 * every folder above it is enabled, it is itself enabled, and no tag carried by
 * it or by any folder above it is disabled. Tags are a *veto*, which is what
 * makes them useful: you can kill an orthogonal slice of mocks with one toggle
 * without touching the folders they live in.
 *
 * Kept as pure functions so it can be unit-tested without a browser, and reused
 * by both the panel (to explain *why* a row is inert) and the compiler that
 * feeds the interceptor.
 */

import type { Folder, Mock, Tag, Workspace } from './types.ts';

export type InactiveReason =
  | 'workspace-disabled'
  | 'tab-not-targeted'
  | 'folder-disabled'
  | 'mock-disabled'
  | 'tag-disabled';

export interface Activation {
  active: boolean;
  /** Absent when `active` is true. */
  reason?: InactiveReason;
  /** The disabled folder responsible, when `reason === 'folder-disabled'`. */
  disabledFolderId?: string;
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
 * `ancestors` is the folder chain above the mock, outermost first — exactly what
 * `walkTree` and `findNode` hand back.
 *
 * Reasons are checked from broadest to narrowest so the explanation surfaced in
 * the UI is the most useful one: there is no point telling someone a tag is
 * disabled when the master switch is off.
 */
export function explainMock(
  workspace: Workspace,
  ancestors: readonly Folder[],
  mock: Mock,
  tabId: number,
  tagsById: ReadonlyMap<string, Tag> = indexTags(workspace.tags),
): Activation {
  if (!workspace.enabled) return { active: false, reason: 'workspace-disabled' };
  if (!workspace.targetTabIds.includes(tabId)) {
    return { active: false, reason: 'tab-not-targeted' };
  }

  // Outermost first, so the reported folder is the highest one that is off —
  // the one you actually need to turn back on.
  for (const folder of ancestors) {
    if (!folder.enabled) {
      return { active: false, reason: 'folder-disabled', disabledFolderId: folder.id };
    }
  }

  if (!mock.enabled) return { active: false, reason: 'mock-disabled' };

  // A tag on any folder above vetoes just as hard as one on the mock itself.
  let vetoingTagId: string | undefined;
  for (const folder of ancestors) {
    vetoingTagId = findVetoingTag(folder.tagIds, tagsById);
    if (vetoingTagId !== undefined) break;
  }
  vetoingTagId ??= findVetoingTag(mock.tagIds, tagsById);

  if (vetoingTagId !== undefined) {
    return { active: false, reason: 'tag-disabled', vetoingTagId };
  }

  return { active: true };
}

export function isMockActive(
  workspace: Workspace,
  ancestors: readonly Folder[],
  mock: Mock,
  tabId: number,
  tagsById?: ReadonlyMap<string, Tag>,
): boolean {
  return explainMock(workspace, ancestors, mock, tabId, tagsById).active;
}
