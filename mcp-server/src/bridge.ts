/**
 * The bridge to the extension.
 *
 * The direction is inverted from what you might expect: an MV3 service worker
 * cannot listen on a port, so *we* run the WebSocket server on loopback and the
 * extension dials in. That also means the extension can be running happily with
 * no MCP server present, and vice versa.
 *
 * Security posture: bound to 127.0.0.1 so nothing off-box can reach it, with an
 * optional shared token for defence in depth. Note that a token is the only real
 * protection against *other local processes* — the `Origin` header a browser
 * extension sends is trivially forged by any local program, so it is not treated
 * as an authorisation signal.
 */

import { WebSocketServer, type WebSocket } from 'ws';

import { log } from './logger.ts';

export type BridgeMethod =
  | 'getWorkspace'
  | 'setWorkspace'
  | 'listTabs'
  | 'setTargetTabs'
  | 'getHits'
  | 'clearHits';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const CALL_TIMEOUT_MS = 10_000;

export class BridgeNotConnectedError extends Error {
  constructor() {
    super(
      'The Mockman extension is not connected. Open Chrome, make sure the ' +
        'extension is loaded, then retry. (The extension dials into this server, ' +
        'so it must be running and pointed at the same port.)',
    );
    this.name = 'BridgeNotConnectedError';
  }
}

export class Bridge {
  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #pending = new Map<number, PendingCall>();
  #seq = 0;

  /** Serialises read-modify-write cycles so two clients cannot interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly port: number,
    private readonly token: string | null,
  ) {}

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === 1;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: this.port });
      this.#server = server;

      server.on('listening', () => {
        log.info(`bridge listening on ws://127.0.0.1:${this.port}`);
        resolve();
      });
      server.on('error', (error) => reject(error));

      server.on('connection', (socket, request) => {
        if (this.token) {
          const supplied = new URL(request.url ?? '/', 'http://localhost').searchParams.get('token');
          if (supplied !== this.token) {
            log.warn('rejected a bridge connection with a bad token');
            socket.close(4401, 'bad token');
            return;
          }
        }

        // One extension at a time. A second connection replaces the first, which
        // is what you want after a browser or extension reload leaves a stale
        // socket behind.
        if (this.#socket) this.#socket.close(4409, 'replaced');
        this.#socket = socket;
        log.info('extension connected');

        socket.on('message', (raw) => this.#onMessage(String(raw)));
        socket.on('close', () => {
          if (this.#socket === socket) this.#socket = null;
          log.info('extension disconnected');
        });
        socket.on('error', (error) => log.warn('bridge socket error', error));
      });
    });
  }

  async stop(): Promise<void> {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new Error('server shutting down'));
    }
    this.#pending.clear();
    this.#socket?.close();
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
  }

  #onMessage(raw: string): void {
    let message: { id?: number; result?: unknown; error?: string; type?: string };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      log.warn('ignoring unparseable bridge message');
      return;
    }

    if (message.type === 'hello') {
      log.debug('extension said hello');
      return;
    }
    if (message.type === 'pong') return;

    if (typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;

    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  /** Calls a method in the extension. Rejects promptly rather than hanging. */
  call<T>(method: BridgeMethod, params?: unknown): Promise<T> {
    if (!this.connected || !this.#socket) return Promise.reject(new BridgeNotConnectedError());

    const id = ++this.#seq;
    const socket = this.#socket;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`extension did not answer "${method}" within ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);

      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Runs `fn` with exclusive access.
   *
   * Every mutating tool is a read-modify-write against the extension's state, so
   * without this two concurrent clients could each read the same workspace and
   * the second write would silently discard the first one's change.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
