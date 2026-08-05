/**
 * Shared vault title rules for the offline importers. The import
 * scripts write .md files directly, bypassing the engine — this module mirrors
 * sanitize_filename() and validate_note_title() from src-tauri/src/vault.rs so
 * a script-written note obeys the same rules as an engine-made one:
 * no invisible dot-stems, no link-corrupting brackets.
 */

/** Mirrors sanitize_filename(): illegal filename chars become spaces,
    whitespace runs collapse to one, empty falls back to "Untitled". */
export function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  return cleaned || "Untitled";
}

/** Mirrors validate_note_title(): a stem starting with `.` would
    land the note outside the index, and `[`/`]` would corrupt every rewritten
    [[wikilink]] — refuse both, throwing the engine's own messages. `title` is
    the exact input, `slug` its sanitized form. */
export function validateNoteTitle(title: string, slug: string): void {
  if (slug.startsWith(".")) {
    throw new Error("titles cannot start with a dot");
  }
  if (title.includes("[") || title.includes("]")) {
    throw new Error("titles cannot contain [ or ]");
  }
  // Mirrors the engine's third refusal: a control char (NUL, DEL)
  // isn't whitespace, so it survives the collapse into the slug and the
  // filesystem then refuses the name -- after side effects, in the engine's
  // rename case. Same Cc set as Rust's char::is_control: C0, DEL, C1.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(slug)) {
    throw new Error("titles cannot contain control characters");
  }
}

/** Title → file stem, sanitized and guarded. Throws the engine's reason when
    the title is one the engine would refuse. */
export function guardedSlug(title: string): string {
  const slug = sanitizeFilename(title);
  validateNoteTitle(title, slug);
  return slug;
}
