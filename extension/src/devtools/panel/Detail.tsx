import { useCallback, useMemo, useState } from 'react';
import {
  compilePattern,
  deleteNode,
  duplicateNode,
  explainMock,
  findNode,
  indexTags,
  isFolder,
  renameNode,
  setNodeTags,
  updateMock,
} from '@mockman/shared';
import type {
  BodyMatchMode,
  Folder,
  HttpMethod,
  Mock,
  Workspace,
} from '@mockman/shared';

import { CodeEditor } from './CodeEditor.tsx';
import { inspectedTabId } from './messaging.ts';
import type { Update } from './messaging.ts';
import {
  BODY_MODE_HINT,
  BODY_MODE_LABEL,
  COMMON_STATUSES,
  METHODS,
  REASON_TEXT,
  statusClass,
} from './labels.ts';

// MVP: the response payload is the only editable pane for now. The request-body
// matcher and the response-header editor are hidden — restore the commented-out
// members here and the blocks below to bring them back.
type PayloadTab = 'response' /* | 'request' | 'headers' */;

export function Detail({
  workspace,
  selectedId,
  update,
  onSelect,
}: {
  workspace: Workspace;
  selectedId: string | null;
  update: Update;
  onSelect: (id: string | null) => void;
}): React.JSX.Element {
  const located = useMemo(
    () => (selectedId ? findNode(workspace.tree, selectedId) : null),
    [workspace.tree, selectedId],
  );

  if (!located) {
    return (
      <div className="detail empty-detail">
        <p className="empty">Select a mock on the left to edit it.</p>
      </div>
    );
  }

  if (isFolder(located.node)) {
    return (
      <FolderDetail
        workspace={workspace}
        folder={located.node}
        ancestors={located.ancestors}
        update={update}
        onSelect={onSelect}
      />
    );
  }

  return (
    <MockDetail
      workspace={workspace}
      mock={located.node}
      ancestors={located.ancestors}
      update={update}
      onSelect={onSelect}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function Breadcrumb({ ancestors }: { ancestors: readonly Folder[] }): React.JSX.Element {
  return (
    <div className="breadcrumb">
      {ancestors.length === 0 ? (
        <span className="crumb muted">Top level</span>
      ) : (
        ancestors.map((folder, index) => (
          <span key={folder.id}>
            {index > 0 && <span className="sep">›</span>}
            <span className={`crumb ${folder.enabled ? '' : 'off'}`}>{folder.name}</span>
          </span>
        ))
      )}
    </div>
  );
}

/** The tag chips on a node, and the picker for adding more. */
function TagStrip({
  workspace,
  nodeId,
  tagIds,
  update,
}: {
  workspace: Workspace;
  nodeId: string;
  tagIds: readonly string[];
  update: Update;
}): React.JSX.Element {
  const set = (next: string[]): void => void update((w) => setNodeTags(w, nodeId, next));

  if (workspace.tags.length === 0) {
    return <span className="hint small">Create tags from the ⋯ menu to group across folders.</span>;
  }

  return (
    <span className="tag-strip">
      {workspace.tags.map((tag) => {
        const on = tagIds.includes(tag.id);
        return (
          <button
            key={tag.id}
            className={`chip ${on ? 'on' : ''} ${tag.enabled ? '' : 'tag-off'}`}
            style={on ? { background: tag.color, borderColor: tag.color } : { borderColor: tag.color }}
            title={
              on
                ? `Remove the ${tag.name} tag`
                : `Add the ${tag.name} tag${tag.enabled ? '' : ' (currently disabled everywhere)'}`
            }
            onClick={() => set(on ? tagIds.filter((id) => id !== tag.id) : [...tagIds, tag.id])}
          >
            {tag.name}
          </button>
        );
      })}
    </span>
  );
}

function NodeActions({
  nodeId,
  update,
  onSelect,
}: {
  nodeId: string;
  update: Update;
  onSelect: (id: string | null) => void;
}): React.JSX.Element {
  return (
    <span className="node-actions">
      <button
        title="Duplicate"
        onClick={() =>
          void update((w) => {
            const { workspace: next, node } = duplicateNode(w, nodeId);
            if (node) onSelect(node.id);
            return next;
          })
        }
      >
        Duplicate
      </button>
      <button
        className="danger"
        title="Delete"
        onClick={() => {
          onSelect(null);
          void update((w) => deleteNode(w, nodeId));
        }}
      >
        Delete
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Folder
// ---------------------------------------------------------------------------

function FolderDetail({
  workspace,
  folder,
  ancestors,
  update,
  onSelect,
}: {
  workspace: Workspace;
  folder: Folder;
  ancestors: Folder[];
  update: Update;
  onSelect: (id: string | null) => void;
}): React.JSX.Element {
  const counts = useMemo(() => {
    let mocks = 0;
    let folders = 0;
    const walk = (nodes: readonly (Folder | Mock)[]): void => {
      for (const node of nodes) {
        if (isFolder(node)) {
          folders++;
          walk(node.children);
        } else mocks++;
      }
    };
    walk(folder.children);
    return { mocks, folders };
  }, [folder]);

  return (
    <div className="detail">
      <Breadcrumb ancestors={ancestors} />

      <div className="title-row">
        <input
          className="title-input"
          value={folder.name}
          spellCheck={false}
          onChange={(e) => {
            const name = e.target.value;
            void update((w) => renameNode(w, folder.id, name));
          }}
        />
        <NodeActions nodeId={folder.id} update={update} onSelect={onSelect} />
      </div>

      <div className="field-row">
        <label className="field">
          <span>Tags</span>
          <TagStrip workspace={workspace} nodeId={folder.id} tagIds={folder.tagIds} update={update} />
        </label>
      </div>

      <p className="hint">
        A folder groups mocks and can be switched off as a unit — disabling it deactivates
        everything inside, however deep. It holds {counts.mocks} mock
        {counts.mocks === 1 ? '' : 's'}
        {counts.folders > 0 && ` in ${counts.folders} nested folder${counts.folders === 1 ? '' : 's'}`}.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

function MockDetail({
  workspace,
  mock,
  ancestors,
  update,
  onSelect,
}: {
  workspace: Workspace;
  mock: Mock;
  ancestors: Folder[];
  update: Update;
  onSelect: (id: string | null) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<PayloadTab>('response');
  // MVP: the pattern tester is hidden, see the commented-out block below.
  // const [testUrl, setTestUrl] = useState('');

  const tagsById = useMemo(() => indexTags(workspace.tags), [workspace.tags]);
  const activation = explainMock(workspace, ancestors, mock, inspectedTabId, tagsById);

  // Stable across renders, so the payload editors below can be memoised on it.
  const patch = useCallback(
    (changes: Partial<Mock>): void => {
      void update((w) => updateMock(w, mock.id, changes));
    },
    [update, mock.id],
  );

  // Memoised on the pattern itself: this compiles a `RegExp`, and editing the
  // payload or any other field is no reason to compile it again.
  const compiled = useMemo(
    () => compilePattern(mock.match.urlPattern, mock.match.patternKind),
    [mock.match.urlPattern, mock.match.patternKind],
  );
  const patternValid = compiled !== null;
  // const testMatches = patternValid && testUrl ? compiled.test(testUrl) : null;

  return (
    <div className="detail">
      <Breadcrumb ancestors={ancestors} />

      <div className="title-row">
        <input
          className="title-input"
          value={mock.name}
          placeholder="Mock name"
          spellCheck={false}
          // Read before awaiting, for the same reason as the checkboxes in the
          // tree: React reverts a controlled input once the handler returns.
          onChange={(e) => {
            const name = e.target.value;
            void update((w) => renameNode(w, mock.id, name));
          }}
        />
        <NodeActions nodeId={mock.id} update={update} onSelect={onSelect} />
      </div>

      {!activation.active && activation.reason !== 'tab-not-targeted' && (
        <div className="inactive-note">
          Not firing: {REASON_TEXT[activation.reason!].toLowerCase()}.
        </div>
      )}

      <div className="url-row">
        <select
          className="pattern-kind"
          value={mock.match.patternKind}
          title="How the URL below is interpreted"
          onChange={(e) =>
            patch({ match: { ...mock.match, patternKind: e.target.value as 'glob' | 'regex' } })
          }
        >
          <option value="glob">glob</option>
          <option value="regex">regex</option>
        </select>
        <input
          className={`url-input ${patternValid ? '' : 'invalid'}`}
          value={mock.match.urlPattern}
          placeholder="https://api.example.com/v1/*"
          spellCheck={false}
          onChange={(e) => patch({ match: { ...mock.match, urlPattern: e.target.value } })}
        />
      </div>

      {!patternValid && <p className="error">That regular expression does not compile.</p>}
      {mock.match.patternKind === 'glob' && (
        <p className="hint">
          A glob is matched against the <em>whole</em> URL, so start it with <code>*</code> unless
          you mean an exact match.
        </p>
      )}

      <div className="field-row">
        <label className="field">
          <span>HTTP Method</span>
          <select
            value={mock.match.method}
            onChange={(e) =>
              patch({ match: { ...mock.match, method: e.target.value as HttpMethod | '*' } })
            }
          >
            {METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </label>

        <label className="field narrow">
          <span>Status code</span>
          <StatusInput
            status={mock.response.status}
            onChange={(status) => patch({ response: { ...mock.response, status } })}
          />
        </label>

        <label className="field narrow">
          <span>Delay by (ms)</span>
          <input
            type="number"
            min={0}
            step={100}
            value={mock.response.delayMs}
            title="Artificial latency before this response is delivered"
            onChange={(e) =>
              patch({
                response: { ...mock.response, delayMs: Math.max(0, Number(e.target.value) || 0) },
              })
            }
          />
        </label>

        {/* MVP: the optional label badge is hidden for now.
        <label className="field grow">
          <span>Label</span>
          <input
            value={mock.label ?? ''}
            placeholder="Optional badge, e.g. “empty state”"
            spellCheck={false}
            title="Shown beside this mock in the tree and the log"
            // `''` rather than `undefined` for an emptied field: `applyPatch`
            // skips undefined values (an absent key in a patch means "leave this
            // alone"), so undefined here would make the label unclearable.
            // Everything that renders a label already tests it for truthiness.
            onChange={(e) => patch({ label: e.target.value })}
          />
        </label>
        */}
      </div>

      <div className="field-row">
        <label className="field grow">
          <span>Tags</span>
          <TagStrip workspace={workspace} nodeId={mock.id} tagIds={mock.tagIds} update={update} />
        </label>
      </div>

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'response'}
          className={tab === 'response' ? 'active' : ''}
          onClick={() => setTab('response')}
        >
          Response payload
        </button>
        {/* MVP: the request-payload and response-header tabs are hidden.
        <button
          role="tab"
          aria-selected={tab === 'request'}
          className={tab === 'request' ? 'active' : ''}
          onClick={() => setTab('request')}
        >
          Request payload
          {mock.match.body?.value ? <span className="pip" title="A body matcher is set" /> : null}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'headers'}
          className={tab === 'headers' ? 'active' : ''}
          onClick={() => setTab('headers')}
        >
          Response headers
          {Object.keys(mock.response.headers).length > 0 && (
            <span className="count">{Object.keys(mock.response.headers).length}</span>
          )}
        </button>
        */}
      </div>

      <div className="tab-body">
        {tab === 'response' && <ResponsePayload mock={mock} patch={patch} />}
        {/* MVP: hidden along with their tabs above.
        {tab === 'request' && <RequestPayload mock={mock} patch={patch} />}
        {tab === 'headers' && (
          <HeadersEditor
            headers={mock.response.headers}
            onChange={(headers) => patch({ response: { ...mock.response, headers } })}
          />
        )}
        */}
      </div>

      {/* MVP: the pattern tester is hidden until it earns its keep.
      <div className="tester">
        <input
          className="grow"
          value={testUrl}
          placeholder="Paste a real URL here to test the pattern"
          spellCheck={false}
          onChange={(e) => setTestUrl(e.target.value)}
        />
        {testMatches !== null && (
          <span className={testMatches ? 'match-yes' : 'match-no'}>
            {testMatches ? 'matches' : 'no match'}
          </span>
        )}
      </div>
      */}
    </div>
  );
}

/**
 * The status code field.
 *
 * It keeps its own text, because the workspace must only ever hold a status the
 * `Response` constructor accepts. Writing through on every keystroke cannot do
 * both: clearing the field to retype it yields `Number('') === 0`, and a stored
 * `0` makes `new Response` throw inside the page on the next matching request.
 *
 * So the text is local and free-form, and only a value in 100–599 is committed.
 * Anything else shows as invalid and leaves the last good value in place.
 */
function StatusInput({
  status,
  onChange,
}: {
  status: number;
  onChange: (status: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(String(status));

  // Re-sync when the selection changes, or when someone else (MCP, another
  // panel) edits this mock — but not while the field is being typed in.
  const [lastSeen, setLastSeen] = useState(status);
  if (status !== lastSeen) {
    setLastSeen(status);
    setText(String(status));
  }

  const parsed = Number(text);
  const valid = /^\d+$/.test(text.trim()) && parsed >= 100 && parsed <= 599;

  return (
    <>
      <input
        className={`${valid ? statusClass(parsed) : 'invalid'}`}
        type="text"
        inputMode="numeric"
        list="common-statuses"
        value={text}
        title={valid ? undefined : 'A status must be between 100 and 599'}
        onChange={(e) => {
          setText(e.target.value);
          const next = Number(e.target.value);
          if (/^\d+$/.test(e.target.value.trim()) && next >= 100 && next <= 599) {
            setLastSeen(next);
            onChange(next);
          }
        }}
        onBlur={() => {
          // Never leave the field showing something the workspace does not hold.
          if (!valid) setText(String(status));
        }}
      />
      <datalist id="common-statuses">
        {COMMON_STATUSES.map(([code, reason]) => (
          <option key={code} value={code}>
            {reason}
          </option>
        ))}
      </datalist>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab bodies
// ---------------------------------------------------------------------------

/**
 * The parse error in `text`, or null if it holds valid JSON.
 *
 * An empty or blank string is not an error: a payload you have not written yet
 * is not a payload you got wrong. Pass `''` to skip the check entirely, which is
 * how both callers express "this field is not JSON right now".
 */
function jsonErrorIn(text: string): string | null {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid JSON';
  }
}

function ResponsePayload({
  mock,
  patch,
}: {
  mock: Mock;
  patch: (changes: Partial<Mock>) => void;
}): React.JSX.Element {
  // Memoised on the body, because parsing a large payload is the most expensive
  // thing this pane does and nothing else that re-renders it changes the answer.
  const bodyError = useMemo(
    () => jsonErrorIn(mock.response.bodyKind === 'json' ? mock.response.body : ''),
    [mock.response.bodyKind, mock.response.body],
  );

  // Stable while the response is, which is what lets `CodeEditor` skip a render
  // when something else in the form moved. `mock.response` keeps its identity
  // across a patch to any other field, so this only changes when it has to.
  const setBody = useCallback(
    (body: string) => patch({ response: { ...mock.response, body } }),
    [patch, mock.response],
  );

  const format = (): void => {
    try {
      setBody(JSON.stringify(JSON.parse(mock.response.body), null, 2));
    } catch {
      /* the error is already on screen; nothing useful to do */
    }
  };

  return (
    <>
      <div className="tab-toolbar">
        <select
          value={mock.response.bodyKind}
          onChange={(e) =>
            patch({ response: { ...mock.response, bodyKind: e.target.value as 'json' | 'text' } })
          }
        >
          <option value="json">json</option>
          <option value="text">text</option>
        </select>
        {mock.response.bodyKind === 'json' && (
          <button onClick={format} disabled={bodyError !== null || !mock.response.body.trim()}>
            Format
          </button>
        )}
        {bodyError && <span className="error">Invalid JSON: {bodyError}</span>}
      </div>

      <CodeEditor
        value={mock.response.body}
        invalid={bodyError !== null}
        placeholder="The body this mock responds with"
        onChange={setBody}
      />
    </>
  );
}

/**
 * The optional request-body condition.
 *
 * Off by default, because most mocks are identified by URL alone. Switching it
 * on narrows the mock: it then only answers requests whose outgoing body
 * satisfies the condition, and requests whose body cannot be read (a stream, a
 * Blob, a FormData) never satisfy one.
 */
function RequestPayload({
  mock,
  patch,
}: {
  mock: Mock;
  patch: (changes: Partial<Mock>) => void;
}): React.JSX.Element {
  const body = mock.match.body;
  const enabled = body !== undefined;

  const setBody = useCallback(
    (next: { mode?: BodyMatchMode; value?: string } | null): void => {
      if (next === null) {
        const { body: _dropped, ...rest } = mock.match;
        patch({ match: rest });
        return;
      }
      patch({
        match: {
          ...mock.match,
          body: {
            mode: next.mode ?? body?.mode ?? 'json-subset',
            value: next.value ?? body?.value ?? '',
          },
        },
      });
    },
    [patch, mock.match, body?.mode, body?.value],
  );

  // Stable for as long as `setBody` is, so the editor can be memoised on it.
  const setBodyValue = useCallback((value: string) => setBody({ value }), [setBody]);

  const jsonError = useMemo(
    () => jsonErrorIn(body?.mode === 'json-subset' ? body.value : ''),
    [body?.mode, body?.value],
  );

  return (
    <>
      <div className="tab-toolbar">
        <label className="inline-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setBody(e.target.checked ? {} : null)}
          />
          Only match when the request body…
        </label>
        {enabled && (
          <select
            value={body.mode}
            onChange={(e) => setBody({ mode: e.target.value as BodyMatchMode })}
          >
            {(Object.keys(BODY_MODE_LABEL) as BodyMatchMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {BODY_MODE_LABEL[mode]}
              </option>
            ))}
          </select>
        )}
        {jsonError && <span className="error">Invalid JSON: {jsonError}</span>}
      </div>

      {enabled ? (
        <>
          <CodeEditor
            value={body.value}
            invalid={jsonError !== null}
            minRows={6}
            placeholder={
              body.mode === 'json-subset' ? '{\n  "action": "save"\n}' : 'Text to look for'
            }
            onChange={setBodyValue}
          />
          <p className="hint">{BODY_MODE_HINT[body.mode]}</p>
          {body.value === '' && (
            <p className="hint">
              An empty condition is ignored, so the mock still matches on URL and method alone.
            </p>
          )}
        </>
      ) : (
        <p className="hint pad">
          This mock matches on URL and method alone. Tick the box above to narrow it to requests
          carrying a particular body — useful when one endpoint does several things depending on
          what you post to it.
        </p>
      )}
    </>
  );
}

function HeadersEditor({
  headers,
  onChange,
}: {
  headers: Record<string, string>;
  onChange: (headers: Record<string, string>) => void;
}): React.JSX.Element {
  const entries = Object.entries(headers);

  return (
    <div className="headers">
      {entries.length === 0 && (
        <p className="hint pad">
          No headers set. A <code>content-type</code> is derived from the payload kind unless you
          override it here.
        </p>
      )}

      {entries.map(([key, value], index) => (
        // Keyed by index, not by name: an empty or duplicated key is a normal
        // intermediate state while typing, and keying by name would remount the
        // input on every keystroke and lose focus.
        <div className="header-row" key={index}>
          <input
            value={key}
            placeholder="Header"
            spellCheck={false}
            onChange={(e) =>
              onChange(
                Object.fromEntries(
                  entries.map(([k, v], i) => (i === index ? [e.target.value, v] : [k, v])),
                ),
              )
            }
          />
          <input
            className="grow"
            value={value}
            placeholder="Value"
            spellCheck={false}
            onChange={(e) =>
              onChange(
                Object.fromEntries(
                  entries.map(([k, v], i) => (i === index ? [k, e.target.value] : [k, v])),
                ),
              )
            }
          />
          <button
            className="icon"
            title="Remove this header"
            onClick={() => onChange(Object.fromEntries(entries.filter((_, i) => i !== index)))}
          >
            ×
          </button>
        </div>
      ))}

      <button onClick={() => onChange({ ...headers, '': '' })} disabled={'' in headers}>
        + Header
      </button>
    </div>
  );
}

