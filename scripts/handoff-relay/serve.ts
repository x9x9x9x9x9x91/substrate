#!/usr/bin/env node
/** Handoff relay (SUB-833) — the dumb store behind "Send as link".
 *
 * The whole trust model in one sentence: this server only ever holds
 * ciphertext, the AES key rides the link's `#fragment` (which browsers never
 * send), so the relay can lose, leak, or be subpoenaed without exposing a
 * single note. It stores blobs, serves a static viewer page that decrypts
 * in the recipient's browser, and deletes on expiry. Nothing else — no
 * accounts, no note metadata, no analytics.
 *
 * Self-host: `node scripts/handoff-relay/serve.ts` and front it with any
 * TLS-terminating proxy (the viewer needs WebCrypto, which browsers gate
 * behind https). See README.md next to this file.
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
import { mkdirSync, promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface HandoffRelayOptions {
  dataDir: string;
  /** hard per-payload cap; the app warns at 10 MiB, this refuses bigger */
  maxBytes?: number;
  /** refuse new stores once the data dir holds this much (disk-fill guard) */
  maxTotalBytes?: number;
  /** optional bearer token required on /api/store (claim stays open — the
      recipient has no account by design) */
  storeToken?: string;
}

const MAX_BYTES_DEFAULT = 32 * 1024 * 1024;
const MAX_TOTAL_DEFAULT = 1024 * 1024 * 1024;

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

async function readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > cap) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = "text/plain") {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    // the relay is a dead end for robots and referrers alike
    "x-robots-tag": "noindex",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // defense-in-depth for the viewer, the one page where an XSS could reach
    // the fragment key: its own inline script may run, nothing else loads,
    // and fetch stays on this origin. The srcdoc iframe INHERITS this policy
    // (spec: srcdoc documents inherit the embedder's CSP) on top of its
    // sandbox, so img-src data: is for the handed-off document's inlined
    // images, and script-src never matters in there — the sandbox has no
    // allow-scripts.
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-src 'self' about:",
  });
  res.end(body);
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
<iframe id="doc" sandbox="allow-popups allow-popups-to-escape-sandbox" hidden></iframe>
<footer hidden>End-to-end encrypted — this page decrypted in your browser; the relay only ever saw ciphertext.</footer>
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
  mkdirSync(dataDir, { recursive: true });

  const payloadPath = (id: string) => join(dataDir, id);
  const metaPath = (id: string) => join(dataDir, `${id}.json`);

  async function readMeta(id: string): Promise<Meta | null> {
    try {
      return JSON.parse(await fs.readFile(metaPath(id), "utf8")) as Meta;
    } catch {
      return null;
    }
  }

  async function remove(id: string) {
    await fs.rm(payloadPath(id), { force: true });
    await fs.rm(metaPath(id), { force: true });
  }

  /** Expired pairs and orphaned claim temps go; runs on an interval and is
      cheap enough to also run lazily where staleness matters. */
  async function sweep() {
    const now = Date.now();
    for (const name of await fs.readdir(dataDir).catch(() => [] as string[])) {
      if (name.endsWith(".json")) {
        const id = name.slice(0, -5);
        const meta = await readMeta(id);
        if (!meta || meta.expiresAt <= now) await remove(id);
      } else if (/\.claimed-\d+-\d+$/.test(name) || name.startsWith(".tmp-")) {
        // crashes between rename steps leave these behind; the shape match
        // (not includes) can never collide with a stored id — ID_RE has no "."
        const st = await fs.stat(join(dataDir, name)).catch(() => null);
        if (st && now - st.mtimeMs > 3600_000) await fs.rm(join(dataDir, name), { force: true });
      }
    }
  }

  async function totalBytes(): Promise<number> {
    let sum = 0;
    for (const name of await fs.readdir(dataDir).catch(() => [] as string[])) {
      const st = await fs.stat(join(dataDir, name)).catch(() => null);
      if (st?.isFile()) sum += st.size;
    }
    return sum;
  }

  async function handleStore(req: IncomingMessage, res: ServerResponse) {
    if (opts.storeToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${opts.storeToken}`) return send(res, 401, "store requires a token");
    }
    const expiry = String(req.headers["x-handoff-expiry"] ?? "");
    const ttl = EXPIRY_MS[expiry];
    if (typeof ttl !== "number") return send(res, 400, "unknown expiry");
    const body = await readBody(req, maxBytes);
    if (body === null) return send(res, 413, "payload too large");
    // counted after the body so the ceiling is maxTotal for serial stores;
    // concurrent stores that pass this line together can still overshoot by
    // a few payloads — the cap is a disk-fill guard, not an exact quota
    if ((await totalBytes()) + body.length > maxTotal) return send(res, 507, "relay is full");
    if (body.length < 21) return send(res, 400, "payload too small to be sealed");
    if (body.subarray(0, 4).toString("utf8") !== "SBH1")
      return send(res, 400, "not a handoff payload");
    const id = newId();
    const tmp = join(dataDir, `.tmp-${id}`);
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, payloadPath(id));
    const meta: Meta = { expiresAt: Date.now() + ttl, burn: expiry === "burn" };
    await fs.writeFile(metaPath(id), JSON.stringify(meta));
    send(res, 201, JSON.stringify({ id }), "application/json");
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
      const body = await fs.readFile(claimed);
      await fs.rm(claimed, { force: true });
      await fs.rm(metaPath(id), { force: true });
      return send(res, 200, body, "application/octet-stream");
    }
    const body = await fs.readFile(payloadPath(id)).catch(() => null);
    if (body === null) return send(res, 404, "unknown or expired");
    send(res, 200, body, "application/octet-stream");
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
      if ((req.method === "GET" || req.method === "HEAD") && view)
        return send(res, 200, VIEWER_HTML, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/")
        return send(res, 200, "substrate handoff relay\n");
      send(res, 404, "not found");
    };
    route().catch(() => send(res, 500, "relay error"));
  });

  const timer = setInterval(() => void sweep(), 10 * 60_000);
  timer.unref();
  server.once("close", () => clearInterval(timer));
  void sweep();
  return server;
}

// CLI entry: `node serve.ts` — env-configured, stdout says where it listens.
// Exact entry-point match (vault-sync-server's pattern): a basename check
// would also fire when imported from another script named serve.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createHandoffRelay({
    dataDir: process.env.HANDOFF_DIR ?? "./handoff-data",
    maxBytes: process.env.HANDOFF_MAX_BYTES ? Number(process.env.HANDOFF_MAX_BYTES) : undefined,
    maxTotalBytes: process.env.HANDOFF_MAX_TOTAL ? Number(process.env.HANDOFF_MAX_TOTAL) : undefined,
    storeToken: process.env.HANDOFF_TOKEN || undefined,
  });
  server.listen(port, process.env.BIND ?? "127.0.0.1", () => {
    console.log(`handoff relay listening on ${process.env.BIND ?? "127.0.0.1"}:${port}`);
  });
}
