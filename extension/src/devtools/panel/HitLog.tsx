import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFolder, createMock, findFolder } from '@mockman/shared';
import type { HttpMethod, Workspace } from '@mockman/shared';

import { isPreflight, useNetworkLog } from './network.ts';
import type { LogEntry, PassedEntry } from './network.ts';
import type { Update } from './messaging.ts';
import { DEFAULT_LOG_CATEGORY, LOG_CATEGORIES, statusClass } from './labels.ts';
import type { LogCategory } from './labels.ts';
import { readStored, writeStored } from './storage.ts';

/**
 * The bottom log: what the inspected tab actually did.
 *
 * Scoped to the inspected tab, always — both of its sources are (see network.ts),
 * so there is nothing to filter and no way for another tab's traffic to appear
 * here.
 *
 * Rows are listed oldest first, newest at the bottom, the way Chrome's own
 * Network panel lists them, and the list follows the newest row unless the user
 * has scrolled up.
 *
 * Rows that reached the real network carry a "mock it" button, which captures
 * the response as it actually was — status, headers and body — and drops a
 * ready-made mock into the tree, selected and ready to edit. That is the fastest
 * path from "I can see the request" to "I control the request", and it is why
 * the log lives next to the tree rather than in a separate view.
 *
 * Pre-filling the *body* is the part that earns the button: a mock whose payload
 * you still have to write from scratch has saved you a url and nothing else. See
 * `PassedEntry.getResponse` for where that body comes from, and why there are
 * two sources for it.
 */

/** Where captured mocks go when no folder is selected. */
const CAPTURE_FOLDER = 'Captured';

const CATEGORY_KEY = 'mockman:log-categories';
const INVERT_KEY = 'mockman:log-invert';
const PREFLIGHT_KEY = 'mockman:log-preflights';

/**
 * The resource-type chips and the Invert switch.
 *
 * An **empty** set means "All" — no type constraint — rather than "every
 * category listed". Storing it that way means a category added later is
 * included automatically for anyone whose filter was already on All, instead of
 * silently going missing because it was not in the set they last saved.
 *
 * Selection behaves like Chrome's: a plain click selects exactly one type,
 * ctrl/cmd-click adds or removes one. Deselecting the last chip falls back to
 * All, because an empty log with every chip dark is a puzzle, not a filter.
 */
function useLogFilter(): {
  categories: ReadonlySet<LogCategory>;
  invert: boolean;
  setInvert: (invert: boolean) => void;
  toggleCategory: (category: LogCategory, additive: boolean) => void;
  showAll: () => void;
} {
  const [categories, setCategories] = useState<ReadonlySet<LogCategory>>(() => {
    const stored = readStored(CATEGORY_KEY);
    if (stored === null) return new Set([DEFAULT_LOG_CATEGORY]);
    // An empty stored value is a deliberate "All", not a missing preference.
    const known = new Set(LOG_CATEGORIES.map((c) => c.id));
    return new Set(stored.split(',').filter((id): id is LogCategory => known.has(id as LogCategory)));
  });

  const [invert, setInvertState] = useState(() => readStored(INVERT_KEY) === 'true');

  const commit = useCallback((next: ReadonlySet<LogCategory>) => {
    setCategories(next);
    writeStored(CATEGORY_KEY, [...next].join(','));
  }, []);

  const toggleCategory = useCallback(
    (category: LogCategory, additive: boolean) => {
      if (!additive) {
        commit(new Set([category]));
        return;
      }
      const next = new Set(categories);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      commit(next);
    },
    [categories, commit],
  );

  const setInvert = useCallback((next: boolean) => {
    setInvertState(next);
    writeStored(INVERT_KEY, next);
  }, []);

  return {
    categories,
    invert,
    setInvert,
    toggleCategory,
    showAll: useCallback(() => commit(new Set()), [commit]),
  };
}

/**
 * The response's content type, lowercased, or `''`.
 *
 * Looked up case-insensitively because the two capture sources disagree: a HAR
 * entry carries whatever casing the server sent, and `fetch` normalises to
 * lowercase.
 */
function contentTypeOf(headers: Record<string, string>): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type') return value.toLowerCase();
  }
  return '';
}

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
  const { entries, clear } = useNetworkLog();
  const [filter, setFilter] = useState('');
  const [onlyMocked, setOnlyMocked] = useState(false);
  const [capturing, setCapturing] = useState<string | null>(null);
  const { categories, invert, setInvert, toggleCategory, showAll } = useLogFilter();
  const [showPreflights, setShowPreflights] = useState(() => readStored(PREFLIGHT_KEY) === 'true');

  const preflightCount = useMemo(() => entries.filter(isPreflight).length, [entries]);

  /** Everything the log is *about*, before the search box and type chips. */
  const relevant = useMemo(
    () => (showPreflights ? entries : entries.filter((entry) => !isPreflight(entry))),
    [entries, showPreflights],
  );

  // Counted off `relevant` so the header describes the rows actually listed.
  const counts = useMemo(
    () => ({
      mocked: relevant.filter((e) => e.kind === 'mocked').length,
      passed: relevant.filter((e) => e.kind === 'passed').length,
    }),
    [relevant],
  );

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();

    return relevant.filter((entry) => {
      // "Mocked only" is an outcome switch, not part of "the filter", so Invert
      // does not touch it — same as Chrome, where Invert flips the query and the
      // type chips but not the other toggles.
      if (onlyMocked && entry.kind !== 'mocked') return false;

      const matchesType = categories.size === 0 || categories.has(entry.category);
      const matchesText =
        !needle ||
        entry.url.toLowerCase().includes(needle) ||
        entry.method.toLowerCase().includes(needle);

      return invert ? !(matchesType && matchesText) : matchesType && matchesText;
    });
  }, [relevant, filter, onlyMocked, categories, invert]);

  /*
   * Follow the newest row, which is now the bottom one.
   *
   * "Stuck" is remembered rather than recomputed after the rows change, because
   * appending a row is itself what moves the list away from the bottom: by the
   * time the effect runs, a list that *was* at the bottom no longer is. Scrolling
   * up to read something clears it, so the log never yanks the view out from
   * under the user.
   */
  /*
   * Every id in the tree, collected once per change to it.
   *
   * A row needs to know whether the mock it fired from is still there, and each
   * row used to answer that by walking the tree itself. That is a walk per
   * mocked row per render, and the whole log re-renders whenever the workspace
   * does — so editing one field in the editor walked the tree a few hundred
   * times before the next frame.
   */
  const liveIds = useMemo(() => {
    const ids = new Set<string>();
    const walk = (nodes: Workspace['tree']): void => {
      for (const node of nodes) {
        ids.add(node.id);
        if (node.kind === 'folder') walk(node.children);
      }
    };
    walk(workspace.tree);
    return ids;
  }, [workspace.tree]);

  const rowsRef = useRef<HTMLDivElement | null>(null);
  const stuckToBottom = useRef(true);

  useEffect(() => {
    const el = rowsRef.current;
    if (el && stuckToBottom.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  // Stable, so `Row` can skip re-rendering when only the workspace moved.
  const capture = useCallback(
    async (entry: PassedEntry): Promise<void> => {
      setCapturing(entry.key);
      try {
        // Headers come back alongside the body rather than off the row: an
        // interceptor-only row learns both at the same moment, and the two must
        // describe the same response for the json/text guess below to be right.
        const { body, headers } = await entry.getResponse();
        const contentType = contentTypeOf(headers);
        const trimmed = body.trimStart();
        const looksJson =
          contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');

        await update((current) => {
          let next = current;

          // Prefer the folder the user has selected; otherwise make (or reuse) a
          // "Captured" folder, so capturing never fails for want of somewhere to
          // put things.
          let parentId =
            targetFolderId && findFolder(next.tree, targetFolderId) ? targetFolderId : null;
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
              // Copied: the row's own `getResponse` may hand the same object out
              // again, and this one is about to become part of the workspace.
              headers: { ...headers },
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
    },
    [onCreated, targetFolderId, update],
  );

  return (
    <section className="log">
      <div className="log-head">
        <strong>Hit log</strong>
        <span className="log-counts">
          <span className="badge mocked">{counts.mocked}</span> mocked
          <span className="badge passed">{counts.passed}</span> passed
        </span>

        {/* Never hide rows silently: say how many and offer them back. */}
        {preflightCount > 0 && (
          <button
            className="link preflights"
            title={
              showPreflights
                ? 'Hide the CORS OPTIONS requests the browser sends on the page’s behalf'
                : 'Show the CORS OPTIONS requests the browser sends on the page’s behalf'
            }
            onClick={() => {
              const next = !showPreflights;
              setShowPreflights(next);
              writeStored(PREFLIGHT_KEY, next);
            }}
          >
            {showPreflights
              ? 'hide preflights'
              : `${preflightCount} preflight${preflightCount === 1 ? '' : 's'} hidden`}
          </button>
        )}
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

      <div className="log-filters" role="group" aria-label="Filter by resource type">
        <button
          className={`type-chip ${categories.size === 0 ? 'on' : ''}`}
          title="Show every resource type"
          onClick={showAll}
        >
          All
        </button>

        {LOG_CATEGORIES.map(({ id, label }) => (
          <button
            key={id}
            className={`type-chip ${categories.has(id) ? 'on' : ''}`}
            title={
              categories.has(id)
                ? `${label} — ctrl/cmd-click to remove it from the selection`
                : `Show only ${label} — ctrl/cmd-click to add it to the selection`
            }
            aria-pressed={categories.has(id)}
            onClick={(e) => toggleCategory(id, e.ctrlKey || e.metaKey)}
          >
            {label}
          </button>
        ))}

        <span className="spacer" />

        <label
          className={`inline-check invert ${invert ? 'on' : ''}`}
          title="Show everything the filter above would have hidden"
        >
          <input
            type="checkbox"
            checked={invert}
            onChange={(e) => setInvert(e.target.checked)}
          />
          Invert
        </label>
      </div>

      <div
        className="log-rows"
        ref={rowsRef}
        onScroll={() => {
          const el = rowsRef.current;
          // A few pixels of slack: fractional scroll heights mean an exact
          // comparison can miss the bottom by a sub-pixel and stop following.
          if (el) stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
        }}
      >
        {visible.length === 0 && (
          <p className="empty">
            {entries.length === 0 ? (
              'Nothing yet — this log only sees requests made while the panel is open. Reload the page to capture its traffic.'
            ) : (
              <>
                {entries.length} request{entries.length === 1 ? '' : 's'}, none matching the filter.{' '}
                <button className="link" onClick={showAll}>
                  Show all types
                </button>
              </>
            )}
          </p>
        )}

        {visible.map((entry) => (
          <Row
            key={entry.key}
            entry={entry}
            busy={capturing === entry.key}
            onCapture={capture}
            onSelectMock={onCreated}
            mockStillExists={entry.kind === 'mocked' && !!entry.mockId && liveIds.has(entry.mockId)}
          />
        ))}
      </div>
    </section>
  );
}

function categoryLabel(entry: LogEntry): string {
  return LOG_CATEGORIES.find((c) => c.id === entry.category)?.label ?? entry.category;
}

/**
 * What the type column says on hover.
 *
 * The column shows the bucket, matching the filter chip above it; the tooltip
 * adds Chrome's own name for the resource, which is the finer-grained answer —
 * and the one that explains an `OPTIONS` row sitting under Fetch/XHR.
 */
function describeCategory(entry: LogEntry): string {
  const label = categoryLabel(entry);
  if (entry.kind === 'mocked') return `${label} — mocked, so it never reached the network`;

  const seenBy =
    entry.source === 'devtools'
      ? 'Seen by DevTools'
      : 'Seen by the page interceptor only — DevTools did not report it';
  return entry.resourceType
    ? `${label} — Chrome reports this as "${entry.resourceType}"\n${seenBy}`
    : `${label}\n${seenBy}`;
}

/** Why a row has no status, which differs by where the row came from. */
function describeMissingStatus(entry: LogEntry): string {
  if (entry.kind === 'mocked') return 'This mock defines no status';
  return entry.source === 'devtools'
    ? 'DevTools reported no status for this request — it was blocked or failed before responding'
    : 'The interceptor saw this request but got no status back — it failed at the network level, or is a stream';
}

/**
 * One line of the log.
 *
 * Memoised, and told whether its mock still exists rather than given the
 * workspace to look it up in — both for the same reason: hundreds of these are
 * mounted at once, and every workspace edit re-renders the log around them.
 */
const Row = memo(function Row({
  entry,
  busy,
  onCapture,
  onSelectMock,
  mockStillExists,
}: {
  entry: LogEntry;
  busy: boolean;
  onCapture: (entry: PassedEntry) => Promise<void>;
  onSelectMock: (mockId: string) => void;
  /**
   * A mock deleted after it fired leaves its hit behind. The row stays — it is a
   * true record of what happened — but there is nothing left to jump to.
   */
  mockStillExists: boolean;
}): React.JSX.Element {
  const mocked = entry.kind === 'mocked';

  return (
    <div className={`log-row ${mocked ? 'mocked' : 'passed'}`}>
      <span className={`badge ${mocked ? 'mocked' : 'passed'}`}>{mocked ? 'MOCKED' : 'passed'}</span>
      {/* Shown, not just filtered on: without it an OPTIONS preflight sitting
          under Fetch/XHR looks like a mistake. Hovering names the exact resource
          type Chrome reported. */}
      <span className={`log-type c-${entry.category}`} title={describeCategory(entry)}>
        {categoryLabel(entry)}
      </span>
      <span className="method">{entry.method}</span>
      {/* Always rendered, so the url column starts at the same x on every row.
          A dash means the response was never observed — see toInterceptedEntry. */}
      <span
        className={`status ${entry.status === undefined ? 'unknown' : statusClass(entry.status)}`}
        title={entry.status === undefined ? describeMissingStatus(entry) : undefined}
      >
        {entry.status ?? '–'}
      </span>
      <span className="url" title={entry.url}>
        {entry.url}
      </span>

      {mocked ? (
        <>
          {entry.label && <span className="row-label">{entry.label}</span>}
          <button
            className="via"
            title={`Show ${entry.path ?? 'this mock'} in the tree`}
            disabled={!mockStillExists}
            onClick={() => entry.mockId && onSelectMock(entry.mockId)}
          >
            {entry.path ?? 'mock'}
          </button>
        </>
      ) : (
        <button
          className="mock-it"
          title={
            entry.bodyAvailable
              ? 'Create a mock from this request, pre-filled with the response it actually returned'
              : 'Create a mock from this request. This response was not recorded — it is not a text payload, or it was too large — so the body starts empty'
          }
          disabled={busy}
          onClick={() => void onCapture(entry)}
        >
          {busy ? 'capturing…' : 'mock it'}
        </button>
      )}
    </div>
  );
});
