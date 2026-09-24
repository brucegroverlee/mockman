/**
 * Typed messaging between the panel and the service worker, plus the React hooks
 * that keep the UI in sync.
 *
 * The worker owns the workspace: the panel reads it from there and re-reads on
 * every broadcast, which is what makes a mock created over MCP show up here
 * immediately with no polling. The one exception is an edit the panel is in the
 * middle of making — see `useWorkspace`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PANEL_PORT } from '@mockman/shared';
import type {
  CapturedResponse,
  FromWorker,
  HitRecord,
  PanelHello,
  ToWorker,
  Workspace,
  WorkerBroadcast,
} from '@mockman/shared';

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
 * The response body the interceptor captured for a hit, or null.
 *
 * Fetched only when "mock it" is clicked. Bodies are held in the worker under a
 * hard cap and are not part of a `HitRecord`, precisely so that the log can hold
 * hundreds of rows without hauling their payloads around — see `bodyKey`.
 */
export async function getCapturedBody(key: string): Promise<CapturedResponse | null> {
  const reply = await send({ type: 'get-hit-body', key });
  return reply.type === 'hit-body' ? reply.captured : null;
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

/** How long a burst of edits may accumulate before it is written through. */
const FLUSH_DELAY_MS = 120;

/**
 * The workspace plus a setter that writes through to the worker.
 *
 * `update` takes a function so callers compose the pure mutation helpers from
 * `@mockman/shared` without worrying about staleness.
 *
 * The panel's copy is authoritative *while it is being edited*, and only then.
 * It did not start out that way: every `update` used to await a fresh read from
 * the worker before applying the mutation, so the new state reached React a
 * round trip and a `chrome.storage` write after the keystroke that caused it.
 * Two things followed, both of them felt on every character typed:
 *
 *  - a controlled `<input>` was handed back its *old* value when the change
 *    handler returned and the new one an await later, and assigning a value to a
 *    text field puts the caret at the end of it — so the caret jumped to the end
 *    on every keystroke;
 *  - each keystroke cost a message round trip, a storage write and a broadcast
 *    to every open tab, with the tree, the editor and the log all re-rendering
 *    twice for one letter.
 *
 * So the mutation is applied to the local copy synchronously — which is the
 * contract React expects of a controlled input, and what leaves the caret alone
 * — and the write through to the worker is coalesced onto a short timer.
 * Broadcasts are ignored while an edit is unwritten or in flight, since those
 * are echoes of state that has already been typed past.
 *
 * The trade is that an MCP edit landing in the same breath as a keystroke loses
 * to the keystroke rather than the other way round. That was already true — a
 * patch built from the props of an earlier render carried the older values into
 * the freshly read workspace anyway — and it is the better direction to lose in.
 */
export function useWorkspace(): { workspace: Workspace | null; update: Update } {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  // Mirrors the state so an update can read the current workspace without
  // waiting for a render: several edits can land before React comes back round.
  const local = useRef<Workspace | null>(null);
  const unwritten = useRef(false);
  const inFlight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Resolved once the edits they were handed out for have reached the worker. */
  const waiting = useRef<(() => void)[]>([]);

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }

    const next = local.current;
    const settle = waiting.current;
    waiting.current = [];

    if (!next || !unwritten.current) {
      for (const done of settle) done();
      return;
    }

    unwritten.current = false;
    inFlight.current += 1;
    try {
      await putWorkspace(next);
    } finally {
      inFlight.current -= 1;
      for (const done of settle) done();
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const initial = await getWorkspace();
      // A broadcast or an edit may have beaten the first read home, and neither
      // should be undone by it.
      if (!initial || local.current) return;
      local.current = initial;
      setWorkspace(initial);
    })();

    const listener = (message: WorkerBroadcast): void => {
      if (message?.type !== 'workspace-changed') return;
      if (unwritten.current || inFlight.current > 0) return;
      local.current = message.workspace;
      setWorkspace(message.workspace);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // Coalescing leaves a window in which the panel could go away with an edit
  // still only in memory, so close it on the way out.
  useEffect(() => {
    const leave = (): void => void flush();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [flush]);

  const update = useCallback(
    (fn: (current: Workspace) => Workspace): Promise<void> => {
      const current = local.current;
      if (!current) return Promise.resolve();
      const next = fn(current);
      if (next === current) return Promise.resolve();

      local.current = next;
      setWorkspace(next);
      unwritten.current = true;

      const written = new Promise<void>((resolve) => waiting.current.push(resolve));
      // Timed from the *first* pending edit rather than the last, so holding a
      // key down still saves every 120ms instead of nothing until you stop.
      timer.current ??= setTimeout(() => void flush(), FLUSH_DELAY_MS);
      return written;
    },
    [flush],
  );

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
export function usePageHits(limit = 300): {
  hits: HitRecord[];
  clear: () => Promise<void>;
  /** Empties this panel's view only; the worker keeps its record for the MCP tools. */
  reset: () => void;
} {
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

  const reset = useCallback(() => setHits([]), []);

  return { hits, clear, reset };
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
