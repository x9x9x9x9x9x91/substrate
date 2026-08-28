/** The plaintext one browser edit of a shared note becomes, before it is
 *  sealed to a space's letterbox.
 *
 *  Its own module beside `slipenvelope.ts`, for the same reason that one is
 *  not two lines inside `slip.ts`: the editing page touches `document` at
 *  import time and carries a real age implementation, so nothing could load it
 *  to check what it puts on the wire. This half is pure, and
 *  `spaceedit.test.ts` holds it to every property below.
 *
 *  **Its own version namespace.** `docs/collab.md` §6.2 numbers this envelope
 *  `v: 1`, which is also the vault letterbox's number for a plain message —
 *  and that is not a collision, because the two never meet. A space edit is
 *  sealed to the recipient derived at `substrate/space/letterbox/v1` (§2.1)
 *  and posted to the SPACE's box; the vault's own box has a different
 *  recipient, a different id and a different poller. Nothing that reads
 *  `commands/letterbox.rs`'s version table will ever be handed one of these.
 *  A build that does not know `kind: "space-edit"` refuses it and leaves the
 *  drop on the relay unacked, exactly as the answer envelope arranged.
 *
 *  **The whole body, never a patch.** §6.4: the one operation a guest has is
 *  "replace the entire body of this note". A diff would need a merge on the
 *  landing side, and a merge is a guess; a whole body plus the `base` it was
 *  started from lets the vault take it or park it, and never guess.
 *
 *  **Padded up a ladder, not to a block.** A slip answer is one of N known
 *  short strings, so 256-byte blocks are enough to hide which. A note body is
 *  free text spanning three orders of magnitude, and rounding THAT to 256
 *  bytes would tell the relay operator the body's length to within a rounding
 *  error — which, for a folder whose note lengths they can watch change over
 *  time, is a usable fingerprint of which note was edited. So the ladder is
 *  coarse and multiplicative (§6.2): 1 KiB, 2, 4, 8, 16, 32, 64, 128, 256 KiB,
 *  then 64 KiB steps. Every drop is one of nine sizes until a quarter of a
 *  megabyte, and what leaks is a bucket rather than a length.
 */

/** Space edits are their own kind, in their own version namespace — see the
    module note. */
export const SPACE_EDIT_ENVELOPE_VERSION = 1;

/** What the engine dispatches on. */
export const SPACE_EDIT_KIND = "space-edit";

const KIB = 1024;

/** Where the doubling stops and the fixed steps begin. Past a quarter of a
    megabyte doubling would round a 300 KiB note up to 512 KiB — paying a
    quarter-megabyte upload to hide a difference the coarser buckets below
    already hid. */
const LADDER_TOP = 256 * KIB;

/** The step above {@link LADDER_TOP}. */
const LADDER_STEP = 64 * KIB;

/** What the padding is made of. Spaces are the one filler that costs exactly
    its own length in JSON — no escape sequence — so the arithmetic here is
    exact rather than approximate. */
const PAD_CHAR = " ";

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The width an envelope of `raw` bytes is padded out to.
 *
 *  Exported because it is the whole privacy claim of this module, and a claim
 *  a test can only check if it can name the ladder independently of the
 *  builder that walks it. */
export function paddedLength(raw: number): number {
  let bucket = KIB;
  while (bucket < raw && bucket < LADDER_TOP) bucket *= 2;
  if (raw <= bucket) return bucket;
  return LADDER_TOP + Math.ceil((raw - LADDER_TOP) / LADDER_STEP) * LADDER_STEP;
}

/** One edit, as §6.2 spells it. */
export interface SpaceEdit {
  /** Which space, so a device holding several does not have to try each. */
  space: string;
  /** The opaque id the index gave this note. Never a path: the guest is never
      told where in someone's folder the note they are reading lives, and a
      path arriving from a browser would be a path the landing side had to
      distrust anyway. */
  note: string;
  /** Hex SHA-256 of the body the guest started from. The whole of the
      stale-base check, and the reason a slow editor overwrites nobody. */
  base: string;
  /** What the guest typed into the name box. Self-declared and unverified —
      the page says so, beside the box. */
  by: string;
  /** The full markdown body, replacing the note's. */
  body: string;
}

function envelope(edit: SpaceEdit, pad: number): string {
  return JSON.stringify({
    v: SPACE_EDIT_ENVELOPE_VERSION,
    kind: SPACE_EDIT_KIND,
    space: edit.space,
    note: edit.note,
    base: edit.base,
    by: edit.by,
    body: edit.body,
    // Ignored by the engine, which reads the fields it knows and no others.
    // Inside the object rather than after its closing brace, so the plaintext
    // stays one well-formed JSON document.
    pad: PAD_CHAR.repeat(pad),
  });
}

/** One edit as the bytes that get sealed: always a ladder step wide, whatever
    was typed. */
export function spaceEditEnvelope(edit: SpaceEdit): string {
  const bare = byteLength(envelope(edit, 0));
  return envelope(edit, paddedLength(bare) - bare);
}
