/**
 * The service worker. Single owner of the workspace state.
 *
 * Everything else — the panel, the relays in each tab, and the MCP bridge —
 * reads and mutates through here, so there is exactly one source of truth and
 * one place that broadcasts change.
 *
 * Storage split, on purpose:
 *  - the workspace (the folder/mock tree and tags) goes in `chrome.storage.local`,
 *    because it should survive a browser restart;
 *  - `targetTabIds` goes in `chrome.storage.session`, because a tab id is
 *    meaningless after a restart and silently mocking a recycled id would be a
 *    nasty surprise.
 */

import { PANEL_PORT, compileActiveMocks, migrateWorkspace } from '@network-mock/shared';
import type {
  FromWorker,
  HitRecord,
  PanelHello,
  ToWorker,
  Workspace,
  WorkerBroadcast,
} from '@network-mock/shared';

import { startBridge } from './bridge.ts';

const LOCAL_KEY = 'workspace';
const SESSION_KEY = 'targetTabIds';

/** Hits are debug telemetry, so they live in memory and are capped. */
const HIT_LIMIT = 500;
let hits: HitRecord[] = [];
let hitSeq = 0;

/**
 * Loads and normalises the stored workspace.
 *
 * Everything read from storage goes through `migrateWorkspace`, so a workspace
 * written by an older build (the flat v1 group model) is upgraded on the way in
 * rather than crashing the worker. The upgrade is written back on the next save,
 * which every mutation performs anyway.
 */
async function loadWorkspace(): Promise<Workspace> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(LOCAL_KEY),
    chrome.storage.session.get(SESSION_KEY),
  ]);

  const workspace = migrateWorkspace(local[LOCAL_KEY]);
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

/**
 * Serialises every read-modify-write of `targetTabIds`.
 *
 * Two panels opening at once is not a hypothetical: restoring a browser session
 * reopens several DevTools windows within milliseconds of each other. Without
 * this, both would read the same target list and the second write would drop the
 * first tab — leaving one tab silently unmocked.
 */
let targetQueue: Promise<void> = Promise.resolve();

function queueTargetChange(fn: (current: number[]) => number[]): Promise<void> {
  const run = targetQueue.then(async () => {
    const workspace = await loadWorkspace();
    const next = [...new Set(fn(workspace.targetTabIds))];
    if (next.length === workspace.targetTabIds.length &&
        next.every((id) => workspace.targetTabIds.includes(id))) {
      return;
    }
    workspace.targetTabIds = next;
    await saveWorkspace(workspace);
  });
  targetQueue = run.catch(() => undefined);
  return run;
}

function setTargetTabs(tabIds: number[]): Promise<void> {
  return queueTargetChange(() => tabIds);
}

/** Adds or removes one tab from the target set, leaving the rest alone. */
function targetTab(tabId: number, on: boolean): Promise<void> {
  return queueTargetChange((current) =>
    on ? [...current, tabId] : current.filter((id) => id !== tabId),
  );
}

function recordHit(tabId: number, partial: Omit<HitRecord, 'id' | 'tabId'>): HitRecord {
  const hit: HitRecord = { ...partial, id: `h${++hitSeq}`, tabId };
  hits.push(hit);
  if (hits.length > HIT_LIMIT) hits = hits.slice(-HIT_LIMIT);
  emit({ type: 'hit', hit });
  return hit;
}

// ---------------------------------------------------------------------------
// The DevTools panel's lifetime
// ---------------------------------------------------------------------------

/**
 * A panel targets its own inspected tab for as long as it is open.
 *
 * This is why targeting needs no UI: opening the Network Mock panel on a tab is
 * the act of choosing it. A long-lived port is the only reliable signal — a
 * DevTools window can be closed, or its whole browser window torn down, without
 * the page getting a chance to send a farewell message, but `onDisconnect`
 * always fires.
 *
 * Reference-counted, because two DevTools windows can inspect the same tab (and
 * because a panel reloads during development); the tab stays targeted until the
 * last one goes away.
 */
const panelsByTab = new Map<number, number>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;

  let tabId: number | null = null;

  port.onMessage.addListener((message: PanelHello) => {
    if (message?.type !== 'panel-hello' || typeof message.tabId !== 'number') return;
    if (tabId !== null) return; // one hello per port

    tabId = message.tabId;
    panelsByTab.set(tabId, (panelsByTab.get(tabId) ?? 0) + 1);
    void targetTab(tabId, true);
  });

  port.onDisconnect.addListener(() => {
    if (tabId === null) return;
    const remaining = (panelsByTab.get(tabId) ?? 1) - 1;

    if (remaining > 0) {
      panelsByTab.set(tabId, remaining);
      return;
    }

    panelsByTab.delete(tabId);
    void targetTab(tabId, false);
  });
});

// ---------------------------------------------------------------------------
// Request/response messaging
// ---------------------------------------------------------------------------

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
            // Targeting is session state owned by this worker, never by the
            // panel: a stale workspace read would otherwise untarget the tab.
            const current = await loadWorkspace();
            await saveWorkspace({ ...message.workspace, targetTabIds: current.targetTabIds });
            sendResponse({ type: 'ok' });
            return;
          }

          case 'set-target-tabs': {
            await setTargetTabs(message.tabIds);
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
            // A panel only ever shows its own tab, so it clears only its own
            // rows; the MCP tool omits tabId and clears everything.
            hits = message.tabId === undefined ? [] : hits.filter((h) => h.tabId !== message.tabId);
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
  setTargetTabs,
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
    panelsByTab.delete(tabId);
    hits = hits.filter((hit) => hit.tabId !== tabId);
    await targetTab(tabId, false);
  })();
});
