/**
 * Tool registration.
 *
 * Two principles here:
 *
 *  1. **Parity with the panel.** Anything a human can do in the DevTools panel an
 *     agent can do through these tools, and both go through the same pure
 *     mutation helpers in `@mockman/shared`, so the two can never disagree
 *     about what a "create mock" means.
 *  2. **Descriptions carry the weight.** Other agents lean far harder on tool
 *     descriptions than a human reading a UI does, so each one states what it
 *     affects and calls out the non-obvious semantics (glob anchoring, the tag
 *     veto, tab targeting, first-match-wins ordering).
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  allMocks,
  createFolder,
  createMock,
  createTag,
  deleteNode,
  deleteTag,
  duplicateNode,
  explainMock,
  findFolder,
  findNode,
  indexTags,
  isFolder,
  migrateWorkspace,
  moveNode,
  pathLabel,
  renameNode,
  reorderChildren,
  setEnabled,
  updateFolder,
  updateMock,
  updateTag,
  walkTree,
} from '@mockman/shared';
import type { HitRecord, TreeNode, Workspace } from '@mockman/shared';

import { Bridge } from './bridge.ts';

interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

const METHOD = z.enum(['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const BODY_MATCH = z
  .object({
    mode: z
      .enum(['contains', 'equals', 'regex', 'json-subset'])
      .default('json-subset')
      .describe(
        '"json-subset" is usually what you want: the request body must be JSON containing every ' +
          'key and value given, extra keys ignored — so it survives timestamps and correlation ids.',
      ),
    value: z.string(),
  })
  .describe(
    'Optional extra condition on the OUTGOING request body, for when one url does several things ' +
      'depending on what is posted to it. A request whose body cannot be read (a stream, a Blob, ' +
      'a FormData) never satisfies this, so a mock carrying one is strictly narrower.',
  );

const MATCH = z.object({
  method: METHOD.describe('HTTP method to match, or "*" for any.'),
  urlPattern: z
    .string()
    .describe(
      'For patternKind "glob": * matches any run of characters (including /), ? matches one, ' +
        'and the pattern is anchored to the WHOLE url — so use "*/api/users" not "/api/users". ' +
        'For "regex": an unanchored JavaScript regular expression tested against the whole url.',
    ),
  patternKind: z.enum(['glob', 'regex']).default('glob'),
  body: BODY_MATCH.optional(),
});

const RESPONSE = z.object({
  status: z.number().int().min(100).max(599).default(200),
  statusText: z.string().optional().describe('Omit to derive the standard reason phrase.'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().default('').describe('Response body as text. JSON must be a JSON string.'),
  bodyKind: z.enum(['json', 'text']).default('json'),
  delayMs: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Artificial latency before the response is delivered, for testing loading states.'),
});

/** Tools return text; this keeps every result shaped the same way. */
function result(payload: unknown) {
  return {
    content: [
      { type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}

/** A compact, id-carrying rendering of the tree, for tool output. */
function outline(nodes: readonly TreeNode[]): unknown[] {
  return nodes.map((node) =>
    isFolder(node)
      ? {
          kind: 'folder',
          id: node.id,
          name: node.name,
          enabled: node.enabled,
          tagIds: node.tagIds,
          children: outline(node.children),
        }
      : {
          kind: 'mock',
          id: node.id,
          name: node.name,
          enabled: node.enabled,
          tagIds: node.tagIds,
          method: node.match.method,
          urlPattern: node.match.urlPattern,
          hasBodyMatcher: Boolean(node.match.body?.value),
          status: node.response.status,
          delayMs: node.response.delayMs,
        },
  );
}

export function registerTools(server: McpServer, bridge: Bridge): void {
  /**
   * Reads the live workspace, normalising an older extension's shape on the way.
   *
   * `migrateWorkspace` drops `targetTabIds` by design — it is meant for stored
   * and imported documents, where adopting someone else's tab ids would start
   * mocking an unrelated tab. This is not that: it is a live read from the
   * browser, where those ids are current and authoritative, so they are put
   * back afterwards.
   */
  const getWorkspace = async (): Promise<Workspace> => {
    const live = await bridge.call<Workspace>('getWorkspace');
    const workspace = migrateWorkspace(live);
    workspace.targetTabIds = Array.isArray(live?.targetTabIds) ? live.targetTabIds : [];
    return workspace;
  };
  const putWorkspace = (workspace: Workspace): Promise<void> =>
    bridge.call<void>('setWorkspace', { workspace });

  /** Read-modify-write under the bridge lock, returning a summary for the agent. */
  const mutate = (fn: (workspace: Workspace) => { workspace: Workspace; summary: unknown }) =>
    bridge.exclusive(async () => {
      const current = await getWorkspace();
      const { workspace, summary } = fn(current);
      await putWorkspace(workspace);
      return result(summary);
    });

  /** Fails loudly rather than letting a typo mutate nothing and report success. */
  const requireNode = (workspace: Workspace, nodeId: string) => {
    const located = findNode(workspace.tree, nodeId);
    if (!located) throw new Error(`No such node: ${nodeId}`);
    return located;
  };

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_workspace',
    {
      description:
        'Read the entire mocking workspace: the full folder/mock tree, every tag, the master ' +
        'enable switch, and which browser tabs are currently targeted. Start here to discover ' +
        'the ids needed by the other tools. Folders nest arbitrarily deep; mocks are leaves.',
      inputSchema: z.object({
        full: z
          .boolean()
          .default(false)
          .describe('true returns every field including response bodies; false a compact outline.'),
      }),
    },
    async ({ full }) => {
      const workspace = await getWorkspace();
      return result(
        full
          ? workspace
          : {
              enabled: workspace.enabled,
              targetTabIds: workspace.targetTabIds,
              tags: workspace.tags,
              tree: outline(workspace.tree),
            },
      );
    },
  );

  server.registerTool(
    'get_status',
    {
      description:
        'A compact summary: whether the extension is connected, the master switch, targeted tab ' +
        'ids, and for each mock its full breadcrumb path plus whether it is currently ACTIVE or ' +
        'why it is not. Use this to answer "why is my mock not firing?". Note that opening the ' +
        'DevTools panel on a tab is what targets it, so with no panel open nothing is mocked.',
      inputSchema: z.object({
        tabId: z
          .number()
          .int()
          .optional()
          .describe('Evaluate activation against this tab. Defaults to the first targeted tab.'),
      }),
    },
    async ({ tabId }) => {
      const workspace = await getWorkspace();
      const target = tabId ?? workspace.targetTabIds[0];
      const tagsById = indexTags(workspace.tags);

      return result({
        bridgeConnected: bridge.connected,
        masterEnabled: workspace.enabled,
        targetTabIds: workspace.targetTabIds,
        evaluatedForTabId: target ?? null,
        tags: workspace.tags.map((t) => ({ id: t.id, name: t.name, enabled: t.enabled })),
        mocks: allMocks(workspace.tree).map((located) => {
          const activation =
            target === undefined
              ? { active: false, reason: 'tab-not-targeted' as const }
              : explainMock(workspace, located.ancestors, located.node, target, tagsById);
          return {
            id: located.node.id,
            path: pathLabel(located),
            enabled: located.node.enabled,
            method: located.node.match.method,
            urlPattern: located.node.match.urlPattern,
            status: located.node.response.status,
            active: activation.active,
            inactiveReason: activation.reason ?? null,
          };
        }),
      });
    },
  );

  server.registerTool(
    'find_nodes',
    {
      description:
        'Search the tree by name, url pattern or tag and return the matching ids with their ' +
        'breadcrumb paths. Cheaper than get_workspace when you already know roughly what you ' +
        'are looking for.',
      inputSchema: z.object({
        query: z.string().describe('Case-insensitive substring, matched against name and url pattern.'),
        kind: z.enum(['any', 'folder', 'mock']).default('any'),
      }),
    },
    async ({ query, kind }) => {
      const workspace = await getWorkspace();
      const needle = query.toLowerCase();

      const hits = [...walkTree(workspace.tree)]
        .filter((located) => {
          const node = located.node;
          if (kind !== 'any' && node.kind !== kind) return false;
          if (node.name.toLowerCase().includes(needle)) return true;
          return !isFolder(node) && node.match.urlPattern.toLowerCase().includes(needle);
        })
        .map((located) => ({
          id: located.node.id,
          kind: located.node.kind,
          path: pathLabel(located),
          parentId: located.parentId,
        }));

      return result({ matches: hits.length, hits });
    },
  );

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_tabs',
    {
      description:
        'List the browser tabs the extension can see, with their ids, titles and urls. ' +
        'Use this to find the tabId to pass to set_target_tabs.',
      inputSchema: z.object({}),
    },
    async () => result(await bridge.call<TabInfo[]>('listTabs')),
  );

  server.registerTool(
    'set_target_tabs',
    {
      description:
        'Replace the set of tabs that get mocked. Mocking applies ONLY to these tabs; every ' +
        'other tab reaches the real network untouched. Note the DevTools panel manages this ' +
        'itself — it targets its own tab while open and untargets it on close — so setting this ' +
        'by hand is for driving a tab that has no panel open on it. Pass an empty array to stop ' +
        'mocking everywhere without disturbing the mocks themselves.',
      inputSchema: z.object({
        tabIds: z.array(z.number().int()).describe('Tab ids from list_tabs.'),
      }),
    },
    async ({ tabIds }) => {
      await bridge.call<void>('setTargetTabs', { tabIds });
      return result({ targetTabIds: tabIds });
    },
  );

  // -------------------------------------------------------------------------
  // Enable / disable
  // -------------------------------------------------------------------------

  server.registerTool(
    'set_enabled',
    {
      description:
        'Enable or disable the master switch, a folder, a single mock, or a tag. These are ' +
        'independent: a mock only fires when the master switch, EVERY folder above it and the ' +
        'mock itself are all enabled AND no tag attached to it or to any of those folders is ' +
        'disabled. Disabling a tag therefore vetoes everything carrying it, which is the ' +
        'cheapest way to switch off a cross-cutting slice of mocks.',
      inputSchema: z.object({
        kind: z.enum(['workspace', 'folder', 'mock', 'tag']),
        id: z.string().nullable().default(null).describe('Required for all kinds except "workspace".'),
        enabled: z.boolean(),
      }),
    },
    async ({ kind, id, enabled }) =>
      mutate((workspace) => {
        if (kind === 'folder' || kind === 'mock') {
          if (!id) throw new Error(`set_enabled with kind "${kind}" requires an id`);
          requireNode(workspace, id);
        }
        return { workspace: setEnabled(workspace, kind, id, enabled), summary: { kind, id, enabled } };
      }),
  );

  // -------------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_folder',
    {
      description:
        'Create a folder to hold mocks and other folders. Folders nest arbitrarily deep and can ' +
        'be enabled or disabled as a unit, which deactivates everything inside them.',
      inputSchema: z.object({
        parentId: z
          .string()
          .nullable()
          .default(null)
          .describe('The folder to create this one inside. null puts it at the top level.'),
        name: z.string(),
        tagIds: z.array(z.string()).default([]),
        enabled: z.boolean().default(true),
      }),
    },
    async ({ parentId, ...input }) =>
      mutate((workspace) => {
        const { workspace: next, folder } = createFolder(workspace, parentId, input);
        return { workspace: next, summary: { created: 'folder', id: folder.id, name: folder.name } };
      }),
  );

  server.registerTool(
    'update_folder',
    {
      description:
        'Rename a folder, change its enabled flag, change which tags it carries, or expand and ' +
        'collapse it in the panel. To move it, use move_node.',
      inputSchema: z.object({
        folderId: z.string(),
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        tagIds: z.array(z.string()).optional(),
        expanded: z.boolean().optional(),
      }),
    },
    async ({ folderId, ...patch }) =>
      mutate((workspace) => {
        if (!findFolder(workspace.tree, folderId)) throw new Error(`No such folder: ${folderId}`);
        return {
          workspace: updateFolder(workspace, folderId, patch),
          summary: { updated: 'folder', id: folderId, patch },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // Mocks
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_mock',
    {
      description:
        'Add a mock. Once active, matching requests made by the targeted tab are answered from ' +
        'this definition and never reach the network — which also means they will not appear in ' +
        'the DevTools Network panel. Use get_hit_log to confirm it fired. Matching is ' +
        'first-match-wins in depth-first tree order, so put narrow mocks before catch-alls.',
      inputSchema: z.object({
        parentId: z
          .string()
          .nullable()
          .default(null)
          .describe('The folder to put it in, from get_workspace or create_folder. null = top level.'),
        name: z.string(),
        label: z.string().optional().describe('Optional short badge shown in the panel and hit log.'),
        match: MATCH,
        response: RESPONSE,
        tagIds: z.array(z.string()).default([]),
        enabled: z.boolean().default(true),
      }),
    },
    async ({ parentId, ...input }) =>
      mutate((workspace) => {
        const { workspace: next, mock } = createMock(workspace, parentId, input);
        return { workspace: next, summary: { created: 'mock', id: mock.id, name: mock.name } };
      }),
  );

  server.registerTool(
    'update_mock',
    {
      description:
        'Change any part of an existing mock. Only the fields you supply are altered; note that ' +
        'match and response are replaced wholesale, not deep-merged — read the mock first with ' +
        'get_workspace({full:true}) if you mean to change one field of either.',
      inputSchema: z.object({
        mockId: z.string(),
        name: z.string().optional(),
        label: z.string().optional(),
        enabled: z.boolean().optional(),
        tagIds: z.array(z.string()).optional(),
        match: MATCH.optional(),
        response: RESPONSE.optional(),
      }),
    },
    async ({ mockId, ...patch }) =>
      mutate((workspace) => {
        const located = requireNode(workspace, mockId);
        if (isFolder(located.node)) throw new Error(`${mockId} is a folder, not a mock`);
        return {
          workspace: updateMock(workspace, mockId, patch),
          summary: { updated: 'mock', id: mockId, patch },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // Tree structure
  // -------------------------------------------------------------------------

  server.registerTool(
    'delete_node',
    {
      description:
        'Delete a folder or a mock. Deleting a folder also deletes everything inside it, however ' +
        'deep. This cannot be undone.',
      inputSchema: z.object({ nodeId: z.string() }),
    },
    async ({ nodeId }) =>
      mutate((workspace) => {
        const located = requireNode(workspace, nodeId);
        return {
          workspace: deleteNode(workspace, nodeId),
          summary: { deleted: located.node.kind, id: nodeId, path: pathLabel(located) },
        };
      }),
  );

  server.registerTool(
    'move_node',
    {
      description:
        'Move a folder or mock to a different parent, and optionally to a specific position among ' +
        'its new siblings. A folder cannot be moved inside itself or its own descendants.',
      inputSchema: z.object({
        nodeId: z.string(),
        parentId: z.string().nullable().default(null).describe('Destination folder; null = top level.'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Position among the destination’s children. Omit to append.'),
      }),
    },
    async ({ nodeId, parentId, index }) =>
      mutate((workspace) => {
        requireNode(workspace, nodeId);
        const next = moveNode(workspace, nodeId, parentId, index);
        if (next === workspace) {
          throw new Error('That move would put a folder inside itself, so nothing was changed.');
        }
        return { workspace: next, summary: { moved: nodeId, parentId, index: index ?? null } };
      }),
  );

  server.registerTool(
    'reorder_children',
    {
      description:
        'Set the evaluation order of one folder’s children (or of the top level). Matching is ' +
        'first-match-wins in depth-first order, so this is how you make a narrow mock win over a ' +
        'catch-all that would otherwise swallow it.',
      inputSchema: z.object({
        parentId: z.string().nullable().default(null).describe('The folder whose children to order; null = top level.'),
        orderedIds: z.array(z.string()).describe('The child ids, in the desired order.'),
      }),
    },
    async ({ parentId, orderedIds }) =>
      mutate((workspace) => ({
        workspace: reorderChildren(workspace, parentId, orderedIds),
        summary: { reordered: parentId ?? 'root', orderedIds },
      })),
  );

  server.registerTool(
    'duplicate_node',
    {
      description:
        'Copy a folder (with everything inside it) or a mock, as a sibling of the original. Every ' +
        'copied node gets a fresh id. Useful for making a variant — a 500 next to the 200.',
      inputSchema: z.object({ nodeId: z.string() }),
    },
    async ({ nodeId }) =>
      mutate((workspace) => {
        requireNode(workspace, nodeId);
        const { workspace: next, node } = duplicateNode(workspace, nodeId);
        return { workspace: next, summary: { duplicated: nodeId, newId: node?.id ?? null } };
      }),
  );

  server.registerTool(
    'rename_node',
    {
      description: 'Rename a folder or a mock. A shortcut for update_folder/update_mock.',
      inputSchema: z.object({ nodeId: z.string(), name: z.string() }),
    },
    async ({ nodeId, name }) =>
      mutate((workspace) => {
        requireNode(workspace, nodeId);
        return { workspace: renameNode(workspace, nodeId, name), summary: { renamed: nodeId, name } };
      }),
  );

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_tag',
    {
      description:
        'Create a tag. Tags label mocks and folders across the whole workspace and can be toggled ' +
        'independently; disabling a tag deactivates everything carrying it, and everything inside ' +
        'a folder carrying it. The panel’s search box matches tag names, so a distinctive name ' +
        'doubles as a filter.',
      inputSchema: z.object({
        name: z.string(),
        color: z.string().optional().describe('Any CSS colour. Auto-assigned if omitted.'),
        enabled: z.boolean().default(true),
      }),
    },
    async (input) =>
      mutate((workspace) => {
        const { workspace: next, tag } = createTag(workspace, input);
        return { workspace: next, summary: { created: 'tag', id: tag.id, name: tag.name } };
      }),
  );

  server.registerTool(
    'update_tag',
    {
      description: 'Rename a tag, recolour it, or change its enabled flag.',
      inputSchema: z.object({
        tagId: z.string(),
        name: z.string().optional(),
        color: z.string().optional(),
        enabled: z.boolean().optional(),
      }),
    },
    async ({ tagId, ...patch }) =>
      mutate((workspace) => ({
        workspace: updateTag(workspace, tagId, patch),
        summary: { updated: 'tag', id: tagId, patch },
      })),
  );

  server.registerTool(
    'delete_tag',
    {
      description:
        'Delete a tag and remove it from every folder and mock that referenced it. The mocks ' +
        'themselves are kept.',
      inputSchema: z.object({ tagId: z.string() }),
    },
    async ({ tagId }) =>
      mutate((workspace) => ({
        workspace: deleteTag(workspace, tagId),
        summary: { deleted: 'tag', id: tagId },
      })),
  );

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_hit_log',
    {
      description:
        'Recent requests the extension observed on targeted tabs, each marked "mocked" (with the ' +
        'breadcrumb path of the mock responsible) or "passed" (reached the real network). This is ' +
        'the only place mocked requests are visible, because they never hit the network and so ' +
        'never appear in the DevTools Network panel.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    },
    async ({ tabId, limit }) =>
      result(await bridge.call<HitRecord[]>('getHits', { tabId, limit })),
  );

  server.registerTool(
    'clear_hit_log',
    { description: 'Discard the recorded hit log.', inputSchema: z.object({}) },
    async () => {
      await bridge.call<void>('clearHits');
      return result({ cleared: true });
    },
  );

  // -------------------------------------------------------------------------
  // Import / export
  // -------------------------------------------------------------------------

  server.registerTool(
    'export_workspace',
    {
      description:
        'Serialise the whole workspace to JSON, suitable for committing to a repository or ' +
        'sharing. Tab targeting is deliberately excluded, since tab ids are only meaningful in ' +
        'the browser session that created them.',
      inputSchema: z.object({}),
    },
    async () => {
      const workspace = await getWorkspace();
      return result(JSON.stringify({ ...workspace, targetTabIds: [] }, null, 2));
    },
  );

  server.registerTool(
    'import_workspace',
    {
      description:
        'Load a workspace previously produced by export_workspace. Older formats are upgraded ' +
        'automatically. By default this REPLACES everything; set merge:true to append its tree ' +
        'and tags to what is already there instead. Tab targeting is left untouched either way.',
      inputSchema: z.object({
        json: z.string().describe('The JSON document from export_workspace.'),
        merge: z.boolean().default(false),
      }),
    },
    async ({ json, merge }) =>
      bridge.exclusive(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch (error) {
          throw new Error(`That is not valid JSON: ${error instanceof Error ? error.message : error}`);
        }

        // Normalise before inspecting: this is also what upgrades a v1 export.
        const incoming = migrateWorkspace(parsed);
        if (incoming.tree.length === 0 && incoming.tags.length === 0) {
          throw new Error('That document contains no mocks, folders or tags. Nothing was imported.');
        }

        const current = await getWorkspace();
        const next: Workspace = merge
          ? {
              ...current,
              tree: [...current.tree, ...incoming.tree].map((node, index) => ({ ...node, order: index })),
              tags: [...current.tags, ...incoming.tags],
            }
          : { ...incoming, targetTabIds: current.targetTabIds };

        await putWorkspace(next);
        const counts = { folders: 0, mocks: 0 };
        for (const { node } of walkTree(next.tree)) {
          if (isFolder(node)) counts.folders++;
          else counts.mocks++;
        }

        return result({ imported: true, mode: merge ? 'merge' : 'replace', ...counts, tags: next.tags.length });
      }),
  );
}
