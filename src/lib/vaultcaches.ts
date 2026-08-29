/** Caches that outlive a vault, and the one moment they stop being true.
 *
 * Most session caches key by something that carries the file's identity — an
 * absolute path, a size, an mtime — so a stale entry simply misses and costs
 * nothing. What those keys do not survive is the user choosing a DIFFERENT
 * vault: the entries stay valid-looking forever while naming files nobody is
 * reading any more, and the ones holding real memory (a parsed document, a
 * decoded buffer) hold it for the rest of the session.
 *
 * `vaultChoose` is that moment, and it already forgets the freshness answers
 * for the same reason. This module is how caches it cannot import reach it:
 * the PDF page renderer sits behind a dynamic import so a vault with no
 * document in it never loads it, and the editor's viewer state sits above the
 * IPC layer. Both announce themselves here instead.
 *
 * Not the same thing as `resetAudioSources`, which runs on every
 * `vault:changed` — that is "a file moved under us", and it fires when
 * anything at all is saved. A cache emptied there is emptied constantly. */

const leaving = new Set<() => void>();

/** Run `fn` when the user opens a different vault. */
export function onVaultLeft(fn: () => void) {
  leaving.add(fn);
}

/** The user has chosen another vault — everything keyed to the last one is
 * now dead weight. One cache throwing must not strand the others. */
export function forgetVaultCaches() {
  for (const fn of leaving) {
    try {
      fn();
    } catch {
      // best effort: this is a memory courtesy, not a correctness step
    }
  }
}
