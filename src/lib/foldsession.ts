/* Session-scoped fold memory. Keyed by the note's LIVE path — not
   the editor's mount identity (docKey), which deliberately lags the path
   across a rename: folds saved under the lagging key would be
   orphaned the moment the user navigates away and back under the new path. */

export const sessionFolds = new Map<string, { from: number; to: number }[]>();

export function foldSessionKey(docKey: string) {
  return docKey.replace(/@\d+$/, "");
}

/** A rename moves the note's fold entries with it, so a rename done while
    the note is CLOSED (row menu, ⌘Z of a rename) doesn't orphan them under
    the old path. A mounted editor saves under its live foldKey anyway — for
    that case this is a harmless early move. Suffixed keys (the sheet source
    view's ":source") ride along. */
export function migrateSessionFolds(from: string, to: string) {
  if (from === to) return;
  for (const [key, ranges] of [...sessionFolds]) {
    const suffix = key === from ? "" : key.startsWith(`${from}:`) ? key.slice(from.length) : null;
    if (suffix === null) continue;
    sessionFolds.delete(key);
    sessionFolds.set(to + suffix, ranges);
  }
}
