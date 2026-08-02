/** True when the string is a single pasted http(s) link — no spaces, a real host. */
export function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  if (!/^https?:\/\//i.test(t) || /\s/.test(t)) return false;
  try {
    const host = new URL(t).hostname;
    return host.includes(".") || host === "localhost";
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

/** email/phone kinds (SUB-181): the external href a value opens on click —
    `mailto:` + the address as typed; `tel:` + the number with spaces and
    dashes stripped from the dialed value only (the displayed value never
    strips anything). */
export function contactHref(kind: "email" | "phone", value: string): string {
  if (kind === "email") return `mailto:${value}`;
  return `tel:${value.replace(/[\s-]+/g, "")}`;
}
