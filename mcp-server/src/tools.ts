/**
 * Tool registration.
 *
 * Two principles here:
 *
 *  1. **Parity with the panel.** Anything a human can do in the DevTools panel an
 *     agent can do through these tools, and both go through the same pure
 *     mutation helpers in `@network-mock/shared`, so the two can never disagree
 *     about what a "create mock" means.
 *  2. **Descriptions carry the weight.** Other agents lean far harder on tool
 *     descriptions than a human reading a UI does, so each one states what it
 *     affects and calls out the non-obvious semantics (glob anchoring, the tag
 *     veto, tab targeting).
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  createGroup,
  createMock,
  createTag,
  deleteGroup,
  deleteMock,
  deleteTag,
  emptyWorkspace,
  explainMock,
  indexTags,
  reorderGroups,
  setEnabled,
  updateGroup,
  updateMock,
  updateTag,
} from '@network-mock/shared';
import type { HitRecord, Workspace } from '@network-mock/shared';

import { Bridge } from './bridge.ts';

interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

const METHOD = z.enum(['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

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
});

const RESPONSE = z.object({
  status: z.number().int().min(100).max(599).default(200),
  statusText: z.string().optional().describe('Omit to derive the standard reason phrase.'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().default('').describe('Response body as text. JSON must be a JSON string.'),
  bodyKind: z.enum(['json', 'text']).default('json'),
});

/** Tools return text; this keeps every result shaped the same way. */
function result(payload: unknown) {
  return {
    content: [
      { type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}

export function registerTools(server: McpServer, bridge: Bridge): void {
  const getWorkspace = (): Promise<Workspace> => bridge.call<Workspace>('getWorkspace');
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

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_workspace',
    {
      description:
        'Read the entire mocking workspace: every group, mock and tag, the master ' +
        'enable switch, and which browser tabs are currently targeted. Start here to ' +
        'discover ids needed by the other tools.',
      inputSchema: z.object({}),
    },
    async () => result(await getWorkspace()),
  );

  server.registerTool(
    'get_status',
    {
      description:
        'A compact summary: whether the extension is connected, the master switch, ' +
        'targeted tab ids, and for each mock whether it is currently ACTIVE or why it ' +
        'is not. Use this to answer "why is my mock not firing?".',
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
        groups: workspace.groups.map((group) => ({
          id: group.id,
          name: group.name,
          enabled: group.enabled,
          tagIds: group.tagIds,
          mocks: group.mocks.map((mock) => {
            const activation =
              target === undefined
                ? { active: false, reason: 'tab-not-targeted' as const }
                : explainMock(workspace, group, mock, target, tagsById);
            return {
              id: mock.id,
              name: mock.name,
              enabled: mock.enabled,
              method: mock.match.method,
              urlPattern: mock.match.urlPattern,
              status: mock.response.status,
              active: activation.active,
              inactiveReason: activation.reason ?? null,
            };
          }),
        })),
      });
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
        'Replace the set of tabs that get mocked. Mocking applies ONLY to these tabs; ' +
        'every other tab reaches the real network untouched. Pass an empty array to ' +
        'stop mocking everywhere without disturbing the mocks themselves.',
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
        'Enable or disable the master switch, a group, a single mock, or a tag. ' +
        'These are independent: a mock only fires when the master switch, its group ' +
        'and the mock itself are all enabled AND no tag attached to it or its group ' +
        'is disabled. Disabling a tag therefore vetoes everything carrying it, which ' +
        'is the cheapest way to switch off a cross-cutting slice of mocks.',
      inputSchema: z.object({
        kind: z.enum(['workspace', 'group', 'mock', 'tag']),
        id: z.string().nullable().default(null).describe('Required for all kinds except "workspace".'),
        enabled: z.boolean(),
      }),
    },
    async ({ kind, id, enabled }) =>
      mutate((workspace) => ({
        workspace: setEnabled(workspace, kind, id, enabled),
        summary: { kind, id, enabled },
      })),
  );

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_group',
    {
      description: 'Create a group to hold mocks. Groups can be enabled or disabled as a unit.',
      inputSchema: z.object({
        name: z.string(),
        tagIds: z.array(z.string()).default([]),
        enabled: z.boolean().default(true),
      }),
    },
    async (input) =>
      mutate((workspace) => {
        const { workspace: next, group } = createGroup(workspace, input);
        return { workspace: next, summary: { created: 'group', id: group.id, name: group.name } };
      }),
  );

  server.registerTool(
    'update_group',
    {
      description: 'Rename a group, change its enabled flag, or change which tags it carries.',
      inputSchema: z.object({
        groupId: z.string(),
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        tagIds: z.array(z.string()).optional(),
      }),
    },
    async ({ groupId, ...patch }) =>
      mutate((workspace) => ({
        workspace: updateGroup(workspace, groupId, patch),
        summary: { updated: 'group', id: groupId, patch },
      })),
  );

  server.registerTool(
    'delete_group',
    {
      description: 'Delete a group and every mock inside it. This cannot be undone.',
      inputSchema: z.object({ groupId: z.string() }),
    },
    async ({ groupId }) =>
      mutate((workspace) => ({
        workspace: deleteGroup(workspace, groupId),
        summary: { deleted: 'group', id: groupId },
      })),
  );

  server.registerTool(
    'reorder_groups',
    {
      description:
        'Set group evaluation order. Matching is first-match-wins across groups in this ' +
        'order, then by mock order within a group, so put narrow mocks before catch-alls.',
      inputSchema: z.object({ groupIds: z.array(z.string()).describe('All group ids, in the desired order.') }),
    },
    async ({ groupIds }) =>
      mutate((workspace) => ({
        workspace: reorderGroups(workspace, groupIds),
        summary: { reordered: groupIds },
      })),
  );

  // -------------------------------------------------------------------------
  // Mocks
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_mock',
    {
      description:
        'Add a mock to a group. Once active, matching requests made by the targeted ' +
        'tab are answered from this definition and never reach the network — which also ' +
        'means they will not appear in the DevTools Network panel. Use get_hit_log to ' +
        'confirm it fired.',
      inputSchema: z.object({
        groupId: z.string().describe('From get_workspace or create_group.'),
        name: z.string(),
        match: MATCH,
        response: RESPONSE,
        tagIds: z.array(z.string()).default([]),
        enabled: z.boolean().default(true),
      }),
    },
    async ({ groupId, ...input }) =>
      mutate((workspace) => {
        const { workspace: next, mock } = createMock(workspace, groupId, input);
        return { workspace: next, summary: { created: 'mock', id: mock.id, name: mock.name } };
      }),
  );

  server.registerTool(
    'update_mock',
    {
      description:
        'Change any part of an existing mock. Only the fields you supply are altered; ' +
        'note that match and response are replaced wholesale, not deep-merged.',
      inputSchema: z.object({
        mockId: z.string(),
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        tagIds: z.array(z.string()).optional(),
        match: MATCH.optional(),
        response: RESPONSE.optional(),
      }),
    },
    async ({ mockId, ...patch }) =>
      mutate((workspace) => ({
        workspace: updateMock(workspace, mockId, patch),
        summary: { updated: 'mock', id: mockId, patch },
      })),
  );

  server.registerTool(
    'delete_mock',
    {
      description: 'Delete a single mock. This cannot be undone.',
      inputSchema: z.object({ mockId: z.string() }),
    },
    async ({ mockId }) =>
      mutate((workspace) => ({
        workspace: deleteMock(workspace, mockId),
        summary: { deleted: 'mock', id: mockId },
      })),
  );

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_tag',
    {
      description:
        'Create a tag. Tags label mocks and groups across the whole workspace and can be ' +
        'toggled independently; disabling a tag deactivates everything carrying it.',
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
        'Delete a tag and remove it from every group and mock that referenced it. The ' +
        'mocks themselves are kept.',
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
        'Recent requests the extension observed on targeted tabs, each marked "mocked" ' +
        '(with the mock responsible) or "passed" (reached the real network). This is the ' +
        'only place mocked requests are visible, because they never hit the network and ' +
        'so never appear in the DevTools Network panel.',
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
        'Serialise the whole workspace to JSON, suitable for committing to a repository ' +
        'or sharing. Tab targeting is deliberately excluded, since tab ids are only ' +
        'meaningful in the browser session that created them.',
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
        'Load a workspace previously produced by export_workspace. By default this ' +
        'REPLACES everything; set merge:true to append its groups and tags to what is ' +
        'already there instead. Tab targeting is left untouched either way.',
      inputSchema: z.object({
        json: z.string().describe('The JSON document from export_workspace.'),
        merge: z.boolean().default(false),
      }),
    },
    async ({ json, merge }) =>
      bridge.exclusive(async () => {
        let incoming: Workspace;
        try {
          incoming = JSON.parse(json) as Workspace;
        } catch (error) {
          throw new Error(`That is not valid JSON: ${error instanceof Error ? error.message : error}`);
        }
        if (!Array.isArray(incoming?.groups) || !Array.isArray(incoming?.tags)) {
          throw new Error('Expected an object with "groups" and "tags" arrays.');
        }

        const current = await getWorkspace();
        const next: Workspace = merge
          ? {
              ...current,
              groups: [...current.groups, ...incoming.groups],
              tags: [...current.tags, ...incoming.tags],
            }
          : {
              ...emptyWorkspace(),
              ...incoming,
              // Never import someone else's tab ids.
              targetTabIds: current.targetTabIds,
            };

        await putWorkspace(next);
        return result({
          imported: true,
          mode: merge ? 'merge' : 'replace',
          groups: next.groups.length,
          tags: next.tags.length,
        });
      }),
  );
}
