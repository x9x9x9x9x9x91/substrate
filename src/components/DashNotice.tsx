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
    happens: in a page's flow, inside a grid tile, under a chart's own label,
    and on the panes outside the board kinds that speak the same failure.

    `fill` is the tile variant: a broken tile has to hold its cell open or the
    grid row collapses around it and the neighbours reflow.

    `live` marks the banner as a live region. A board's banner is painted with
    the board, so a reader meets it by reading; a sync failure ARRIVES in
    answer to a button that was just pressed, and a screen reader has to be
    told without being moved. That is the only difference between the two, so
    it is a flag rather than a second component. */
export function DashAlert({
  fill = false,
  live = false,
  children,
}: {
  fill?: boolean;
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={fill ? "dash-alert is-fill" : "dash-alert"} role={live ? "alert" : undefined}>
      {children}
    </div>
  );
}

/** A board's provenance footer: where the numbers came from, how old they
    are, what they exclude. Every fact gets its OWN line.

    The facts used to arrive middot-chained — "polled 14:02 · every 10s ·
    rates avg 10m · quota every 5m · 127.0.0.1:8318" — which design-principles
    lists twice as a bug: §1.6 asks prose for one fact per line, and §6 names
    the chain itself an anti-pattern. A chain reads as one long unparseable
    string precisely where the reader is scanning for a single fact ("how
    stale is this?"), because nothing tells them where one fact ends.

    Facts are `ReactNode`, so a line can carry a formatted number or a link,
    and `null`/`false`/`""` entries drop out — a conditional fact is written
    inline as a ternary rather than filtered by every caller. `children` slots
    a control (a refresh button) after the lines. */
export function DashFoot({
  className,
  facts,
  children,
}: {
  className?: string;
  facts: ReactNode[];
  children?: ReactNode;
}) {
  const lines = facts.filter((f) => f !== null && f !== undefined && f !== false && f !== "");
  if (lines.length === 0 && !children) return null;
  return (
    <div className={className ? `dash-foot ${className}` : "dash-foot"}>
      {lines.map((f, i) => (
        <div className="dash-foot-line" key={i}>
          {f}
        </div>
      ))}
      {children}
    </div>
  );
}
