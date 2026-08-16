/** Capture-window rules for voice recordings. Pure decisions only —
    the recording itself lives in the backend. */

/** Past this, Escape asks before discarding. Under it, a capture is a mis-hit
    or a false start and a confirmation step is the annoying thing; past it
    there is a real thought in the file, and Escape sits one key away from the
    Enter that files it. The recording keeps running while the question
    stands — arming costs nothing but a second keystroke. */
export const DISCARD_CONFIRM_MS = 10_000;

/** What Escape means right now while a recording is in flight. `confirm` only
    arms the discard: the caller shows [`escapeHint`] and waits for the next
    Escape, which arrives here as `armed` and discards. */
export function voiceEscape(elapsedMs: number, armed: boolean): "discard" | "confirm" {
  if (armed) return "discard";
  return elapsedMs >= DISCARD_CONFIRM_MS ? "confirm" : "discard";
}

/** The foot hint for Escape while recording — the armed state has to be
    visible, or the second Escape is a surprise rather than an answer. */
export function escapeHint(armed: boolean): string {
  return armed ? "again to discard" : "discard";
}
