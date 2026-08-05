/** Bodies this session has already read, per note path (SUB-1169).
 *
 * A dashboard re-reads its own note over IPC on every mount, and until that
 * read lands the pane has nothing to draw — so leaving a board and coming
 * straight back flashes an empty frame over content the app was holding a
 * moment ago. This is that held copy: the last body a read actually returned,
 * used to paint the first frame of the next mount so the blank frame is
 * reserved for a genuinely cold read.
 *
 * It is a paint seed, never a source of truth. Every mount still issues its
 * read and adopts the answer, so a seed can be at most one read round-trip
 * stale, and nothing is ever written back from it. A read that fails evicts
 * the entry rather than leaving the pane painting a body the vault no longer
 * has.
 *
 * Bounded to LIMIT entries, most-recently-read last: browsing a vault full of
 * boards must not accumulate every body it passed through for the life of the
 * session.
 */

/** Boards a session realistically cycles between; well under the point where
    retained bodies are worth worrying about. */
const LIMIT = 32;

const bodies = new Map<string, string>();

/** The body last read for `path`, or null if this session has none. */
export function rememberedNoteBody(path: string): string | null {
  return bodies.get(path) ?? null;
}

export function rememberNoteBody(path: string, body: string): void {
  // re-insert so recency is the map's own order
  bodies.delete(path);
  bodies.set(path, body);
  while (bodies.size > LIMIT) {
    const oldest = bodies.keys().next();
    if (oldest.done) break;
    bodies.delete(oldest.value);
  }
}

/** Drop one path's copy — a read that failed, so the next mount goes cold
    rather than seeding from a body the vault may no longer have. */
export function forgetNoteBody(path: string): void {
  bodies.delete(path);
}

/** Drop every copy. Called on the way back from a history projection: a seed
    is only ever as good as the era it was read in. */
export function dropRememberedNoteBodies(): void {
  bodies.clear();
}

/** Test seam — how many bodies are currently held. */
export function rememberedNoteBodyCount(): number {
  return bodies.size;
}
