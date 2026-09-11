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
 *  - **Reading a request body must not consume it.** A `Request` or a stream can
 *    only be read once, so `readRequestBody` never touches anything it cannot
 *    read from a clone — see the comment there.
 */

import {
  CAPTURE_BODY_LIMIT,
  PAGE_EVENT,
  resolveCompiled,
  shouldCaptureResponse,
} from '@network-mock/shared';
import type {
  BodyEventDetail,
  CapturedResponse,
  CompiledMock,
  ConfigEventDetail,
  HitRecord,
  RequestInfo as MockRequestInfo,
  TabConfig,
} from '@network-mock/shared';

/** How long to wait for the relay before giving up and passing everything through. */
const CONFIG_TIMEOUT_MS = 2000;

let config: TabConfig = { active: false, observed: false, mocks: [] };
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

/**
 * Response-body capture, so the panel's "mock it" can pre-fill a mock with what
 * the endpoint actually returned.
 *
 * The panel's other source, `chrome.devtools.network`, carries response bodies
 * too — but only for requests it reported, and only while it still holds them.
 * Neither is guaranteed, and a "mock it" that opens an empty editor is the most
 * annoying way for this feature to fail: the whole point is to start from
 * reality and edit it, not to retype a payload by hand.
 *
 * So the interceptor captures too. It sees every call the page makes, by
 * construction, which makes it the reliable source — and the one that has to be
 * careful, since it is buffering bytes inside the page.
 *
 * Two gates keep that carefulness honest. `config.observed` restricts capture to
 * tabs a panel is actually open on: this file runs on `<all_urls>`, and reading
 * response bodies out of every tab in the browser is not something to do on the
 * off-chance someone clicks "mock it". `shouldCaptureResponse` then decides
 * whether a given response is worth keeping at all.
 */

/**
 * Per-frame prefix, because the relay runs in every frame and each frame has its
 * own copy of this file. A bare counter would collide across iframes, and one
 * frame's body would be served for another frame's row.
 */
const CAPTURE_PREFIX = Math.random().toString(36).slice(2, 8);
let captureSeq = 0;

function nextBodyKey(): string {
  return `${CAPTURE_PREFIX}-${++captureSeq}`;
}

function reportBody(key: string, captured: CapturedResponse): void {
  const detail: BodyEventDetail = { key, captured };
  document.dispatchEvent(new CustomEvent(PAGE_EVENT.body, { detail }));
}

function headerObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    headers.forEach((value, name) => {
      out[name] = value;
    });
  } catch {
    /* an opaque response exposes no headers; an empty map is the honest answer */
  }
  return out;
}

/** `getAllResponseHeaders()` returns one `name: value` pair per CRLF-delimited line. */
function parseRawHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

/**
 * The text of a finished XHR's response, or `undefined` when there is no text to
 * be had.
 *
 * `responseText` throws outright for a `blob`, `arraybuffer` or `document`
 * `responseType`, so each is handled on its own terms: `json` is re-serialised
 * (the parsed value is all XHR kept), `arraybuffer` is decoded, and `blob` and
 * `document` are skipped — a Blob needs an await there is nowhere to put, and a
 * re-serialised DOM is not what came over the wire.
 */
function readXhrText(xhr: XMLHttpRequest): string | undefined {
  try {
    switch (xhr.responseType) {
      case '':
      case 'text':
        return xhr.responseText;
      case 'json':
        return xhr.response === null || xhr.response === undefined
          ? undefined
          : JSON.stringify(xhr.response, null, 2);
      case 'arraybuffer':
        return xhr.response ? new TextDecoder().decode(xhr.response as ArrayBuffer) : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Captures a finished XHR, and returns the key to put on its hit.
 *
 * Everything is already in hand here, so the key is only minted when there
 * genuinely is a body behind it — unlike the fetch path, which has to commit
 * before the body has finished arriving.
 */
function captureXhr(xhr: XMLHttpRequest): string | undefined {
  if (!config.observed) return undefined;

  let headers: Record<string, string>;
  try {
    headers = parseRawHeaders(xhr.getAllResponseHeaders());
  } catch {
    return undefined;
  }
  if (!shouldCaptureResponse(headers)) return undefined;

  const body = readXhrText(xhr);
  if (body === undefined || body.length > CAPTURE_BODY_LIMIT) return undefined;

  const key = nextBodyKey();
  reportBody(key, { body, headers });
  return key;
}

/**
 * Reads a response body, giving up rather than exceeding `CAPTURE_BODY_LIMIT`.
 *
 * `text()` cannot be used for this: it buffers the whole body and only then
 * hands it over, so the limit would be checked after the memory had already been
 * spent. Since `content-length` is absent for anything chunked or compressed —
 * which is most JSON APIs — that would leave the cap as a hope rather than a
 * bound. Reading chunk by chunk makes it a real one, and cancels the moment the
 * budget is gone.
 *
 * Cancelling is safe: `clone()` tees the stream, and the branches are
 * independent, so abandoning ours does nothing to the one the page is reading.
 */
async function readCapped(response: Response): Promise<string | undefined> {
  const stream = response.body;
  if (!stream) return undefined;

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > CAPTURE_BODY_LIMIT) {
        // Abandoned rather than truncated: half a JSON document is not a
        // starting point for a mock, it is a syntax error found later.
        void reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    // The page aborted, or the body failed mid-stream. Either way there is no
    // response to offer.
    return undefined;
  }

  const merged = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.byteLength;
  }

  try {
    return new TextDecoder().decode(merged);
  } catch {
    return undefined;
  }
}

/**
 * Starts capturing a real `fetch` response, and returns the key to put on its
 * hit.
 *
 * The clone is taken synchronously, before the response is handed back, which is
 * the only moment it is guaranteed to be unread — and it is the clone that gets
 * drained, so the page's own copy is untouched.
 *
 * The read is deliberately **not** awaited. `fetch` resolves on headers, so
 * awaiting the body here would delay the caller by however long the body takes
 * to arrive, which this file promises never to do. That is also why the key is
 * minted before the body exists: the hit goes out now, and the body catches up.
 */
function captureFetch(response: Response): string | undefined {
  if (!config.observed) return undefined;

  const headers = headerObject(response.headers);
  if (!shouldCaptureResponse(headers)) return undefined;

  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return undefined;
  }

  const key = nextBodyKey();
  void readCapped(clone).then((body) => {
    if (body !== undefined) reportBody(key, { body, headers });
  });
  return key;
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

/** True when any live mock actually cares about request bodies. */
function anyMockNeedsBody(): boolean {
  return config.active && config.mocks.some((mock) => mock.match.body?.value);
}

/**
 * Best-effort text of an outgoing body, or `undefined` when it is unreadable.
 *
 * `undefined` is meaningful downstream: a mock with a body matcher never
 * matches an unreadable body, so we must not conflate it with `''`.
 *
 * Only types that can be read *without* consuming the original are handled. A
 * `ReadableStream` body is deliberately left unread — draining it would break
 * the very request we are about to let through — and a `Blob`/`FormData` needs
 * an await that would change fetch's timing for every caller, mocked or not.
 */
function readRequestBody(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) {
    try {
      return new TextDecoder().decode(body as ArrayBufferView);
    } catch {
      return undefined;
    }
  }
  if (body instanceof ArrayBuffer) {
    try {
      return new TextDecoder().decode(body);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The body of a `Request` object, read from a clone so the original stays usable.
 *
 * Only called when a body matcher exists — cloning and buffering every request
 * would be a real cost to impose on pages that never asked for it.
 */
async function readRequestObjectBody(request: Request): Promise<string | undefined> {
  // No body at all is "unreadable", not "empty" — `undefined` and `''` mean
  // different things to a body matcher. `bodyUsed` would make clone() throw.
  if (!request.body || request.bodyUsed) return undefined;
  try {
    return await request.clone().text();
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Artificial latency, if the mock asked for any. */
async function applyDelay(mock: CompiledMock): Promise<void> {
  const delay = mock.response.delayMs;
  if (delay > 0) await sleep(delay);
}

/**
 * Reports a request that reached the real network.
 *
 * Called *after* the response arrives, so the status can be included — the panel
 * shows these rows next to ones DevTools reported, and a blank status column
 * beside a populated one reads as a bug. `startedAt` is therefore passed in
 * explicitly: the row must be timestamped when the request went out, not when it
 * came back, or it would sort away from its neighbours and drift outside the
 * window the panel uses to pair the two sources up.
 *
 * A status of 0 means the request failed outright (network error, abort), which
 * is not a status anyone can act on, so it is left off.
 *
 * `bodyKey` names the captured response body, when one is being captured; the
 * body itself follows on its own event. See the capture block above.
 */
function reportPassed(
  method: string,
  url: string,
  startedAt: number,
  status?: number,
  bodyKey?: string,
): void {
  const hit: Omit<HitRecord, 'id' | 'tabId'> = {
    timestamp: startedAt,
    method,
    url,
    outcome: 'passed',
  };
  if (status !== undefined && status > 0) hit.status = status;
  if (bodyKey !== undefined) hit.bodyKey = bodyKey;
  report(hit);
}

function reportMocked(method: string, url: string, mock: CompiledMock): void {
  const hit: Omit<HitRecord, 'id' | 'tabId'> = {
    timestamp: Date.now(),
    method,
    url,
    outcome: 'mocked',
    mockId: mock.mockId,
    path: mock.path,
    status: mock.response.status,
  };
  if (mock.label) hit.label = mock.label;
  report(hit);
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

/**
 * Builds the mocked `Response`, or null if it cannot be built.
 *
 * Returning null rather than throwing is the fail-open rule applied here. The
 * `Response` constructor rejects any status outside 200–599 with a RangeError,
 * and such a status is reachable: the panel's number input yields 0 for an
 * emptied field, and 1xx passes both the MCP schema and `migrateWorkspace`. An
 * exception escaping here would reject the page's own `fetch` — turning a
 * mis-typed status into a page-breaking error, which is precisely what this file
 * promises never to do. A null sends the request to the real network instead.
 *
 * Header values can be rejected too (a stray newline), so the whole construction
 * is guarded, not just the status.
 */
function buildResponse(mock: CompiledMock, url: string): Response | null {
  let response: Response;
  try {
    const headers = new Headers(mock.response.headers);
    if (!headers.has('content-type')) headers.set('content-type', defaultContentType(mock));

    const body = forbidsBody(mock.response.status) ? null : mock.response.body;
    response = new Response(body, {
      status: mock.response.status,
      statusText: statusTextFor(mock),
      headers,
    });
  } catch {
    return null;
  }

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

  // Reading the body costs a clone and an await, so it only happens when some
  // live mock actually has a body matcher. `init.body` wins over the Request's
  // own body, matching how fetch itself resolves the two.
  let body: string | undefined;
  if (anyMockNeedsBody()) {
    if (init && 'body' in init) body = readRequestBody(init.body);
    else if (input instanceof Request) body = await readRequestObjectBody(input);
  }

  const mock = findMock({ method, url, body });

  // Build before reporting: an unbuildable response is not a mocked request, and
  // claiming otherwise in the hit log would send you hunting for a mock that
  // never actually answered.
  const response = mock ? buildResponse(mock, url) : null;
  if (!mock || !response) {
    // Reported once the real response is in, so the hit carries its status. The
    // caller sees no difference: this awaits exactly the promise it would have
    // been handed, and the report is dispatched before it is handed back.
    const startedAt = Date.now();
    try {
      const real = await originalFetch.call(window, input as RequestInfo, init);
      // Capture first, so the hit can name the body that is on its way. Starting
      // the capture does not block the caller — see `captureFetch`.
      reportPassed(method, url, startedAt, real.status, captureFetch(real));
      return real;
    } catch (error) {
      // A network-level failure still belongs in the log — knowing the request
      // was attempted and died is exactly what you need when a mock's pattern
      // did not match and you are wondering where the call went.
      reportPassed(method, url, startedAt);
      throw error;
    }
  }

  reportMocked(method, url, mock);
  await applyDelay(mock);
  return response;
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

  // Unlike fetch, XHR hands us the body synchronously and reading it consumes
  // nothing, so there is no clone to avoid and no reason to gate on
  // `anyMockNeedsBody`.
  const request = { ...state, body: readRequestBody(body) };

  // A synchronous XHR must have its response ready when send() returns, so there
  // is no opportunity to await config. If config has not arrived yet we can only
  // pass it through; if it has, we can still mock without waiting.
  if (!state.async) {
    const mock = settled ? findMock(request) : null;
    if (!mock) {
      // Synchronous XHR has its status ready the moment send() returns, so no
      // listener is needed. `finally` so a throwing send is still logged.
      const startedAt = Date.now();
      try {
        originalSend.call(this, body ?? null);
      } finally {
        // A synchronous XHR has its whole response in hand the moment send()
        // returns, so capturing it is a plain read with nothing to await.
        reportPassed(state.method, state.url, startedAt, this.status, captureXhr(this));
      }
      return;
    }
    reportMocked(state.method, state.url, mock);
    // A delay is impossible here: the caller is blocking on send() returning,
    // and there is no way to yield without breaking that contract.
    deliverMockedXhr(this, mock, state.url, { synchronous: true });
    return;
  }

  void ready.then(() => {
    const mock = findMock(request);
    if (!mock) {
      // `loadend` is the one event that fires for success, failure and abort
      // alike, so the request is logged exactly once however it ends.
      const startedAt = Date.now();
      const onDone = (): void => {
        this.removeEventListener('loadend', onDone);
        reportPassed(state.method, state.url, startedAt, this.status, captureXhr(this));
      };
      this.addEventListener('loadend', onDone);
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

  // Synchronous XHR expects everything to have happened before send() returns,
  // which also rules out honouring `delayMs` — blocking the main thread for it
  // would be worse than ignoring it.
  if (opts.synchronous) run();
  else setTimeout(run, Math.max(0, mock.response.delayMs));

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

    // `delayMs` is applied to the connection opening, which is the closest
    // analogue to "the server took a while to answer" for a stream.
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
    }, Math.max(0, mock.response.delayMs));

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
      // No status: an EventSource is a long-lived stream, not a request that
      // completes with one. The panel shows a dash for it.
      reportPassed('GET', absolute, Date.now());
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
