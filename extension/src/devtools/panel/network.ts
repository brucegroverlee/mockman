/**
 * The bottom log: everything the inspected tab did, stitched from two sources
 * that see genuinely different things.
 *
 *  - **`chrome.devtools.network`** reports what the *network stack* did. It
 *    carries the response — which is what lets "mock it" pre-fill from reality —
 *    and it covers every resource type, not just API calls. But it describes the
 *    network's view: a CORS preflight is a first-class row here, and a request
 *    answered from the memory cache is not reported at all.
 *  - **The interceptor's hit stream** reports what the *page* asked for. It
 *    patched `fetch`, `XMLHttpRequest` and `EventSource` itself, so it cannot
 *    miss a call and always has the true method. It is also the only source that
 *    can see a mocked request, since those never reach the network. What it does
 *    not have is the response.
 *
 * Taking only the first is what produced a log full of `OPTIONS` preflights with
 * none of the `GET`s that caused them. So both are used, and matching entries
 * are paired so each request is listed once — see `useNetworkLog`.
 *
 * Both sources are already scoped to the inspected tab.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HitRecord } from '@network-mock/shared';

import { usePageHits } from './messaging.ts';
import type { LogCategory } from './labels.ts';

/** How many real requests to keep. Old ones fall off the top. */
const KEEP = 200;

export interface PassedEntry {
  kind: 'passed';
  key: string;
  timestamp: number;
  method: string;
  url: string;
  /** Undefined when only the interceptor saw it, so the response is unknown. */
  status: number | undefined;
  category: LogCategory;
  /**
   * Chrome's raw `_resourceType`, surfaced in the row tooltip.
   *
   * Kept so that a request landing in an unexpected bucket can be diagnosed by
   * hovering it, rather than by rebuilding the extension with a console.log.
   */
  resourceType: string | undefined;
  responseHeaders: Record<string, string>;
  /**
   * Which of the two sources produced this row.
   *
   * Surfaced in the tooltips. The two carry different fields — DevTools has the
   * response, the interceptor has the true method — so when a row looks wrong,
   * knowing which one it came from is the first question worth answering, and
   * it should not require a rebuild to find out.
   */
  source: 'devtools' | 'interceptor';
  /**
   * False for a row the interceptor reported but DevTools did not, where only
   * the request is known. "mock it" still works; the body just starts empty.
   */
  bodyAvailable: boolean;
  /** Callback-only in the DevTools API, so it stays lazy until "mock it". */
  getBody: () => Promise<string>;
}

export interface MockedEntry {
  kind: 'mocked';
  key: string;
  timestamp: number;
  method: string;
  url: string;
  status: number | undefined;
  category: LogCategory;
  mockId: string | undefined;
  path: string | undefined;
  label: string | undefined;
}

export type LogEntry = PassedEntry | MockedEntry;

/**
 * A HAR entry from either source.
 *
 * `onRequestFinished` hands over a `Request`, which adds a `getContent` method;
 * `getHAR()` hands over the plain HAR entry without it. Everything that only
 * *reads* an entry takes this wider shape so it works with both.
 */
type HarEntry = Omit<chrome.devtools.network.Request, 'getContent'>;

function headerMap(headers: HarEntry['response']['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(headers)) return out;
  for (const header of headers) {
    if (header?.name) out[header.name] = header.value ?? '';
  }
  return out;
}

/**
 * Chrome's `_resourceType` HAR extension, lowercased, mapped to our buckets.
 *
 * Three entries here are judgement calls rather than transcription:
 *
 *  - `preflight` — the CORS `OPTIONS` that Chrome sends ahead of a
 *    cross-origin API call. It is its own resource type, but it belongs to the
 *    request that caused it, and Chrome's own Fetch/XHR filter shows it. An API
 *    that needs CORS can easily emit more preflights than real calls, so
 *    dropping these into "Other" empties the default filter of exactly the
 *    traffic you opened this panel to look at.
 *  - `eventsource` — also its own type in Chrome, but one of the three APIs
 *    this extension can actually mock, so it belongs with the other two.
 *  - `texttrack` — subtitles, which are media by any useful reading.
 */
const RESOURCE_TYPES: Record<string, LogCategory> = {
  xhr: 'fetch-xhr',
  fetch: 'fetch-xhr',
  preflight: 'fetch-xhr',
  eventsource: 'fetch-xhr',
  document: 'doc',
  stylesheet: 'css',
  script: 'js',
  font: 'font',
  image: 'img',
  media: 'media',
  texttrack: 'media',
  manifest: 'manifest',
  websocket: 'socket',
  wasm: 'wasm',
};

/** The response's declared mime type, from the HAR body or the header. */
function mimeTypeOf(entry: HarEntry): string {
  const declared = entry.response?.content?.mimeType;
  if (declared) return declared.toLowerCase();

  // `content.mimeType` is empty for a bodiless response (a 204, a preflight),
  // so fall back to the header, which is present far more often.
  const header = (entry.response?.headers ?? []).find(
    (h) => h.name?.toLowerCase() === 'content-type',
  );
  return (header?.value ?? '').toLowerCase();
}

/**
 * Which filter bucket a real request belongs to.
 *
 * `_resourceType` is Chrome's own HAR extension and is authoritative when it
 * names a type we map. Anything else — a type we do not know, or no type at all
 * — falls through to the mime heuristic rather than going straight to "Other".
 *
 * That fall-through is deliberate. Chrome adds resource types over time
 * (`preflight`, `fedcm`, `webbundle` are all recent), and a hard "unknown type
 * means Other" makes each new one silently vanish from the default filter. An
 * unrecognised type carrying `application/json` is API traffic whatever Chrome
 * decided to call it.
 */
export function classifyEntry(entry: HarEntry): LogCategory {
  const mime = mimeTypeOf(entry);

  // Checked before the resource type: Chrome reports wasm as `script` or
  // `fetch`, and the Network panel's own Wasm filter goes by mime type too.
  if (mime.includes('application/wasm')) return 'wasm';

  const known = RESOURCE_TYPES[String(entry._resourceType ?? '').toLowerCase()];
  if (known) return known;

  if (mime.startsWith('text/html')) return 'doc';
  if (mime.startsWith('text/css')) return 'css';
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'js';
  if (mime.startsWith('font/') || mime.includes('font-')) return 'font';
  if (mime.startsWith('image/')) return 'img';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
  if (mime.includes('json') || mime.includes('graphql')) return 'fetch-xhr';

  return 'other';
}

/**
 * Two requests are the same request when all three of these agree. HAR has no
 * request id, and `startedDateTime` carries milliseconds, so a collision would
 * need the same url and method to start in the same millisecond.
 */
function identify(entry: HarEntry): string {
  return `${entry.startedDateTime}|${entry.request?.method}|${entry.request?.url}`;
}

/**
 * Real requests made by the inspected tab.
 *
 * `chrome.devtools.network` only ever reports the inspected tab, which is
 * exactly the scoping we want and is why no filtering is needed here.
 *
 * Two sources, because `onRequestFinished` only reports what happens *from now
 * on*: opening this panel after browsing for a while would otherwise show a log
 * that is almost empty while Chrome's own Network panel is full — the requests
 * were not missed, they were made before anyone was listening. `getHAR()`
 * returns what DevTools has already recorded, so the log opens with the same
 * history the Network panel is showing, and the listener takes it from there.
 *
 * The one thing neither source sees is a response served from the memory cache;
 * Chrome does not report those to extensions at all.
 */
function useRealTraffic(): { entries: PassedEntry[]; clear: () => void } {
  const [entries, setEntries] = useState<PassedEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const seen = new Set<string>();

    /**
     * Converts a HAR entry, or returns null if it cannot be read.
     *
     * Every field access here is guarded. These objects come from Chrome, not
     * from us, and the shape is not guaranteed for a request that was blocked,
     * is still in flight, or is of a kind the HAR format handles loosely. One
     * malformed entry must cost us that entry, never the whole log.
     */
    const toPassed = (
      entry: HarEntry,
      getBody: () => Promise<string>,
    ): PassedEntry | null => {
      try {
        const method = entry.request?.method;
        const url = entry.request?.url;
        if (typeof method !== 'string' || typeof url !== 'string') return null;

        // HAR timings are ISO strings; fall back to arrival time if absent.
        const started = Date.parse(entry.startedDateTime ?? '');
        const status = Number(entry.response?.status);

        return {
          kind: 'passed',
          key: `n${++seq}`,
          timestamp: Number.isFinite(started) ? started : Date.now(),
          method,
          url,
          // Normalised: DevTools reports 0 for a request that was blocked or
          // never answered, and a bare "0" in the column reads as a real status.
          // Undefined renders as a dash, which is what it actually means.
          status: Number.isFinite(status) && status > 0 ? status : undefined,
          category: classifyEntry(entry),
          // Coerced rather than passed through: `Omit` widens the literal union
          // this field carries on `Request`, and it is only ever displayed.
          resourceType: entry._resourceType ? String(entry._resourceType) : undefined,
          responseHeaders: headerMap(entry.response?.headers),
          source: 'devtools',
          bodyAvailable: true,
          getBody,
        };
      } catch {
        return null;
      }
    };

    /** Newest last, capped — which is also the order the log displays in. */
    const add = (incoming: (PassedEntry | null)[]): void => {
      const usable = incoming.filter((entry): entry is PassedEntry => entry !== null);
      if (usable.length === 0) return;
      setEntries((previous) =>
        [...previous, ...usable].sort((a, b) => a.timestamp - b.timestamp).slice(-KEEP),
      );
    };

    const listener = (entry: chrome.devtools.network.Request): void => {
      try {
        const id = identify(entry);
        if (seen.has(id)) return; // already seeded
        seen.add(id);

        add([
          toPassed(entry, () =>
            new Promise<string>((resolve) => {
              // getContent returns '' for bodiless responses and never rejects.
              entry.getContent((content) => resolve(content ?? ''));
            }),
          ),
        ]);
      } catch {
        /* one unreadable entry must not stop the ones after it */
      }
    };

    // Subscribe FIRST. Live capture is the thing that must work; the seeding
    // below is a nicety, and an earlier version of this had them the other way
    // round — where anything thrown by getHAR meant the listener was never
    // registered and the log stayed empty for the whole session.
    chrome.devtools.network.onRequestFinished.addListener(listener);

    // Seed from DevTools' existing recording, so the log starts out agreeing
    // with the Network panel rather than looking like nothing is happening.
    try {
      chrome.devtools.network.getHAR((har) => {
        if (cancelled) return;
        try {
          const seeded: (PassedEntry | null)[] = [];
          for (const entry of har?.entries ?? []) {
            const id = identify(entry);
            if (seen.has(id)) continue;
            seen.add(id);
            // A seeded entry has no `getContent`; DevTools may have kept the
            // body on the HAR itself, and "mock it" falls back to an empty body
            // when it did not. Live entries always have the real thing.
            const stored = entry.response?.content?.text ?? '';
            seeded.push(toPassed(entry, () => Promise.resolve(stored)));
          }
          add(seeded);
        } catch {
          /* seeding is best-effort; the listener above carries the session */
        }
      });
    } catch {
      /* older or non-Chrome hosts may not implement getHAR at all */
    }

    return () => {
      cancelled = true;
      chrome.devtools.network.onRequestFinished.removeListener(listener);
    };
  }, []);

  return { entries, clear: useCallback(() => setEntries([]), []) };
}

function toMockedEntry(hit: HitRecord): MockedEntry {
  return {
    kind: 'mocked',
    key: hit.id,
    timestamp: hit.timestamp,
    method: hit.method,
    url: hit.url,
    status: hit.status,
    // Always Fetch/XHR, and not a guess: the interceptor patches exactly three
    // APIs — `fetch`, `XMLHttpRequest` and `EventSource` — so anything that got
    // mocked was an API call by construction. (EventSource is strictly its own
    // resource type in Chrome, but burying mocked SSE under "Other" would hide
    // it from the default filter, which is the one place you look to confirm a
    // mock fired.)
    category: 'fetch-xhr',
    mockId: hit.mockId,
    path: hit.path,
    label: hit.label,
  };
}

/**
 * An interceptor hit that DevTools never reported, rendered as its own row.
 *
 * It has everything except the response: the interceptor sees the request go
 * out, not what came back. "mock it" still works and still pre-fills the url and
 * method — only the body starts empty.
 */
function toInterceptedEntry(hit: HitRecord): PassedEntry {
  return {
    kind: 'passed',
    key: `i${hit.id}`,
    timestamp: hit.timestamp,
    method: hit.method,
    url: hit.url,
    // The interceptor reports these once the response is in, so a status is
    // normally present. It is absent only where there genuinely is not one: a
    // request that failed at the network level, or an EventSource stream.
    status: hit.status,
    category: 'fetch-xhr',
    resourceType: undefined,
    responseHeaders: {},
    source: 'interceptor',
    bodyAvailable: false,
    getBody: () => Promise.resolve(''),
  };
}

/** How far apart the same request may look to the two sources, in ms. */
const PAIRING_WINDOW_MS = 4000;

/**
 * Whether a row is a CORS preflight — the `OPTIONS` the browser sends on the
 * page's behalf before a cross-origin call.
 *
 * The page never asked for it and cannot mock it, and an API needing CORS emits
 * one per call, so they double the length of the log with rows nobody can act
 * on. Hidden by default; the log header says how many and offers them back.
 *
 * A *mocked* row is never treated as one: if someone deliberately mocked an
 * `OPTIONS` endpoint, hiding the proof that it fired would be perverse.
 */
export function isPreflight(entry: LogEntry): boolean {
  if (entry.kind !== 'passed') return false;
  if (entry.resourceType) return entry.resourceType.toLowerCase() === 'preflight';
  // No resource type to go on (an interceptor-only row): fall back to the method.
  return entry.method.toUpperCase() === 'OPTIONS';
}

export interface NetworkLog {
  /** Oldest first, newest last — the order Chrome's own Network panel lists in. */
  entries: LogEntry[];
  clear: () => Promise<void>;
}

export function useNetworkLog(): NetworkLog {
  const { entries: fromDevtools, clear: clearPassed } = useRealTraffic();
  const { hits, clear: clearHits } = usePageHits();

  const entries = useMemo(() => {
    const mocked = hits.filter((hit) => hit.outcome === 'mocked');
    const intercepted = hits.filter((hit) => hit.outcome === 'passed');

    /*
     * Pair each intercepted request with the DevTools entry for the same
     * request, so it is listed once rather than twice.
     *
     * The two sources see different things: the interceptor sees every call the
     * page makes, with its true method, and nothing else; DevTools sees what the
     * network stack did — including CORS preflights the page never asked for,
     * and including the response, which is what "mock it" needs. Whichever one
     * is missing an entry, the other still lists it.
     *
     * Matching is on method and url within a few seconds, since neither source
     * carries a request id. A DevTools entry always wins the pairing, because it
     * is the one that carries the response body.
     */
    const unpaired = new Map<string, HitRecord[]>();
    for (const hit of intercepted) {
      const key = `${hit.method.toUpperCase()}|${hit.url}`;
      const list = unpaired.get(key);
      if (list) list.push(hit);
      else unpaired.set(key, [hit]);
    }

    const paired = fromDevtools.map((entry) => {
      const list = unpaired.get(`${entry.method.toUpperCase()}|${entry.url}`);
      if (!list || list.length === 0) return entry;

      // Consume the closest one in time, so a polled endpoint pairs each call
      // with its own row instead of collapsing them all onto the first.
      let best = -1;
      let bestGap = PAIRING_WINDOW_MS;
      list.forEach((hit, index) => {
        const gap = Math.abs(hit.timestamp - entry.timestamp);
        if (gap <= bestGap) {
          best = index;
          bestGap = gap;
        }
      });
      if (best < 0) return entry;

      const [hit] = list.splice(best, 1);

      // Merge rather than discard. The DevTools row wins overall — it has the
      // response body — but if it has no usable status and the interceptor's
      // record does, take that: throwing away the only status we have because
      // the richer source happened to lack one is how a row ends up showing a
      // dash for a request that plainly succeeded.
      if (entry.status === undefined && hit?.status !== undefined) {
        return { ...entry, status: hit.status };
      }
      return entry;
    });

    const orphans = [...unpaired.values()].flat().map(toInterceptedEntry);

    const merged: LogEntry[] = [...paired, ...orphans, ...mocked.map(toMockedEntry)];
    // Oldest first, so the log reads top-to-bottom like the Network panel and
    // new rows arrive at the bottom. Ties keep insertion order, so a burst of
    // same-millisecond requests still reads in the order they happened.
    return merged.sort((a, b) => a.timestamp - b.timestamp);
  }, [fromDevtools, hits]);

  const clear = useCallback(async () => {
    clearPassed();
    await clearHits();
  }, [clearPassed, clearHits]);

  return { entries, clear };
}
