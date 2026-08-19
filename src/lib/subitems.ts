/** Sub-item trees: when a database marks one of its relation props as the
    parent link (the reserved `parent` key of its schema entry — see
    typeParentProp), its table and board rows render as ONE level of
    expandable tree rows. Nothing about the notes changes: the link is a
    plain relation value in frontmatter, so grep, agents and every other
    surface see exactly what they saw before; this module derives the shape
    on read, the way rollup.ts derives its columns.

    Matching mirrors rollup.ts and the rename sweep: rows are matched by
    title OR stem, case-insensitive and trimmed — two rows sharing a title
    are indistinguishable, the first wins. A dangling value (a trashed or
    renamed-away row) links nothing. A row naming itself, and any cycle,
    links nothing either: both ends fall back to standing on their own, so a
    hand-edited vault can never hide a row or spin the walk.

    ONE level, deliberately: a grandchild is NOT indented under its indented
    parent. It stands flat, as a top-level row of its own — with no chevron
    of its own in that section, since its children stand flat there too. It
    still carries its badge, so nothing disappears and the indent never runs
    away into an outliner. (In another section — a board column its own
    parent is not in — the same row is top-level and DOES gather its
    children; the fence is per section, not per note.) */

import type { NoteMeta } from "./types.ts";
import { foldedPropKey, foldedPropStr } from "./types.ts";
import { propList } from "./relation.ts";
import { isComplete } from "./calendar.ts";

/** child path → parent path, for the rows of one database. */
export type ParentLinks = ReadonlyMap<string, string>;

/** One parent row's rollup: what climbs the chain. `total` counts every
    descendant, not just the rows nested directly under it — a parent of a
    parent reports the whole branch — and `done` is how many of those read
    complete (`status: done`/`cancelled`, the one status-aware predicate). */
export interface SubSummary {
  total: number;
  done: number;
}

/** Resolve the parent link of every row of one database. `parentProp` is the
    canonical schema key of the marked relation prop; `notes` are the
    database's own rows (the relation points back at this same database, so
    parents and children come from one set). */
export function parentLinks(notes: NoteMeta[], parentProp: string): ParentLinks {
  // title/stem → the row it names, first wins (rollup.ts's convention)
  const byName = new Map<string, string>();
  for (const n of notes) {
    const title = n.title.trim().toLowerCase();
    const stem = n.stem.trim().toLowerCase();
    if (title && !byName.has(title)) byName.set(title, n.path);
    if (stem && !byName.has(stem)) byName.set(stem, n.path);
  }
  const links = new Map<string, string>();
  for (const n of notes) {
    // ONE parent: a relation may store several values, the first that
    // resolves is the parent — a second link would fork the tree
    for (const v of propList(n.props, foldedPropKey(n.props, parentProp))) {
      const target = byName.get(v.trim().toLowerCase());
      if (!target || target === n.path) continue;
      links.set(n.path, target);
      break;
    }
  }
  // break cycles: every row ON a loop stands on its own — decided against
  // the ORIGINAL links, so both ends of an A↔B pair drop, never just the
  // one that happened to be walked first
  const onCycle = new Set<string>();
  const settled = new Set<string>();
  for (const start of links.keys()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const index = new Map<string, number>();
    let at: string | undefined = start;
    while (at && !settled.has(at) && !index.has(at)) {
      index.set(at, path.length);
      path.push(at);
      at = links.get(at);
    }
    if (at && index.has(at)) for (const p of path.slice(index.get(at)!)) onCycle.add(p);
    for (const p of path) settled.add(p);
  }
  for (const p of onCycle) links.delete(p);
  return links;
}

/** The rollup every parent row carries: descendant count and how many of
    those are complete. Rows with no descendants are absent from the map —
    the "no chevron, no badge" case. */
export function subSummaries(notes: NoteMeta[], links: ParentLinks): Map<string, SubSummary> {
  const byPath = new Map(notes.map((n) => [n.path, n]));
  const out = new Map<string, SubSummary>();
  for (const n of notes) {
    const done = isComplete(foldedPropStr(n.props, "status") ?? undefined);
    // climb the chain: the row counts for its parent, its grandparent, …
    // (links are cycle-free, so the walk always terminates)
    let at = links.get(n.path);
    const seen = new Set<string>();
    while (at && byPath.has(at) && !seen.has(at)) {
      seen.add(at);
      const rec = out.get(at) ?? { total: 0, done: 0 };
      rec.total += 1;
      if (done) rec.done += 1;
      out.set(at, rec);
      at = links.get(at);
    }
  }
  return out;
}

/** One section's rows in tree order. `depth` is 0 or 1 per rendered row;
    `childCount` is how many rows nest DIRECTLY under a row in THIS section
    (0 = no chevron here, even when the row has descendants elsewhere). */
export interface TreeSection {
  rows: NoteMeta[];
  depth: Map<string, number>;
  childCount: Map<string, number>;
}

/** Arrange one section's rows (a table group, a board column, or the whole
    ungrouped table) into tree order: each parent immediately followed by its
    children, in the order the sort already put them.

    A row nests only when its parent is in the SAME section and is itself
    top-level there — so grouping stays honest (a child never jumps into
    another group's box to find its parent) and the indent stays one level
    deep. Every other row keeps its place in the flat order. Children of a
    COLLAPSED parent drop out of `rows` entirely, which is what keeps lazy
    paint, keyboard navigation and the section count describing the rows the
    reader can actually see. (Exports and the footer tally deliberately do
    NOT ride a fold — the caller re-derives them with nothing collapsed.) */
export function treeSection(
  rows: NoteMeta[],
  links: ParentLinks,
  collapsed: ReadonlySet<string>
): TreeSection {
  const here = new Set(rows.map((n) => n.path));
  // a row is a child HERE when its parent sits in this section…
  const parentHere = new Map<string, string>();
  for (const n of rows) {
    const p = links.get(n.path);
    if (p && here.has(p)) parentHere.set(n.path, p);
  }
  // …and that parent is itself top-level here — otherwise the row would
  // indent a second level, so it stands on its own instead
  const kids = new Map<string, NoteMeta[]>();
  const depth = new Map<string, number>();
  const out: NoteMeta[] = [];
  for (const n of rows) {
    const p = parentHere.get(n.path);
    if (p && !parentHere.has(p)) kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  for (const n of rows) {
    const p = parentHere.get(n.path);
    if (p && !parentHere.has(p)) continue; // emitted under its parent below
    depth.set(n.path, 0);
    out.push(n);
    if (collapsed.has(n.path)) continue;
    for (const kid of kids.get(n.path) ?? []) {
      depth.set(kid.path, 1);
      out.push(kid);
    }
  }
  const childCount = new Map([...kids].map(([p, list]) => [p, list.length]));
  return { rows: out, depth, childCount };
}
