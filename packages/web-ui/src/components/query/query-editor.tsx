'use client';

import { type KeyboardEvent } from 'react';

export interface QueryEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}

export function QueryEditor({ value, onChange, onSubmit, disabled }: QueryEditorProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter to run — standard editor pattern; users discover it via
    // the hint shown below the editor.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const next = value.slice(0, start) + '  ' + value.slice(end);
      onChange(next);
      // Move caret past the inserted spaces on next tick (after React re-renders).
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  };

  return (
    <div className="border-border bg-panel rounded-base flex flex-col gap-2 border p-3">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        spellCheck={false}
        aria-label="Cypher query"
        className="text-text placeholder:text-text-dim min-h-[120px] w-full resize-y bg-transparent font-mono text-[13px] leading-[1.5] outline-none"
        placeholder="MATCH (n) RETURN labels(n) AS label, count(*) AS count ORDER BY count DESC"
      />
      <div className="text-text-dim flex items-center justify-between text-[11px]">
        <span>
          <kbd className="bg-panel-2 text-text-muted rounded-xs px-[6px] py-[2px] font-mono text-[10px]">
            ⌘/Ctrl + ⏎
          </kbd>{' '}
          to run · <kbd className="bg-panel-2 text-text-muted rounded-xs px-[6px] py-[2px] font-mono text-[10px]">Tab</kbd>{' '}
          inserts 2 spaces
        </span>
        <span>Read-only: write keywords are blocked server-side</span>
      </div>
    </div>
  );
}
