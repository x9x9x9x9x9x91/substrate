/** Folder-as-playlist classification (SUB-812) — pure parsing over the
 * `FolderFile` rows the engine lists for a folder view. Turning a row into a
 * playable URL is `assets.ts`'s job; driving the shared player is
 * `editor-widgets.ts`'s; this module only decides what a row IS.
 *
 * The `.assets/` dedupe lives one layer down, in the engine: the listing
 * skips dot-paths, so an imported embed (which lives in `.assets/`) can never
 * also be a folder row. A LINK-IN-PLACE embed (`![[/Users/…/master.wav]]`)
 * does point at a file a folder view can list — and that is correct: it is
 * one file with two surfaces, and since both address it by absolute path
 * they share one shared-player entry rather than fighting over two.
 */

import { AUDIO_EXT_RE, isImageName } from "./artwork.ts";
import type { FolderFile } from "./types.ts";

/** Rows that play. Same audio set as note embeds and file props (artwork.ts),
 * so a format added there becomes playable everywhere at once. */
export function isPlayableFile(file: FolderFile): boolean {
  return AUDIO_EXT_RE.test(file.name);
}

/** The playable subset, in listing order — the playlist a folder IS. */
export function playableFiles(files: FolderFile[]): FolderFile[] {
  return files.filter(isPlayableFile);
}

/** Coarse row class, for the glyph. Audio rows get the play affordance;
 * everything else is a plain row with the OS open/reveal actions. */
export type FileKind = "audio" | "image" | "other";

export function fileKind(file: FolderFile): FileKind {
  if (isPlayableFile(file)) return "audio";
  if (isImageName(file.name)) return "image";
  return "other";
}

/** Uppercase extension for the row's type mark ("WAV", "ALS"), or null for a
 * file with no extension — a mark reading "FILE" would be noise. */
export function fileExt(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  // a "extension" with a space in it is really part of the name
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toUpperCase() : null;
}

/** Index `dir` steps from `index`, wrapping. Manual prev/next WRAPS: the
 * gesture was asked for, and stopping dead at the last take reads as a broken
 * button. Auto-advance does not wrap — see `playqueue.ts` — because a folder
 * that silently restarts forever is a different product. */
export function stepIndex(length: number, index: number, dir: 1 | -1): number {
  if (length <= 0) return 0;
  return (((index + dir) % length) + length) % length;
}

/** mm:ss for a player position. Non-finite durations (a stream still
 * resolving its metadata) render as a placeholder rather than "NaN:aN". */
export function clockTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
