/* What the capture window does with the context snapshot Rust armed it with
   (src-tauri/src/context_snapshot.rs): how the chip reads, and which
   frontmatter the note is filed with.

   Both are pure functions over the snapshot so the window itself stays a
   render: the e2e lane stages a snapshot through the mock backend, and the
   two decisions that actually carry — what a chip says, and what lands in the
   note — are unit-tested here without a browser.

   The chip is attached BY DEFAULT: context is the reason the feature exists,
   and a capture is one keystroke long, so an opt-in per note would mean
   nobody ever attaches anything. Dropping it is Backspace on an empty box. */

/** The snapshot as `context_pending` serializes it. */
export interface CaptureContext {
  /** frontmost app's display name */
  app: string;
  /** focused window's document/title, when Accessibility is already granted */
  doc: string | null;
  /** absolute path of the open document, when the app exposes one */
  file: string | null;
}

/** Last path segment, POSIX. Names the Ableton set rather than the four
    folders above it — the window is 620px wide and the path is not the point. */
function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The chip's glyph: a filled dot for a real file on disk, the lighter mark
    for "an app, and maybe what it was showing". Two marks, both from the
    palette the capture window already uses — no colour, no badge. */
export function contextChipIcon(c: CaptureContext): string {
  return c.file ? "⏺" : "⌁";
}

/** The chip's text. A file names itself (`MyTrack.als`); anything else is the
    app, plus the window it was showing when there is one
    (`Safari — page title`). */
export function contextChipLabel(c: CaptureContext): string {
  if (c.file && c.file.trim()) return basename(c.file.trim());
  const app = c.app.trim();
  const doc = (c.doc ?? "").trim();
  if (!app) return doc;
  return doc ? `${app} — ${doc}` : app;
}

/** Frontmatter for the filed note, in the order the engine writes it. Flat
    string props, lowercase and hyphenated like every other vault key, and
    none of them collide with the engine-owned `created`/`type`/`title`.
    Mirrors `ContextSnapshot::props` on the Rust side — the note reads the
    same however it was captured. */
export function contextProps(c: CaptureContext): [string, string][] {
  const out: [string, string][] = [];
  const app = c.app.trim();
  if (app) out.push(["context-app", app]);
  const doc = (c.doc ?? "").trim();
  if (doc) out.push(["context-doc", doc]);
  const file = (c.file ?? "").trim();
  if (file) out.push(["context-file", file]);
  return out;
}
