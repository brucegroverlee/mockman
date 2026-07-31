import { useMemo, useState } from 'react';
import {
  compilePattern,
  createGroup,
  createMock,
  createTag,
  deleteGroup,
  deleteMock,
  deleteTag,
  explainMock,
  indexTags,
  setEnabled,
  updateMock,
} from '@network-mock/shared';
import type { Group, HttpMethod, InactiveReason, Mock, Workspace } from '@network-mock/shared';

import { inspectedTabId, send, useHits, useTabs, useWorkspace } from './messaging.ts';
import { RecordedRequests } from './RecordedRequests.tsx';

const METHODS: (HttpMethod | '*')[] = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const REASON_TEXT: Record<InactiveReason, string> = {
  'workspace-disabled': 'Master switch is off',
  'tab-not-targeted': 'This tab is not targeted',
  'group-disabled': 'Its group is disabled',
  'mock-disabled': 'This mock is disabled',
  'tag-disabled': 'A tag on it is disabled',
};

export function App(): React.JSX.Element {
  const { workspace, update } = useWorkspace();
  const { hits, clear } = useHits();
  const tabs = useTabs();
  const [selectedMockId, setSelectedMockId] = useState<string | null>(null);

  if (!workspace) return <div className="loading">Connecting to the extension…</div>;

  const targeting = workspace.targetTabIds;
  const inspectedIsTargeted = targeting.includes(inspectedTabId);

  const toggleTargetTab = async (tabId: number, on: boolean): Promise<void> => {
    const next = on ? [...new Set([...targeting, tabId])] : targeting.filter((id) => id !== tabId);
    await send({ type: 'set-target-tabs', tabIds: next });
  };

  return (
    <div className="app">
      <header className="bar">
        <label className="master">
          <input
            type="checkbox"
            checked={workspace.enabled}
            onChange={(e) => void update((w) => setEnabled(w, 'workspace', null, e.target.checked))}
          />
          <strong>Mocking {workspace.enabled ? 'on' : 'off'}</strong>
        </label>

        <div className="tabs-picker">
          <span className="label">Target tabs</span>
          <label className="chip">
            <input
              type="checkbox"
              checked={inspectedIsTargeted}
              onChange={(e) => void toggleTargetTab(inspectedTabId, e.target.checked)}
            />
            This tab ({inspectedTabId})
          </label>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) void toggleTargetTab(Number(e.target.value), true);
            }}
          >
            <option value="">Add another tab…</option>
            {tabs
              .filter((t) => t.id !== inspectedTabId && !targeting.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title.slice(0, 60)} — {t.url.slice(0, 40)}
                </option>
              ))}
          </select>
          {targeting
            .filter((id) => id !== inspectedTabId)
            .map((id) => (
              <span key={id} className="chip other">
                Tab {id}
                <button onClick={() => void toggleTargetTab(id, false)}>×</button>
              </span>
            ))}
        </div>
      </header>

      {!inspectedIsTargeted && (
        <div className="warning">
          This tab is not targeted, so nothing here is being mocked. Tick “This tab” above.
        </div>
      )}

      <TagBar workspace={workspace} update={update} />

      <div className="body">
        <aside className="tree">
          <button
            className="primary"
            onClick={() => void update((w) => createGroup(w, { name: 'New group' }).workspace)}
          >
            + Group
          </button>

          {[...workspace.groups]
            .sort((a, b) => a.order - b.order)
            .map((group) => (
              <GroupRow
                key={group.id}
                group={group}
                workspace={workspace}
                update={update}
                selectedMockId={selectedMockId}
                onSelect={setSelectedMockId}
              />
            ))}

          {workspace.groups.length === 0 && (
            <p className="empty">No groups yet. Create one, then add a mock to it.</p>
          )}
        </aside>

        <main className="editor">
          <MockEditor
            workspace={workspace}
            mockId={selectedMockId}
            update={update}
            onDeleted={() => setSelectedMockId(null)}
          />
        </main>
      </div>

      <RecordedRequests update={update} onCreated={setSelectedMockId} />

      <section className="hits">
        <div className="hits-head">
          <strong>Hit log</strong>
          <span className="hint">
            Mocked requests never reach the network, so they do <em>not</em> appear in the Network
            panel. This is the only place you will see them.
          </span>
          <button onClick={() => void clear()}>Clear</button>
        </div>
        <div className="hit-rows">
          {hits.length === 0 && <p className="empty">No requests seen yet.</p>}
          {[...hits].reverse().map((hit) => (
            <div key={hit.id} className={`hit ${hit.outcome}`}>
              <span className="badge">{hit.outcome === 'mocked' ? 'MOCKED' : 'passed'}</span>
              <span className="method">{hit.method}</span>
              <span className="url" title={hit.url}>
                {hit.url}
              </span>
              {hit.label && <span className="via">{hit.label}</span>}
              {hit.status !== undefined && <span className="status">{hit.status}</span>}
              <span className="tab">tab {hit.tabId}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

type Update = (fn: (current: Workspace) => Workspace) => Promise<void>;

function TagBar({ workspace, update }: { workspace: Workspace; update: Update }): React.JSX.Element {
  return (
    <div className="tagbar">
      <span className="label">Tags</span>
      {workspace.tags.map((tag) => (
        <span
          key={tag.id}
          className={`tag ${tag.enabled ? 'on' : 'off'}`}
          style={{ borderColor: tag.color }}
        >
          <input
            type="checkbox"
            checked={tag.enabled}
            title={tag.enabled ? 'Disable this tag everywhere' : 'Re-enable this tag'}
            onChange={(e) => void update((w) => setEnabled(w, 'tag', tag.id, e.target.checked))}
          />
          {tag.name}
          <button title="Delete tag" onClick={() => void update((w) => deleteTag(w, tag.id))}>
            ×
          </button>
        </span>
      ))}
      <button
        onClick={() => {
          const name = prompt('Tag name');
          if (name) void update((w) => createTag(w, { name }).workspace);
        }}
      >
        + Tag
      </button>
      <span className="hint">Disabling a tag overrides everything it is attached to.</span>
    </div>
  );
}

function GroupRow({
  group,
  workspace,
  update,
  selectedMockId,
  onSelect,
}: {
  group: Group;
  workspace: Workspace;
  update: Update;
  selectedMockId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const tagsById = useMemo(() => indexTags(workspace.tags), [workspace.tags]);

  return (
    <div className="group">
      <div className="group-head">
        <input
          type="checkbox"
          checked={group.enabled}
          onChange={(e) => void update((w) => setEnabled(w, 'group', group.id, e.target.checked))}
        />
        <input
          className="name"
          value={group.name}
          onChange={(e) =>
            void update((w) => ({
              ...w,
              groups: w.groups.map((g) => (g.id === group.id ? { ...g, name: e.target.value } : g)),
            }))
          }
        />
        <TagPicker
          workspace={workspace}
          selected={group.tagIds}
          onChange={(tagIds) =>
            void update((w) => ({
              ...w,
              groups: w.groups.map((g) => (g.id === group.id ? { ...g, tagIds } : g)),
            }))
          }
        />
        <button
          title="Add a mock to this group"
          onClick={() =>
            void update((w) => {
              const result = createMock(w, group.id, {
                name: 'New mock',
                match: { method: 'GET', urlPattern: '*/api/*', patternKind: 'glob' },
                response: {
                  status: 200,
                  headers: {},
                  body: '{\n  "mocked": true\n}',
                  bodyKind: 'json',
                },
              });
              onSelect(result.mock.id);
              return result.workspace;
            })
          }
        >
          + Mock
        </button>
        <button title="Delete group" onClick={() => void update((w) => deleteGroup(w, group.id))}>
          ×
        </button>
      </div>

      {[...group.mocks]
        .sort((a, b) => a.order - b.order)
        .map((mock) => {
          const activation = explainMock(workspace, group, mock, inspectedTabId, tagsById);
          return (
            <div
              key={mock.id}
              className={`mock ${activation.active ? 'active' : 'inert'} ${
                selectedMockId === mock.id ? 'selected' : ''
              }`}
              onClick={() => onSelect(mock.id)}
            >
              <input
                type="checkbox"
                checked={mock.enabled}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => void update((w) => setEnabled(w, 'mock', mock.id, e.target.checked))}
              />
              <span className="method">{mock.match.method}</span>
              <span className="mock-name">{mock.name}</span>
              <span className="pattern">{mock.match.urlPattern}</span>
              {!activation.active && activation.reason && (
                <span className="why" title={REASON_TEXT[activation.reason]}>
                  {REASON_TEXT[activation.reason]}
                </span>
              )}
            </div>
          );
        })}
    </div>
  );
}

function TagPicker({
  workspace,
  selected,
  onChange,
}: {
  workspace: Workspace;
  selected: string[];
  onChange: (tagIds: string[]) => void;
}): React.JSX.Element {
  return (
    <span className="tagpicker">
      {workspace.tags.map((tag) => {
        const on = selected.includes(tag.id);
        return (
          <button
            key={tag.id}
            className={`minitag ${on ? 'on' : ''}`}
            style={on ? { background: tag.color } : undefined}
            title={on ? `Remove tag ${tag.name}` : `Add tag ${tag.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange(on ? selected.filter((id) => id !== tag.id) : [...selected, tag.id]);
            }}
          >
            {tag.name}
          </button>
        );
      })}
    </span>
  );
}

function MockEditor({
  workspace,
  mockId,
  update,
  onDeleted,
}: {
  workspace: Workspace;
  mockId: string | null;
  update: Update;
  onDeleted: () => void;
}): React.JSX.Element {
  const [testUrl, setTestUrl] = useState('');

  const found = useMemo(() => {
    for (const group of workspace.groups) {
      const mock = group.mocks.find((m) => m.id === mockId);
      if (mock) return { group, mock };
    }
    return null;
  }, [workspace, mockId]);

  if (!found) return <p className="empty">Select a mock to edit it.</p>;
  const { mock } = found;

  const patch = (changes: Partial<Mock>): void => {
    void update((w) => updateMock(w, mock.id, changes));
  };

  const compiled = compilePattern(mock.match.urlPattern, mock.match.patternKind);
  const patternValid = compiled !== null;
  const testMatches = patternValid && testUrl ? compiled.test(testUrl) : null;

  let bodyError: string | null = null;
  if (mock.response.bodyKind === 'json' && mock.response.body.trim()) {
    try {
      JSON.parse(mock.response.body);
    } catch (error) {
      bodyError = error instanceof Error ? error.message : 'Invalid JSON';
    }
  }

  return (
    <div className="mock-editor">
      <div className="row">
        <input
          className="grow"
          value={mock.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="Mock name"
        />
        <TagPicker
          workspace={workspace}
          selected={mock.tagIds}
          onChange={(tagIds) => patch({ tagIds })}
        />
        <button
          onClick={() => {
            void update((w) => deleteMock(w, mock.id));
            onDeleted();
          }}
        >
          Delete
        </button>
      </div>

      <fieldset>
        <legend>Match</legend>
        <div className="row">
          <select
            value={mock.match.method}
            onChange={(e) =>
              patch({ match: { ...mock.match, method: e.target.value as HttpMethod | '*' } })
            }
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={mock.match.patternKind}
            onChange={(e) =>
              patch({
                match: { ...mock.match, patternKind: e.target.value as 'glob' | 'regex' },
              })
            }
          >
            <option value="glob">glob</option>
            <option value="regex">regex</option>
          </select>
          <input
            className={`grow ${patternValid ? '' : 'invalid'}`}
            value={mock.match.urlPattern}
            onChange={(e) => patch({ match: { ...mock.match, urlPattern: e.target.value } })}
            placeholder="*/api/users"
          />
        </div>
        {!patternValid && <p className="error">That regular expression does not compile.</p>}
        {mock.match.patternKind === 'glob' && (
          <p className="hint">
            A glob is matched against the <em>whole</em> URL, so start it with <code>*</code> unless
            you mean an exact match.
          </p>
        )}
        <div className="row">
          <input
            className="grow"
            value={testUrl}
            onChange={(e) => setTestUrl(e.target.value)}
            placeholder="Paste a URL here to test the pattern"
          />
          {testMatches !== null && (
            <span className={testMatches ? 'match-yes' : 'match-no'}>
              {testMatches ? 'matches' : 'no match'}
            </span>
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend>Response</legend>
        <div className="row">
          <input
            type="number"
            value={mock.response.status}
            onChange={(e) =>
              patch({ response: { ...mock.response, status: Number(e.target.value) } })
            }
          />
          <select
            value={mock.response.bodyKind}
            onChange={(e) =>
              patch({
                response: { ...mock.response, bodyKind: e.target.value as 'json' | 'text' },
              })
            }
          >
            <option value="json">json</option>
            <option value="text">text</option>
          </select>
        </div>

        <HeadersEditor
          headers={mock.response.headers}
          onChange={(headers) => patch({ response: { ...mock.response, headers } })}
        />

        <textarea
          className={bodyError ? 'invalid' : ''}
          rows={12}
          value={mock.response.body}
          onChange={(e) => patch({ response: { ...mock.response, body: e.target.value } })}
        />
        {bodyError && <p className="error">Invalid JSON: {bodyError}</p>}
      </fieldset>
    </div>
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
      {entries.map(([key, value], index) => (
        <div className="row" key={`${key}-${index}`}>
          <input
            value={key}
            placeholder="Header"
            onChange={(e) => {
              const next = Object.fromEntries(
                entries.map(([k, v], i) => (i === index ? [e.target.value, v] : [k, v])),
              );
              onChange(next);
            }}
          />
          <input
            className="grow"
            value={value}
            placeholder="Value"
            onChange={(e) => onChange({ ...headers, [key]: e.target.value })}
          />
          <button
            onClick={() => {
              const next = { ...headers };
              delete next[key];
              onChange(next);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button onClick={() => onChange({ ...headers, '': '' })}>+ Header</button>
    </div>
  );
}
