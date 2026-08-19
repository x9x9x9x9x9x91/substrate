// The freshness cache — what keeps a freshness column from re-walking git
// every time a table repaints.
//
// Mining a fact's age opens the repository and walks the commits that touched
// its note. That is fine once and ruinous per render: a hub with three views
// on screen repaints on every keystroke in the note beside it. So the answers
// are kept, stamped with the note's `updated_ms`, and only the facts whose
// NOTE has changed on disk since are asked again. A fact cannot move without
// its note moving, so the stamp is exact rather than a heuristic — and when
// nothing changed, a repaint asks for nothing at all.
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.
// Keep to erasable TS syntax only (no enums/namespaces).

import type { FactFreshness } from "./types.ts";

/** One fact, with the note-modified stamp its answer is good for. */
export interface FreshStamp {
  path: string;
  key: string;
  updated_ms: number;
}

/** What a repaint has to do: the answers already held, and the facts that
    must be asked of the history. `misses` is what goes down the wire. */
export interface FreshPlan {
  hits: FactFreshness[];
  misses: FreshStamp[];
}

/** How a fact is addressed everywhere ages are held or handed around: the
    note's path and the property key, joined by a byte that cannot occur in
    either. One spelling, so a surface that keys its own answer map cannot
    drift from the cache the answers came out of — a space-joined key collides
    the moment a path or a prop name contains a space. */
export const factRefKey = (path: string, key: string): string => `${path}\0${key}`;

/** How many facts one history call may carry.

    The call takes the history mutex for its whole walk, and the watcher's
    batch handler — reindex, auto-snapshot, the reflex run — queues on that
    same lock. A whole-vault ask sent as ONE call therefore stalls every
    background write for the length of an O(notes × commits) walk. Chunked,
    the lock is released between chunks and the report fills in visibly
    instead of arriving at once. */
export const FRESH_CHUNK_FACTS = 60;

/** The most facts one surface will ask about at all. A vault big enough to
    exceed this would spend minutes walking git for a single screen; the
    surface says how many it left unread rather than pretending the report is
    complete (`FactAges.unread`). */
export const FRESH_MAX_FACTS = 600;

/** How many answers the module-level cache holds. Bounded because the app's
    instance lives for the session and a long day of browsing a big vault
    would otherwise grow it without limit; oldest-inserted goes first, which
    for this access pattern is the surface the reader has left. */
export const FRESH_CACHE_MAX = 5000;

/** The facts a surface will actually ask about, and the ones it had to leave
    out. Order is the caller's own, so what gets dropped is the tail of the
    surface's own ranking rather than an arbitrary slice. */
export function capStamps(
  stamps: FreshStamp[],
  max: number = FRESH_MAX_FACTS
): { asked: FreshStamp[]; unread: number } {
  if (stamps.length <= max) return { asked: stamps, unread: 0 };
  return { asked: stamps.slice(0, max), unread: stamps.length - max };
}

/** Split a set of misses into calls, each small enough that the history lock
    it takes is held for a bounded walk. */
export function chunkStamps(
  stamps: FreshStamp[],
  size: number = FRESH_CHUNK_FACTS
): FreshStamp[][] {
  const out: FreshStamp[][] = [];
  for (let i = 0; i < stamps.length; i += Math.max(1, size)) {
    out.push(stamps.slice(i, i + Math.max(1, size)));
  }
  return out;
}

export interface FreshCache {
  /** Which of these facts are answered, and which have to be mined. */
  plan(stamps: FreshStamp[]): FreshPlan;
  /** Keep what the history just answered. `stamps` are the ones asked for,
      so a fact the history had nothing to say about is still remembered as
      answered — otherwise every repaint would re-ask the unanswerable ones,
      which are exactly the notes with no history and the most expensive to
      walk. */
  fill(stamps: FreshStamp[], answers: FactFreshness[]): void;
  /** Forget everything. Called on a vault switch (`vaultChoose`, ipc.ts):
      paths repeat across vaults and an answer from the last one would be a
      lie about this one. */
  clear(): void;
  /** How many facts are held — the number a test asserts against. */
  size(): number;
}

/** A cache instance. The app keeps one module-level instance (`freshCache`);
    a test makes its own, so tests never share state. */
export function makeFreshCache(max: number = FRESH_CACHE_MAX): FreshCache {
  const held = new Map<string, { updated_ms: number; fresh: FactFreshness | null }>();
  return {
    plan(stamps) {
      const hits: FactFreshness[] = [];
      const misses: FreshStamp[] = [];
      for (const s of stamps) {
        const have = held.get(factRefKey(s.path, s.key));
        // a stamp that moved in EITHER direction is a different note state —
        // an undo or a sync rolling a file back must re-ask, not reuse
        if (have && have.updated_ms === s.updated_ms) {
          if (have.fresh) hits.push(have.fresh);
        } else {
          misses.push(s);
        }
      }
      return { hits, misses };
    },
    fill(stamps, answers) {
      const byRef = new Map(answers.map((a) => [factRefKey(a.path, a.key), a]));
      for (const s of stamps) {
        const k = factRefKey(s.path, s.key);
        // re-inserting moves a key to the end of the Map's own order, which
        // is what makes the eviction below oldest-first rather than
        // oldest-ever-seen
        held.delete(k);
        held.set(k, { updated_ms: s.updated_ms, fresh: byRef.get(k) ?? null });
      }
      while (held.size > max) {
        const oldest = held.keys().next();
        if (oldest.done) break;
        held.delete(oldest.value);
      }
    },
    clear() {
      held.clear();
    },
    size() {
      return held.size;
    },
  };
}

/** The app's one cache. Module-level because the surfaces that show ages —
    a fence in a note, the same fence on a hub, the stale-facts report — are
    asking about the same vault, and a per-component cache would mine the
    same fact once per surface. */
export const freshCache: FreshCache = makeFreshCache();

/** Ask the history for a set of misses, one bounded chunk at a time, keeping
    each chunk's answers as they land.

    `live` is checked before every chunk AND before every hand-back, so a
    surface that unmounted mid-walk stops asking rather than finishing a walk
    nobody is waiting for — the whole point of chunking is that there are
    places to stop. `onChunk` receives every answer known so far, so a caller
    can paint progressively without accumulating its own.

    The ask is injected rather than imported: this module stays free of the
    IPC layer (and of the DOM), which is what lets it run under `node --test`. */
export async function askFreshness(
  misses: FreshStamp[],
  ask: (refs: { path: string; key: string }[]) => Promise<FactFreshness[]>,
  onChunk: (answers: FactFreshness[]) => void,
  live: () => boolean = () => true,
  cache: FreshCache = freshCache,
  size: number = FRESH_CHUNK_FACTS
): Promise<void> {
  const found: FactFreshness[] = [];
  for (const chunk of chunkStamps(misses, size)) {
    if (!live()) return;
    const mined = await ask(chunk.map(({ path, key }) => ({ path, key })));
    // the answers are worth keeping even if the surface has gone: the walk
    // has already been paid for, and the next surface asking gets it free
    cache.fill(chunk, mined);
    found.push(...mined);
    if (!live()) return;
    onChunk([...found]);
  }
}
