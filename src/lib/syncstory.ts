/* Shared age voice for status rows: "35m", "2h 14m", "1d 2h", "never". Pure
   and now-injectable so a surface and its tests share the words. fmtDur is the
   bare-duration half — the feed dashboard's staleness label and the shelf's
   row ages reuse it so every surface spells ages the same way. */

/** ms since an ISO timestamp, null when absent/unparseable */
export function ageMs(iso: string | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : now - t;
}

/** The two largest units with zero remainders dropped, matching fmtWindow's
    convention in this surface's compact spelling: "35m", "9h",
    "2h 14m", "1d 2h", "2d". */
export function fmtDur(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) {
    const rm = mins % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  }
  const rh = h % 24;
  return rh > 0 ? `${Math.floor(h / 24)}d ${rh}h` : `${Math.floor(h / 24)}d`;
}

/** fmtDur of a stamp's age; absent → "never". */
export function fmtAge(iso: string | undefined, now = Date.now()): string {
  const ms = ageMs(iso, now);
  if (ms === null) return "never";
  return fmtDur(ms);
}

export const ago = (iso: string | undefined, now = Date.now()): string => {
  const a = fmtAge(iso, now);
  return a === "never" ? "never" : `${a} ago`;
};

