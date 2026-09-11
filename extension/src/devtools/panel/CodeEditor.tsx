import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * The line height every part of this editor is measured in, in pixels.
 *
 * It has to agree with `--code-font` in styles.css, where the same number is set
 * for the textarea and the gutter. It is a constant rather than a measurement
 * because the gutter's windowing arithmetic below needs it on every scroll, and
 * reading it back off the DOM there would mean a layout flush per frame.
 */
const LINE_HEIGHT = 16;

/**
 * A line-numbered plain-text editor.
 *
 * Deliberately a real `<textarea>` rather than a syntax-highlighting editor: it
 * costs nothing, it keeps native undo, spellcheck-off, find-in-page and IME
 * behaviour, and a DevTools panel is not the place to ship a code editor's
 * worth of JavaScript.
 *
 * The gutter is a separate element scrolled in lockstep with the textarea. Both
 * must therefore share the exact same font metrics and line height — see the
 * `.code-*` rules in styles.css, where those are set in one place for both, and
 * `LINE_HEIGHT` above.
 *
 * The editor takes its height from whatever the detail pane has left rather than
 * carrying one of its own; `.tab-body` is what stretches it.
 *
 * Memoised, and its callers must keep `onChange` stable, because React re-runs a
 * `<textarea>`'s value bookkeeping on every render of its parent whether the
 * value moved or not — measurably ~9ms for a 19KB payload. Without this, typing
 * one character into the Label field paid the full cost of the body sitting in
 * the tab below it.
 */
export const CodeEditor = memo(function CodeEditor({
  value,
  onChange,
  placeholder,
  invalid,
  readOnly,
  minRows = 8,
}: {
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  readOnly?: boolean;
  minRows?: number;
}): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

  // `split` rather than a hand-rolled newline count: the throwaway array looks
  // wasteful and measures twelve times faster, because V8 splits natively and a
  // charCodeAt loop over a 19KB payload does not optimise.
  const lineCount = useMemo(() => Math.max(value.split('\n').length, minRows), [value, minRows]);

  /*
   * Only the line numbers that can be on screen are rendered.
   *
   * Laying out a number per line is not free the way it looks: an 882-line
   * payload put ~8ms of gutter layout on *every* keystroke anywhere in the
   * editor pane, which was the single largest cost left after the writes
   * stopped going through the worker synchronously. The textarea itself is
   * cheap by comparison — the browser lays out its content with the machinery
   * it has for exactly that — and emptying the gutter alone took a keystroke
   * from 13.7ms to 5.7ms.
   *
   * The numbers that are out of view are replaced by padding above and below,
   * so the gutter still has the full scroll height and the lockstep scrolling
   * below keeps working untouched.
   */
  const [visible, setVisible] = useState({ first: 0, count: minRows });

  const sync = useCallback((): void => {
    const area = textarea.current;
    if (!area) return;

    if (gutter.current) gutter.current.scrollTop = area.scrollTop;

    const first = Math.max(0, Math.floor(area.scrollTop / LINE_HEIGHT));
    // One spare line at each end, so a scroll part-way into a line never leaves
    // a gap at the top or the bottom of the gutter.
    const count = Math.ceil(area.clientHeight / LINE_HEIGHT) + 2;
    setVisible((previous) =>
      previous.first === first && previous.count === count ? previous : { first, count },
    );
  }, []);

  // Keep the gutter aligned after an edit that changes the scroll position
  // (paste, undo) as well as during ordinary scrolling.
  useLayoutEffect(sync, [sync, value]);

  // The editor grows and shrinks with the pane, and a resize with no typing and
  // no scrolling would otherwise leave the window too short for the new height.
  useEffect(() => {
    const area = textarea.current;
    if (!area) return;
    const observer = new ResizeObserver(sync);
    observer.observe(area);
    return () => observer.disconnect();
  }, [sync]);

  const last = Math.min(lineCount, visible.first + visible.count);
  const numbers = useMemo(
    () =>
      Array.from({ length: Math.max(0, last - visible.first) }, (_, i) => visible.first + i + 1).join(
        '\n',
      ),
    [visible.first, last],
  );

  return (
    <div className={`code ${invalid ? 'invalid' : ''}`}>
      <div className="code-gutter" ref={gutter} aria-hidden="true">
        <div
          className="code-lines"
          style={{
            paddingTop: visible.first * LINE_HEIGHT,
            paddingBottom: (lineCount - last) * LINE_HEIGHT,
          }}
        >
          {numbers}
        </div>
      </div>
      <textarea
        ref={textarea}
        className="code-area"
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        spellCheck={false}
        wrap="off"
        onScroll={sync}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={(e) => {
          // Tab indents instead of leaving the field. Without this, editing a
          // JSON payload means never being able to type an indent.
          if (e.key !== 'Tab' || e.shiftKey || readOnly || !onChange) return;
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart, selectionEnd } = el;
          onChange(`${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`);
          // React re-renders from `value`, and assigning a textarea's value puts
          // the caret at the end of it, so the caret has to be put back.
          //
          // In a microtask, not a frame: React flushes a discrete event's update
          // in a microtask of its own, queued by the `onChange` above and so
          // ahead of this one. A `requestAnimationFrame` was both a frame late
          // and never ran at all while the panel was hidden — which is any time
          // the user is on another DevTools tab.
          queueMicrotask(() => {
            el.selectionStart = el.selectionEnd = selectionStart + 2;
          });
        }}
      />
    </div>
  );
});
