/** Capture-box reset, split out of `capture.tsx` so the ordering rule below is
    testable.

    One `substrate://capture?text=…` link resets the capture window more than
    once: the backend emits `capture:prefill` immediately AND the window gets a
    `tauri://focus` when the window server delivers it. Both handlers run this
    reset, and a reset clears the box synchronously before pulling the prefill
    asynchronously — so the two round trips can resolve in either order, and
    whichever clear lands last would win.

    It doesn't, because the pull is non-destructive (`deeplink_capture_prefill`
    reads, it doesn't take): every reset in the interleaving reads the same
    text and ends by writing it back. The last write is therefore always the
    text, never the clear. The prefill is dropped explicitly instead, when the
    capture window hides or files the note. */
export type CapturePrefillPort = {
  /** Write the capture box: `""` for the clear, the prefill when one exists. */
  setText: (text: string) => void;
  /** Read the pending prefill. Must NOT consume it — see above. */
  readPrefill: () => Promise<string | null>;
};

/** Clear the capture box, then refill it from a pending deeplink prefill.
    Safe to run concurrently with itself: overlapping calls converge on the
    prefill regardless of which one's read resolves first. */
export async function resetCaptureBox(port: CapturePrefillPort): Promise<void> {
  port.setText("");
  let text: string | null = null;
  try {
    text = await port.readPrefill();
  } catch {
    // no prefill to be had — the cleared box is the right resting state
    return;
  }
  if (text) port.setText(text);
}
