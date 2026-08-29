/** A small cache of parsed things that cost real memory, where more than one
 * viewer may be drawing from the same entry at once. It lives apart from
 * `pdfdoc.ts` so the bookkeeping can be exercised without a PDF library, a
 * worker or a DOM behind it — the cases that matter are all about counting.
 *
 * Only an entry nobody is holding may be taken apart. The case that matters is
 * a note showing more embeds than the cap keeps: evicting by age alone would
 * destroy a document a visible viewer is still rendering from, and that viewer
 * would go on to call a perfectly healthy file unreadable. The cache overshoots
 * its cap while that many viewers are mounted and comes back down to it as they
 * are torn down. */

/** A holder's claim on a cached value. `release` is called once, when the
 * holder stops using it — until then the cache leaves the entry alone. */
export interface Held<T> {
  value: T;
  release(): void;
}

interface Entry<T> {
  value: T;
  holders: number;
}

export interface HeldCache<T> {
  /** The value for a key, made on a miss. Held from the moment it is asked
   * for, not from when it finishes arriving: a caller that walks away before
   * then releases the claim it already has. */
  hold(key: string, make: () => T): Held<T>;
  /** Forget a key, if it still names `value`. The value is disposed of even
   * while someone holds it — which is what a failed parse and a vault switch
   * both want, and neither has a viewer left that could draw from it. */
  drop(key: string, value?: T): void;
  /** Every key the cache carries, oldest first. */
  keys(): string[];
  /** How many holders a key has; 0 for a key the cache does not carry. */
  holders(key: string): number;
}

export function heldCache<T>(cap: number, dispose: (value: T) => void): HeldCache<T> {
  const entries = new Map<string, Entry<T>>();

  const evictUnheld = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= cap) return;
      if (entry.holders === 0) {
        entries.delete(key);
        dispose(entry.value);
      }
    }
  };

  const take = (entry: Entry<T>): Held<T> => {
    entry.holders++;
    evictUnheld();
    let released = false;
    return {
      value: entry.value,
      release() {
        // a holder that releases twice would let the cache take a value apart
        // under another holder that is still using it
        if (released) return;
        released = true;
        entry.holders--;
        evictUnheld();
      },
    };
  };

  return {
    hold(key, make) {
      const hit = entries.get(key);
      if (hit) return take(hit);
      const entry: Entry<T> = { value: make(), holders: 0 };
      entries.set(key, entry);
      return take(entry);
    },
    drop(key, value) {
      const entry = entries.get(key);
      if (!entry || (value !== undefined && entry.value !== value)) return;
      entries.delete(key);
      dispose(entry.value);
    },
    keys: () => [...entries.keys()],
    holders: (key) => entries.get(key)?.holders ?? 0,
  };
}
