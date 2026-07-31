import { useEffect, useState } from 'react';
import { createGroup, createMock } from '@network-mock/shared';
import type { HttpMethod, Workspace } from '@network-mock/shared';

/**
 * Real traffic seen on the inspected tab, and a one-click way to turn any entry
 * into a mock pre-filled with its actual status, headers and body.
 *
 * `chrome.devtools.network` only ever reports the **inspected** tab, so recording
 * is inspected-tab-only even though mocking can target a different tab.
 *
 * Note this list shows requests that really happened. Anything already being
 * mocked never reaches the network and so will not appear here.
 */

interface Recorded {
  key: string;
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  getContent: () => Promise<string>;
}

const KEEP = 60;

function patternFor(url: string): string {
  try {
    const parsed = new URL(url);
    // Everything up to the query, then a wildcard so query variations still hit.
    return `${parsed.origin}${parsed.pathname}*`;
  } catch {
    return url;
  }
}

export function RecordedRequests({
  update,
  onCreated,
}: {
  update: (fn: (current: Workspace) => Workspace) => Promise<void>;
  onCreated: (mockId: string) => void;
}): React.JSX.Element {
  const [recorded, setRecorded] = useState<Recorded[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let seq = 0;

    const listener = (entry: chrome.devtools.network.Request): void => {
      const headers: Record<string, string> = {};
      for (const header of entry.response.headers ?? []) {
        if (header.name) headers[header.name] = header.value ?? '';
      }

      const item: Recorded = {
        key: `r${++seq}`,
        method: entry.request.method,
        url: entry.request.url,
        status: entry.response.status,
        headers,
        getContent: () =>
          new Promise<string>((resolve) => {
            // getContent is callback-only and returns '' for bodiless responses.
            entry.getContent((content) => resolve(content ?? ''));
          }),
      };

      setRecorded((previous) => [...previous, item].slice(-KEEP));
    };

    chrome.devtools.network.onRequestFinished.addListener(listener);
    return () => chrome.devtools.network.onRequestFinished.removeListener(listener);
  }, []);

  const makeMock = async (item: Recorded): Promise<void> => {
    const body = await item.getContent();
    const looksJson =
      (item.headers['content-type'] ?? item.headers['Content-Type'] ?? '').includes('json') ||
      body.trimStart().startsWith('{') ||
      body.trimStart().startsWith('[');

    await update((current) => {
      // Recorded mocks need somewhere to live; make a group on first use rather
      // than forcing the user to create one before they can capture anything.
      let next = current;
      let groupId = current.groups.find((g) => g.name === 'Recorded')?.id;
      if (!groupId) {
        const created = createGroup(next, { name: 'Recorded' });
        next = created.workspace;
        groupId = created.group.id;
      }

      const result = createMock(next, groupId, {
        name: new URL(item.url).pathname.slice(0, 60) || item.url,
        match: {
          method: item.method.toUpperCase() as HttpMethod,
          urlPattern: patternFor(item.url),
          patternKind: 'glob',
        },
        response: {
          status: item.status || 200,
          headers: item.headers,
          body,
          bodyKind: looksJson ? 'json' : 'text',
        },
      });
      onCreated(result.mock.id);
      return result.workspace;
    });
  };

  const visible = filter
    ? recorded.filter((r) => r.url.toLowerCase().includes(filter.toLowerCase()))
    : recorded;

  return (
    <section className="recorded">
      <div className="recorded-head">
        <button onClick={() => setOpen((v) => !v)}>
          {open ? '▾' : '▸'} Real traffic ({recorded.length})
        </button>
        {open && (
          <>
            <input
              value={filter}
              placeholder="Filter by URL"
              onChange={(e) => setFilter(e.target.value)}
            />
            <span className="hint">Inspected tab only. Reload the page to capture its requests.</span>
            <button onClick={() => setRecorded([])}>Clear</button>
          </>
        )}
      </div>

      {open && (
        <div className="recorded-rows">
          {visible.length === 0 && (
            <p className="empty">
              Nothing recorded yet — this panel only sees requests made while it is open.
            </p>
          )}
          {[...visible].reverse().map((item) => (
            <div className="recorded-row" key={item.key}>
              <span className="method">{item.method}</span>
              <span className="status">{item.status}</span>
              <span className="url" title={item.url}>
                {item.url}
              </span>
              <button onClick={() => void makeMock(item)}>Create mock from this</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
