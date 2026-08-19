import { foldDiacritics, foldWithMap } from "./fold.ts";
import type { ImageHit, NoteMeta } from "./types.ts";

/** Virtual path prefix for a picture whose recognized text is in the index.
    Like a mount row it is not a vault path and never reaches the engine as
    one — a picture is not a note, but the row pipeline is path-keyed, so the
    hit still needs something unique to be keyed by. */
export const IMAGE_SCHEME = "image://";

/** The vault-relative path of the picture behind such a row, or null for an
    ordinary vault path. Anything that opens a search hit has to ask: a hit
    inside a screenshot opens the picture, not an editor. */
export function parseImagePath(path: string): string | null {
  if (!path.startsWith(IMAGE_SCHEME)) return null;
  const rel = path.slice(IMAGE_SCHEME.length);
  return rel.length > 0 ? rel : null;
}

/** The row projection for a picture hit, built from the hit alone — there is
 * no note behind it, and every filter, sort and render downstream reads a
 * `NoteMeta`.
 *
 * `updated_ms` is 0 for the same reason a mount row's is: a hit carries no
 * mtime, so sorting by Updated sinks pictures below every note.
 */
export function imageHitMeta(path: string): NoteMeta | null {
  const rel = parseImagePath(path);
  if (rel === null) return null;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const slash = rel.lastIndexOf("/");
  const dot = name.lastIndexOf(".");
  return {
    path,
    stem: name,
    title: name,
    folder: slash > 0 ? rel.slice(0, slash) : "",
    props: {
      type: "image",
      name,
      ...(dot > 0 ? { extension: name.slice(dot + 1) } : {}),
    },
    updated_ms: 0,
    excerpt: "",
    // sealing is a note's property, and this row is a picture
    sealed: false,
  };
}

/** The recognized lines of a picture, cut where the query landed, so the
 * matched words can be marked in the same ink the rest of the search uses.
 *
 * The engine already marks the snippet lines it returns; this is for the
 * whole read-out text shown beside the picture, where the marks have to be
 * found again. Case-folded AND accent-folded, because the search is: the
 * index is built with `remove_diacritics 2`, so "cafe" is what found the
 * picture that reads "Café". Matching runs on the folded text and the marks
 * are cut out of the original through the fold's back-map, so the accented
 * word is marked whole and the runs still concatenate back to exactly the
 * text handed in.
 */
export function markQuery(text: string, needles: string[]): { text: string; hit: boolean }[] {
  const terms = needles.map((n) => foldDiacritics(n)).filter((n) => n.length > 0);
  if (terms.length === 0) return [{ text, hit: false }];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:${terms.map(esc).join("|")})`, "giu");
  const { folded, map } = foldWithMap(text);
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  let hits = 0;
  for (const m of folded.matchAll(re)) {
    const s = map[m.index];
    const e = map[m.index + m[0].length];
    if (s < at) continue; // overlapping terms mark once
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    hits += 1;
    at = e;
  }
  if (hits === 0) return [{ text, hit: false }];
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** What the label under a picture says, in one sentence: who read it, and how
    much of it was kept. Never phrased as the picture's contents. */
export function readingLabel(hit: ImageHit): string {
  return hit.truncated
    ? `${hit.label} — long, so only the beginning was kept`
    : hit.label;
}
