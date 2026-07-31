/**
 * The service worker's end of the MCP bridge.
 *
 * An MV3 service worker cannot listen on a port, so the extension dials *out* to
 * the MCP server and answers method calls over that socket. If no server is
 * running the extension carries on working standalone; it simply retries in the
 * background.
 *
 * Lifetime note: since Chrome 116 WebSocket activity resets the service worker's
 * 30-second idle timer, so an open bridge keeps the worker alive on its own. The
 * periodic ping below is belt and braces — it also detects a half-open socket
 * that Chrome has not yet noticed.
 */

import { emptyWorkspace } from '@network-mock/shared';
import type { HitRecord, Workspace } from '@network-mock/shared';

const DEFAULT_PORT = 8787;
const PING_MS = 20_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export interface BridgeHost {
  loadWorkspace: () => Promise<Workspace>;
  saveWorkspace: (workspace: Workspace) => Promise<void>;
  setTargetTabs: (tabIds: number[]) => Promise<void>;
  getHits: (tabId?: number, limit?: number) => HitRecord[];
  clearHits: () => void;
  onStatusChange: (connected: boolean) => void;
}

interface Call {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

let socket: WebSocket | null = null;
let retryDelay = RETRY_MIN_MS;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let host: BridgeHost | null = null;
let enabled = true;

async function bridgePort(): Promise<number> {
  const stored = await chrome.storage.local.get('bridgePort');
  const port = Number(stored['bridgePort']);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

async function bridgeToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get('bridgeToken');
  const token = stored['bridgeToken'];
  return typeof token === 'string' && token ? token : null;
}

async function handle(call: Call): Promise<unknown> {
  if (!host) throw new Error('bridge host not initialised');

  switch (call.method) {
    case 'getWorkspace':
      return await host.loadWorkspace();

    case 'setWorkspace': {
      const workspace = call.params?.['workspace'] as Workspace | undefined;
      if (!workspace) throw new Error('setWorkspace requires a workspace');
      // Tab targeting is session state owned by the browser, never by the caller.
      const current = await host.loadWorkspace();
      await host.saveWorkspace({ ...emptyWorkspace(), ...workspace, targetTabIds: current.targetTabIds });
      return { ok: true };
    }

    case 'listTabs': {
      const tabs = await chrome.tabs.query({});
      return tabs
        .filter((tab) => tab.id !== undefined)
        .map((tab) => ({
          id: tab.id,
          title: tab.title ?? '',
          url: tab.url ?? '',
          active: tab.active === true,
        }));
    }

    case 'setTargetTabs': {
      const tabIds = call.params?.['tabIds'];
      if (!Array.isArray(tabIds)) throw new Error('setTargetTabs requires tabIds: number[]');
      await host.setTargetTabs(tabIds.map(Number));
      return { ok: true };
    }

    case 'getHits':
      return host.getHits(
        call.params?.['tabId'] as number | undefined,
        call.params?.['limit'] as number | undefined,
      );

    case 'clearHits':
      host.clearHits();
      return { ok: true };

    default:
      throw new Error(`Unknown bridge method: ${call.method}`);
  }
}

function scheduleReconnect(): void {
  if (!enabled) return;
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  setTimeout(() => void connect(), delay);
}

export async function connect(): Promise<void> {
  if (!enabled || socket) return;

  const port = await bridgePort();
  const token = await bridgeToken();
  const url = `ws://127.0.0.1:${port}/${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.addEventListener('open', () => {
    retryDelay = RETRY_MIN_MS;
    ws.send(JSON.stringify({ type: 'hello', version: 1 }));
    host?.onStatusChange(true);

    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_MS);
  });

  ws.addEventListener('message', (event) => {
    void (async () => {
      let call: Call;
      try {
        call = JSON.parse(String(event.data)) as Call;
      } catch {
        return;
      }
      if (typeof call.id !== 'number') return;

      try {
        ws.send(JSON.stringify({ id: call.id, result: await handle(call) }));
      } catch (error) {
        ws.send(
          JSON.stringify({
            id: call.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    })();
  });

  const teardown = (): void => {
    if (socket === ws) socket = null;
    clearInterval(pingTimer);
    host?.onStatusChange(false);
    scheduleReconnect();
  };

  ws.addEventListener('close', teardown);
  ws.addEventListener('error', () => ws.close());
}

export function startBridge(bridgeHost: BridgeHost): void {
  host = bridgeHost;
  enabled = true;
  void connect();
}
