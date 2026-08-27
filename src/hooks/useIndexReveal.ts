import { useEffect } from "react";

/** Keep the selected row visible when arrow-keying past the fold: scroll the
    child matching `[<attr>="<sel>"]` into view whenever `deps` move. `deps`
    are the caller's — `sel` plus whatever can replace its row set while `sel`
    stays the same number (filtering resets the selection to the top, which is
    a no-op when it already was 0, so without the rows in `deps` a list the
    user had scrolled keeps its offset and hides the selection). A negative
    `sel` (no selection) reveals nothing. */
export function useIndexReveal(
  listRef: { current: HTMLElement | null },
  sel: number,
  deps: readonly unknown[],
  attr = "data-idx",
) {
  useEffect(() => {
    if (sel < 0) return;
    listRef.current?.querySelector(`[${attr}="${sel}"]`)?.scrollIntoView({ block: "nearest" });
    // the dependency list is the caller's own, per the contract above
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}
