/**
 * Typed messaging between the panel and the service worker, plus the React hooks
 * that keep the UI in sync.
 *
 * The panel never holds authoritative state: it reads the workspace from the
 * worker and re-reads on every broadcast. That is what makes a mock created over
 * MCP show up here immediately, with no polling.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FromWorker, HitRecord, ToWorker, Workspace, WorkerBroadcast } from '@network-mock/shared';

/** The tab this DevTools window is inspecting. */
export const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

export async function send(message: ToWorker): Promise<FromWorker> {
  try {
    return (await chrome.runtime.sendMessage(message)) as FromWorker;
  } catch (error) {
    return { type: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function getWorkspace(): Promise<Workspace | null> {
  const reply = await send({ type: 'get-workspace' });
  return reply.type === 'workspace' ? reply.workspace : null;
}

export async function putWorkspace(workspace: Workspace): Promise<void> {
  await send({ type: 'set-workspace', workspace });
}

/**
 * The workspace plus a setter that writes through to the worker.
 *
 * `update` takes a function so callers compose the pure mutation helpers from
 * `@network-mock/shared` without worrying about staleness.
 */
export function useWorkspace(): {
  workspace: Workspace | null;
  update: (fn: (current: Workspace) => Workspace) => Promise<void>;
} {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  const reload = useCallback(async () => {
    setWorkspace(await getWorkspace());
  }, []);

  useEffect(() => {
    void reload();

    const listener = (message: WorkerBroadcast): void => {
      if (message?.type === 'workspace-changed') setWorkspace(message.workspace);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [reload]);

  const update = useCallback(
    async (fn: (current: Workspace) => Workspace) => {
      const current = await getWorkspace();
      if (!current) return;
      const next = fn(current);
      setWorkspace(next); // optimistic; the broadcast will confirm
      await putWorkspace(next);
    },
    [],
  );

  return { workspace, update };
}

/** Live hit log, seeded from the worker's buffer then appended to via broadcast. */
export function useHits(limit = 200): { hits: HitRecord[]; clear: () => Promise<void> } {
  const [hits, setHits] = useState<HitRecord[]>([]);

  useEffect(() => {
    void (async () => {
      const reply = await send({ type: 'get-hits', limit });
      if (reply.type === 'hits') setHits(reply.hits);
    })();

    const listener = (message: WorkerBroadcast): void => {
      if (message?.type === 'hit') {
        setHits((previous) => [...previous, message.hit].slice(-limit));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [limit]);

  const clear = useCallback(async () => {
    await send({ type: 'clear-hits' });
    setHits([]);
  }, []);

  return { hits, clear };
}

export interface TabOption {
  id: number;
  title: string;
  url: string;
}

/** Every tab that could be targeted, for the picker. */
export function useTabs(): TabOption[] {
  const [tabs, setTabs] = useState<TabOption[]>([]);

  useEffect(() => {
    void (async () => {
      const all = await chrome.tabs.query({});
      setTabs(
        all
          .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
          .map((tab) => ({ id: tab.id, title: tab.title ?? '(untitled)', url: tab.url ?? '' })),
      );
    })();
  }, []);

  return tabs;
}
