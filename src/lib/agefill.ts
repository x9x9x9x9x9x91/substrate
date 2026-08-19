// The freshness column, painted into a plain-DOM table.
//
// The editor renders a view fence as DOM rather than as React, so the ages
// that the React table gets from a hook have to be filled in by hand here.
// The arithmetic is not repeated: the cell is decided in agecell.ts and the
// asking is done by freshcache.ts, so the two surfaces cannot disagree.
//
// No CodeMirror and no IPC imports on purpose — the history call is injected,
// which is what lets this run against a jsdom table under `node --test`.

import type { EmbedResult } from "./embeds.ts";
import type { FactFreshness } from "./types.ts";
import { ageCell, reviewWindow } from "./agecell.ts";
import { askFreshness, freshCache } from "./freshcache.ts";

/** Which asks have already come back empty-handed, by the exact set of facts
    they were about. History being off is a standing answer, not a transient
    failure: without this the editor re-fires the IPC on every repaint of every
    fence in the note, which on a vault with no repository is the one case
    where the call can never succeed. Bounded, because a session browsing a big
    vault would otherwise remember every table it ever failed on. */
const failed = new Set<string>();
const FAILED_MAX = 200;

function rememberFailure(signature: string): void {
  failed.add(signature);
  while (failed.size > FAILED_MAX) {
    const oldest = failed.values().next();
    if (oldest.done) break;
    failed.delete(oldest.value);
  }
}

/** Forget the standing "history said no" answers. A vault switch is the one
    event that can change that answer, and it is the same moment the cached
    ages are dropped. */
export function forgetFreshnessFailures(): void {
  failed.clear();
}

/** Fill a table's freshness columns, cached answers now and mined ones as they
 * land.
 *
 * The table may still be DETACHED when this runs — the widget builds its whole
 * node before CodeMirror inserts it — so "is this answer still wanted?" is
 * asked as "is this table still the one hanging off its wrapper?", never as
 * "is it in the document?". A repaint removes the old table from the wrapper,
 * which is exactly what makes the parent test the accurate one; testing
 * `isConnected` instead loses the whole warm-cache paint, and a fully cached
 * table then has no ages at all until something else happens to repaint it.
 *
 * `ask` is the history call. Chunked through `askFreshness`, so a fence over a
 * big database releases the history lock between chunks rather than holding it
 * against the watcher for one long walk. */
export function fillAges(
  table: HTMLElement,
  result: EmbedResult,
  ask: (refs: { path: string; key: string }[]) => Promise<FactFreshness[]>
): void {
  if ("error" in result || !result.ages) return;
  const props = Object.values(result.ages);
  const stamps = result.rows.flatMap((r) =>
    props.map((key) => ({ path: r.path, key, updated_ms: r.updated_ms }))
  );
  if (stamps.length === 0) return;
  const schema = result.typeSchema;
  // still ours as long as the wrapper still holds it; a repaint detaches the
  // table it replaced, and an answer for that one has nowhere to land
  const live = () => table.parentNode !== null;
  const paint = (found: FactFreshness[]) => {
    if (!live()) return;
    // one clock per painted batch: cells that landed together should not
    // disagree about what "today" is
    const now = Date.now();
    for (const fresh of found) {
      const td = table.querySelector(
        `tr[data-path="${CSS.escape(fresh.path)}"] td[data-age="${CSS.escape(fresh.key)}"]`
      );
      if (!td) continue;
      const cell = ageCell(fresh.key, fresh, reviewWindow(schema, fresh.key), now);
      const span = document.createElement("span");
      span.className = cell.className;
      span.title = cell.title;
      span.textContent = cell.text;
      td.replaceChildren(span);
    }
  };
  const { hits, misses } = freshCache.plan(stamps);
  paint(hits);
  if (misses.length === 0) return;
  const signature = misses.map((s) => `${s.path}\0${s.key}\0${s.updated_ms}`).join("\n");
  if (failed.has(signature)) return;
  void askFreshness(misses, ask, paint, live).catch(() => {
    // history being off is an answer, not an error: the cells stay empty, and
    // this table stops asking
    rememberFailure(signature);
  });
}
