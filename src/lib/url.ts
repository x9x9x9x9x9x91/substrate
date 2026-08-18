/**
 * True when the string is a single pasted http(s) link with a host the capture
 * pipeline can actually turn into a note. The explicit scheme is what fences
 * bare text out (`example.com`, `status:live`, `foo/bar` never reach the parse),
 * so any non-empty hostname counts: dotless intranet names (`http://nas/`,
 * `http://intranet:8080/`) are links the backend already captures, and the old
 * dot heuristic hid the capture row for them entirely. Bracketed IPv6 literals
 * (`http://[::1]:5173/`) are deliberately NOT accepted: the capture title is
 * derived from the host-and-path display form and `validate_note_title`
 * refuses `[` and `]` (src-tauri/src/vault/mod.rs), so offering the row would
 * only buy an error toast — the recognizer stays no looser than the engine.
 */
export function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  // a third slash — or its backslash spelling, which WHATWG treats identically
  // for special schemes — means an empty authority; the parser collapses it and
  // promotes the first path segment to a host (`http:///path`, `http://\path`
  // both parse to host `path`), which is not a link the user pasted
  if (!/^https?:\/\//i.test(t) || /^https?:\/\/[/\\]/i.test(t) || /\s/.test(t)) return false;
  try {
    const { hostname } = new URL(t);
    return hostname.length > 0 && !hostname.startsWith("[");
  } catch {
    return false;
  }
}

/**
 * Bare display title for an unfetched link: scheme and www. stripped, no
 * trailing slash. Mirrors Engine::create_reference so the mock backend and
 * palette labels agree with the real engine.
 */
export function urlDisplayTitle(url: string): string {
  const t = url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
  return t || url.trim();
}

/** email/phone kinds: the external href a value opens on click —
    `mailto:` + the address as typed; `tel:` + the number with spaces and
    dashes stripped from the dialed value only (the displayed value never
    strips anything). */
export function contactHref(kind: "email" | "phone", value: string): string {
  if (kind === "email") return `mailto:${value}`;
  return `tel:${value.replace(/[\s-]+/g, "")}`;
}
