import { useEffect } from "react";
import { shareCaptureSupported, shareCaptureSweep } from "../lib/ipc";

/** The app half of iOS share-sheet capture (`src-tauri/src/landing.rs`).

    Sharing a link or some text from another app writes one envelope into the
    App Group and returns — the share extension never opens the vault, because
    an extension gets killed the moment the system wants its memory back. So
    nothing is a note until the app looks, and this is the looking: once at
    open, and again every time the app comes back to the foreground.

    Both triggers matter and neither is enough alone. A share made while the
    app was closed lands at the next open; a share made while it was merely
    backgrounded — the ordinary case, since sharing happens FROM another app —
    lands on the way back. iOS gives that return as `visibilitychange` rather
    than a window `focus`, so the hook listens for both and lets the in-flight
    guard collapse the two into one sweep.

    The sweep needs no scheduling of its own: it is idempotent, and on an empty
    folder it is one `read_dir` that finds nothing. Captures reach the other
    devices through the ordinary auto-sync lane — the notes it files emit
    `vault:changed`, which arms that lane's push debounce like any other edit. */
export function useShareCapture() {
  useEffect(() => {
    let alive = true;
    let inFlight = false;

    const sweep = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      try {
        const report = await shareCaptureSweep();
        if (report.landed || report.quarantined) {
          console.debug(
            `share capture: filed ${report.landed}, quarantined ${report.quarantined}`
          );
        }
      } catch (e) {
        // a capture that cannot be filed is already quarantined in Rust, so
        // there is nothing for the user to do here and nothing to interrupt
        // them with — the app log has the reason
        console.debug(`share capture: sweep failed: ${String(e)}`);
      } finally {
        inFlight = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void sweep();
    };

    // desktop has no share extension, so it never arms the listeners at all
    void shareCaptureSupported()
      .catch(() => false)
      .then((supported) => {
        if (!alive || !supported) return;
        void sweep();
        window.addEventListener("focus", sweep);
        document.addEventListener("visibilitychange", onVisible);
      });

    return () => {
      alive = false;
      window.removeEventListener("focus", sweep);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
