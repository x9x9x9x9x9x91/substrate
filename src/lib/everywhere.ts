/**
 * The everywhere palette's row model — the floating window summoned by a
 * global chord from any app (src/palette.tsx).
 *
 * DOM-free on purpose: the window is a second React entry point with its own
 * bundle, and everything worth arguing about here is ordering. It reuses the
 * ⌘K palette's ranking wholesale (`rankCommands`, `hoistAboveContent`,
 * synonyms) so a query behaves the same in both surfaces; what is new is the
 * merge of three row kinds into one list, and the rule that keeps the capture
 * row from stealing Enter.
 */
import { FIXED_VIEW_COMMANDS, hoistAboveContent, rankCommands } from "./palette.ts";
import { basename } from "./files.ts";
import { looksLikeUrl } from "./url.ts";
import type { SearchHit, View } from "./types.ts";

/** What Enter on a row does. */
export type EverywhereAction =
  | { kind: "note"; path: string }
  | { kind: "view"; view: View }
  | { kind: "capture"; text: string };

/** One rendered row. `dest` is the bare destination name ranking reads
    ("Today" for "Go to Today"); `section` is both the heading and what
    `hoistAboveContent` sorts against. */
export interface EverywhereRow {
  id: string;
  section: string;
  label: string;
  dest?: string;
  snippet?: string;
  action: EverywhereAction;
}

/** The capture row's id — the window checks for it when it needs to know
    whether Enter is filing text rather than navigating. */
export const CAPTURE_ROW_ID = "everywhere:capture";

/** A dashboard as the window knows it: enough to name and open it. */
export interface DashboardRef {
  path: string;
  title: string;
}

/** Note title as this window shows it: the indexed title when the note list
    has arrived, the filename otherwise — a search hit must never render
    blank while the list is still loading. */
function titleFor(path: string, titles: Map<string, string>): string {
  return titles.get(path) ?? basename(path).replace(/\.md$/i, "");
}

/** Every fixed destination this window offers. The gated rows stay out: the
    proxy row hangs off a boot probe the main window runs and this one does
    not, and the Agent Ledger's switch lives in a Settings.md read this window
    never makes. A row that can only report "not here" is worse than no row. */
function destinationRows(dashboards: DashboardRef[]): EverywhereRow[] {
  return [
    ...FIXED_VIEW_COMMANDS.filter(
      (c) =>
        !c.when ||
        c.when({
          proxyAvailable: false,
        })
    ).map((c) => ({
      id: c.id,
      section: "Destinations",
      label: c.label,
      dest: c.dest,
      action: { kind: "view" as const, view: c.view },
    })),
    ...dashboards.map((d) => ({
      id: `everywhere:dashboard:${d.path}`,
      section: "Destinations",
      label: `Dashboard: ${d.title}`,
      dest: d.title,
      action: { kind: "view" as const, view: { kind: "dashboard" as const, path: d.path } },
    })),
  ];
}

/** The capture row's words — a pasted link becomes a reference note, exactly
    as it does in the quick-capture window. */
export function captureLabel(text: string): string {
  return looksLikeUrl(text) ? `Capture link “${text}”` : `Capture “${text}” to Inbox`;
}

/**
 * The window's rows, in render order, for one query.
 *
 * An empty query browses the destinations in declaration order (no search has
 * run, and there is nothing to capture yet). With a query: note hits first,
 * then destinations — with any destination in the exact/prefix band hoisted
 * directly under the notes, the ⌘K palette's own rule — and the capture row
 * LAST.
 *
 * Last is the whole point: the window opens with row 0 selected, so Enter
 * navigates whenever there is anything to navigate to, and only reaches the
 * capture row when the user walks down to it or when nothing else matched (it
 * is then the only row, hence row 0).
 */
export function everywhereRows(input: {
  q: string;
  hits: SearchHit[];
  /** path → indexed title, from the note list */
  titles: Map<string, string>;
  dashboards: DashboardRef[];
}): EverywhereRow[] {
  const q = input.q.trim();
  const dests = destinationRows(input.dashboards);
  if (!q) return dests;

  const { ranked, hoisted } = rankCommands(q, dests);
  const notes: EverywhereRow[] = input.hits.map((h) => ({
    id: `everywhere:note:${h.path}`,
    section: "Notes",
    label: titleFor(h.path, input.titles),
    // the prop value that answered the query when the body didn't
    snippet: h.prop_snippet ?? h.snippet ?? undefined,
    action: { kind: "note", path: h.path },
  }));
  const rows = hoistAboveContent([...notes, ...ranked], hoisted);
  rows.push({
    id: CAPTURE_ROW_ID,
    section: "Capture",
    label: captureLabel(q),
    action: { kind: "capture", text: q },
  });
  return rows;
}

/**
 * Validate a view arriving over the `app:open-view` event before the main
 * window renders it.
 *
 * The emitter is this app's own palette window, so this is a shape check
 * rather than a trust boundary — but `setView` takes the app straight to a
 * pane, and a kind it has no case for renders nothing at all. Only the kinds
 * the palette can actually emit pass: the fixed catalogue's own, plus a
 * dashboard with a path.
 */
export function parseEverywhereView(payload: unknown): View | null {
  if (typeof payload !== "object" || payload === null) return null;
  const kind = (payload as { kind?: unknown }).kind;
  if (typeof kind !== "string") return null;
  if (kind === "dashboard") {
    const path = (payload as { path?: unknown }).path;
    return typeof path === "string" && path.trim() ? { kind: "dashboard", path } : null;
  }
  const fixed = FIXED_VIEW_COMMANDS.find((c) => c.view.kind === kind);
  return fixed ? fixed.view : null;
}
