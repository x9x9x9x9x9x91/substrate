/** Embed-target classification + cover resolution for gallery cards — pure
 * parsing only (node-testable). Turning a target name into a renderable URL
 * lives in `assets.ts`. */

import { byFoldedKey } from "./schemalookup.ts";

// the canonical inline-image set — editor embeds, gallery covers, hub
// dashboards, print, and PDF export all route through isImageName, so a
// format added here renders everywhere at once. heic/heif ride on WebKit's
// native decoder (Safari 17+), which every supported macOS ships.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|heic|heif)$/i;

export function isImageName(name: string): boolean {
  return IMAGE_EXT_RE.test(name.trim());
}

// the canonical audio set (SUB-202): embeds with an audio extension render
// the player, and a file prop whose value matches carries the play
// affordance (SUB-674). The intake lanes accept any file type — this set
// only picks the affordance, it never gates intake.
export const AUDIO_EXT_RE = /\.(wav|aiff?|mp3|flac|m4a|ogg|opus|weba|webm)$/i;

/** Targets with an audio extension render/play as audio, not images. */
export function isAudioEmbed(name: string): boolean {
  return AUDIO_EXT_RE.test(name.trim());
}

/** A value that is wholly wrapped in `![[...]]` / `[[...]]` unwraps to the
 * embed target; anything else passes through (trimmed). */
export function unwrapEmbed(v: string): string {
  const t = v.trim();
  const m = /^!?\[\[([^[\]]+)\]\]$/.exec(t);
  return m ? m[1].trim() : t;
}

/** The `artwork` prop names a cover as a bare asset name, an absolute path,
 * or a `![[...]]` / `[[...]]` embed — normalize all three to the target. */
export function artworkTarget(props: Record<string, unknown>): string | null {
  const raw = byFoldedKey(props, "artwork");
  if (typeof raw !== "string") return null;
  const v = unwrapEmbed(raw);
  return v ? v : null;
}

/** First image embed (`![[cover.png]]`) in a note body. The §6 paste flow
 * puts artwork there, so galleries work without any prop editing. */
export function firstImageEmbed(body: string): string | null {
  const re = /!\[\[([^[\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const name = m[1].trim();
    if (isImageName(name)) return name;
  }
  return null;
}
