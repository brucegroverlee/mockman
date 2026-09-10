/**
 * The bottom log: everything the inspected tab did, from two sources that have
 * to be stitched together.
 *
 * Neither source alone is enough:
 *
 *  - `chrome.devtools.network` sees every real request the tab made, with the
 *    full response — which is what lets "mock it" pre-fill a mock from reality.
 *    It cannot see mocked requests, because those never reach the network.
 *  - The extension's own hit stream sees the mocked ones, because the
 *    interceptor reports them, but knows nothing about a passed request beyond
 *    its method and URL.
 *
 * So: passed rows come from DevTools, mocked rows come from the hit stream, and
 * they are merged by timestamp. Both are already scoped to the inspected tab.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HitRecord } from '@network-mock/shared';

import { useMockedHits } from './messaging.ts';

/** How many real requests to keep. Old ones fall off the top. */
const KEEP = 200;

export interface PassedEntry {
  kind: 'passed';
  key: string;
  timestamp: number;
  method: string;
  url: string;
  status: number;
  responseHeaders: Record<string, string>;
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
  mockId: string | undefined;
  path: string | undefined;
  label: string | undefined;
}

export type LogEntry = PassedEntry | MockedEntry;

function headerMap(headers: chrome.devtools.network.Request['response']['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers ?? []) {
    if (header.name) out[header.name] = header.value ?? '';
  }
  return out;
}

/**
 * Real requests made by the inspected tab.
 *
 * `chrome.devtools.network` only ever reports the inspected tab, which is
 * exactly the scoping we want and is why no filtering is needed here.
 */
function useRealTraffic(): { entries: PassedEntry[]; clear: () => void } {
  const [entries, setEntries] = useState<PassedEntry[]>([]);

  useEffect(() => {
    let seq = 0;

    const listener = (entry: chrome.devtools.network.Request): void => {
      // HAR timings are ISO strings; fall back to arrival time if absent.
      const started = Date.parse(entry.startedDateTime ?? '');

      const passed: PassedEntry = {
        kind: 'passed',
        key: `n${++seq}`,
        timestamp: Number.isFinite(started) ? started : Date.now(),
        method: entry.request.method,
        url: entry.request.url,
        status: entry.response.status,
        responseHeaders: headerMap(entry.response.headers),
        getBody: () =>
          new Promise<string>((resolve) => {
            // getContent returns '' for bodiless responses and never rejects.
            entry.getContent((content) => resolve(content ?? ''));
          }),
      };

      setEntries((previous) => [...previous, passed].slice(-KEEP));
    };

    chrome.devtools.network.onRequestFinished.addListener(listener);
    return () => chrome.devtools.network.onRequestFinished.removeListener(listener);
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
    mockId: hit.mockId,
    path: hit.path,
    label: hit.label,
  };
}

export interface NetworkLog {
  /** Newest first, which is the order the log is read in. */
  entries: LogEntry[];
  clear: () => Promise<void>;
  counts: { mocked: number; passed: number };
}

export function useNetworkLog(): NetworkLog {
  const { entries: passed, clear: clearPassed } = useRealTraffic();
  const { hits, clear: clearHits } = useMockedHits();

  const entries = useMemo(() => {
    const merged: LogEntry[] = [...passed, ...hits.map(toMockedEntry)];
    // Newest first. Ties keep insertion order, so a burst of same-millisecond
    // requests still reads in the order they happened.
    return merged.sort((a, b) => b.timestamp - a.timestamp);
  }, [passed, hits]);

  const clear = useCallback(async () => {
    clearPassed();
    await clearHits();
  }, [clearPassed, clearHits]);

  return {
    entries,
    clear,
    counts: { mocked: hits.length, passed: passed.length },
  };
}
