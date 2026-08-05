/** Pure selection math for the table's row multi-select — in lib so
    the range/toggle semantics are unit-testable without mounting the pane. */

/** Paths of the inclusive row range between two `rows` indices (order-free):
    shift-click selects from the anchor (last clicked row) to the clicked row.
    Indices walk the flat, focus-addressable `rows` array — grouped tables
    interleave `.db-group-tr` header rows in the DOM, so DOM siblings would
    lie. Out-of-range indices clamp, so a stale anchor can't throw. */
export function rangePaths(rows: { path: string }[], a: number, b: number): Set<string> {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(rows.length - 1, Math.max(a, b));
  const out = new Set<string>();
  for (let i = lo; i <= hi; i++) out.add(rows[i].path);
  return out;
}

/** ⌘/ctrl-click: toggle one path in or out of the selection. Returns a new
    set — the pane's selection state is immutable so React sees the change. */
export function togglePath(sel: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(sel);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
