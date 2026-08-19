#!/usr/bin/env node
/** Handoff relay — the dumb store behind "Send as link".
 *
 * The whole trust model in one sentence: this server only ever holds
 * ciphertext, the AES key rides the link's `#fragment` (which browsers never
 * send), so a leak of the relay's stored state exposes no note plaintext.
 * It stores blobs, serves a static viewer page that decrypts in the
 * recipient's browser, and deletes on expiry. The viewer makes the operator
 * part of the live trust boundary; README.md spells that out. Nothing else —
 * no accounts, no note metadata, no analytics.
 *
 * Self-host: compile this file to ESM, run it with Node, and front it with a
 * TLS-terminating proxy (the viewer needs WebCrypto, which browsers gate
 * behind https). See README.md next to this file for the exact command.
 *
 * Wire format lockstep: payload = "SBH1" + 12-byte IV + AES-256-GCM
 * ciphertext, sealed by `src/lib/handoff.ts` and opened by the viewer page
 * below. Change one, change all three.
 *
 * Endpoints:
 *   POST /api/store        body = sealed payload, `x-handoff-expiry` header
 *                          (burn|1d|7d|30d) → 201 {"id":"…"}
 *   GET  /h/<id>           the viewer page (never burns — link-preview bots
 *                          GET links; the human's browser claims via POST)
 *   POST /api/claim/<id>   → payload bytes; burn entries delete after the
 *                          first successful claim, day entries serve until
 *                          swept
 *
 * Letterbox (the inbound half — a standing drop link the vault polls):
 *   POST   /api/box/register        → {"id","token"}; owner-side
 *   GET    /d/<box>                 the sealing page (recipient key in #hash)
 *   POST   /api/box/<box>/drop      sender upload, "SBL1" + age ciphertext
 *   GET    /api/box/<box>/drops     owner bearer → pending drops
 *   POST   /api/box/<box>/claim/<d> owner bearer → bytes, leased to one poller
 *   DELETE /api/box/<box>/drops/<d> owner bearer → ack, the drop is gone
 *   DELETE /api/box/<box>           owner bearer → revoke box and ciphertext
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, promises as fs, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { SEALING_PAGE_SCRIPT } from "./sealing-page.generated.ts";

export interface HandoffRelayOptions {
  dataDir: string;
  /** hard per-payload cap; the app warns at 10 MiB, this refuses bigger */
  maxBytes?: number;
  /** refuse new stores once the data dir holds this much (disk-fill guard) */
  maxTotalBytes?: number;
  /** refuse new stores once this many live handoffs exist (inode/O(n) guard) */
  maxEntries?: number;
  /** bound simultaneous request-body streams even when the proxy is bypassed */
  maxConcurrentStores?: number;
  /** the same bound for letterbox drops, counted separately so senders cannot
      spend the handoff store's slots (defaults to maxConcurrentStores) */
  maxConcurrentDrops?: number;
  /** optional bearer token required on /api/store (claim stays open — the
      recipient has no account by design) */
  storeToken?: string;
  /** letterbox: refuse every box endpoint (LETTERBOX_DISABLED=1 — a relay that
      only wants to carry handoffs) */
  letterboxDisabled?: boolean;
  /** letterbox pool ceiling, deliberately SEPARATE from maxTotalBytes so a
      flood of drops can never evict pending handoffs (and vice versa) */
  letterboxMaxTotalBytes?: number;
  /** live-box ceiling for the letterbox pool */
  letterboxMaxBoxes?: number;
  /** pending drops one box may hold before it refuses further senders */
  maxDropsPerBox?: number;
  /** pending ciphertext one box may hold */
  maxBoxBytes?: number;
  /** how long a claimed drop stays leased to one poller before it returns to
      the pool (a crash mid-landing must re-offer the drop, not lose it) */
  leaseMs?: number;
  /** a box nobody has registered, dropped to, polled or acked within this span
      — and that holds nothing pending — is removed by the sweep, so an
      abandoned or anonymously-registered box cannot sit on the relay forever */
  boxIdleTtlMs?: number;
  /** injectable clock — expiry tests drive time instead of sleeping */
  now?: () => number;
}

const MAX_BYTES_DEFAULT = 32 * 1024 * 1024;
const MAX_TOTAL_DEFAULT = 1024 * 1024 * 1024;
const MAX_ENTRIES_DEFAULT = 4096;
const MAX_CONCURRENT_STORES_DEFAULT = 2;
// Letterbox ceilings. Separate constants, not a share of the handoff numbers:
// the two pools are sized independently so neither can starve the other.
const LETTERBOX_MAX_TOTAL_DEFAULT = 1024 * 1024 * 1024;
const LETTERBOX_MAX_BOXES_DEFAULT = 256;
const MAX_DROPS_PER_BOX_DEFAULT = 64;
const MAX_BOX_BYTES_DEFAULT = 256 * 1024 * 1024;
const LEASE_MS_DEFAULT = 10 * 60_000;
const BOX_TTL_DEFAULT = "30d";
const BOX_IDLE_TTL_DEFAULT = 90 * 86400_000;
const ORPHAN_GRACE_MS = 3600_000;
// A one-shot box that has spent its drop is finished; the grace only covers a
// poller that is still landing the drop it already claimed.
const SPENT_BOX_GRACE_MS = 3600_000;

// null prototype: the expiry name arrives in an attacker-controlled header,
// and a plain literal would answer `constructor`/`toString` with a function
// that passes the truthiness gate and string-concatenates into expiresAt —
// an entry that never expires and never sweeps
const EXPIRY_MS: Record<string, number> = Object.assign(Object.create(null), {
  // burn entries still age out — an unopened one-shot link shouldn't sit
  // on disk forever waiting for a reader that never comes
  burn: 7 * 86400_000,
  "1d": 86400_000,
  "7d": 7 * 86400_000,
  "30d": 30 * 86400_000,
});

const ID_RE = /^[A-Za-z0-9_-]{16,32}$/;

interface Meta {
  expiresAt: number;
  burn: boolean;
}

interface BoxMeta {
  token: string;
  oneShot: boolean;
  /** a one-shot box that already took its drop refuses the next sender */
  used: boolean;
  /** how long each drop this box takes stays on the relay */
  ttlMs: number;
  /** last register/drop/list/claim/ack on this box, by the relay's clock; the
      sweep reads it to retire boxes nobody uses any more */
  lastActivity: number;
}

interface DropMeta {
  expiresAt: number;
  bytes: number;
}

function newId(): string {
  return randomBytes(16).toString("base64url");
}

async function readBodyToFile(
  req: IncomingMessage,
  path: string,
  cap: number
): Promise<{ bytes: number; magic: string } | null> {
  const file = await fs.open(path, "wx", 0o600);
  let total = 0;
  let prefix = Buffer.alloc(0);
  let tooLarge = false;
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.length;
      if (total > cap) {
        // The committed nginx edge rejects by Content-Length first. A
        // chunked client that bypasses it must not hold a store slot while it
        // streams forever: stop reading and close that request immediately.
        tooLarge = true;
        req.destroy();
        break;
      }
      if (prefix.length < 4) prefix = Buffer.concat([prefix, chunk.subarray(0, 4 - prefix.length)]);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
    }
  } finally {
    await file.close();
  }
  return tooLarge ? null : { bytes: total, magic: prefix.toString("utf8") };
}

// the relay is a dead end for robots and referrers alike
const SAFETY_HEADERS = {
  "x-robots-tag": "noindex",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

// defense-in-depth for the pages that touch a fragment key: their own inline
// script may run, nothing else loads, and fetch stays on this origin. The
// srcdoc iframe INHERITS this policy (spec: srcdoc documents inherit the
// embedder's CSP) on top of its sandbox, so img-src data: is for the
// handed-off document's inlined images, and script-src never matters in there
// — the sandbox has no allow-scripts. `form-action 'none'` is what keeps the
// sealing page's form from ever submitting itself: if its script fails to
// start, the browser refuses the plaintext POST outright.
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-src 'self' about:; form-action 'none'";

function responseHeaders(length: number, type: string) {
  return {
    "content-type": type,
    "content-length": length,
    ...SAFETY_HEADERS,
    "content-security-policy": CONTENT_SECURITY_POLICY,
  };
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = "text/plain") {
  res.writeHead(status, responseHeaders(Buffer.byteLength(body), type));
  res.end(body);
}

/** 204 means "no body", so it carries no content-type or content-length —
    a length header on an empty response only invites proxies to argue. */
function sendNoContent(res: ServerResponse) {
  res.writeHead(204, { ...SAFETY_HEADERS });
  res.end();
}

async function sendFile(
  res: ServerResponse,
  status: number,
  path: string,
  type = "application/octet-stream",
  unlinkAfterOpen = false
) {
  // Always open first and stream from the descriptor, never from the path: a
  // sweep (or a burn, or a lease returning to the pool) that renames or
  // removes the file mid-response cannot then truncate what this reader is
  // already sending.
  const file = await fs.open(path, "r");
  try {
    const stat = await file.stat();
    if (unlinkAfterOpen) await fs.rm(path, { force: true });
    res.writeHead(status, responseHeaders(stat.size, type));
    await pipeline(file.createReadStream(), res);
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** The recipient's whole client, inlined: claim, decrypt with the fragment
    key, show the document in a sandboxed iframe (no scripts run — the
    handed-off document is static by construction, and stays static even if
    a hostile sender crafts one). Decrypt failures name themselves — a
    burned link and a wrong key are different problems. */
const VIEWER_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Substrate handoff</title>
<style>
  :root { color-scheme: light; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: #f6f7f8;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1b1e22; }
  #st { margin: auto; max-width: 26rem; padding: 1.5rem; text-align: center; color: #565b63; }
  #st.err { color: #8c3a3a; }
  #st small { display: block; margin-top: .8rem; color: #9198a1; }
  iframe { flex: 1; border: 0; width: 100%; }
  footer { padding: .45rem 1rem; text-align: center; font-size: .72rem; color: #9198a1;
    border-top: 1px solid #e6e8eb; background: #fff; }
</style></head>
<body>
<div id="st">Decrypting locally…</div>
<iframe id="doc" sandbox="allow-popups" hidden></iframe>
<footer hidden>Decrypted in your browser from ciphertext. Never enter passwords into a shared note.</footer>
<script>
(async () => {
  const st = document.getElementById("st");
  const fail = (m, s) => { st.className = "err"; st.innerHTML = ""; st.append(m);
    if (s) { const x = document.createElement("small"); x.append(s); st.append(x); } };
  const id = location.pathname.split("/").pop();
  const key64 = location.hash.slice(1);
  if (!key64) return fail("This link is incomplete.",
    "The part after # carries the decryption key — copy the whole link.");
  if (!crypto.subtle) return fail("This page needs a secure (https) connection to decrypt.");
  let buf;
  try {
    const r = await fetch("/api/claim/" + id, { method: "POST" });
    if (r.status === 404 || r.status === 410) return fail("This link has expired or was already opened.",
      "Handoff links are ephemeral — ask the sender for a fresh one.");
    if (!r.ok) return fail("The relay returned an error (" + r.status + ").");
    buf = new Uint8Array(await r.arrayBuffer());
  } catch { return fail("Could not reach the relay."); }
  try {
    if (new TextDecoder().decode(buf.slice(0, 4)) !== "SBH1")
      return fail("This is not a Substrate handoff payload.");
    const b64 = key64.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Uint8Array.from(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)),
      (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf.slice(4, 16) }, key, buf.slice(16));
    document.getElementById("doc").srcdoc = new TextDecoder().decode(pt);
    document.getElementById("doc").hidden = false;
    document.querySelector("footer").hidden = false;
    st.remove();
  } catch { fail("Could not decrypt.", "The key in the link is wrong or truncated."); }
})();
</script>
</body></html>
`;

/** The sender's page for a letterbox drop link: compose, seal in the browser
    against the recipient key in the fragment, upload ciphertext. The script is
    bundled at build time (sealing-page/build.ts) because it carries a real age
    implementation; the relay itself stays dependency-free. The footer states
    the same operator-trust boundary the viewer does — the relay serves this
    script, so a hostile operator could serve a different one. */
const SEALING_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Send to this letterbox</title>
<style>
  :root { color-scheme: light; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: #f6f7f8;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1b1e22; }
  main { margin: auto; width: 100%; max-width: 34rem; padding: 1.5rem; box-sizing: border-box; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  label { display: block; margin: .9rem 0 .25rem; font-size: .82rem; color: #565b63; }
  input[type=text], textarea { width: 100%; box-sizing: border-box; padding: .55rem .65rem;
    border: 1px solid #d6dade; border-radius: 6px; background: #fff; font: inherit; }
  textarea { min-height: 9rem; resize: vertical; }
  button { margin-top: 1rem; padding: .55rem 1.1rem; border: 0; border-radius: 6px;
    background: #1b1e22; color: #fff; font: inherit; cursor: pointer; }
  button[disabled] { opacity: .5; cursor: default; }
  #st { margin-top: .9rem; font-size: .82rem; color: #565b63; word-break: break-all; }
  #st.err { color: #8c3a3a; }
  #st.ok { color: #2f6b45; }
  footer { padding: .45rem 1rem; text-align: center; font-size: .72rem; color: #9198a1;
    border-top: 1px solid #e6e8eb; background: #fff; }
</style></head>
<body>
<main>
<h1>Send to this letterbox</h1>
<form id="f">
  <label for="from">Who is this from? (optional)</label>
  <input id="from" type="text" maxlength="200" autocomplete="off">
  <label for="text">Message</label>
  <textarea id="text"></textarea>
  <label for="files">Attachments (optional, 16 MiB total)</label>
  <input id="files" type="file" multiple>
  <button id="send" type="submit" disabled>Encrypt and send</button>
</form>
<p id="done" hidden>Compare that hash with the recipient over another channel if it matters.</p>
<div id="st"></div>
</main>
<footer>Encrypted in your browser before upload. The relay stores ciphertext only — but it also serves this page, so trust the operator you were linked to.</footer>
<script>${SEALING_PAGE_SCRIPT}</script>
</body></html>
`;

export function createHandoffRelay(opts: HandoffRelayOptions): Server {
  const { dataDir } = opts;
  const maxBytes = opts.maxBytes ?? MAX_BYTES_DEFAULT;
  const maxTotal = opts.maxTotalBytes ?? MAX_TOTAL_DEFAULT;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES_DEFAULT;
  const maxConcurrentStores = opts.maxConcurrentStores ?? MAX_CONCURRENT_STORES_DEFAULT;
  const clock = opts.now ?? Date.now;
  let storesInFlight = 0;
  let quotaTail = Promise.resolve();
  mkdirSync(dataDir, { recursive: true });

  const payloadPath = (id: string) => join(dataDir, id);
  const metaPath = (id: string) => join(dataDir, `${id}.json`);

  async function readMeta(id: string): Promise<Meta | null> {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath(id), "utf8")) as Partial<Meta>;
      return Number.isFinite(meta.expiresAt) && typeof meta.burn === "boolean"
        ? { expiresAt: meta.expiresAt as number, burn: meta.burn }
        : null;
    } catch {
      return null;
    }
  }

  async function remove(id: string) {
    await fs.rm(payloadPath(id), { force: true });
    await fs.rm(metaPath(id), { force: true });
  }

  /** Expired pairs and crash orphans go; runs on an interval and lazily
      before quota decisions. The grace period avoids racing an active store. */
  async function sweep() {
    const now = Date.now();
    for (const name of await fs.readdir(dataDir).catch(() => [] as string[])) {
      if (/\.claimed-\d+-\d+$/.test(name) || name.startsWith(".tmp-")) {
        // crashes between rename steps leave these behind; the shape match
        // (not includes) can never collide with a stored id — ID_RE has no "."
        const st = await fs.stat(join(dataDir, name)).catch(() => null);
        if (st && now - st.mtimeMs > ORPHAN_GRACE_MS)
          await fs.rm(join(dataDir, name), { force: true });
      } else if (name.endsWith(".json")) {
        const id = name.slice(0, -5);
        if (!ID_RE.test(id)) {
          await fs.rm(join(dataDir, name), { force: true });
          continue;
        }
        const meta = await readMeta(id);
        if (!meta || meta.expiresAt <= now) {
          await remove(id);
          continue;
        }
        const payload = await fs.stat(payloadPath(id)).catch(() => null);
        const metadata = await fs.stat(metaPath(id)).catch(() => null);
        if (!payload && metadata && now - metadata.mtimeMs > ORPHAN_GRACE_MS)
          await fs.rm(metaPath(id), { force: true });
      } else if (ID_RE.test(name)) {
        const metadata = await fs.stat(metaPath(name)).catch(() => null);
        const payload = await fs.stat(payloadPath(name)).catch(() => null);
        if (!metadata && payload && now - payload.mtimeMs > ORPHAN_GRACE_MS)
          await fs.rm(payloadPath(name), { force: true });
      }
    }
  }

  async function usage(): Promise<{ bytes: number; entries: number }> {
    let bytes = 0;
    let entries = 0;
    for (const name of await fs.readdir(dataDir).catch(() => [] as string[])) {
      const st = await fs.stat(join(dataDir, name)).catch(() => null);
      if (st?.isFile()) bytes += st.size;
      if (ID_RE.test(name)) entries += 1;
    }
    return { bytes, entries };
  }

  async function withQuotaLock<T>(fn: () => Promise<T>): Promise<T> {
    const prior = quotaTail;
    let release = () => {};
    quotaTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async function handleStore(req: IncomingMessage, res: ServerResponse) {
    if (opts.storeToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${opts.storeToken}`) return send(res, 401, "store requires a token");
    }
    const expiry = String(req.headers["x-handoff-expiry"] ?? "");
    const ttl = EXPIRY_MS[expiry];
    if (typeof ttl !== "number") return send(res, 400, "unknown expiry");
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      req.resume();
      return send(res, 413, "payload too large");
    }
    if (storesInFlight >= maxConcurrentStores) {
      req.resume();
      return send(res, 503, "relay is busy; try again");
    }
    storesInFlight += 1;
    const id = newId();
    const tmp = join(dataDir, `.tmp-${id}`);
    const tmpMeta = join(dataDir, `.tmp-${id}.json`);
    try {
      const body = await readBodyToFile(req, tmp, maxBytes);
      if (body === null) return send(res, 413, "payload too large");
      if (body.bytes < 21) return send(res, 400, "payload too small to be sealed");
      if (body.magic !== "SBH1") return send(res, 400, "not a handoff payload");
      return await withQuotaLock(async () => {
        await sweep();
        // The current temp body is already included, so this is exact even
        // when other requests are waiting with their own temp files.
        const meta: Meta = { expiresAt: Date.now() + ttl, burn: expiry === "burn" };
        const metaJson = JSON.stringify(meta);
        const current = await usage();
        if (current.bytes + Buffer.byteLength(metaJson) > maxTotal)
          return send(res, 507, "relay is full");
        if (current.entries >= maxEntries) return send(res, 507, "relay has too many entries");
        await fs.writeFile(tmpMeta, metaJson, { mode: 0o600 });
        await fs.rename(tmp, payloadPath(id));
        await fs.rename(tmpMeta, metaPath(id));
        send(res, 201, JSON.stringify({ id }), "application/json");
      });
    } finally {
      storesInFlight -= 1;
      await fs.rm(tmp, { force: true });
      await fs.rm(tmpMeta, { force: true });
    }
  }

  async function handleClaim(id: string, res: ServerResponse) {
    const meta = await readMeta(id);
    if (!meta) return send(res, 404, "unknown or expired");
    if (meta.expiresAt <= Date.now()) {
      await remove(id);
      return send(res, 404, "unknown or expired");
    }
    if (meta.burn) {
      // atomic rename picks exactly one winner if two readers race the
      // same one-shot link; the loser sees a burned link, as designed
      const claimed = join(dataDir, `${id}.claimed-${process.pid}-${Date.now()}`);
      try {
        await fs.rename(payloadPath(id), claimed);
      } catch {
        return send(res, 404, "unknown or expired");
      }
      // The atomic rename has consumed the link. Remove its discoverable
      // metadata before streaming so a completed claim is dead immediately;
      // a disconnect can leave only the already-unreachable claimed file for
      // the orphan sweep.
      await fs.rm(metaPath(id), { force: true });
      await sendFile(res, 200, claimed, "application/octet-stream", true);
      return;
    }
    try {
      await sendFile(res, 200, payloadPath(id));
    } catch {
      if (!res.headersSent) return send(res, 404, "unknown or expired");
      res.destroy();
    }
  }

  // --- letterbox ---------------------------------------------------------
  // The inbound half: a standing drop link anyone can seal to, polled by the
  // vault that owns the box. Everything lives under its own directory with its
  // own ceilings, so a flood of drops cannot evict pending handoffs — the
  // handoff usage scan counts files, and this is a directory it never descends
  // into.
  const letterboxOn = !opts.letterboxDisabled;
  const letterboxDir = join(dataDir, "letterbox");
  const letterboxMaxTotal = opts.letterboxMaxTotalBytes ?? LETTERBOX_MAX_TOTAL_DEFAULT;
  const letterboxMaxBoxes = opts.letterboxMaxBoxes ?? LETTERBOX_MAX_BOXES_DEFAULT;
  const maxDropsPerBox = opts.maxDropsPerBox ?? MAX_DROPS_PER_BOX_DEFAULT;
  const maxBoxBytes = opts.maxBoxBytes ?? MAX_BOX_BYTES_DEFAULT;
  const leaseMs = opts.leaseMs ?? LEASE_MS_DEFAULT;
  const boxIdleTtlMs = opts.boxIdleTtlMs ?? BOX_IDLE_TTL_DEFAULT;
  const maxConcurrentDrops = opts.maxConcurrentDrops ?? maxConcurrentStores;
  let dropsInFlight = 0;
  let letterboxTail = Promise.resolve();
  if (letterboxOn) mkdirSync(letterboxDir, { recursive: true });

  /** The letterbox has its OWN serialisation tail. Sharing the handoff quota
      lock would queue every store behind a walk of the box tree — two pools
      that are separate on disk should be separate in latency too. */
  async function withLetterboxLock<T>(fn: () => Promise<T>): Promise<T> {
    const prior = letterboxTail;
    let release = () => {};
    letterboxTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  const boxDir = (box: string) => join(letterboxDir, box);
  const boxMetaPath = (box: string) => join(letterboxDir, box, "box.json");
  const dropPath = (box: string, drop: string) => join(letterboxDir, box, drop);
  const dropMetaPath = (box: string, drop: string) => join(letterboxDir, box, `${drop}.json`);
  const LEASE_RE = /^([A-Za-z0-9_-]{16,32})\.lease-(\d+)$/;

  async function readBox(id: string): Promise<BoxMeta | null> {
    if (!ID_RE.test(id)) return null;
    try {
      const box = JSON.parse(await fs.readFile(boxMetaPath(id), "utf8")) as Partial<BoxMeta>;
      if (typeof box.token !== "string" || !Number.isFinite(box.ttlMs)) return null;
      return {
        token: box.token,
        oneShot: box.oneShot === true,
        used: box.used === true,
        ttlMs: box.ttlMs as number,
        // 0 means "never stamped"; the sweep stamps it rather than treating an
        // older box as instantly idle
        lastActivity: Number.isFinite(box.lastActivity) ? (box.lastActivity as number) : 0,
      };
    } catch {
      return null;
    }
  }

  /** .tmp + rename, the same discipline the handoff meta write uses: a reader
      never catches a half-written box.json, and a crash leaves a .tmp- file
      the sweep collects rather than a corrupt box. */
  async function writeBox(id: string, box: BoxMeta) {
    const tmp = join(boxDir(id), `.tmp-box-${newId()}.json`);
    try {
      await fs.writeFile(tmp, JSON.stringify(box), { mode: 0o600 });
      await fs.rename(tmp, boxMetaPath(id));
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  /** Every owner and sender touch of a box restarts its idle clock. A box in
      daily use never ages out; one nobody has used for the idle span does. */
  async function touchBox(id: string) {
    const box = await readBox(id);
    if (box) await writeBox(id, { ...box, lastActivity: clock() });
  }

  /** The owner bearer gates every pickup endpoint. The drop endpoint stays
      open on purpose: the link IS the capability a sender was handed. */
  function ownsBox(req: IncomingMessage, box: BoxMeta): boolean {
    return (req.headers.authorization ?? "") === `Bearer ${box.token}`;
  }

  /** Pending drops of one box: unexpired, not currently leased. */
  async function listDrops(id: string) {
    const now = clock();
    const names = await fs.readdir(boxDir(id)).catch(() => [] as string[]);
    // A leased drop is excluded by construction: claim renamed its payload to
    // `<drop>.lease-<deadline>`, so its plain id is no longer a name here.
    const drops: { id: string; bytes: number; expiresAt: number }[] = [];
    for (const name of names) {
      if (!ID_RE.test(name)) continue;
      const meta = await readDropMeta(id, name);
      if (!meta || meta.expiresAt <= now) continue;
      drops.push({ id: name, bytes: meta.bytes, expiresAt: meta.expiresAt });
    }
    return drops;
  }

  async function readDropMeta(box: string, drop: string): Promise<DropMeta | null> {
    try {
      const meta = JSON.parse(await fs.readFile(dropMetaPath(box, drop), "utf8")) as
        Partial<DropMeta>;
      return Number.isFinite(meta.expiresAt) && Number.isFinite(meta.bytes)
        ? { expiresAt: meta.expiresAt as number, bytes: meta.bytes as number }
        : null;
    } catch {
      return null;
    }
  }

  async function removeDrop(box: string, drop: string) {
    await fs.rm(dropPath(box, drop), { force: true });
    await fs.rm(dropMetaPath(box, drop), { force: true });
    for (const name of await fs.readdir(boxDir(box)).catch(() => [] as string[]))
      if (LEASE_RE.exec(name)?.[1] === drop) await fs.rm(join(boxDir(box), name), { force: true });
  }

  async function letterboxUsage(): Promise<{ bytes: number; boxes: number }> {
    let bytes = 0;
    let boxes = 0;
    for (const box of await fs.readdir(letterboxDir).catch(() => [] as string[])) {
      if (!ID_RE.test(box)) continue;
      boxes += 1;
      bytes += (await boxUsage(box)).bytes;
    }
    return { bytes, boxes };
  }

  async function boxUsage(id: string): Promise<{ bytes: number; drops: number }> {
    let bytes = 0;
    let drops = 0;
    for (const name of await fs.readdir(boxDir(id)).catch(() => [] as string[])) {
      const st = await fs.stat(join(boxDir(id), name)).catch(() => null);
      if (st?.isFile()) bytes += st.size;
      if (ID_RE.test(name) || LEASE_RE.test(name)) drops += 1;
    }
    return { bytes, drops };
  }

  /** Crash leftovers are removed only once they are older than the grace
      window. A drop that is mid-rename, or a box a sender is still streaming
      into, looks exactly like an orphan for a moment — the grace is what keeps
      the sweep from deleting a 201 out from under the request that made it. */
  async function removeAged(path: string) {
    const st = await fs.stat(path).catch(() => null);
    if (st && Date.now() - st.mtimeMs > ORPHAN_GRACE_MS)
      await fs.rm(path, { recursive: true, force: true });
  }

  /** Expired drops go; leases whose deadline passed return to the pool so a
      poller that crashed mid-landing does not strand the drop it held; and a
      box that holds nothing and has gone unused for the idle span goes too —
      otherwise a relay that lets anyone register accumulates empty boxes for
      as long as it runs. */
  async function sweepLetterbox() {
    const now = clock();
    for (const box of await fs.readdir(letterboxDir).catch(() => [] as string[])) {
      if (!ID_RE.test(box)) continue;
      const meta = await readBox(box);
      if (!meta) {
        await removeAged(boxDir(box));
        continue;
      }
      if (meta.lastActivity === 0) {
        // a box.json from before the relay stamped activity: start its clock
        // rather than reading "never used" as "idle since the epoch"
        await writeBox(box, { ...meta, lastActivity: now });
        continue;
      }
      for (const name of await fs.readdir(boxDir(box)).catch(() => [] as string[])) {
        const lease = LEASE_RE.exec(name);
        if (lease) {
          const drop = await readDropMeta(box, lease[1]);
          if (!drop) {
            await removeAged(join(boxDir(box), name));
          } else if (drop.expiresAt <= now) {
            await removeDrop(box, lease[1]);
          } else if (Number(lease[2]) <= now) {
            await fs
              .rename(join(boxDir(box), name), dropPath(box, lease[1]))
              .catch(() => undefined);
          }
        } else if (ID_RE.test(name)) {
          const drop = await readDropMeta(box, name);
          // a payload whose metadata never landed is only junk after the grace
          if (!drop) await removeAged(join(boxDir(box), name));
          else if (drop.expiresAt <= now) await removeDrop(box, name);
        } else if (name === "box.json") {
          continue;
        } else if (name.endsWith(".json") && !name.startsWith(".tmp-")) {
          const drop = name.slice(0, -5);
          if (!ID_RE.test(drop)) {
            await removeAged(join(boxDir(box), name));
            continue;
          }
          const dropMeta = await readDropMeta(box, drop);
          if (dropMeta && dropMeta.expiresAt <= now) {
            await removeDrop(box, drop);
            continue;
          }
          const siblings = await fs.readdir(boxDir(box)).catch(() => [] as string[]);
          const hasPayload = siblings.some((n) => n === drop || LEASE_RE.exec(n)?.[1] === drop);
          // metadata with no ciphertext behind it: an interrupted drop, or one
          // whose payload is still being renamed into place
          if (!dropMeta || !hasPayload) await removeAged(join(boxDir(box), name));
        } else {
          // .tmp-* from a crashed write, and anything else this relay never
          // put here — both go once the grace window has passed
          await removeAged(join(boxDir(box), name));
        }
      }

      const left = await fs.readdir(boxDir(box)).catch(() => [] as string[]);
      // a drop still streaming shows up only as its .tmp- file; treat that as
      // "in use" so the sweep cannot retire a box mid-upload
      const inUse = left.some((n) => ID_RE.test(n) || LEASE_RE.test(n) || n.startsWith(".tmp-"));
      if (inUse) continue;
      if (meta.oneShot && meta.used) {
        // spent one-shot box: its single drop was taken and acked, nothing can
        // ever arrive again, so the box itself goes after a short grace
        if (now - meta.lastActivity > SPENT_BOX_GRACE_MS)
          await fs.rm(boxDir(box), { recursive: true, force: true });
      } else if (now - meta.lastActivity > boxIdleTtlMs) {
        await fs.rm(boxDir(box), { recursive: true, force: true });
      }
    }
  }

  async function handleBoxRegister(req: IncomingMessage, res: ServerResponse) {
    if (opts.storeToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${opts.storeToken}`) return send(res, 401, "register requires a token");
    }
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (body.length > 4096) {
        req.destroy();
        return send(res, 413, "registration body too large");
      }
    }
    let wanted: { mode?: unknown; expiry?: unknown } = {};
    if (body.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(res, 400, "registration body is not JSON");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return send(res, 400, "registration body is not an object");
      wanted = parsed as { mode?: unknown; expiry?: unknown };
    }
    // typeof first, never String(): stringifying an attacker's object would run
    // its toString and hand the result to the lookup below
    if (wanted.mode !== undefined && typeof wanted.mode !== "string")
      return send(res, 400, "unknown mode");
    if (wanted.expiry !== undefined && typeof wanted.expiry !== "string")
      return send(res, 400, "unknown expiry");
    const mode = wanted.mode ?? "standing";
    if (mode !== "standing" && mode !== "one-shot") return send(res, 400, "unknown mode");
    const expiry = wanted.expiry ?? BOX_TTL_DEFAULT;
    // burn is a handoff-only policy; a box holds drops for a span of days
    const ttlMs = expiry === "burn" ? undefined : EXPIRY_MS[expiry];
    if (typeof ttlMs !== "number") return send(res, 400, "unknown expiry");

    return await withLetterboxLock(async () => {
      await sweepLetterbox();
      const current = await letterboxUsage();
      if (current.boxes >= letterboxMaxBoxes) return send(res, 507, "relay has too many boxes");
      const id = newId();
      const token = randomBytes(32).toString("base64url");
      await fs.mkdir(boxDir(id), { recursive: true, mode: 0o700 });
      await writeBox(id, {
        token,
        oneShot: mode === "one-shot",
        used: false,
        ttlMs,
        lastActivity: clock(),
      });
      send(res, 201, JSON.stringify({ id, token, mode, expiry }), "application/json");
    });
  }

  async function handleDrop(id: string, req: IncomingMessage, res: ServerResponse) {
    const box = await readBox(id);
    if (!box) {
      req.resume();
      return send(res, 404, "unknown letterbox");
    }
    if (box.oneShot && box.used) {
      req.resume();
      return send(res, 410, "this letterbox accepted its one drop");
    }
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      req.resume();
      return send(res, 413, "drop too large");
    }
    if (dropsInFlight >= maxConcurrentDrops) {
      req.resume();
      return send(res, 503, "relay is busy; try again");
    }
    dropsInFlight += 1;
    const drop = newId();
    const tmp = join(boxDir(id), `.tmp-${drop}`);
    const tmpMeta = join(boxDir(id), `.tmp-${drop}.json`);
    try {
      const body = await readBodyToFile(req, tmp, maxBytes);
      if (body === null) return send(res, 413, "drop too large");
      if (body.bytes < 21) return send(res, 400, "drop too small to be sealed");
      if (body.magic !== "SBL1") return send(res, 400, "not a letterbox payload");
      return await withLetterboxLock(async () => {
        await sweepLetterbox();
        // re-read under the lock: a concurrent one-shot drop or a revoke may
        // have landed while this body was streaming
        const fresh = await readBox(id);
        if (!fresh) return send(res, 404, "unknown letterbox");
        if (fresh.oneShot && fresh.used) return send(res, 410, "this letterbox accepted its one drop");
        const meta: DropMeta = { expiresAt: clock() + fresh.ttlMs, bytes: body.bytes };
        const metaJson = JSON.stringify(meta);
        const mine = await boxUsage(id);
        if (mine.drops >= maxDropsPerBox) return send(res, 507, "this letterbox is full");
        if (mine.bytes + Buffer.byteLength(metaJson) > maxBoxBytes)
          return send(res, 507, "this letterbox is full");
        const pool = await letterboxUsage();
        if (pool.bytes + Buffer.byteLength(metaJson) > letterboxMaxTotal)
          return send(res, 507, "relay letterbox storage is full");
        // Ciphertext first, metadata second, both by rename: a crash between
        // the two leaves a payload the sweep collects, never a valid-looking
        // drop the owner would poll for and find nothing behind.
        await fs.rename(tmp, dropPath(id, drop));
        await fs.writeFile(tmpMeta, metaJson, { mode: 0o600 });
        await fs.rename(tmpMeta, dropMetaPath(id, drop));
        await writeBox(id, { ...fresh, used: fresh.oneShot || fresh.used, lastActivity: clock() });
        send(res, 201, JSON.stringify({ id: drop, bytes: body.bytes }), "application/json");
      });
    } finally {
      dropsInFlight -= 1;
      await fs.rm(tmp, { force: true });
      await fs.rm(tmpMeta, { force: true });
    }
  }

  async function handleDropList(id: string, req: IncomingMessage, res: ServerResponse) {
    const box = await readBox(id);
    if (!box) return send(res, 404, "unknown letterbox");
    if (!ownsBox(req, box)) return send(res, 401, "pickup requires the box token");
    const pending = await withLetterboxLock(async () => {
      await sweepLetterbox();
      await touchBox(id);
      return listDrops(id);
    });
    send(res, 200, JSON.stringify({ drops: pending }), "application/json");
  }

  async function handleDropClaim(
    id: string,
    drop: string,
    req: IncomingMessage,
    res: ServerResponse
  ) {
    const box = await readBox(id);
    if (!box) return send(res, 404, "unknown letterbox");
    if (!ownsBox(req, box)) return send(res, 401, "pickup requires the box token");
    const lease = await withLetterboxLock(async () => {
      // Sweep first: a lease whose deadline has passed belongs back in the
      // pool, so a poller that died mid-landing does not leave this drop
      // answering 409 to its replacement forever.
      await sweepLetterbox();
      await touchBox(id);
      const meta = await readDropMeta(id, drop);
      if (!meta) {
        send(res, 404, "unknown or expired drop");
        return null;
      }
      if (meta.expiresAt <= clock()) {
        await removeDrop(id, drop);
        send(res, 404, "unknown or expired drop");
        return null;
      }
      // atomic rename picks exactly one winner when two devices poll the same
      // box; the loser is told the drop is already being landed elsewhere. The
      // deadline in the name is what returns an abandoned lease to the pool.
      const path = join(boxDir(id), `${drop}.lease-${clock() + leaseMs}`);
      try {
        await fs.rename(dropPath(id, drop), path);
      } catch {
        send(res, 409, "drop already claimed");
        return null;
      }
      return path;
    });
    if (lease === null) return;
    // streamed outside the lock — a slow poller must not hold up the box, and
    // sendFile opens the lease before reading it, so a sweep that returns the
    // lease to the pool cannot truncate this response
    await sendFile(res, 200, lease);
  }

  /** Ack: the drop landed in the vault, so the ciphertext can go. A one-shot
      box has nothing left to do afterwards and removes itself. */
  async function handleDropAck(
    id: string,
    drop: string,
    req: IncomingMessage,
    res: ServerResponse
  ) {
    const box = await readBox(id);
    if (!box) return send(res, 404, "unknown letterbox");
    if (!ownsBox(req, box)) return send(res, 401, "pickup requires the box token");
    await withLetterboxLock(async () => {
      await removeDrop(id, drop);
      if (box.oneShot && box.used) await fs.rm(boxDir(id), { recursive: true, force: true });
      else await touchBox(id);
    });
    sendNoContent(res);
  }

  async function handleBoxRevoke(id: string, req: IncomingMessage, res: ServerResponse) {
    const box = await readBox(id);
    if (!box) return send(res, 404, "unknown letterbox");
    if (!ownsBox(req, box)) return send(res, 401, "revoke requires the box token");
    await withLetterboxLock(() => fs.rm(boxDir(id), { recursive: true, force: true }));
    sendNoContent(res);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    const route = async () => {
      if (req.method === "POST" && url.pathname === "/api/store") return handleStore(req, res);
      const claim = url.pathname.match(/^\/api\/claim\/([^/]+)$/);
      if (req.method === "POST" && claim) {
        if (!ID_RE.test(claim[1])) return send(res, 404, "unknown or expired");
        return handleClaim(claim[1], res);
      }
      if (letterboxOn) {
        if (req.method === "POST" && url.pathname === "/api/box/register")
          return handleBoxRegister(req, res);
        const drop = url.pathname.match(/^\/api\/box\/([^/]+)\/drop$/);
        if (req.method === "POST" && drop) {
          if (!ID_RE.test(drop[1])) {
            req.resume();
            return send(res, 404, "unknown letterbox");
          }
          return handleDrop(drop[1], req, res);
        }
        const drops = url.pathname.match(/^\/api\/box\/([^/]+)\/drops$/);
        if (req.method === "GET" && drops) {
          if (!ID_RE.test(drops[1])) return send(res, 404, "unknown letterbox");
          return handleDropList(drops[1], req, res);
        }
        const claimDrop = url.pathname.match(/^\/api\/box\/([^/]+)\/claim\/([^/]+)$/);
        if (req.method === "POST" && claimDrop) {
          if (!ID_RE.test(claimDrop[1]) || !ID_RE.test(claimDrop[2]))
            return send(res, 404, "unknown or expired drop");
          return handleDropClaim(claimDrop[1], claimDrop[2], req, res);
        }
        const ack = url.pathname.match(/^\/api\/box\/([^/]+)\/drops\/([^/]+)$/);
        if (req.method === "DELETE" && ack) {
          if (!ID_RE.test(ack[1]) || !ID_RE.test(ack[2]))
            return send(res, 404, "unknown or expired drop");
          return handleDropAck(ack[1], ack[2], req, res);
        }
        const revoke = url.pathname.match(/^\/api\/box\/([^/]+)$/);
        if (req.method === "DELETE" && revoke) {
          if (!ID_RE.test(revoke[1])) return send(res, 404, "unknown letterbox");
          return handleBoxRevoke(revoke[1], req, res);
        }
        const seal = url.pathname.match(/^\/d\/([^/]+)$/);
        if ((req.method === "GET" || req.method === "HEAD") && seal && ID_RE.test(seal[1]))
          return send(res, 200, SEALING_PAGE_HTML, "text/html; charset=utf-8");
      }
      const view = url.pathname.match(/^\/h\/([^/]+)$/);
      if ((req.method === "GET" || req.method === "HEAD") && view && ID_RE.test(view[1]))
        return send(res, 200, VIEWER_HTML, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/")
        return send(res, 200, "substrate handoff relay\n");
      send(res, 404, "not found");
    };
    route().catch(() => {
      if (!res.headersSent) send(res, 500, "relay error");
      else res.destroy();
    });
  });

  // Both pools sweep on the same cadence, each under its own lock: the
  // letterbox tree walk never makes a handoff store wait.
  const sweepBoth = () => {
    void sweep();
    if (letterboxOn) void withLetterboxLock(sweepLetterbox);
  };
  const timer = setInterval(sweepBoth, 10 * 60_000);
  timer.unref();
  server.once("close", () => clearInterval(timer));
  sweepBoth();
  return server;
}

// CLI entry after compilation: `node serve.mjs` — env-configured, stdout says
// where it listens.
// Exact entry-point match after resolving symlinks (`/tmp` is `/private/tmp`
// on macOS); a basename check would also fire when imported from another
// script named serve.ts.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createHandoffRelay({
    dataDir: process.env.HANDOFF_DIR ?? "./handoff-data",
    maxBytes: process.env.HANDOFF_MAX_BYTES ? Number(process.env.HANDOFF_MAX_BYTES) : undefined,
    maxTotalBytes: process.env.HANDOFF_MAX_TOTAL ? Number(process.env.HANDOFF_MAX_TOTAL) : undefined,
    maxEntries: process.env.HANDOFF_MAX_ENTRIES ? Number(process.env.HANDOFF_MAX_ENTRIES) : undefined,
    maxConcurrentStores: process.env.HANDOFF_MAX_CONCURRENT_STORES
      ? Number(process.env.HANDOFF_MAX_CONCURRENT_STORES)
      : undefined,
    storeToken: process.env.HANDOFF_TOKEN || undefined,
    letterboxDisabled: process.env.LETTERBOX_DISABLED === "1",
    letterboxMaxTotalBytes: process.env.LETTERBOX_MAX_TOTAL
      ? Number(process.env.LETTERBOX_MAX_TOTAL)
      : undefined,
    letterboxMaxBoxes: process.env.LETTERBOX_MAX_BOXES
      ? Number(process.env.LETTERBOX_MAX_BOXES)
      : undefined,
    maxDropsPerBox: process.env.LETTERBOX_MAX_DROPS_PER_BOX
      ? Number(process.env.LETTERBOX_MAX_DROPS_PER_BOX)
      : undefined,
    maxBoxBytes: process.env.LETTERBOX_MAX_BOX_BYTES
      ? Number(process.env.LETTERBOX_MAX_BOX_BYTES)
      : undefined,
    leaseMs: process.env.LETTERBOX_LEASE_MS ? Number(process.env.LETTERBOX_LEASE_MS) : undefined,
    boxIdleTtlMs: process.env.LETTERBOX_BOX_IDLE_TTL_MS
      ? Number(process.env.LETTERBOX_BOX_IDLE_TTL_MS)
      : undefined,
  });
  server.listen(port, process.env.BIND ?? "127.0.0.1", () => {
    console.log(`handoff relay listening on ${process.env.BIND ?? "127.0.0.1"}:${port}`);
  });
}
