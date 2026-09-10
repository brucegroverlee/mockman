/**
 * Typed messaging between the panel and the service worker, plus the React hooks
 * that keep the UI in sync.
 *
 * The panel never holds authoritative state: it reads the workspace from the
 * worker and re-reads on every broadcast. That is what makes a mock created over
 * MCP show up here immediately, with no polling.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PANEL_PORT } from '@network-mock/shared';
import type {
  FromWorker,
  HitRecord,
  PanelHello,
  ToWorker,
  Workspace,
  WorkerBroadcast,
} from '@network-mock/shared';

/** The tab this DevTools window is inspecting. Everything here is scoped to it. */
export const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

export type Update = (fn: (current: Workspace) => Workspace) => Promise<void>;

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
 * Holds the inspected tab in the worker's target set for as long as this panel
 * is open, so mocking needs no tab picker at all.
 *
 * The port is what carries the lifetime; see the `onConnect` handler in the
 * service worker. Reconnecting on disconnect matters because MV3 tears the
 * worker down when idle, and an evicted worker takes the port with it.
 */
export function useTabTargeting(): void {
  useEffect(() => {
    let closed = false;
    let port: chrome.runtime.Port | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const open = (): void => {
      if (closed) return;
      try {
        port = chrome.runtime.connect({ name: PANEL_PORT });
      } catch {
        // The extension is reloading (constant during development). Try again.
        retry = setTimeout(open, 1000);
        return;
      }

      const hello: PanelHello = { type: 'panel-hello', tabId: inspectedTabId };
      port.postMessage(hello);
      port.onDisconnect.addListener(() => {
        port = null;
        if (!closed) retry = setTimeout(open, 1000);
      });
    };

    open();

    return () => {
      closed = true;
      clearTimeout(retry);
      port?.disconnect();
    };
  }, []);
}

/**
 * The workspace plus a setter that writes through to the worker.
 *
 * `update` takes a function so callers compose the pure mutation helpers from
 * `@network-mock/shared` without worrying about staleness.
 */
export function useWorkspace(): { workspace: Workspace | null; update: Update } {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    void (async () => setWorkspace(await getWorkspace()))();

    const listener = (message: WorkerBroadcast): void => {
      if (message?.type === 'workspace-changed') setWorkspace(message.workspace);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // Writes are serialised. Each update re-reads the authoritative workspace from
  // the worker, so two overlapping edits (typing quickly, or clicking while a
  // save is in flight) would otherwise both read the same state and the second
  // write would silently discard the first.
  const chain = useRef<Promise<void>>(Promise.resolve());

  const update = useCallback((fn: (current: Workspace) => Workspace): Promise<void> => {
    const run = chain.current.then(async () => {
      const current = await getWorkspace();
      if (!current) return;
      const next = fn(current);
      if (next === current) return;
      setWorkspace(next); // optimistic; the broadcast confirms
      await putWorkspace(next);
    });
    chain.current = run.catch(() => undefined);
    return run;
  }, []);

  return { workspace, update };
}

/**
 * Every request the interceptor saw on the inspected tab, mocked or passed.
 *
 * This is the authoritative record of what the *page* asked for. The interceptor
 * patched `fetch`, `XMLHttpRequest` and `EventSource` itself, so it cannot miss
 * one and it always knows the true method — unlike `chrome.devtools.network`,
 * which reports what the *network stack* did and can therefore show a CORS
 * preflight without the request that caused it.
 *
 * Passed hits used to be dropped here on the assumption that DevTools would
 * always have them. It does not always, so both are kept now and `useNetworkLog`
 * pairs them up.
 */
export function usePageHits(limit = 300): { hits: HitRecord[]; clear: () => Promise<void> } {
  const [hits, setHits] = useState<HitRecord[]>([]);

  useEffect(() => {
    void (async () => {
      const reply = await send({ type: 'get-hits', tabId: inspectedTabId, limit });
      if (reply.type === 'hits') setHits(reply.hits);
    })();

    const listener = (message: WorkerBroadcast): void => {
      if (message?.type !== 'hit') return;
      const { hit } = message;
      if (hit.tabId !== inspectedTabId) return;
      setHits((previous) => [...previous, hit].slice(-limit));
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [limit]);

  const clear = useCallback(async () => {
    await send({ type: 'clear-hits', tabId: inspectedTabId });
    setHits([]);
  }, []);

  return { hits, clear };
}

/** Whether the MCP bridge is currently connected, for the status dot. */
export function useBridgeStatus(): boolean {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const listener = (message: WorkerBroadcast): void => {
      if (message?.type === 'bridge-status') setConnected(message.connected);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return connected;
}
