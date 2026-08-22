import { useCallback, useEffect, useState } from "react";
import type { ConflictChoice, ConflictFile, ConflictState, SyncReport } from "../lib/types";
import {
  vaultSyncConflicts,
  vaultSyncResolveClear,
  vaultSyncResolveFinish,
  vaultSyncResolveSet,
} from "../lib/ipc";
import { DashAlert } from "./DashNotice";
import { errText } from "../lib/errtext";

const CHOICES: { id: ConflictChoice; label: string }[] = [
  { id: "mine", label: "Keep mine" },
  { id: "theirs", label: "Take theirs" },
  { id: "both", label: "Keep both" },
];

function choiceSummary(file: ConflictFile): string {
  switch (file.resolution) {
    case "mine":
      return "Keeping this device's version — the other stays in version history.";
    case "theirs":
      return "Taking the incoming version — this device's stays in version history.";
    case "both":
      return `Keeping both — the incoming one lands as ${file.both_path}.`;
    default:
      return "";
  }
}

/** Empty text with a present side means a genuinely empty file; an absent side
    means that device deleted it. Both read better than a blank panel. */
function sideNote(present: boolean, text: string | null): string | null {
  if (!present) return "Deleted on this side";
  if (text === null) return "Binary file — not shown";
  if (text.trim().length === 0) return "Empty file";
  return null;
}

function PropTable({ file }: { file: ConflictFile }) {
  if (file.props.length === 0) return null;
  const cell = (value: string | null) =>
    value === null ? <span className="sync-conflict-prop-missing">—</span> : <code>{value}</code>;
  return (
    <table className="sync-conflict-props">
      <thead>
        <tr>
          <th scope="col">Property</th>
          <th scope="col">Before</th>
          <th scope="col">Mine</th>
          <th scope="col">Theirs</th>
        </tr>
      </thead>
      <tbody>
        {file.props.map((prop) => (
          <tr key={prop.key}>
            <th scope="row">{prop.key}</th>
            <td>{cell(prop.base)}</td>
            <td>{cell(prop.ours)}</td>
            <td>{cell(prop.theirs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The same markup History's diff pane uses, so both surfaces read alike. */
function Diff({ file }: { file: ConflictFile }) {
  const mine = sideNote(file.ours.present, file.ours.text);
  const theirs = sideNote(file.theirs.present, file.theirs.text);
  return (
    <div className="hist-diff sync-conflict-diff">
      <div className="hist-diff-head">
        <span className="hist-diff-label">Mine → theirs</span>
        {mine && <span className="sync-conflict-side-note">Mine: {mine}</span>}
        {theirs && <span className="sync-conflict-side-note">Theirs: {theirs}</span>}
      </div>
      {file.diff.length === 0 ? (
        <div className="sync-conflict-empty">
          No line differences — the two sides changed the same file in ways git could not merge.
        </div>
      ) : (
        <div className="hist-diff-lines">
          {file.diff.map((line, i) => (
            <div key={i} className={`hist-line hist-line-${line.kind}`}>
              {line.text || " "}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SyncConflicts({ onResolved }: { onResolved: (report: SyncReport) => void }) {
  const [state, setState] = useState<ConflictState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `keepError` is for the re-read that follows a failed action: the backend's
  // message (why the action was refused) is what the user needs, and a
  // successful re-read must not wipe it off the screen before it is painted.
  const refresh = useCallback(async (keepError = false) => {
    try {
      setState(await vaultSyncConflicts());
      if (!keepError) setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = async (file: ConflictFile, choice: ConflictChoice) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Toggling the active choice clears it, so a wrong click is one click back.
      setState(
        file.resolution === choice
          ? await vaultSyncResolveClear(file.path)
          : await vaultSyncResolveSet(file.path, choice),
      );
    } catch (err) {
      setError(errText(err));
      await refresh(true);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const report = await vaultSyncResolveFinish();
      setState(null);
      onResolved(report);
    } catch (err) {
      setError(errText(err));
      await refresh(true);
    } finally {
      setBusy(false);
    }
  };

  // A failed first read leaves no state at all — say so rather than rendering
  // a dead pane the user can't tell apart from "no conflicts".
  if (!state?.active) {
    return error ? (
      <section className="vault-sync-card sync-conflict">
        <DashAlert live>{error}</DashAlert>
      </section>
    ) : null;
  }
  const total = state.files.length;
  const done = total > 0 && state.files.every((file) => file.resolution);

  return (
    <section className="vault-sync-card sync-conflict" aria-labelledby="sync-conflict-title">
      <div className="vault-sync-card-head">
        <div>
          <h2 id="sync-conflict-title">Resolve conflicts</h2>
          <p>
            Both devices changed the same {total === 1 ? "file" : "files"}. Nothing is lost —
            whichever side you set aside stays in this vault&apos;s version history.
          </p>
        </div>
        <span className="sync-conflict-progress" role="status">
          {state.resolved} of {total} resolved
        </span>
      </div>

      {error && <DashAlert live>{error}</DashAlert>}

      <ul className="sync-conflict-list">
        {state.files.map((file) => (
          <li
            key={file.path}
            className={`sync-conflict-file${file.resolution ? " resolved" : ""}`}
            data-path={file.path}
          >
            <div className="sync-conflict-file-head">
              <code className="sync-conflict-path">{file.path}</code>
              {file.resolution && (
                <span className="sync-conflict-badge">{choiceSummary(file)}</span>
              )}
            </div>
            <PropTable file={file} />
            <Diff file={file} />
            <div className="sync-conflict-actions">
              {CHOICES.map((choice) => {
                // Keep-both needs somewhere to put the second copy; a
                // delete-vs-edit conflict has no such path. Only block it
                // while nothing is chosen — an already-set choice must stay
                // clickable so it can be taken back.
                const unavailable =
                  !file.resolution && choice.id === "both" && file.both_path.length === 0;
                return (
                  <button
                    key={choice.id}
                    type="button"
                    className={`vault-sync-button sync-conflict-choice${
                      file.resolution === choice.id ? " active" : ""
                    }`}
                    aria-pressed={file.resolution === choice.id}
                    disabled={busy || unavailable}
                    title={
                      unavailable ? "One side deleted this file, so there is no second copy" : undefined
                    }
                    onClick={() => void choose(file, choice.id)}
                  >
                    {choice.label}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>

      <div className="sync-conflict-foot">
        <button
          type="button"
          className="vault-sync-save"
          disabled={busy || !done}
          onClick={() => void finish()}
        >
          {busy ? <span className="sync-spinner" /> : "Finish merge"}
        </button>
        <span className="vault-sync-muted">
          {done
            ? "Applies every choice and records one merge commit."
            : "Choose an outcome for each file to finish the merge."}
        </span>
      </div>
    </section>
  );
}
