/** The listening queue behind the mini-player (SUB-812): which folder is
 * playing, in what order, and where in it we are.
 *
 * Module state, not React state — deliberately, and for the same reason the
 * shared `<audio>` lives in `editor-widgets.ts`: playback has to survive
 * every navigation, and anything owned by a pane dies when that pane
 * unmounts. App renders the bar from a subscription; the queue itself
 * outlives every view switch.
 *
 * Deliberately audio-free. Nothing here touches an `HTMLAudioElement` or
 * imports the player, so the whole ordering story stays pure and testable
 * under `node --test`; `MiniPlayer` is the one place that binds a queue
 * position to the shared player.
 */

import { stepIndex } from "./folderfiles.ts";

export interface QueueTrack {
  /** the shared player's key — the same NAME the row mounts its player with,
   * which is what `audioSource` resolves. A folder queue passes the file's
   * ABSOLUTE path (`FolderFile.path`); a sheet-backed queue passes its own
   * cell verbatim (absolute, `~/…`, or a bare `.assets/` name). So one file is
   * one player exactly as far as the two surfaces spell it the same way — two
   * spellings of one file are two seats, not a clobber. */
  key: string;
  /** vault-relative path — row identity inside the folder listing */
  rel: string;
  /** display name */
  name: string;
}

export interface PlayQueue {
  /** where the queue came from, as the mini-player labels it: the
   * vault-relative folder for a folder queue ("" = vault root), or the source
   * note's title for a sheet-backed queue, whose rows have no one folder on
   * disk. A label, never a path to resolve against. */
  folder: string;
  tracks: QueueTrack[];
  index: number;
}

let queue: PlayQueue | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function getQueue(): PlayQueue | null {
  return queue;
}

export function subscribeQueue(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Start a folder at one track. Returns the track so the caller can hand it
 * to the player — the queue never plays anything itself. */
export function startQueue(folder: string, tracks: QueueTrack[], index: number): QueueTrack | null {
  if (tracks.length === 0) {
    clearQueue();
    return null;
  }
  const at = Math.min(Math.max(index, 0), tracks.length - 1);
  queue = { folder, tracks, index: at };
  notify();
  return tracks[at];
}

/** Manual prev/next — WRAPS (see `stepIndex`). Returns the track to play, or
 * null when there is no queue. */
export function stepQueue(dir: 1 | -1): QueueTrack | null {
  if (!queue || queue.tracks.length === 0) return null;
  queue = { ...queue, index: stepIndex(queue.tracks.length, queue.index, dir) };
  notify();
  return queue.tracks[queue.index];
}

/** Auto-advance when a track ends — does NOT wrap. Reaching the last take
 * leaves the queue parked on it and returns null: a folder that silently
 * restarts forever is a different product from one that plays through. */
export function advanceQueue(): QueueTrack | null {
  if (!queue) return null;
  const next = queue.index + 1;
  if (next >= queue.tracks.length) return null;
  queue = { ...queue, index: next };
  notify();
  return queue.tracks[next];
}

/** Re-seat the queue against a fresh listing of the same folder (the
 * `vault:changed` refetch). The playing track keeps its position by key, so a
 * file added or removed elsewhere in the folder does not silently make
 * "next" mean a different take. A queue whose track vanished from disk is
 * dropped whole — there is nothing left to step through from. */
export function syncQueue(folder: string, tracks: QueueTrack[]): void {
  if (!queue || queue.folder !== folder) return;
  const playing = queue.tracks[queue.index];
  const at = playing ? tracks.findIndex((t) => t.key === playing.key) : -1;
  if (at === -1) {
    clearQueue();
    return;
  }
  queue = { folder, tracks, index: at };
  notify();
}

export function clearQueue(): void {
  if (!queue) return;
  queue = null;
  notify();
}

/** Test-only reset so a spec's queue never leaks into the next one. */
export function resetQueueForTests(): void {
  queue = null;
  listeners.clear();
}
