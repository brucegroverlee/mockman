import { useCallback, useMemo, useRef, useState } from 'react';
import {
  createFolder,
  createMock,
  createTag,
  defaultMatch,
  defaultResponse,
  deleteTag,
  explainMock,
  filterTree,
  findNode,
  indexTags,
  isFolder,
  isSelfOrDescendant,
  moveNode,
  parseSearch,
  renameNode,
  setAllExpanded,
  setEnabled,
  setExpanded,
} from '@network-mock/shared';
import type { Folder, Tag, TreeNode, Workspace } from '@network-mock/shared';

import { inspectedTabId } from './messaging.ts';
import type { Update } from './messaging.ts';
import { REASON_TEXT } from './labels.ts';

/**
 * The folder/mock explorer.
 *
 * Two things here are worth knowing before reading the code:
 *
 *  - **While a search is active the tree shown is a filtered copy**, and every
 *    surviving folder renders open regardless of its stored `expanded` flag.
 *    Collapsing a branch you are actively searching would hide the very result
 *    you asked for.
 *  - **Drag and drop moves nodes; it does not copy them.** The drop target is
 *    either "into this folder" or "between these two rows", decided by where in
 *    the row height the pointer is.
 */

type DropZone = 'before' | 'inside' | 'after';

interface DropTarget {
  nodeId: string;
  zone: DropZone;
}

export function Tree({
  workspace,
  update,
  selectedId,
  onSelect,
}: {
  workspace: Workspace;
  update: Update;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const tagsById = useMemo(() => indexTags(workspace.tags), [workspace.tags]);
  const query = useMemo(() => parseSearch(search), [search]);
  const filtered = useMemo(
    () => filterTree(workspace.tree, query, tagsById),
    [workspace.tree, query, tagsById],
  );
  const searching = query.terms.length > 0;

  /**
   * Where a "new folder"/"new mock" button should put things.
   *
   * Creating while a folder is selected puts the new node inside it; creating
   * while a mock is selected puts it beside that mock. Both read as "next to
   * what I am looking at", which is what people expect from a tree.
   */
  const insertionParent = (): string | null => {
    if (!selectedId) return null;
    const located = findNode(workspace.tree, selectedId);
    if (!located) return null;
    return isFolder(located.node) ? located.node.id : located.parentId;
  };

  const addFolder = (): void => {
    const parentId = insertionParent();
    void update((w) => {
      const { workspace: next, folder } = createFolder(w, parentId, { name: 'New folder' });
      onSelect(folder.id);
      setRenaming(folder.id);
      return next;
    });
  };

  const addMock = (): void => {
    const parentId = insertionParent();
    void update((w) => {
      const { workspace: next, mock } = createMock(w, parentId, {
        name: 'New mock',
        match: defaultMatch(),
        response: defaultResponse(),
      });
      onSelect(mock.id);
      return next;
    });
  };

  const handleDrop = useCallback(
    (target: DropTarget) => {
      const sourceId = dragId;
      setDragId(null);
      setDropTarget(null);
      if (!sourceId || sourceId === target.nodeId) return;

      void update((w) => {
        const destination = findNode(w.tree, target.nodeId);
        if (!destination) return w;

        if (target.zone === 'inside') {
          return moveNode(w, sourceId, target.nodeId);
        }

        // Dropping between rows means "become a sibling of that row". The index
        // is computed against the sibling list *after* removal, so a node moving
        // down within its own parent lands where the indicator was rather than
        // one slot short.
        const parentId = destination.parentId;
        // The root can always receive; only a real folder can be inside itself.
        if (parentId !== null && isSelfOrDescendant(w.tree, sourceId, parentId)) return w;

        const source = findNode(w.tree, sourceId);
        const sameParent = source?.parentId === parentId;
        const movingDown = sameParent && source!.node.order < destination.node.order;

        let index = destination.node.order + (target.zone === 'after' ? 1 : 0);
        if (movingDown) index -= 1;

        return moveNode(w, sourceId, parentId, index);
      });
    },
    [dragId, update],
  );

  const rows = filtered.tree;

  return (
    <div className="tree-panel">
      <div className="tree-toolbar">
        <input
          className="search"
          value={search}
          placeholder="Filter by name, tag, url…"
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
        {search && (
          <button className="icon" title="Clear the filter" onClick={() => setSearch('')}>
            ×
          </button>
        )}
        <button className="icon" title="New folder" onClick={addFolder}>
          <FolderPlusIcon />
        </button>
        <button className="icon" title="New mock" onClick={addMock}>
          <FilePlusIcon />
        </button>
        <div className="menu-wrap">
          <button
            className="icon"
            title="More"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ⋯
          </button>
          {menuOpen && (
            <TreeMenu
              workspace={workspace}
              update={update}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
      </div>

      {searching && (
        <div className="tree-filter-note">
          {filtered.matched.size === 0
            ? 'Nothing matches that filter.'
            : `${filtered.matched.size} match${filtered.matched.size === 1 ? '' : 'es'}`}
        </div>
      )}

      <div
        className="tree-scroll"
        onClick={(e) => {
          // A click on the empty space below the rows deselects.
          if (e.target === e.currentTarget) onSelect(null);
        }}
      >
        {rows.length === 0 && !searching && (
          <p className="empty">
            Nothing here yet. Use the folder and file buttons above, or capture a request from the
            log below.
          </p>
        )}

        {rows.map((node) => (
          <Row
            key={node.id}
            node={node}
            depth={0}
            ancestors={[]}
            workspace={workspace}
            tagsById={tagsById}
            update={update}
            selectedId={selectedId}
            onSelect={onSelect}
            matched={filtered.matched}
            forceExpanded={searching}
            renaming={renaming}
            setRenaming={setRenaming}
            dragId={dragId}
            setDragId={setDragId}
            dropTarget={dropTarget}
            setDropTarget={setDropTarget}
            onDrop={handleDrop}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface RowProps {
  node: TreeNode;
  depth: number;
  ancestors: Folder[];
  workspace: Workspace;
  tagsById: ReadonlyMap<string, Tag>;
  update: Update;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  matched: ReadonlySet<string>;
  forceExpanded: boolean;
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  dragId: string | null;
  setDragId: (id: string | null) => void;
  dropTarget: DropTarget | null;
  setDropTarget: (target: DropTarget | null) => void;
  onDrop: (target: DropTarget) => void;
}

function Row(props: RowProps): React.JSX.Element {
  const {
    node,
    depth,
    ancestors,
    workspace,
    tagsById,
    update,
    selectedId,
    onSelect,
    matched,
    forceExpanded,
    renaming,
    setRenaming,
    dragId,
    setDragId,
    dropTarget,
    setDropTarget,
    onDrop,
  } = props;

  // Narrowed once into a pair of nullable consts, because `node` is a union and
  // TypeScript cannot carry a narrowing through the JSX below on its own.
  const folder = isFolder(node) ? node : null;
  const mock = isFolder(node) ? null : node;

  const expanded = folder ? forceExpanded || folder.expanded : false;
  const selected = selectedId === node.id;

  const activation = mock
    ? explainMock(workspace, ancestors, mock, inspectedTabId, tagsById)
    : null;

  const tags = node.tagIds
    .map((id) => tagsById.get(id))
    .filter((tag): tag is Tag => tag !== undefined);

  const toggleEnabled = (next: boolean): void => {
    void update((w) => setEnabled(w, folder ? 'folder' : 'mock', node.id, next));
  };

  const dropZoneFor = (event: React.DragEvent<HTMLDivElement>): DropZone => {
    const box = event.currentTarget.getBoundingClientRect();
    const offset = (event.clientY - box.top) / box.height;
    // Only a folder has an "inside": the middle band of the row. A mock is a
    // leaf, so its whole height splits between before and after.
    if (!folder) return offset < 0.5 ? 'before' : 'after';
    if (offset < 0.25) return 'before';
    if (offset > 0.75) return 'after';
    return 'inside';
  };

  const indicator = dropTarget?.nodeId === node.id ? dropTarget.zone : null;

  return (
    <>
      <div
        className={[
          'row',
          folder ? 'row-folder' : 'row-mock',
          selected ? 'selected' : '',
          activation && !activation.active ? 'inert' : '',
          matched.has(node.id) ? 'matched' : '',
          dragId === node.id ? 'dragging' : '',
          indicator ? `drop-${indicator}` : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => setRenaming(node.id)}
        draggable={renaming !== node.id}
        onDragStart={(e) => {
          e.stopPropagation();
          setDragId(node.id);
          e.dataTransfer.effectAllowed = 'move';
          // Firefox refuses to start a drag without payload; the id itself is
          // tracked in React state, since dataTransfer is unreadable mid-drag.
          e.dataTransfer.setData('text/plain', node.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setDropTarget(null);
        }}
        onDragOver={(e) => {
          if (!dragId || dragId === node.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const zone = dropZoneFor(e);
          if (dropTarget?.nodeId !== node.id || dropTarget.zone !== zone) {
            setDropTarget({ nodeId: node.id, zone });
          }
        }}
        onDragLeave={(e) => {
          // Ignore the leave events fired while crossing this row's own children.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          if (dropTarget?.nodeId === node.id) setDropTarget(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDrop({ nodeId: node.id, zone: dropZoneFor(e) });
        }}
      >
        {folder ? (
          <button
            className={`twisty ${expanded ? 'open' : ''}`}
            title={expanded ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation();
              // While searching, expansion is imposed by the filter, so the
              // stored flag is not what is on screen and toggling it would look
              // like nothing happened.
              if (forceExpanded) return;
              void update((w) => setExpanded(w, folder.id, !folder.expanded));
            }}
          >
            <ChevronIcon />
          </button>
        ) : (
          <span className="twisty-spacer" />
        )}

        <input
          type="checkbox"
          className="row-check"
          checked={node.enabled}
          title={node.enabled ? 'Disable' : 'Enable'}
          onClick={(e) => e.stopPropagation()}
          // `next` is read synchronously on purpose. `update` awaits before it
          // applies the change, and React restores a controlled input's DOM
          // state as soon as the handler returns — so reading `e.target.checked`
          // inside the async closure would see the value React just reverted to,
          // and the toggle would appear stuck. Same everywhere below.
          onChange={(e) => toggleEnabled(e.target.checked)}
        />

        {mock ? <MethodBadge method={mock.match.method} /> : <FolderIcon open={expanded} />}

        {renaming === node.id ? (
          <RenameInput
            initial={node.name}
            onDone={(name) => {
              setRenaming(null);
              if (name && name !== node.name) void update((w) => renameNode(w, node.id, name));
            }}
          />
        ) : (
          <span className="row-name" title={mock ? mock.match.urlPattern : node.name}>
            {node.name}
          </span>
        )}

        {mock?.label && <span className="row-label">{mock.label}</span>}

        {tags.map((tag) => (
          <span
            key={tag.id}
            className={`dot ${tag.enabled ? '' : 'off'}`}
            style={{ background: tag.color }}
            title={tag.enabled ? tag.name : `${tag.name} (disabled)`}
          />
        ))}

        {activation && !activation.active && activation.reason !== 'tab-not-targeted' && (
          <span className="row-why" title={REASON_TEXT[activation.reason!]}>
            !
          </span>
        )}
      </div>

      {folder &&
        expanded &&
        folder.children.map((child) => (
          <Row
            {...props}
            key={child.id}
            node={child}
            depth={depth + 1}
            ancestors={[...ancestors, folder]}
          />
        ))}
    </>
  );
}

/** An input that commits on blur or Enter and abandons on Escape. */
function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (name: string | null) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  const cancelled = useRef(false);

  return (
    <input
      className="rename"
      value={value}
      autoFocus
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(cancelled.current ? null : value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onFocus={(e) => e.currentTarget.select()}
    />
  );
}

// ---------------------------------------------------------------------------
// Overflow menu
// ---------------------------------------------------------------------------

function TreeMenu({
  workspace,
  update,
  onClose,
}: {
  workspace: Workspace;
  update: Update;
  onClose: () => void;
}): React.JSX.Element {
  const run = (fn: (w: Workspace) => Workspace): void => {
    void update(fn);
    onClose();
  };

  return (
    <>
      {/* Full-viewport backdrop, so a click anywhere else dismisses the menu. */}
      <div className="menu-backdrop" onClick={onClose} />
      <div className="menu" role="menu">
        <button onClick={() => run((w) => setAllExpanded(w, true))}>Expand all</button>
        <button onClick={() => run((w) => setAllExpanded(w, false))}>Collapse all</button>
        <hr />
        <TagManager workspace={workspace} update={update} />
      </div>
    </>
  );
}

/**
 * Tag creation, colouring and the global on/off veto.
 *
 * Tags are attached to individual nodes from the detail panel; this is the
 * workspace-wide list. Turning one off here deactivates everything carrying it
 * without touching any node's own enabled flag, which is the cheapest way to
 * switch off a cross-cutting slice of mocks.
 */
function TagManager({
  workspace,
  update,
}: {
  workspace: Workspace;
  update: Update;
}): React.JSX.Element {
  const [name, setName] = useState('');

  const add = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setName('');
    void update((w) => {
      // Two tags with the same name would be indistinguishable in the search
      // box, which is the main way tags get used.
      const existing = w.tags.some((tag) => tag.name.toLowerCase() === trimmed.toLowerCase());
      return existing ? w : createTag(w, { name: trimmed }).workspace;
    });
  };

  return (
    <div className="tag-manager">
      <div className="menu-heading">Tags</div>
      {workspace.tags.length === 0 && <p className="empty small">No tags yet.</p>}

      {workspace.tags.map((tag) => (
        <div className="tag-row" key={tag.id}>
          <input
            type="checkbox"
            checked={tag.enabled}
            title={tag.enabled ? 'Disable everywhere' : 'Re-enable everywhere'}
            onChange={(e) => {
              const next = e.target.checked;
              void update((w) => setEnabled(w, 'tag', tag.id, next));
            }}
          />
          <span className="dot" style={{ background: tag.color }} />
          <span className="tag-name">{tag.name}</span>
          <button
            className="icon"
            title="Delete this tag (the mocks carrying it are kept)"
            onClick={() => void update((w) => deleteTag(w, tag.id))}
          >
            ×
          </button>
        </div>
      ))}

      <div className="tag-row">
        <input
          className="grow"
          value={name}
          placeholder="New tag…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button onClick={add}>Add</button>
      </div>
      <p className="hint small">Disabling a tag overrides everything it is attached to.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function MethodBadge({ method }: { method: string }): React.JSX.Element {
  return <span className={`method m-${method.toLowerCase()}`}>{method}</span>;
}

/**
 * The expand/collapse arrow.
 *
 * One glyph rotated by CSS rather than two, so the two states cannot drift
 * apart optically and the transition is free. Stroked, not filled: a filled
 * triangle this small renders as a smudge, whereas a 1.6px stroke stays crisp.
 */
function ChevronIcon(): React.JSX.Element {
  return (
    <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6.5 3.5 11 8l-4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The classic tabbed folder, drawn to read at 15px.
 *
 * Filled rather than outlined: at this size an outline folder and an outline
 * file are nearly the same shape, and the solid silhouette is what makes a
 * folder recognisable at a glance. The open state tilts the front panel, which
 * is the only open-folder convention people actually read as "open".
 */
function FolderIcon({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg className="glyph folder" viewBox="0 0 16 16" aria-hidden="true">
      {open ? (
        <>
          {/* Back plate, visible above and behind the tilted front. */}
          <path
            d="M1 4.25c0-.69.56-1.25 1.25-1.25h3.4c.33 0 .65.13.88.37L7.7 4.5h5.05c.69 0 1.25.56 1.25 1.25V7H4.9a1.75 1.75 0 0 0-1.66 1.2L1 13.2V4.25z"
            fill="currentColor"
            opacity="0.6"
          />
          {/* Front panel, sheared right. */}
          <path
            d="M4.9 8h9.85c.6 0 1.02.58.84 1.15l-1.3 4.1c-.16.5-.63.85-1.16.85H2.2a.85.85 0 0 1-.8-1.13l2.05-4.4c.17-.35.52-.57.9-.57z"
            fill="currentColor"
          />
        </>
      ) : (
        <path
          d="M1 4.25c0-.69.56-1.25 1.25-1.25h3.4c.33 0 .65.13.88.37L7.7 4.5h6.05c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H2.25C1.56 13.5 1 12.94 1 12.25v-8z"
          fill="currentColor"
        />
      )}
    </svg>
  );
}

/** Toolbar: new folder. The plus sits outside the folder so both stay legible. */
function FolderPlusIcon(): React.JSX.Element {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1 4.25c0-.69.56-1.25 1.25-1.25h3.4c.33 0 .65.13.88.37L7.7 4.5h4.05c.69 0 1.25.56 1.25 1.25v2.4A4.5 4.5 0 0 0 7.2 13.5H2.25C1.56 13.5 1 12.94 1 12.25v-8z"
        fill="currentColor"
      />
      <path
        d="M11.5 9.5v4M9.5 11.5h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Toolbar: new mock. A document with a folded corner, plus the same plus. */
function FilePlusIcon(): React.JSX.Element {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 2.25c0-.69.56-1.25 1.25-1.25H9l4 4v3.15A4.5 4.5 0 0 0 7.2 14H4.25C3.56 14 3 13.44 3 12.75v-10.5z"
        fill="currentColor"
      />
      {/* The folded corner, knocked out so it reads as a fold, not a notch. */}
      <path d="M9 1l4 4H9.6A.6.6 0 0 1 9 4.4V1z" fill="var(--bg)" opacity="0.85" />
      <path
        d="M11.5 9.5v4M9.5 11.5h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
