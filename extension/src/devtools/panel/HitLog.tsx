import { useMemo, useState } from 'react';
import { createFolder, createMock, findFolder, findNode } from '@network-mock/shared';
import type { HttpMethod, Workspace } from '@network-mock/shared';

import { useNetworkLog } from './network.ts';
import type { LogEntry, PassedEntry } from './network.ts';
import type { Update } from './messaging.ts';
import { statusClass } from './labels.ts';

/**
 * The bottom log: what the inspected tab actually did.
 *
 * Scoped to the inspected tab, always — both of its sources are (see network.ts),
 * so there is nothing to filter and no way for another tab's traffic to appear
 * here.
 *
 * Rows that reached the real network carry a "mock it" button, which captures
 * the response as it actually was and drops a ready-made mock into the tree.
 * That is the fastest path from "I can see the request" to "I control the
 * request", and it is why the log lives next to the tree rather than in a
 * separate view.
 */

/** Where captured mocks go when no folder is selected. */
const CAPTURE_FOLDER = 'Captured';

function patternFor(url: string): string {
  try {
    const parsed = new URL(url);
    // Everything up to the query, then a wildcard so query variations still hit.
    return `${parsed.origin}${parsed.pathname}*`;
  } catch {
    return url;
  }
}

function nameFor(url: string): string {
  try {
    const { pathname } = new URL(url);
    const last = pathname.split('/').filter(Boolean).pop();
    return last ?? pathname ?? url;
  } catch {
    return url;
  }
}

export function HitLog({
  workspace,
  update,
  targetFolderId,
  onCreated,
}: {
  workspace: Workspace;
  update: Update;
  /** The selected folder, if any: captured mocks land there. */
  targetFolderId: string | null;
  onCreated: (mockId: string) => void;
}): React.JSX.Element {
  const { entries, clear, counts } = useNetworkLog();
  const [filter, setFilter] = useState('');
  const [onlyMocked, setOnlyMocked] = useState(false);
  const [capturing, setCapturing] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return entries.filter((entry) => {
      if (onlyMocked && entry.kind !== 'mocked') return false;
      if (!needle) return true;
      return entry.url.toLowerCase().includes(needle) || entry.method.toLowerCase().includes(needle);
    });
  }, [entries, filter, onlyMocked]);

  const capture = async (entry: PassedEntry): Promise<void> => {
    setCapturing(entry.key);
    try {
      const body = await entry.getBody();
      const contentType = entry.responseHeaders['content-type'] ?? entry.responseHeaders['Content-Type'] ?? '';
      const trimmed = body.trimStart();
      const looksJson =
        contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');

      await update((current) => {
        let next = current;

        // Prefer the folder the user has selected; otherwise make (or reuse) a
        // "Captured" folder, so capturing never fails for want of somewhere to
        // put things.
        let parentId = targetFolderId && findFolder(next.tree, targetFolderId) ? targetFolderId : null;
        if (!parentId) {
          const existing = next.tree.find(
            (node) => node.kind === 'folder' && node.name === CAPTURE_FOLDER,
          );
          if (existing) {
            parentId = existing.id;
          } else {
            const created = createFolder(next, null, { name: CAPTURE_FOLDER });
            next = created.workspace;
            parentId = created.folder.id;
          }
        }

        const result = createMock(next, parentId, {
          name: nameFor(entry.url),
          match: {
            method: entry.method.toUpperCase() as HttpMethod,
            urlPattern: patternFor(entry.url),
            patternKind: 'glob',
          },
          response: {
            status: entry.status || 200,
            headers: entry.responseHeaders,
            body,
            bodyKind: looksJson ? 'json' : 'text',
            delayMs: 0,
          },
        });
        onCreated(result.mock.id);
        return result.workspace;
      });
    } finally {
      setCapturing(null);
    }
  };

  return (
    <section className="log">
      <div className="log-head">
        <strong>Hit log</strong>
        <span className="log-counts">
          <span className="badge mocked">{counts.mocked}</span> mocked
          <span className="badge passed">{counts.passed}</span> passed
        </span>
        <input
          className="log-filter"
          value={filter}
          placeholder="Filter"
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="inline-check">
          <input
            type="checkbox"
            checked={onlyMocked}
            onChange={(e) => setOnlyMocked(e.target.checked)}
          />
          Mocked only
        </label>
        <span className="hint">
          Mocked requests never reach the network, so they do <em>not</em> appear in the Network
          panel. This is the only place you will see them.
        </span>
        <button onClick={() => void clear()}>Clear</button>
      </div>

      <div className="log-rows">
        {visible.length === 0 && (
          <p className="empty">
            {entries.length === 0
              ? 'Nothing yet — this log only sees requests made while the panel is open. Reload the page to capture its traffic.'
              : 'Nothing matches that filter.'}
          </p>
        )}

        {visible.map((entry) => (
          <Row
            key={entry.key}
            entry={entry}
            busy={capturing === entry.key}
            onCapture={capture}
            onSelectMock={onCreated}
            workspace={workspace}
          />
        ))}
      </div>
    </section>
  );
}

function Row({
  entry,
  busy,
  onCapture,
  onSelectMock,
  workspace,
}: {
  entry: LogEntry;
  busy: boolean;
  onCapture: (entry: PassedEntry) => Promise<void>;
  onSelectMock: (mockId: string) => void;
  workspace: Workspace;
}): React.JSX.Element {
  const mocked = entry.kind === 'mocked';

  // A mock deleted after it fired leaves its hit behind. The row stays — it is a
  // true record of what happened — but there is nothing left to jump to.
  const stillExists =
    mocked && entry.mockId !== undefined && findNode(workspace.tree, entry.mockId) !== null;

  return (
    <div className={`log-row ${mocked ? 'mocked' : 'passed'}`}>
      <span className={`badge ${mocked ? 'mocked' : 'passed'}`}>{mocked ? 'MOCKED' : 'passed'}</span>
      <span className="method">{entry.method}</span>
      {entry.status !== undefined && (
        <span className={`status ${statusClass(entry.status)}`}>{entry.status}</span>
      )}
      <span className="url" title={entry.url}>
        {entry.url}
      </span>

      {mocked ? (
        <>
          {entry.label && <span className="row-label">{entry.label}</span>}
          <button
            className="via"
            title={`Show ${entry.path ?? 'this mock'} in the tree`}
            disabled={!entry.mockId || !stillExists}
            onClick={() => entry.mockId && onSelectMock(entry.mockId)}
          >
            {entry.path ?? 'mock'}
          </button>
        </>
      ) : (
        <button
          className="mock-it"
          title="Create a mock from this request, pre-filled with the response it actually returned"
          disabled={busy}
          onClick={() => void onCapture(entry)}
        >
          {busy ? 'capturing…' : 'mock it'}
        </button>
      )}
    </div>
  );
}
