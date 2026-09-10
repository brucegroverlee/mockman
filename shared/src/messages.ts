/**
 * Message contracts between the four contexts that make up the extension.
 *
 *   page (MAIN world)  <--CustomEvent-->  relay (ISOLATED world)
 *   relay              <--runtime msg-->  service worker
 *   devtools panel     <--runtime msg-->  service worker
 *   devtools panel     <--port---------->  service worker   (lifetime only)
 *   service worker     <--WebSocket--->   MCP server
 *
 * Every hop is a discriminated union on `type` so an unhandled case is a compile
 * error rather than a silent no-op.
 */

import type { HitRecord, TabConfig, Workspace } from './types.ts';

/**
 * DOM event names for the MAIN <-> ISOLATED hop.
 *
 * These cross into the page's own event space, so they are namespaced to avoid
 * colliding with anything the host page does.
 */
export const PAGE_EVENT = {
  /** MAIN → ISOLATED: interceptor loaded, asking for config. */
  ready: 'network-mock:ready',
  /** ISOLATED → MAIN: here is the config (also sent on every later change). */
  config: 'network-mock:config',
  /** MAIN → ISOLATED: a request was mocked or passed through. */
  hit: 'network-mock:hit',
} as const;

/**
 * The long-lived port the DevTools panel opens to the service worker.
 *
 * Its only job is lifetime: while the port is open the panel's inspected tab is
 * a mocking target, and `onDisconnect` untargets it. A one-shot message could
 * not do this, because a DevTools window can be closed without ever getting a
 * chance to send anything.
 */
export const PANEL_PORT = 'network-mock:panel';

/** The first and only message the panel sends over {@link PANEL_PORT}. */
export interface PanelHello {
  type: 'panel-hello';
  tabId: number;
}

/** Sent as the `detail` of a {@link PAGE_EVENT.config} event. */
export interface ConfigEventDetail {
  config: TabConfig;
}

/** Sent as the `detail` of a {@link PAGE_EVENT.hit} event. */
export interface HitEventDetail {
  /** Everything except the fields only the service worker can know (tabId, id). */
  hit: Omit<HitRecord, 'id' | 'tabId'>;
}

/** relay/panel → service worker. */
export type ToWorker =
  | { type: 'get-config' }
  | { type: 'report-hit'; hit: Omit<HitRecord, 'id' | 'tabId'> }
  | { type: 'get-workspace' }
  | { type: 'set-workspace'; workspace: Workspace }
  | { type: 'set-target-tabs'; tabIds: number[] }
  | { type: 'get-hits'; tabId?: number; limit?: number }
  | { type: 'clear-hits'; tabId?: number };

/** service worker → relay/panel, in reply to {@link ToWorker}. */
export type FromWorker =
  | { type: 'config'; config: TabConfig }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'hits'; hits: HitRecord[] }
  | { type: 'ok' }
  | { type: 'error'; message: string };

/**
 * service worker → panel, unsolicited.
 *
 * The panel re-renders from these instead of polling, which is what keeps a mock
 * created over MCP appearing in the UI immediately.
 */
export type WorkerBroadcast =
  | { type: 'workspace-changed'; workspace: Workspace }
  | { type: 'hit'; hit: HitRecord }
  | { type: 'bridge-status'; connected: boolean };
