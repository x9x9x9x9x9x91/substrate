/* The Deep Recall section of the settings sheet.

   Deep Recall keeps a second search index over every version of every note
   the vault's git history remembers, so search can reach text that was
   rewritten or deleted. That index is a real cost — a walk of the whole
   history once, and a device-local SQLite file forever after — which is why
   the feature is opt-in per vault per device and why this row leads with the
   numbers rather than with the promise.

   Two honest facts live here and nowhere else: how long the first walk still
   has to go (from the `recall:index` progress event, never a spinner), and
   what the finished index costs on disk. */

import { useCallback, useEffect, useState } from "react";
import { recallIndex, recallSetEnabled, recallStatus } from "../lib/ipc";
import { countLabel, sizeLabel } from "../lib/recall";
import type { RecallStatus } from "../lib/types";
import { listen } from "../lib/tauri";

export default function RecallSettings({ onToast }: { onToast: (msg: string) => void }) {
  const [status, setStatus] = useState<RecallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  /** live first-walk progress: snapshots done out of snapshots to walk */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState("");

  const load = useCallback(async () => {
    try {
      setStatus(await recallStatus());
    } catch {
      // a backend without the commands leaves the section hidden rather than
      // showing an error about a feature this build does not have
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let dead = false;
    let unlisten: (() => void)[] = [];
    Promise.all([
      listen<{ done: number; total: number }>("recall:index", (e) => {
        setProgress(e.payload.total > 0 ? e.payload : null);
        // the last tick is also the finish: re-read the numbers rather than
        // guess them from the event
        if (e.payload.total === 0 || e.payload.done >= e.payload.total) {
          setProgress(null);
          void load();
        }
      }),
      listen<string>("recall:index-error", (e) => {
        // the reason stays on the row: this is a minutes-long walk someone
        // probably walked away from, and a toast would be gone
        setFailed(String(e.payload || "indexing failed"));
        setProgress(null);
        void load();
      }),
    ]).then((callbacks) => {
      if (dead) callbacks.forEach((c) => c());
      else unlisten = callbacks;
    });
    return () => {
      dead = true;
      unlisten.forEach((c) => c());
    };
  }, [load]);

  const build = useCallback(async () => {
    setBusy(true);
    setFailed("");
    try {
      await recallIndex();
    } catch (e) {
      setFailed(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
      void load();
    }
  }, [load]);

  const toggle = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    setFailed("");
    try {
      const next = await recallSetEnabled(!status.enabled);
      setStatus(next);
      // turning it on with nothing indexed yet means the walk IS the answer to
      // the click — asking a second time would be a needless step
      if (next.enabled && !next.indexed) void build();
    } catch (e) {
      onToast(`couldn't change Deep Recall (${e})`);
    } finally {
      setBusy(false);
    }
  }, [build, onToast, status]);

  if (!status) return null;

  const pct =
    progress && progress.total > 0 ? Math.floor((progress.done / progress.total) * 100) : 0;
  const running = status.indexing || progress !== null;

  return (
    <>
      <div className="palette-section">Deep Recall</div>
      <div className="settings-row" data-testid="recall-row">
        <div className="settings-row-text">
          <div className="settings-label">Search this vault&apos;s past</div>
          <div className="settings-hint">
            {status.enabled
              ? status.indexed
                ? `${countLabel(status.versions, "past version", "past versions")} of ${countLabel(
                    status.blobs,
                    "unique text",
                    "unique texts"
                  )} across ${countLabel(status.commits, "snapshot", "snapshots")} · ${sizeLabel(
                    status.bytes
                  )} on this Mac`
                : "on — the index is still to be built"
              : "Off. Turned on, search can also find text your notes used to contain: earlier drafts, deleted paragraphs, notes you removed entirely. Costs one walk of this vault's history now and a local index file after — for this vault on this Mac. Sealed notes are never indexed."}
          </div>
          {running && (
            <div className="settings-hint" data-testid="recall-progress">
              {progress
                ? `indexing — ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} snapshots (${pct}%)`
                : "indexing…"}
            </div>
          )}
          {failed && (
            <div className="settings-hint settings-hint-warn" data-testid="recall-error">
              {failed}
            </div>
          )}
        </div>
        <button
          className={`settings-switch${status.enabled ? " on" : ""}`}
          data-testid="recall-enable"
          role="switch"
          aria-checked={status.enabled}
          aria-label="Search this vault's past"
          disabled={busy || running}
          onClick={() => void toggle()}
        >
          <span className="settings-knob" />
        </button>
      </div>
      {status.enabled && !running && (
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-label">
              {status.indexed ? "Catch the index up" : "Build the index"}
            </div>
            <div className="settings-hint">
              {status.indexed
                ? "Indexes whatever history has arrived since the last walk. Near-instant unless a lot has synced in."
                : "Walks this vault's whole history once. Minutes on a long-lived vault; you can keep working."}
            </div>
          </div>
          <button
            className="settings-raw"
            data-testid="recall-index"
            disabled={busy}
            onClick={() => void build()}
          >
            {status.indexed ? "update" : "build…"}
          </button>
        </div>
      )}
    </>
  );
}
