/** What happens to focus and to an owed reveal when a database cell editor
    closes.

    The editor owns real DOM focus while it is open, so every close is a
    hand-off: something has to hold focus afterwards, and the grid's own
    coordinate is the only place that reads as "where I was". The close paths
    do not agree on where focus has landed by then, though —

      - Escape and a keyboard commit unmount the editor with nothing else
        asking for focus, so the browser drops it on `<body>`;
      - a click-away lands it on whatever the user pressed, and the editor's
        dismissal runs on `mousedown`, one task BEFORE the browser's own focus
        assignment — so the answer is only knowable a task later;
      - a stale anchor (the scroller moved under the popover) closes it with
        nobody having asked for anything.

    The rule the pane defends is one line: never move focus or the viewport
    under a user who has deliberately put focus somewhere else. So focus is
    restored only when nothing claimed it, and a reveal that came in while the
    editor was open is delivered at the close — scrolling only — rather than
    left armed for the next scroll or resize to hand over late. */

/** Where focus sits once the editor is gone and the click has settled. */
export type ActiveAfterClose =
  /** `<body>` — the editor took focus with it and nothing claimed it */
  | "nowhere"
  /** a cell/card of the grid composite itself (its roving tab stop) */
  | "grid-cell"
  /** a native control the user went to on purpose: a button, a link, a field */
  | "other-control";

/** Restore the anchoring cell's focus, or leave the user where they went. */
export function focusAfterEditorClose(active: ActiveAfterClose): "restore" | "leave" {
  return active === "nowhere" ? "restore" : "leave";
}

/** How an owed reveal — one queued while the editor held focus, which the
    focus effect refused to deliver — is settled at the close transition.
    It is always settled there: an owed reveal that survives the close is the
    late yank, delivered by whatever scroll or resize re-runs the effect next. */
export function revealAfterEditorClose(state: {
  owed: boolean;
  active: ActiveAfterClose;
}): "focus-and-scroll" | "scroll-only" | "none" {
  if (!state.owed) return "none";
  // focus is free (or already the composite's): the ordinary reveal, which
  // moves the roving tab stop onto the revealed row as well as scrolling it in
  if (state.active !== "other-control") return "focus-and-scroll";
  // the user is typing in something else. The row still has to be shown —
  // that is what was asked for — but taking their focus to do it is not.
  return "scroll-only";
}

/** Classify the live `document.activeElement` for the two rules above. A cell
    carries the roving tab stop's `data-fc`/`data-fr` pair. An element the
    document no longer holds is the editor's own input, unmounted with focus
    still nominally on it — nobody claimed focus, so that reads as nowhere. */
export function classifyActive(active: Element | null | undefined): ActiveAfterClose {
  if (!active) return "nowhere";
  const doc = active.ownerDocument;
  if (active === doc?.body || active === doc?.documentElement) return "nowhere";
  if (doc && !doc.contains(active)) return "nowhere";
  if (active.matches("[data-fc][data-fr]")) return "grid-cell";
  return "other-control";
}
