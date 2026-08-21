/** The plaintext one tapped chip becomes, before it is sealed.
 *
 * Its own module, and not two lines inside `slip.ts`, for one reason: `slip.ts`
 * touches `document` at import time and carries a real age implementation, so
 * nothing can load it to check what it puts on the wire. This half is pure, and
 * `lens.test.ts` holds it to both of the properties below.
 *
 * **Version 2, not "version 1 with a new field".** A message is a version-1
 * envelope and stays one, so every sealing page already sitting in somebody's
 * browser keeps working. An ANSWER is version 2 — deliberately unreadable to a
 * build that predates it. `.vault/letterbox.json` is synced vault data and
 * every device holding it polls the same box, so a mixed-version window is
 * reachable whenever a rollout is staged: an older engine reads unknown fields
 * as absent, would file the answer as an empty-bodied `Inbox/Drop from …` note,
 * and would ACK it — the answer destroyed rather than deferred. A version it
 * refuses outright leaves the drop on the relay, unacked, for the device that
 * understands it. Refusing is the only forward-compatibility a door with an
 * irreversible ack can offer.
 *
 * **Padded to a fixed width.** Unpadded, the POST body is a constant plus the
 * chosen option's own byte length, and an answer is one of N *known* strings —
 * so `todo / doing / done` tells the relay operator which chip was tapped from
 * the size alone, and `yes / no` tells them outright. That is not the drop's
 * threat model (free text of arbitrary length) and it must not inherit its
 * silence. Every option of one slip therefore seals to the same number of
 * bytes: the width is the longest option's envelope, rounded up to a block so
 * the total says nothing about the option set either.
 */

/** Answers are their own envelope version — see the module note. */
export const SLIP_ENVELOPE_VERSION = 2;

/** Padding granularity. Rounding up to a block means the width leaks at most
    "the longest option is somewhere in this 256-byte range", instead of its
    exact length. */
const PAD_BLOCK = 256;

/** What the padding is made of. Spaces are the one filler that costs its own
    length in JSON — no escape sequence, so the arithmetic below is exact. */
const PAD_CHAR = " ";

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function envelope(lens: string, value: string, pad: number): string {
  return JSON.stringify({
    v: SLIP_ENVELOPE_VERSION,
    kind: "slip",
    lens,
    value,
    // Ignored by the engine, which reads the fields it knows and no others.
    // It is here rather than appended after the closing brace so the plaintext
    // stays one well-formed JSON document.
    pad: PAD_CHAR.repeat(pad),
  });
}

/** One answer as the bytes that get sealed: the same length for every option
    this slip offers, whichever one the reader tapped. */
export function slipEnvelope(lens: string, options: string[], value: string): string {
  // the width every option must reach. `value` is one of the options, but a
  // page whose spec drifted from what it renders must still produce a legal
  // envelope, so it is measured alongside them rather than assumed among them.
  const widest = Math.max(...[...options, value].map((o) => byteLength(envelope(lens, o, 0))));
  const target = Math.ceil(widest / PAD_BLOCK) * PAD_BLOCK;
  const pad = target - byteLength(envelope(lens, value, 0));
  return envelope(lens, value, Math.max(pad, 0));
}
