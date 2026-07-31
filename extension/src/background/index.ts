/**
 * The service worker. Single owner of the workspace state.
 *
 * Everything else — the panel, the relays in each tab, and (later) the MCP
 * bridge — reads and mutates through here, so there is exactly one source of
 * truth and one place that broadcasts change.
 *
 * Storage split, on purpose:
 *  - the workspace (groups/mocks/tags) goes in `chrome.storage.local`, because it
 *    should survive a browser restart;
 *  - `targetTabIds` goes in `chrome.storage.session`, because a tab id is
 *    meaningless after a restart and silently mocking a recycled id would be a
 *    nasty surprise.
 */

import { compileActiveMocks, emptyWorkspace } from '@network-mock/shared';
import type { FromWorker, HitRecord, ToWorker, Workspace, WorkerBroadcast } from '@network-mock/shared';

import { startBridge } from './bridge.ts';

const LOCAL_KEY = 'workspace';
const SESSION_KEY = 'targetTabIds';

/** Hits are debug telemetry, so they live in memory and are capped. */
const HIT_LIMIT = 500;
let hits: HitRecord[] = [];
let hitSeq = 0;

async function loadWorkspace(): Promise<Workspace> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(LOCAL_KEY),
    chrome.storage.session.get(SESSION_KEY),
  ]);

  const stored = local[LOCAL_KEY] as Workspace | undefined;
  const workspace = stored ?? emptyWorkspace();
  workspace.targetTabIds = (session[SESSION_KEY] as number[] | undefined) ?? [];
  return workspace;
}

async function saveWorkspace(workspace: Workspace): Promise<void> {
  const { targetTabIds, ...persistent } = workspace;
  await Promise.all([
    chrome.storage.local.set({ [LOCAL_KEY]: { ...persistent, targetTabIds: [] } }),
    chrome.storage.session.set({ [SESSION_KEY]: targetTabIds }),
  ]);
  await broadcastWorkspaceChanged(workspace);
}

/**
 * Tells the panel and every affected tab that state moved.
 *
 * `chrome.runtime.sendMessage` rejects when nothing is listening (a very common
 * case — the panel is usually closed), and `chrome.tabs.sendMessage` rejects for
 * tabs with no content script, such as `chrome://` pages. Neither is an error
 * worth surfacing.
 */
async function broadcastWorkspaceChanged(workspace: Workspace): Promise<void> {
  const message: WorkerBroadcast = { type: 'workspace-changed', workspace };

  chrome.runtime.sendMessage(message).catch(() => {});

  // Every tab is notified, not just the targeted ones: a tab that has just been
  // *un*targeted also needs to hear about it so it can go inert.
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

function emit(message: WorkerBroadcast): void {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function recordHit(tabId: number, partial: Omit<HitRecord, 'id' | 'tabId'>): HitRecord {
  const hit: HitRecord = { ...partial, id: `h${++hitSeq}`, tabId };
  hits.push(hit);
  if (hits.length > HIT_LIMIT) hits = hits.slice(-HIT_LIMIT);
  emit({ type: 'hit', hit });
  return hit;
}

chrome.runtime.onMessage.addListener(
  (message: ToWorker, sender, sendResponse: (response: FromWorker) => void) => {
    void (async () => {
      try {
        switch (message.type) {
          case 'get-config': {
            const tabId = sender.tab?.id;
            if (tabId === undefined) {
              sendResponse({ type: 'config', config: { active: false, mocks: [] } });
              return;
            }
            const workspace = await loadWorkspace();
            const active = workspace.enabled && workspace.targetTabIds.includes(tabId);
            sendResponse({
              type: 'config',
              config: { active, mocks: active ? compileActiveMocks(workspace, tabId) : [] },
            });
            return;
          }

          case 'report-hit': {
            const tabId = sender.tab?.id;
            if (tabId !== undefined) recordHit(tabId, message.hit);
            sendResponse({ type: 'ok' });
            return;
          }

          case 'get-workspace': {
            sendResponse({ type: 'workspace', workspace: await loadWorkspace() });
            return;
          }

          case 'set-workspace': {
            await saveWorkspace(message.workspace);
            sendResponse({ type: 'ok' });
            return;
          }

          case 'set-target-tabs': {
            const workspace = await loadWorkspace();
            workspace.targetTabIds = [...new Set(message.tabIds)];
            await saveWorkspace(workspace);
            sendResponse({ type: 'ok' });
            return;
          }

          case 'get-hits': {
            const filtered =
              message.tabId === undefined ? hits : hits.filter((h) => h.tabId === message.tabId);
            const limit = message.limit ?? HIT_LIMIT;
            sendResponse({ type: 'hits', hits: filtered.slice(-limit) });
            return;
          }

          case 'clear-hits': {
            hits = [];
            sendResponse({ type: 'ok' });
            return;
          }

          default: {
            const exhaustive: never = message;
            sendResponse({ type: 'error', message: `Unknown message: ${JSON.stringify(exhaustive)}` });
          }
        }
      } catch (error) {
        sendResponse({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();

    // Keeps the message channel open for the async work above.
    return true;
  },
);

/**
 * Dial out to the MCP server.
 *
 * Deliberately last, and deliberately non-blocking: if no server is running the
 * extension is fully functional on its own and simply keeps retrying.
 */
startBridge({
  loadWorkspace,
  saveWorkspace,
  setTargetTabs: async (tabIds) => {
    const workspace = await loadWorkspace();
    workspace.targetTabIds = [...new Set(tabIds)];
    await saveWorkspace(workspace);
  },
  getHits: (tabId, limit) => {
    const filtered = tabId === undefined ? hits : hits.filter((h) => h.tabId === tabId);
    return filtered.slice(-(limit ?? HIT_LIMIT));
  },
  clearHits: () => {
    hits = [];
  },
  onStatusChange: (connected) => emit({ type: 'bridge-status', connected }),
});

/** A closed tab must stop being a target, or its id could later be recycled. */
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const workspace = await loadWorkspace();
    if (!workspace.targetTabIds.includes(tabId)) return;
    workspace.targetTabIds = workspace.targetTabIds.filter((id) => id !== tabId);
    await saveWorkspace(workspace);
  })();
});
