import { useState } from "react";
import { kindsDisable, kindsSetTrust } from "../lib/ipc";
import { invalidateKindBundles, useKindBundles } from "../hooks/useKindBundles";
import { resolveKindState, type KindBundleInfo, type KindState } from "../lib/kinds";

/* The Kinds section of Settings — where consent is reviewed after
   the fact.

   The review pane answers "should this run?" at the moment a dashboard asks.
   This answers the question that has no moment: what did I already say yes to
   in this vault, and how do I take it back. Without it, consent granted once
   from a note would only ever be visible from that note.

   Per vault, per device, like the consent itself: the list is what
   `kinds_list` finds in THIS vault, and the states are this device's records.
   The same vault opened on another machine shows the same folders and none of
   the same answers. */

/** One line of the section's status column. Deliberately not the dashboard
    card's wording: the card explains a pane that isn't rendering, this labels
    a row in a list. */
function stateLabel(state: KindState): string {
  switch (state.state) {
    case "enabled":
      return "enabled";
    case "disabled":
      return "not enabled";
    case "hash-drift":
      return "code changed — review again";
    case "api-too-new":
      return "needs a newer Substrate";
    case "api-too-old":
      return "written for an older Substrate";
    case "invalid":
      return `can't be read — ${state.reason}`;
  }
}

export default function KindsSettings() {
  const bundles = useKindBundles(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Nothing installed is not an empty state worth a paragraph: a vault with no
  // .vault/kinds folder has never met this feature, and a section explaining
  // what it would say is noise in everyone else's settings.
  if (!bundles || bundles.length === 0) return null;

  const act = (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    run()
      .then(() => invalidateKindBundles())
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <div className="palette-section">Kinds</div>
      <div className="settings-hint settings-kinds-lead">
        Dashboard kinds installed in this vault. Enabling happens on the note that
        uses one, after you have read what it does — this is where you take it back.
        Disabling never deletes anything: the folder stays in the vault, the code
        just stops running here.
      </div>
      <ul className="settings-kinds" data-testid="settings-kinds">
        {bundles.map((b: KindBundleInfo) => {
          const state = resolveKindState(b, b.record);
          /* The rider is offered only for a kind that is running right now.
             Not for a drifted one: ticking it there writes `trustUpdates` onto
             a record whose bytes already moved, and `shouldTrustReenable` would
             then run the unreviewed code off the back of a checkbox — the drift
             in front of you is the review pane's decision, never this one's. */
          const ridable = state.state === "enabled";
          /* Withdrawal follows the RECORD, not the state. A kind whose manifest
             turned invalid, or whose api drifted out of this build's window,
             still holds a consent on disk — and that is the case where a person
             most wants the verb. `clear_enabled` tolerates an unknown id, so
             this is safe wherever a record exists. */
          const withdrawable = b.record !== undefined;
          return (
            <li className="settings-row settings-kind-row" key={b.id} data-kind={b.id}>
              <div className="settings-row-text">
                <div className="settings-label">
                  {state.state === "invalid" ? b.id : state.manifest.title}
                </div>
                <div className="settings-hint" data-testid={`kind-state-${b.id}`}>
                  {stateLabel(state)}
                </div>
                {/* the rider is only meaningful for a kind that has a consent
                    record to hang it on — offering it before the first enable
                    would be a way to pre-approve code nobody has looked at */}
                {ridable && (
                  <label className="settings-hint settings-kind-trust">
                    <input
                      type="checkbox"
                      data-testid={`kind-trust-${b.id}`}
                      checked={b.record?.trustUpdates === true}
                      disabled={busy === b.id}
                      onChange={(e) =>
                        act(b.id, () => kindsSetTrust(b.id, e.target.checked))
                      }
                    />
                    Trust updates to this kind in this vault
                  </label>
                )}
              </div>
              {withdrawable && (
                <button
                  className="settings-raw"
                  data-testid={`kind-disable-${b.id}`}
                  disabled={busy === b.id}
                  onClick={() => act(b.id, () => kindsDisable(b.id))}
                >
                  disable
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <div className="settings-hint settings-hint-warn" data-testid="kinds-error">
          {error}
        </div>
      )}
    </>
  );
}
