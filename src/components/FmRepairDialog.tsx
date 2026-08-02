import { useEffect, useState } from "react";
import type { FmState, NoteMeta } from "../lib/types";
import { vaultFmWrite } from "../lib/ipc";

/* Broken-frontmatter repair dialog (SUB-430): the raw block verbatim, the
   engine's one-line diagnosis, and a Save that only lands a clean parse — a
   still-broken block bounces back with its diagnosis inline and the dialog
   stays open. Rides the DbAdmin overlay/dbform idiom (Esc or backdrop
   closes); Enter must NOT submit — newlines are the content. */
export default function FmRepairDialog({
  path,
  fm,
  onSaved,
  onClose,
}: {
  path: string;
  fm: FmState;
  /** saved meta (props now parse) — the pane adopts it and re-checks health */
  onSaved: (meta: NoteMeta) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(fm.raw);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const save = () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    vaultFmWrite(path, draft)
      .then((m) => {
        onSaved(m);
        onClose();
      })
      .catch((e) => {
        setErr(String(e instanceof Error ? e.message : e));
        setBusy(false);
      });
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dbform" role="dialog" aria-label="Repair frontmatter">
        <div className="dbform-title">Repair frontmatter</div>
        {fm.error && <div className="dbform-note">{fm.error}</div>}
        <textarea
          className="fm-raw"
          aria-label="Frontmatter source"
          autoFocus
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {err && <div className="dbform-err">{err}</div>}
        <div className="dbform-foot">
          <button className="selmenu-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="selmenu-btn selmenu-btn-primary"
            disabled={busy}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
