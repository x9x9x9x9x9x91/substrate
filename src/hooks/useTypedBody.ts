import { useCallback, useEffect, useRef, useState } from "react";

/** The open note's body as the EDITOR has it, sampled a beat after typing
    stops — the buffer live values resolve against.
 *
 * Why a sample at all: the pane's `loaded` body is the body as DISK has it,
 * which is the right base for saving and the wrong one for live values. A
 * `` `= Cash.cash_total` `` span typed just now names a sheet the disk body has
 * never mentioned, so the sheet never loads and the fresh span shows the dim
 * dash until the note is reopened. Reading the buffer makes the value appear
 * where it was typed, which is the only reading of "live" a writer would
 * accept.
 *
 * Why the delay: resolving the sheet set is a body-sized scan and the load
 * behind it is IPC, so it rides its own quiet-period timer rather than firing
 * per keystroke. 400ms is under the save debounce — the value appears while
 * the sentence is still being written, not after it is filed.
 *
 * Why `clear()` is part of the contract: a sample outlives the buffer it came
 * from. Whenever a body arrives from OUTSIDE the editor — an external write
 * adopted in place, a conflict resolved by taking disk, a rename's link sweep
 * rewriting this note — the sampled buffer is stale, and because it wins over
 * `loaded` it would keep live values resolving against text that is no longer
 * on screen until the next keystroke. Every adopt site clears. So does a note
 * switch: the outgoing note's text says nothing about the incoming one's
 * sheets. */
export interface TypedBody {
  /** the sampled buffer for `path`, or null when nothing has been sampled for
      it (a sample held for another note never bleeds across) */
  body: string | null;
  /** sample this buffer once typing settles */
  sample: (path: string, body: string) => void;
  /** forget the sample and any pending one */
  clear: () => void;
}

export function useTypedBody(path: string, delayMs = 400): TypedBody {
  const [sampled, setSampled] = useState<{ path: string; body: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setSampled((cur) => (cur === null ? cur : null));
  }, []);

  const sample = useCallback(
    (samplePath: string, body: string) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setSampled({ path: samplePath, body }), delayMs);
    },
    [delayMs]
  );

  // a pending sample has nothing left to feed once the pane is gone
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { body: sampled?.path === path ? sampled.body : null, sample, clear };
}
