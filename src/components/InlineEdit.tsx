import { useEffect, useRef, useState } from "react";

interface InlineEditProps {
  /** starting text (basename for folders, title for notes) */
  initial: string;
  placeholder?: string;
  /** Enter / blur commit with the trimmed value; a rejected promise keeps the
      editor open and shows the error (rename collisions etc.). Empty cancels. */
  onCommit: (value: string) => void | Promise<unknown>;
  onCancel: () => void;
  /** What committing this text would do, when that isn't what the control
      implies. Read from the text as it is typed and rendered muted beside the
      field — the save-view control says "Updates “Weekly”" once the name
      matches a pin it would replace. Null (the usual answer) renders nothing. */
  hint?: (value: string) => string | null;
}

/** Single-line rename/create input: Enter commits, Esc cancels, blur commits. */
export default function InlineEdit({
  initial,
  placeholder,
  onCommit,
  onCancel,
  hint,
}: InlineEditProps) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const [error, setError] = useState<string | null>(null);
  /* Mirrors the typed text for the hint only — the field itself stays
     uncontrolled, so no keystroke changes what the input holds. */
  const [draft, setDraft] = useState(initial);
  const note = hint?.(draft) ?? null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    const v = ref.current?.value.trim() ?? "";
    if (!v) {
      done.current = true;
      onCancel();
      return;
    }
    done.current = true;
    Promise.resolve(onCommit(v)).catch((e) => {
      setError(String(e instanceof Error ? e.message : e));
      done.current = false;
      const el = ref.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
  };

  return (
    <span className="inline-edit-wrap">
      <input
        ref={ref}
        className={`inline-edit${error ? " error" : ""}`}
        defaultValue={initial}
        placeholder={placeholder}
        title={error ?? undefined}
        onChange={hint ? (e) => setDraft(e.target.value) : undefined}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (!done.current) {
              done.current = true;
              onCancel();
            }
          }
        }}
        onClick={(e) => e.stopPropagation()}
      />
      {error && <span className="inline-edit-error">{error}</span>}
      {!error && note && <span className="inline-edit-hint">{note}</span>}
    </span>
  );
}
