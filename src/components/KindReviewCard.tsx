import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { kindsEnable, kindsSetTrust, vaultRoot } from "../lib/ipc";
import { invalidateKindBundles } from "../hooks/useKindBundles";
import type { KindReview } from "../lib/kindpane";

/* The review a person reads before code from their vault runs (SUB-961).

   A pane inside the dashboard frame, not a modal. A modal would arrive on top
   of whatever the user was doing and be dismissible with Escape, and the two
   habits that trains — skim, dismiss — are the two this surface cannot afford.
   Here the review IS the note: the dashboard stays on the review until the
   decision is made, and not deciding leaves the kind not running, which is
   the safe end of the fork.

   Nothing is pre-checked and nothing enables itself. The single exception is
   the standing rider the user turned on by hand for this kind in this vault,
   and even that only re-enables code they already consented to running. */

export default function KindReviewCard(props: {
  review: KindReview;
  /** the bundle hash the review describes — consent is pinned to it */
  hash: string;
  /** something changed; the caller may want to re-read the bundle list */
  onChanged?: () => void;
}) {
  const { review, hash } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState(review.trustUpdates);

  const enable = () => {
    setBusy(true);
    setError(null);
    kindsEnable(review.id, hash)
      .then(() =>
        /* The rider is a second write, riding a consent that already landed.
           If only it fails the kind IS enabled and running, so reporting
           "enabling failed" would be a lie about the state of the machine —
           the sentence has to say which half didn't stick. */
        trust !== review.trustUpdates
          ? kindsSetTrust(review.id, trust).catch((e) =>
              setError(
                `Enabled — but the standing permission could not be saved: ${String(e)}. Set it in Settings → Kinds.`,
              ),
            )
          : undefined,
      )
      .then(() => {
        // The consent record lives outside the vault, so no vault epoch moves
        // and nothing would re-read the list on its own. Invalidating here is
        // what makes the kind mount in place instead of after a reload.
        invalidateKindBundles();
        props.onChanged?.();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  /* Reveal, never open: the whole point is to look at the code, and handing
     the entry file to the OS "open" verb would run it through whatever is
     registered for .js. The same reveal path the note and asset panes use. */
  const openCode = () => {
    vaultRoot()
      .then((root) => revealItemInDir(`${root}/.vault/kinds/${review.id}/${review.entry}`))
      .catch((e) => setError(`could not show the folder: ${String(e)}`));
  };

  return (
    <div className="kind-review" data-testid="kind-review">
      <div className="kind-review-head">
        <div className="kind-review-title">{review.title}</div>
        <div className="dash-sub">{review.headline}</div>
      </div>

      {review.description && <p className="kind-review-desc">{review.description}</p>}

      <dl className="kind-review-facts">
        <div>
          <dt>Kind</dt>
          <dd data-testid="kind-review-id">{review.id}</dd>
        </div>
        {review.author && (
          <div>
            <dt>Author</dt>
            <dd>{review.author}</dd>
          </div>
        )}
        <div>
          <dt>Runs</dt>
          <dd>{review.entry}</dd>
        </div>
        <div>
          <dt>Kind api</dt>
          <dd>{review.api}</dd>
        </div>
        {review.fileSummary && (
          <div>
            <dt>Files</dt>
            <dd data-testid="kind-review-files">{review.fileSummary}</dd>
          </div>
        )}
      </dl>

      <ul className="kind-review-terms">
        {review.terms.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>

      {/* The rider rides an existing consent, so it is offered only on the
          second decision — a drift review, for a kind this vault already said
          yes to once. Offering it on a first enable would let one interaction
          both admit code nobody has read and pre-approve every future version
          of it, which is what §5.8, the Rust comment on `set_trust_updates`
          and Settings → Kinds all say cannot happen.

          And nothing is written from the tick: the box only carries a value
          into the enable press below. Writing it here would land
          `trustUpdates: true` on the drifted record, which is exactly what
          `shouldTrustReenable` fires on — the drift being reviewed would
          re-enable itself because the checkbox was ticked while its own review
          card was on screen. The rider covers FUTURE drift; consenting to
          THIS one is the button's job. */}
      {review.moment === "changed" && (
        <label className="kind-review-trust">
          <input
            type="checkbox"
            data-testid="kind-trust"
            checked={trust}
            onChange={(e) => setTrust(e.target.checked)}
          />
          <span>
            {review.trustLabel}
            <span className="dash-sub">{review.trustHint}</span>
          </span>
        </label>
      )}

      <div className="kind-review-actions">
        <button type="button" data-testid="kind-enable" onClick={enable} disabled={busy}>
          {review.enableLabel}
        </button>
        <button type="button" className="ghost" data-testid="kind-open-code" onClick={openCode}>
          Open the code
        </button>
      </div>

      {error && (
        <div className="kind-review-error" data-testid="kind-review-error">
          {error}
        </div>
      )}
    </div>
  );
}
