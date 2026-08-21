import type { ReactNode } from "react";

/* The two sentences every dashboard kind can be reduced to when it has
   nothing to draw: "there is nothing here, and here is why" and "something
   broke, and here is what". Fifteen kinds had four dialects between them —
   a faint mono footer line, a centred sentence, a per-kind error class each,
   and one board with a calm dot and a full sentence. The dot-and-sentence one
   was the one worth keeping, so it is the one that lives here.

   The SENTENCES stay with the kinds: each board knows what its own emptiness
   means and says it in its own words. What this file owns is the dress. */

/** Nothing to show, and nothing is wrong — the calm state.

    `tone` is deliberately two values, not a palette. `quiet` is the default
    and means "this board has no content yet"; `ok` is for the affirmative
    all-clear, where the emptiness IS the good news ("everything accounted
    for") and a green mark is the reading rather than decoration. A failed
    read is never an empty state — that is `DashAlert`. */
export function DashEmpty({
  tone = "quiet",
  children,
}: {
  tone?: "quiet" | "ok";
  children: ReactNode;
}) {
  return (
    <div className="dash-empty">
      <span
        className="dash-dot"
        style={{ background: tone === "ok" ? "var(--ok)" : "var(--text-4)" }}
      />
      <span>{children}</span>
    </div>
  );
}

/** Something failed — a fence that would not parse, a source that is not
    there, a write that did not land. One banner, one colour, wherever it
    happens: in a page's flow, inside a grid tile, under a chart's own label.

    `fill` is the tile variant: a broken tile has to hold its cell open or the
    grid row collapses around it and the neighbours reflow. */
export function DashAlert({
  fill = false,
  children,
}: {
  fill?: boolean;
  children: ReactNode;
}) {
  return <div className={fill ? "dash-alert is-fill" : "dash-alert"}>{children}</div>;
}
