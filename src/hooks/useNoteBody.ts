import { useEffect, useState } from "react";
import { historyProjectionActive, onHistoryLeave, projectedNoteBody, vaultRead } from "../lib/ipc";
import {
  dropRememberedNoteBodies,
  forgetNoteBody,
  rememberNoteBody,
  rememberedNoteBody,
} from "../lib/notebody";

// leaving the past reloads every pane from disk anyway; a body read in one era
// must never seed a paint in another (the NotePane orphan purge, SUB-822, for
// the same reason)
onHistoryLeave(dropRememberedNoteBodies);

/** This note's body, reloaded when the vault changes under it — seeded, where
    the app already holds a copy, so the pane paints content on its first
    frame instead of an empty one (SUB-1169).
 *
 * The seed comes from the in-memory vault snapshot, whichever one is in force:
 * a history projection's own contents while the past is on screen, otherwise
 * the body this session last read for the path. The read still runs on every
 * mount and its answer always wins, so a seeded pane is at most one read
 * behind disk and reconciles the moment that read lands. `null` is still
 * returned for a genuinely cold read — the caller's empty frame is then honest.
 *
 * Sealed notes are never held: a locked note's plaintext must not outlive the
 * pane that read it. */
export function useNoteBody(path: string, vaultEpoch: number, sealed = false): string | null {
  const [body, setBody] = useState<string | null>(() => seedBody(path, sealed));

  // Re-seed the instant the note under this pane changes: the state still
  // holds the PREVIOUS note's body, which is a wrong paint rather than a slow
  // one. Adjusted during render, not in an effect, so no frame is ever drawn
  // with the stale pairing. A bare `vaultEpoch` bump is deliberately not a
  // re-seed — the body on screen belongs to the right note, so it stays up
  // while the fresh read runs.
  const key = `${sealed ? "!" : ""}${path}`;
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setBody(seedBody(path, sealed));
  }

  useEffect(() => {
    let gone = false;
    vaultRead(path)
      .then((c) => {
        if (gone) return;
        if (!sealed && !historyProjectionActive()) rememberNoteBody(path, c.body);
        setBody(c.body);
      })
      .catch(() => {
        // the note is gone, sealed shut, or the read failed — drop the held
        // copy so this pane (and the next mount) shows nothing rather than a
        // body the vault can no longer produce
        forgetNoteBody(path);
        if (!gone) setBody(null);
      });
    return () => {
      gone = true;
    };
  }, [path, vaultEpoch, sealed]);

  return body;
}

function seedBody(path: string, sealed: boolean): string | null {
  if (sealed) return null;
  if (historyProjectionActive()) return projectedNoteBody(path);
  return rememberedNoteBody(path);
}
