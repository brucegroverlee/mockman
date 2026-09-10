import { useLayoutEffect, useMemo, useRef } from 'react';

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
 * `.code-*` rules in styles.css, where those are set in one place for both.
 */
export function CodeEditor({
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

  const lineCount = useMemo(() => Math.max(value.split('\n').length, minRows), [value, minRows]);

  // Keep the gutter aligned after an edit that changes the scroll position
  // (paste, undo) as well as during ordinary scrolling.
  useLayoutEffect(() => {
    if (gutter.current && textarea.current) {
      gutter.current.scrollTop = textarea.current.scrollTop;
    }
  }, [value]);

  const syncScroll = (): void => {
    if (gutter.current && textarea.current) {
      gutter.current.scrollTop = textarea.current.scrollTop;
    }
  };

  return (
    <div className={`code ${invalid ? 'invalid' : ''}`}>
      <div className="code-gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={textarea}
        className="code-area"
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        spellCheck={false}
        wrap="off"
        onScroll={syncScroll}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={(e) => {
          // Tab indents instead of leaving the field. Without this, editing a
          // JSON payload means never being able to type an indent.
          if (e.key !== 'Tab' || e.shiftKey || readOnly || !onChange) return;
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart, selectionEnd } = el;
          onChange(`${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`);
          // React re-renders from `value`, so the caret has to be restored
          // afterwards or it jumps to the end of the text.
          requestAnimationFrame(() => {
            el.selectionStart = el.selectionEnd = selectionStart + 2;
          });
        }}
      />
    </div>
  );
}
