/* The Reflexes section of the settings sheet.

   Three jobs, in this order of importance:

     1. The enable switch. A `reflexes.json` can ARRIVE on a device — synced
        vault, shared folder, restored backup — so the first one seen here shows
        as paused behind one switch, and nothing runs until it is thrown. One
        switch covers the feature forever after: the verb set is closed, so no
        later rule edit can reach something the enable did not already cover.
     2. What the rules are. Read-only on purpose: rules are authored in the
        file, and a half-UI that could write some of them would make the file
        stop being the answer to "what runs here?".
     3. What they did. Errors are state, shown here — never an OS notification,
        which is the one thing a silent feature must not become.

   No rule-level controls: `enabled` and `dry_run` are the file's to say. */

import { useCallback, useEffect, useState } from "react";
import {
  reflexesDisable,
  reflexesEnable,
  reflexesReceipts,
  reflexesSetPaused,
  reflexesStatus,
} from "../lib/ipc";
import { listen } from "../lib/tauri";
import { ruleSummary, sectionState } from "../lib/reflexes";
import type { ReflexReceipt, ReflexStatus } from "../lib/reflexes";
import { errText } from "../lib/errtext";

/** How many receipts the "recent" list shows. The log itself keeps 500; a
    settings pane is not a log viewer, and the newest handful is what answers
    "did my rule fire?". */
const RECENT = 8;

export default function ReflexesSettings({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const [status, setStatus] = useState<ReflexStatus | null>(null);
  const [receipts, setReceipts] = useState<ReflexReceipt[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([reflexesStatus(), reflexesReceipts()]);
      setStatus(s);
      setReceipts(r);
    } catch {
      // a backend too old to answer leaves the section hidden rather than
      // showing an error about a feature that build does not have
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // the rules file is live-editable, so this pane hears the same
  // config-changed event the engine reloads its ruleset on — a rule edited in
  // an editor shows up here without reopening settings
  useEffect(() => {
    let dead = false;
    let unlisten: (() => void) | null = null;
    listen("vault:config-changed", () => void load()).then((un) => {
      if (dead) un();
      else unlisten = un;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, [load]);

  const act = useCallback(
    async (fn: () => Promise<void>, failed: string) => {
      setBusy(true);
      try {
        await fn();
        await load();
      } catch (e) {
        onToast(`${failed} (${errText(e)})`);
      } finally {
        setBusy(false);
      }
    },
    [load, onToast]
  );

  const state = sectionState(status);
  if (!status || state === "absent") return null;

  const live = state === "live";
  return (
    <>
      <div className="palette-section">Reflexes</div>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-label">
            {status.enabled ? "Run this vault's rules" : "Enable reflexes"}
          </div>
          <div className="settings-hint">
            {status.enabled
              ? `${status.rules.length} rule${status.rules.length === 1 ? "" : "s"} from .vault/reflexes.json` +
                (status.enabledAt ? ` · enabled ${status.enabledAt}` : "")
              : "This vault carries rules that move, tag and file notes for you. They are off until you turn them on here — once, for this vault on this Mac."}
          </div>
          {status.filePaused && status.enabled && (
            <div className="settings-hint settings-hint-warn">
              paused by the file&apos;s own <code>paused</code> flag
            </div>
          )}
        </div>
        <button
          className={`settings-switch${live ? " on" : ""}`}
          data-testid="reflexes-enable"
          role="switch"
          aria-checked={live}
          aria-label="Enable reflexes"
          disabled={busy || (status.enabled && status.filePaused)}
          onClick={() => {
            if (!status.enabled) return void act(reflexesEnable, "couldn't enable reflexes");
            void act(() => reflexesSetPaused(!status.paused), "couldn't change reflexes");
          }}
        >
          <span className="settings-knob" />
        </button>
      </div>

      {status.error && (
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-hint settings-hint-warn" data-testid="reflexes-error">
              {status.error}
            </div>
          </div>
        </div>
      )}

      {status.rules.map((r) => (
        <div className="settings-row" key={r.id}>
          <div className="settings-row-text">
            <div className="settings-label">
              {r.id}
              {!r.enabled && <span className="settings-hint"> · off</span>}
              {r.dryRun && <span className="settings-hint"> · dry run</span>}
              {r.autoPaused && (
                <span className="settings-hint settings-hint-warn"> · auto-paused</span>
              )}
            </div>
            <div className="settings-hint">
              {r.event}
              {r.path ? ` ${r.path}` : ""} → {r.actions.join(", ")}
            </div>
            <div
              className={`settings-hint${r.lastError ? " settings-hint-warn" : ""}`}
              data-testid={`reflex-state-${r.id}`}
            >
              {ruleSummary(r)}
              {r.suppressed > 0 && ` · ${r.suppressed} suppressed`}
            </div>
          </div>
        </div>
      ))}

      {status.invalid.map((r) => (
        <div className="settings-row" key={`invalid-${r.id}`}>
          <div className="settings-row-text">
            <div className="settings-label">{r.id}</div>
            <div className="settings-hint settings-hint-warn">
              not loaded — {r.error}
            </div>
          </div>
        </div>
      ))}

      {receipts.length > 0 && (
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-label">Recent</div>
            {receipts.slice(0, RECENT).map((r, i) => (
              <div className="settings-hint" key={`${r.at}-${r.rule}-${i}`}>
                {r.at} · {r.rule} · {r.subject} · {r.outcome}
                {r.dryRun ? " (dry run)" : ""}
              </div>
            ))}
          </div>
        </div>
      )}

      {status.enabled && (
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-label">Forget this decision</div>
            <div className="settings-hint">
              Back to the first-run state: rules stay listed, nothing runs, and the
              switch above asks again.
            </div>
          </div>
          <button
            className="settings-raw"
            data-testid="reflexes-forget"
            disabled={busy}
            onClick={() => void act(reflexesDisable, "couldn't disable reflexes")}
          >
            forget
          </button>
        </div>
      )}
    </>
  );
}
