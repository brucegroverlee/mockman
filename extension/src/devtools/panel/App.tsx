import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findNode, isFolder, setEnabled } from '@mockman/shared';

import { Detail } from './Detail.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { HitLog } from './HitLog.tsx';
import { Tree } from './Tree.tsx';
// MVP: `useBridgeStatus` is unused while the MCP chip is hidden — see below.
import { /* useBridgeStatus, */ useTabTargeting, useWorkspace } from './messaging.ts';
import { readStored, writeStored } from './storage.ts';

/**
 * The panel shell.
 *
 * Layout, top to bottom:
 *
 *   ┌ app bar ────────────────────────────────────┐  master switch, bridge dot
 *   ├ tree ─────────────┬ detail ─────────────────┤  fills whatever is left
 *   ├ hit log ────────────────────────────────────┤  what this tab actually did
 *   └─────────────────────────────────────────────┘
 *
 * Both dividers are draggable, and both remember where you put them.
 *
 * The hit log's height is **explicit**, not content-derived. That is the whole
 * point: rows arrive continuously while you work, and a log that grew with them
 * would shrink the tree out from under you mid-edit. It stays exactly where you
 * put it and scrolls internally.
 *
 * There is no tab picker anywhere: `useTabTargeting` targets the inspected tab
 * for as long as this panel is open, and the log only ever shows that tab. The
 * panel is scoped to the tab you opened it on, full stop.
 */
export function App(): React.JSX.Element {
  const { workspace, update } = useWorkspace();
  // const bridgeConnected = useBridgeStatus();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shell = useRef<HTMLDivElement>(null);

  useTabTargeting();

  // Dragging the log's top edge upwards makes it taller, so the height is
  // measured from the bottom of the panel. The upper clamp leaves room for the
  // tree — a drag should never be able to hide it completely.
  const measureLogHeight = useCallback((event: PointerEvent): number => {
    const box = shell.current?.getBoundingClientRect();
    if (!box) return LOG_DEFAULT;
    const ceiling = Math.max(LOG_MIN, box.height - MIN_BODY_HEIGHT);
    return Math.min(ceiling, Math.max(LOG_MIN, box.bottom - event.clientY));
  }, []);

  const log = useDragSize(LOG_KEY, LOG_DEFAULT, measureLogHeight);

  // A selected node can vanish underneath us — deleted here, or over MCP.
  useEffect(() => {
    if (!workspace || !selectedId) return;
    if (!findNode(workspace.tree, selectedId)) setSelectedId(null);
  }, [workspace, selectedId]);

  const selectedFolderId = useMemo(() => {
    if (!workspace || !selectedId) return null;
    const located = findNode(workspace.tree, selectedId);
    if (!located) return null;
    return isFolder(located.node) ? located.node.id : located.parentId;
  }, [workspace, selectedId]);

  if (!workspace) return <div className="loading">Connecting to the extension…</div>;

  return (
    <div className="app" ref={shell} style={{ gridTemplateRows: `auto minmax(0, 1fr) 4px ${log.size}px` }}>
      <header className="appbar">
        <label className="master" title="Nothing is mocked anywhere while this is off">
          <input
            type="checkbox"
            checked={workspace.enabled}
            // `next` is read synchronously on purpose. `update` awaits before it
            // applies the change, and React restores a controlled input's DOM
            // state as soon as the handler returns — so reading
            // `e.target.checked` inside the async closure would see the value
            // React just reverted to, and the toggle would appear stuck.
            onChange={(e) => {
              const next = e.target.checked;
              void update((w) => setEnabled(w, 'workspace', null, next));
            }}
          />
          <strong>Mocking {workspace.enabled ? 'on' : 'off'}</strong>
        </label>

        <span className="spacer" />

        {/* MVP: the MCP status chip is hidden while the bridge is not part of
            the story we are sharing. Uncomment with `useBridgeStatus` above.
        <span
          className={`bridge ${bridgeConnected ? 'up' : 'down'}`}
          title={
            bridgeConnected
              ? 'Connected to the MCP server — an agent can read and edit these mocks.'
              : 'No MCP server connected. The extension works fine on its own.'
          }
        >
          MCP
        </span>
        */}
      </header>

      {/* Each pane is isolated: a mock with a shape this build does not expect
          should break its own editor, not take the tree and the log with it. */}
      <SplitBody
        left={
          <ErrorBoundary area="tree">
            <Tree
              workspace={workspace}
              update={update}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </ErrorBoundary>
        }
        right={
          <ErrorBoundary area="editor">
            <Detail
              workspace={workspace}
              selectedId={selectedId}
              update={update}
              onSelect={setSelectedId}
            />
          </ErrorBoundary>
        }
      />

      <div
        className="log-splitter"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize the log; double-click to reset"
        onPointerDown={log.onPointerDown}
        onDoubleClick={log.reset}
      />

      <ErrorBoundary area="hit log">
        <HitLog
          workspace={workspace}
          update={update}
          targetFolderId={selectedFolderId}
          onCreated={setSelectedId}
        />
      </ErrorBoundary>
    </div>
  );
}

/** Pane sizes in a DevTools panel are personal; remember the last ones. */
const WIDTH_KEY = 'mockman:tree-width';
const WIDTH_DEFAULT = 260;
const MIN_WIDTH = 160;
const MAX_WIDTH = 640;

const LOG_KEY = 'mockman:log-height';
const LOG_DEFAULT = 160;
const LOG_MIN = 56;
/** Never let the log squeeze the tree and editor below this. */
const MIN_BODY_HEIGHT = 140;

/**
 * A pointer-drag resizable dimension, persisted across sessions.
 *
 * `measure` turns a pointer position into the new size and owns all clamping —
 * the two callers clamp against different things (a fixed maximum, and the
 * panel's own height), so there is no single rule to hoist in here.
 */
function useDragSize(
  storageKey: string,
  fallback: number,
  measure: (event: PointerEvent) => number,
): {
  size: number;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  reset: () => void;
} {
  const [size, setSize] = useState(() => {
    const stored = Number(readStored(storageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  });

  // Mirrors `size` so the drag can persist the final value without reading it
  // from inside a state updater — React may call an updater more than once
  // (StrictMode does, in development), and a side effect in there runs twice.
  const latest = useRef(size);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);

      const move = (e: PointerEvent): void => {
        const next = measure(e);
        latest.current = next;
        setSize(next);
      };

      const stop = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        // Written once at the end rather than on every move, to keep the drag
        // off the synchronous-storage path.
        writeStored(storageKey, latest.current);
      };

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    },
    [measure, storageKey],
  );

  const reset = useCallback(() => {
    latest.current = fallback;
    setSize(fallback);
    writeStored(storageKey, fallback);
  }, [fallback, storageKey]);

  return { size, onPointerDown, reset };
}


function SplitBody({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);

  const measureWidth = useCallback((event: PointerEvent): number => {
    const box = container.current?.getBoundingClientRect();
    if (!box) return WIDTH_DEFAULT;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, event.clientX - box.left));
  }, []);

  const tree = useDragSize(WIDTH_KEY, WIDTH_DEFAULT, measureWidth);

  return (
    // `minmax(0, 1fr)` rather than `1fr`: a plain fr track's automatic minimum
    // is min-content, so one long unwrappable string in the detail pane would
    // widen the track and make the whole panel scroll sideways.
    <div
      className="body"
      ref={container}
      style={{ gridTemplateColumns: `${tree.size}px 4px minmax(0, 1fr)` }}
    >
      {left}
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize; double-click to reset"
        onPointerDown={tree.onPointerDown}
        onDoubleClick={tree.reset}
      />
      {right}
    </div>
  );
}
