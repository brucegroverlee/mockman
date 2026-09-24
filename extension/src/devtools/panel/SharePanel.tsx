import { useMemo, useRef, useState } from 'react';
import { exportFileName, exportText, findFolder, importNodes, parseImport } from '@mockman/shared';
import type { TreeNode, Workspace } from '@mockman/shared';

import { CodeEditor } from './CodeEditor.tsx';
import type { Update } from './messaging.ts';

/**
 * What the share view is for. Plain data, held by `Detail`, which shows this
 * view in place of the editor until Back is pressed or the selection changes.
 */
export type ShareRequest =
  | { mode: 'export'; nodes: readonly TreeNode[]; title: string }
  | { mode: 'import'; parentId: string | null; title: string };

/**
 * Import or export, shown inside the detail pane rather than as an overlay: a
 * DevTools panel is often short, and a floating dialog ended up partly off
 * screen. Here it simply takes the pane's own size.
 */
export function SharePanel({
  request,
  workspace,
  update,
  onClose,
  onImported,
}: {
  request: ShareRequest;
  workspace: Workspace;
  update: Update;
  onClose: () => void;
  onImported: (firstId: string) => void;
}): React.JSX.Element {
  return (
    <div className="detail share-view" aria-label={request.title}>
      {request.mode === 'export' ? (
        <ExportBody request={request} workspace={workspace} onClose={onClose} />
      ) : (
        <ImportBody request={request} update={update} onClose={onClose} onImported={onImported} />
      )}
    </div>
  );
}

function summary(mocks: number, folders: number): string {
  const m = `${mocks} mock${mocks === 1 ? '' : 's'}`;
  return folders > 0 ? `${m} in ${folders} folder${folders === 1 ? '' : 's'}` : m;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function ExportBody({
  request,
  workspace,
  onClose,
}: {
  request: Extract<ShareRequest, { mode: 'export' }>;
  workspace: Workspace;
  onClose: () => void;
}): React.JSX.Element {
  // Computed once, when the view opens: the document is a snapshot to hand to
  // someone, and it re-rendering under you while you select text would be odd.
  const [text] = useState(() => exportText(workspace, request.nodes));
  const counts = useMemo(() => {
    const parsed = parseImport(text);
    return parsed.ok ? summary(parsed.plan.mocks, parsed.plan.folders) : '';
  }, [text]);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const body = useRef<HTMLDivElement>(null);

  const copy = async (): Promise<void> => {
    if (await copyText(text)) {
      setCopied('done');
      setTimeout(() => setCopied('idle'), 1500);
      return;
    }
    // Leave the text selected so a plain Ctrl+C finishes the job.
    const area = body.current?.querySelector('textarea');
    area?.focus();
    area?.select();
    setCopied('failed');
  };

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFileName(request.nodes.length === 1 ? request.nodes[0]!.name : 'mocks');
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <div className="share-head">
        <BackButton onClick={onClose} />
        <strong>{request.title}</strong>
        <span className="hint small">{counts}</span>
      </div>
      <p className="hint small">
        Share this with a colleague — they can paste it into Import, or open the downloaded file.
      </p>
      <div className="share-body" ref={body}>
        <CodeEditor value={text} readOnly />
      </div>
      <div className="share-foot">
        <button className="primary" onClick={() => void copy()}>
          {copied === 'done' ? 'Copied ✓' : 'Copy JSON'}
        </button>
        <button onClick={download}>Download .json</button>
        {copied === 'failed' && (
          <span className="hint small">Couldn’t reach the clipboard — the text is selected, press Ctrl+C.</span>
        )}
      </div>
    </>
  );
}

/**
 * `navigator.clipboard` is refused inside a DevTools panel more often than not
 * (it needs focus and a permissions policy the panel frame does not always get),
 * so fall back to the old select-and-copy command, which works there.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function ImportBody({
  request,
  update,
  onClose,
  onImported,
}: {
  request: Extract<ShareRequest, { mode: 'import' }>;
  update: Update;
  onClose: () => void;
  onImported: (firstId: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const result = useMemo(() => parseImport(text), [text]);

  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
  };

  const apply = (): void => {
    if (!result.ok) return;
    const plan = result.plan;
    void update((w) => {
      // The target folder may have been deleted (over MCP, say) since the
      // view opened; the top level is the only safe place left.
      const parentId =
        request.parentId !== null && findFolder(w.tree, request.parentId) ? request.parentId : null;
      const { workspace: next, nodeIds } = importNodes(w, parentId, plan);
      if (nodeIds[0]) onImported(nodeIds[0]);
      return next;
    });
    onClose();
  };

  const status = !text.trim() ? (
    <span className="hint small">Paste JSON above, or choose or drop a file.</span>
  ) : result.ok ? (
    <span className="ok small">
      Ready to import {summary(result.plan.mocks, result.plan.folders)}
      {result.plan.tagNames.length > 0 && ` · tags: ${result.plan.tagNames.join(', ')}`}
    </span>
  ) : (
    <span className="error small">{result.error}</span>
  );

  return (
    <>
      <div className="share-head">
        <BackButton onClick={onClose} />
        <strong>{request.title}</strong>
      </div>
      <div className="tab-toolbar">
        <button onClick={() => fileInput.current?.click()}>Choose file…</button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            void readFile(e.target.files?.[0]);
            e.target.value = ''; // so choosing the same file again still fires
          }}
        />
        <span className="hint small">{fileName ? `Loaded ${fileName}` : 'or paste the JSON below'}</span>
      </div>
      <div
        className={`share-body ${dragging ? 'dropping' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void readFile(e.dataTransfer.files[0]);
        }}
      >
        <CodeEditor
          value={text}
          invalid={text.trim() !== '' && !result.ok}
          placeholder={'{\n  "mockman": 1,\n  "nodes": [ ... ]\n}'}
          onChange={(value) => {
            setText(value);
            setFileName(null);
          }}
        />
      </div>
      <div className="share-foot">
        {status}
        <span className="spacer" />
        <button className="primary" disabled={!result.ok} onClick={apply}>
          Import
        </button>
      </div>
    </>
  );
}

function BackButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button className="back" title="Back to the editor" onClick={onClick}>
      ‹ Back
    </button>
  );
}
