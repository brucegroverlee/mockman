/**
 * The interception engine. Runs in the page's own JavaScript world (MAIN) at
 * document_start, which is the only way to substitute response bodies while
 * DevTools is open on the same tab — `chrome.debugger` cannot attach to a tab
 * that already has DevTools attached, and `declarativeNetRequest` cannot supply
 * a body.
 *
 * Constraints that shape this file:
 *
 *  - **No `chrome.*` APIs exist here.** Config arrives from the ISOLATED-world
 *    relay over DOM CustomEvents.
 *  - **Patches must be installed synchronously**, before any page script runs,
 *    but the config cannot arrive synchronously. So every interception awaits a
 *    `ready` promise. This is free in practice because fetch and XHR both
 *    deliver asynchronously anyway.
 *  - **It must fail open.** If the relay never answers, a timeout releases every
 *    waiter into passthrough. A broken extension must never hang a page.
 */

import { PAGE_EVENT, resolveCompiled } from '@network-mock/shared';
import type {
  CompiledMock,
  ConfigEventDetail,
  HitRecord,
  RequestInfo as MockRequestInfo,
  TabConfig,
} from '@network-mock/shared';

/** How long to wait for the relay before giving up and passing everything through. */
const CONFIG_TIMEOUT_MS = 2000;

let config: TabConfig = { active: false, mocks: [] };
let settled = false;

let releaseReady!: () => void;
const ready = new Promise<void>((resolve) => {
  releaseReady = resolve;
});

function settle(): void {
  if (settled) return;
  settled = true;
  releaseReady();
}

const failOpenTimer = setTimeout(settle, CONFIG_TIMEOUT_MS);

document.addEventListener(PAGE_EVENT.config, (event) => {
  const detail = (event as CustomEvent<ConfigEventDetail>).detail;
  if (detail?.config) config = detail.config;
  clearTimeout(failOpenTimer);
  settle();
});

// The relay lives in a different world; there is no ordering guarantee between
// the two at document_start. So we announce ourselves *and* the relay pushes
// config unprompted as soon as it starts. Either order works.
document.dispatchEvent(new CustomEvent(PAGE_EVENT.ready));

function report(hit: Omit<HitRecord, 'id' | 'tabId'>): void {
  document.dispatchEvent(new CustomEvent(PAGE_EVENT.hit, { detail: { hit } }));
}

function absolutise(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

/** Resolve a mock for a request, or null to pass through. */
function findMock(request: MockRequestInfo): CompiledMock | null {
  if (!config.active) return null;
  return resolveCompiled(config.mocks, request);
}

function reportPassed(method: string, url: string): void {
  report({ timestamp: Date.now(), method, url, outcome: 'passed' });
}

function reportMocked(method: string, url: string, mock: CompiledMock): void {
  report({
    timestamp: Date.now(),
    method,
    url,
    outcome: 'mocked',
    mockId: mock.mockId,
    label: mock.label,
    status: mock.response.status,
  });
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  418: "I'm a Teapot",
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function statusTextFor(mock: CompiledMock): string {
  return mock.response.statusText ?? STATUS_TEXT[mock.response.status] ?? '';
}

function defaultContentType(mock: CompiledMock): string {
  return mock.response.bodyKind === 'json' ? 'application/json' : 'text/plain;charset=UTF-8';
}

/** Statuses the Fetch spec forbids from carrying a body. */
function forbidsBody(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

const originalFetch = window.fetch;

function buildResponse(mock: CompiledMock, url: string): Response {
  const headers = new Headers(mock.response.headers);
  if (!headers.has('content-type')) headers.set('content-type', defaultContentType(mock));

  const body = forbidsBody(mock.response.status) ? null : mock.response.body;
  const response = new Response(body, {
    status: mock.response.status,
    statusText: statusTextFor(mock),
    headers,
  });

  // `Response.url` is read-only and defaults to '' for a synthesised response.
  // Consumers that read it (or check `redirected`) should see something sane.
  try {
    Object.defineProperty(response, 'url', { value: url, configurable: true });
  } catch {
    /* non-fatal: some engines lock this down */
  }
  return response;
}

window.fetch = async function patchedFetch(
  this: unknown,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  let method = 'GET';
  let rawUrl = '';
  try {
    if (typeof input === 'string') rawUrl = input;
    else if (input instanceof URL) rawUrl = input.href;
    else {
      rawUrl = input.url;
      method = input.method;
    }
    if (init?.method) method = init.method;
    method = method.toUpperCase();
  } catch {
    // Something exotic was passed; let the real fetch deal with it.
    return originalFetch.call(window, input as RequestInfo, init);
  }

  const url = absolutise(rawUrl);

  await ready;

  const mock = findMock({ method, url });
  if (!mock) {
    reportPassed(method, url);
    return originalFetch.call(window, input as RequestInfo, init);
  }

  reportMocked(method, url, mock);
  return buildResponse(mock, url);
} as typeof window.fetch;

// ---------------------------------------------------------------------------
// XMLHttpRequest
// ---------------------------------------------------------------------------

const XhrProto = XMLHttpRequest.prototype;
const originalOpen = XhrProto.open;
const originalSend = XhrProto.send;

interface XhrState {
  method: string;
  url: string;
  async: boolean;
}

const xhrState = new WeakMap<XMLHttpRequest, XhrState>();

/** Loosely typed so we can forward the caller's exact argument list. */
type LooseOpen = (this: XMLHttpRequest, ...args: unknown[]) => void;

type OpenArgs = [method: string, url: string | URL, isAsync?: boolean, user?: string | null, password?: string | null];

XhrProto.open = function patchedOpen(this: XMLHttpRequest, ...args: OpenArgs): void {
  const [method, url, isAsync] = args;
  xhrState.set(this, {
    method: String(method).toUpperCase(),
    url: absolutise(String(url)),
    // The spec default for the third argument is true.
    async: isAsync === undefined ? true : Boolean(isAsync),
  });
  // Forward verbatim: XHR behaviour is sensitive to how many arguments were
  // actually supplied, so we must not normalise them.
  return (originalOpen as LooseOpen).apply(this, args);
} as typeof XhrProto.open;

XhrProto.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
  const state = xhrState.get(this);
  if (!state) return originalSend.call(this, body ?? null);

  // A synchronous XHR must have its response ready when send() returns, so there
  // is no opportunity to await config. If config has not arrived yet we can only
  // pass it through; if it has, we can still mock without waiting.
  if (!state.async) {
    const mock = settled ? findMock(state) : null;
    if (!mock) {
      reportPassed(state.method, state.url);
      return originalSend.call(this, body ?? null);
    }
    reportMocked(state.method, state.url, mock);
    deliverMockedXhr(this, mock, state.url, { synchronous: true });
    return;
  }

  void ready.then(() => {
    const mock = findMock(state);
    if (!mock) {
      reportPassed(state.method, state.url);
      originalSend.call(this, body ?? null);
      return;
    }
    reportMocked(state.method, state.url, mock);
    deliverMockedXhr(this, mock, state.url, { synchronous: false });
  });
} as typeof XhrProto.send;

/**
 * Fakes a completed response on a real XHR object.
 *
 * The underlying request is never sent, so none of the native machinery runs.
 * Every observable member has to be redefined on the instance and the event
 * sequence replayed by hand in the order the spec mandates, because libraries
 * (axios, jQuery, older SDKs) depend on precisely that order.
 */
function deliverMockedXhr(
  xhr: XMLHttpRequest,
  mock: CompiledMock,
  url: string,
  opts: { synchronous: boolean },
): void {
  const { status, headers, body, bodyKind } = mock.response;
  const statusText = statusTextFor(mock);

  const responseHeaders = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    responseHeaders.set(key.toLowerCase(), value);
  }
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', defaultContentType(mock));
  }

  // Explicitly `number`: the XHR constants are literal types, so inference would
  // pin this to `1` and reject every later transition.
  let readyState: number = XMLHttpRequest.OPENED;

  const define = (name: string, get: () => unknown): void => {
    try {
      Object.defineProperty(xhr, name, { get, configurable: true });
    } catch {
      /* ignore: a locked-down property just keeps its native value */
    }
  };

  const responseType = xhr.responseType;

  const computeResponse = (): unknown => {
    if (readyState < XMLHttpRequest.LOADING) return responseType === '' || responseType === 'text' ? '' : null;
    switch (responseType) {
      case 'json':
        try {
          return JSON.parse(body) as unknown;
        } catch {
          return null; // matches the spec: invalid JSON yields null, not a throw
        }
      case 'arraybuffer':
        return new TextEncoder().encode(body).buffer;
      case 'blob':
        return new Blob([body], { type: responseHeaders.get('content-type') ?? '' });
      case 'document':
        try {
          const type = (responseHeaders.get('content-type') ?? '').includes('xml')
            ? 'application/xml'
            : 'text/html';
          return new DOMParser().parseFromString(body, type as DOMParserSupportedType);
        } catch {
          return null;
        }
      default:
        return body;
    }
  };

  define('readyState', () => readyState);
  define('status', () => (readyState >= XMLHttpRequest.HEADERS_RECEIVED ? status : 0));
  define('statusText', () => (readyState >= XMLHttpRequest.HEADERS_RECEIVED ? statusText : ''));
  define('responseURL', () => url);
  define('response', computeResponse);
  define('responseText', () =>
    readyState >= XMLHttpRequest.LOADING && (responseType === '' || responseType === 'text')
      ? body
      : '',
  );

  Object.defineProperty(xhr, 'getAllResponseHeaders', {
    value: () =>
      readyState < XMLHttpRequest.HEADERS_RECEIVED
        ? ''
        : [...responseHeaders].map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n',
    configurable: true,
  });
  Object.defineProperty(xhr, 'getResponseHeader', {
    value: (name: string) =>
      readyState < XMLHttpRequest.HEADERS_RECEIVED
        ? null
        : responseHeaders.get(String(name).toLowerCase()) ?? null,
    configurable: true,
  });

  const byteLength = body.length;
  const fireProgress = (name: string): void => {
    xhr.dispatchEvent(
      new ProgressEvent(name, { lengthComputable: true, loaded: byteLength, total: byteLength }),
    );
  };

  const run = (): void => {
    readyState = XMLHttpRequest.HEADERS_RECEIVED;
    xhr.dispatchEvent(new Event('readystatechange'));

    readyState = XMLHttpRequest.LOADING;
    xhr.dispatchEvent(new Event('readystatechange'));

    readyState = XMLHttpRequest.DONE;
    xhr.dispatchEvent(new Event('readystatechange'));
    fireProgress('progress');
    fireProgress('load');
    fireProgress('loadend');
  };

  // Synchronous XHR expects everything to have happened before send() returns.
  if (opts.synchronous) run();
  else setTimeout(run, 0);

  void bodyKind; // documented on the type; not needed beyond content-type defaulting
}

// ---------------------------------------------------------------------------
// EventSource (minimal: the initial connection and an immediate payload)
// ---------------------------------------------------------------------------

const OriginalEventSource = window.EventSource;

if (typeof OriginalEventSource === 'function') {
  /**
   * Parses the mock body as an SSE stream and replays it once.
   *
   * Deliberately minimal, as planned: this covers "the endpoint exists and sends
   * me this", not long-lived stream scripting.
   */
  function makeFakeEventSource(url: string, mock: CompiledMock): EventSource {
    const target = new EventTarget() as EventTarget & Record<string, unknown>;
    let readyState = 0; // CONNECTING

    Object.defineProperties(target, {
      url: { value: url, configurable: true },
      withCredentials: { value: false, configurable: true },
      readyState: { get: () => readyState, configurable: true },
      CONNECTING: { value: 0 }, OPEN: { value: 1 }, CLOSED: { value: 2 },
      close: {
        value: () => {
          readyState = 2;
        },
        configurable: true,
      },
    });

    // `onmessage`/`onopen`/`onerror` are handler properties, not just listeners.
    for (const name of ['open', 'message', 'error'] as const) {
      let handler: ((event: Event) => void) | null = null;
      Object.defineProperty(target, `on${name}`, {
        get: () => handler,
        set: (fn: ((event: Event) => void) | null) => {
          if (handler) target.removeEventListener(name, handler);
          handler = fn;
          if (fn) target.addEventListener(name, fn);
        },
        configurable: true,
      });
    }

    setTimeout(() => {
      readyState = 1; // OPEN
      target.dispatchEvent(new Event('open'));

      for (const chunk of mock.response.body.split(/\r?\n\r?\n/)) {
        if (!chunk.trim()) continue;
        // Accept both a raw JSON payload and a proper `data:`-prefixed SSE frame.
        const dataLines = chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        const data = dataLines.length > 0 ? dataLines.join('\n') : chunk;
        target.dispatchEvent(new MessageEvent('message', { data, origin: new URL(url).origin }));
      }
    }, 0);

    return target as unknown as EventSource;
  }

  const PatchedEventSource = function (
    this: unknown,
    url: string | URL,
    init?: EventSourceInit,
  ): EventSource {
    const absolute = absolutise(String(url));
    // A constructor cannot await, so EventSource is only mocked once config has
    // arrived — true for anything created after page load, which is the norm.
    const mock = settled ? findMock({ method: 'GET', url: absolute }) : null;
    if (!mock) {
      reportPassed('GET', absolute);
      return new OriginalEventSource(url, init);
    }
    reportMocked('GET', absolute, mock);
    return makeFakeEventSource(absolute, mock);
  } as unknown as typeof EventSource;

  PatchedEventSource.prototype = OriginalEventSource.prototype;
  Object.defineProperties(PatchedEventSource, {
    CONNECTING: { value: 0 }, OPEN: { value: 1 }, CLOSED: { value: 2 },
  });
  window.EventSource = PatchedEventSource;
}
