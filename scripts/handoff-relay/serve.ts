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
 */

import { randomBytes } from "node:crypto";
import { createReadStream, mkdirSync, promises as fs, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

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
  /** optional bearer token required on /api/store (claim stays open — the
      recipient has no account by design) */
  storeToken?: string;
}

const MAX_BYTES_DEFAULT = 32 * 1024 * 1024;
const MAX_TOTAL_DEFAULT = 1024 * 1024 * 1024;
const MAX_ENTRIES_DEFAULT = 4096;
const MAX_CONCURRENT_STORES_DEFAULT = 2;
const ORPHAN_GRACE_MS = 3600_000;

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

function responseHeaders(length: number, type: string) {
  return {
    "content-type": type,
    "content-length": length,
    // the relay is a dead end for robots and referrers alike
    "x-robots-tag": "noindex",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    // defense-in-depth for the viewer, the one page where an XSS could reach
    // the fragment key: its own inline script may run, nothing else loads,
    // and fetch stays on this origin. The srcdoc iframe INHERITS this policy
    // (spec: srcdoc documents inherit the embedder's CSP) on top of its
    // sandbox, so img-src data: is for the handed-off document's inlined
    // images, and script-src never matters in there — the sandbox has no
    // allow-scripts.
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-src 'self' about:",
  };
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = "text/plain") {
  res.writeHead(status, responseHeaders(Buffer.byteLength(body), type));
  res.end(body);
}

async function sendFile(
  res: ServerResponse,
  status: number,
  path: string,
  type = "application/octet-stream",
  unlinkAfterOpen = false
) {
  if (!unlinkAfterOpen) {
    const stat = await fs.stat(path);
    res.writeHead(status, responseHeaders(stat.size, type));
    await pipeline(createReadStream(path), res);
    return;
  }

  const file = await fs.open(path, "r");
  try {
    const stat = await file.stat();
    await fs.rm(path, { force: true });
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

export function createHandoffRelay(opts: HandoffRelayOptions): Server {
  const { dataDir } = opts;
  const maxBytes = opts.maxBytes ?? MAX_BYTES_DEFAULT;
  const maxTotal = opts.maxTotalBytes ?? MAX_TOTAL_DEFAULT;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES_DEFAULT;
  const maxConcurrentStores = opts.maxConcurrentStores ?? MAX_CONCURRENT_STORES_DEFAULT;
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    const route = async () => {
      if (req.method === "POST" && url.pathname === "/api/store") return handleStore(req, res);
      const claim = url.pathname.match(/^\/api\/claim\/([^/]+)$/);
      if (req.method === "POST" && claim) {
        if (!ID_RE.test(claim[1])) return send(res, 404, "unknown or expired");
        return handleClaim(claim[1], res);
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

  const timer = setInterval(() => void sweep(), 10 * 60_000);
  timer.unref();
  server.once("close", () => clearInterval(timer));
  void sweep();
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
  });
  server.listen(port, process.env.BIND ?? "127.0.0.1", () => {
    console.log(`handoff relay listening on ${process.env.BIND ?? "127.0.0.1"}:${port}`);
  });
}
