/** Ephemeral encrypted handoff — a note rendered to one
    self-contained HTML document, sealed client-side, and parked on a dumb
    relay that only ever sees ciphertext. The AES key rides the link's
    `#fragment`, which browsers never send over the wire, so the relay (and
    anyone who subpoenas it) holds bytes it physically cannot read.

    This module is the pure half: payload format, WebCrypto seal/open, the
    standalone document builder and the link shape. Talking to the relay is
    the Rust side's job (`share_upload` — the shipped CSP allows no remote
    origin), and `relay/serve.ts` + its embedded viewer page are the other
    end of the same byte format. Keep the three in lockstep. */

import { renderPrintBody, escapeHtml, type AssetSrc } from "./print.ts";
import { foldedPropKey } from "./types.ts";

/** Sealed-payload layout: magic + format version, then the fresh 96-bit
    GCM IV, then ciphertext. Versioned so a future format (chunked audio,
    compression) can coexist with old links still in flight. */
export const HANDOFF_MAGIC = "SBH1";
const IV_BYTES = 12;
export const KEY_BYTES = 32;

/** Payloads past this size get a "this will be slow" warning in the send
    dialog — images inline as base64, and a screenshot-heavy one-sheet adds
    up. A warning only: the relay enforces its own hard cap. */
export const SIZE_WARN_BYTES = 10 * 1024 * 1024;

/** Expiry choices the send dialog offers. "burn" = deleted when the first
    reader claims it; the day variants serve any number of readers until the
    relay's sweep removes them. Honesty rule (per the issue): expiry limits
    access from now on — it cannot un-save a copy a recipient already kept. */
export type HandoffExpiry = "burn" | "1d" | "7d" | "30d";
export const EXPIRY_DEFAULT: HandoffExpiry = "7d";

export const EXPIRY_LABELS: Record<HandoffExpiry, string> = {
  burn: "After first open",
  "1d": "1 day",
  "7d": "7 days",
  "30d": "30 days",
};

const B64URL = /^[A-Za-z0-9_-]*$/;

/** bytes → base64url (no padding) — the key's wire form in the fragment. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  if (!B64URL.test(s)) throw new Error("not base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Seal `plaintext` under a fresh random key. Returns the payload for the
    relay and the key for the fragment — the two never travel together. */
export async function sealHandoff(
  plaintext: Uint8Array
): Promise<{ payload: Uint8Array; keyB64: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)
  );
  const magic = new TextEncoder().encode(HANDOFF_MAGIC);
  const payload = new Uint8Array(magic.length + IV_BYTES + ct.length);
  payload.set(magic, 0);
  payload.set(iv, magic.length);
  payload.set(ct, magic.length + IV_BYTES);
  return { payload, keyB64: toBase64Url(keyBytes) };
}

/** Inverse of {@link sealHandoff} — the viewer's half, kept here so the
    round trip is testable in one place. Rejects unknown magic before
    touching the key: a clear "not a handoff payload" beats a generic
    decrypt failure when a relay serves the wrong bytes. */
export async function openHandoff(payload: Uint8Array, keyB64: string): Promise<Uint8Array> {
  const magic = new TextDecoder().decode(payload.slice(0, HANDOFF_MAGIC.length));
  if (magic !== HANDOFF_MAGIC) throw new Error(`not a handoff payload (${magic})`);
  const keyBytes = fromBase64Url(keyB64);
  if (keyBytes.length !== KEY_BYTES) throw new Error("bad key length");
  const iv = payload.slice(HANDOFF_MAGIC.length, HANDOFF_MAGIC.length + IV_BYTES);
  const ct = payload.slice(HANDOFF_MAGIC.length + IV_BYTES);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle
    .decrypt({ name: "AES-GCM", iv }, key, ct)
    .catch(() => Promise.reject(new Error("decrypt failed — wrong key or corrupted payload")));
  return new Uint8Array(pt);
}

/** Compose the share link. The key lives after `#` — a URL fragment stays
    in the browser, so the relay's access log never contains it. */
export function buildHandoffLink(relayUrl: string, id: string, keyB64: string): string {
  return `${relayUrl.replace(/\/+$/, "")}/h/${id}#${keyB64}`;
}

/** Minimal self-contained styling for the handed-off document. The app's
    print CSS lives inside styles.css and leans on app tokens; a recipient's
    browser has neither, so the document carries its own small light-page
    sheet keyed to the same `print-*` class contract renderPrintBody emits. */
const DOC_CSS = `
:root { color-scheme: light; }
body { margin: 0; background: #f6f7f8; font: 15px/1.65 -apple-system, BlinkMacSystemFont,
  "Segoe UI", Roboto, sans-serif; color: #1b1e22; }
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.5rem 5rem; background: #fff;
  min-height: 100vh; box-sizing: border-box; }
h1.print-title { font-size: 1.7rem; line-height: 1.25; margin: 0 0 .35rem; }
.print-props { color: #71767e; font-size: .82rem; margin-bottom: 2rem; }
.print-sep { color: #b6bac1; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.6em 0 .5em; }
p { margin: .75em 0; }
img { max-width: 100%; height: auto; border-radius: 4px; }
pre { background: #f2f3f5; border-radius: 6px; padding: .8em 1em; overflow-x: auto;
  font-size: .85em; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
p code, li code, td code { background: #f2f3f5; border-radius: 3px; padding: .1em .3em; }
blockquote { border-left: 3px solid #d5d8dc; margin: 1em 0; padding: .1em 0 .1em 1em;
  color: #565b63; }
table { border-collapse: collapse; margin: 1em 0; font-size: .92em; }
th, td { border: 1px solid #dfe2e6; padding: .35em .7em; text-align: left; }
th { background: #f6f7f8; }
hr { border: none; border-top: 1px solid #e6e8eb; margin: 2em 0; }
a { color: #3d4bb5; }
ul, ol { padding-left: 1.4em; }
li.print-task { list-style: none; margin-left: -1.4em; }
.print-box { display: inline-block; width: 1em; height: 1em; border: 1.5px solid #b6bac1;
  border-radius: 3px; margin-right: .5em; font-size: .8em; line-height: 1em;
  text-align: center; vertical-align: -.1em; }
.print-task.done .print-box { background: #3d4bb5; border-color: #3d4bb5; color: #fff; }
.print-link { color: #3d4bb5; }
.print-embed, .print-missing { color: #9198a1; font-style: italic; }
`;

/** One note → one standalone HTML document: title, props line, rendered
    body, all assets already inlined by the caller's `assetSrc`. This is the
    plaintext that gets sealed — the viewer page injects it into an iframe
    verbatim after decrypting. */
export function buildHandoffDocument(opts: {
  title: string;
  propsLine: string;
  body: string;
  assetSrc: AssetSrc;
}): string {
  return (
    "<!doctype html>\n<html><head><meta charset=\"utf-8\">" +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(opts.title)}</title>` +
    `<style>${DOC_CSS}</style></head><body><main>` +
    `<h1 class="print-title">${escapeHtml(opts.title)}</h1>` +
    (opts.propsLine ? `<div class="print-props">${opts.propsLine}</div>` : "") +
    renderPrintBody(opts.body, opts.assetSrc) +
    "</main></body></html>"
  );
}

export const HOSTED_HANDOFF_RELAY_URL = "https://drop.substrate.zone";

/** `share-relay-url` (Settings.md) — where "Send as link" uploads. Missing
    uses the hosted default so existing vaults adopt it without a rewrite;
    `disabled` (and legacy `off`) or an explicit empty value opts out. Trailing slashes are trimmed
    so link building never doubles them. */
export function parseShareRelayUrl(props: Record<string, unknown>): string {
  const v = props[foldedPropKey(props, "share-relay-url")];
  if (v === undefined || v === null) return HOSTED_HANDOFF_RELAY_URL;
  if (typeof v !== "string") return "";
  const s = v.trim().replace(/\/+$/, "");
  if (["disabled", "off"].includes(s.toLowerCase())) return "";
  return /^https?:\/\/.+/i.test(s) ? s : "";
}
