import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHandoffRelay } from "./serve.ts";
import { openHandoff, sealHandoff } from "../../src/lib/handoff.ts";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function startRelay(opts: { maxBytes?: number; storeToken?: string } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "handoff-relay-"));
  const server = createHandoffRelay({ dataDir, ...opts });
  const port = await new Promise<number>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (!a || typeof a === "string") return rej(new Error("no port"));
      res(a.port);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  cleanups.push(async () => {
    await new Promise<void>((res) => (server as Server).close(() => res()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { base, dataDir };
}

async function store(base: string, payload: Uint8Array, expiry: string, token?: string) {
  return fetch(`${base}/api/store`, {
    method: "POST",
    headers: {
      "x-handoff-expiry": expiry,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: payload as BodyInit,
  });
}

async function claim(base: string, id: string) {
  return fetch(`${base}/api/claim/${id}`, { method: "POST" });
}

test("store → claim round-trips a sealed note end to end", async () => {
  const { base } = await startRelay();
  const doc = "<!doctype html><p>master notes v3</p>";
  const { payload, keyB64 } = await sealHandoff(new TextEncoder().encode(doc));
  const r = await store(base, payload, "7d");
  assert.equal(r.status, 201);
  const { id } = (await r.json()) as { id: string };
  assert.match(id, /^[A-Za-z0-9_-]{16,32}$/);

  const c = await claim(base, id);
  assert.equal(c.status, 200);
  const back = new Uint8Array(await c.arrayBuffer());
  const opened = await openHandoff(back, keyB64);
  assert.equal(new TextDecoder().decode(opened), doc);
});

test("day-expiry links serve multiple readers", async () => {
  const { base } = await startRelay();
  const { payload } = await sealHandoff(new TextEncoder().encode("x"));
  const { id } = (await (await store(base, payload, "1d")).json()) as { id: string };
  assert.equal((await claim(base, id)).status, 200);
  assert.equal((await claim(base, id)).status, 200);
});

test("burn links serve exactly one claim, then are gone from disk", async () => {
  const { base, dataDir } = await startRelay();
  const { payload } = await sealHandoff(new TextEncoder().encode("one-shot"));
  const { id } = (await (await store(base, payload, "burn")).json()) as { id: string };

  // GETting the viewer page (what a link-preview bot does) must NOT burn it
  const view = await fetch(`${base}/h/${id}`);
  assert.equal(view.status, 200);
  assert.match(await view.text(), /Decrypting locally/);

  assert.equal((await claim(base, id)).status, 200);
  assert.equal((await claim(base, id)).status, 404, "second claim refused");
  const left = (await readdir(dataDir)).filter((n) => n.includes(id));
  assert.deepEqual(left, [], "payload and meta deleted after the claim");
});

test("expired entries are refused and removed on claim", async () => {
  const { base, dataDir } = await startRelay();
  const { payload } = await sealHandoff(new TextEncoder().encode("old"));
  const { id } = (await (await store(base, payload, "1d")).json()) as { id: string };
  // age the entry by rewriting its meta, as the sweep would find it
  const metaFile = join(dataDir, `${id}.json`);
  const meta = JSON.parse(await readFile(metaFile, "utf8")) as { burn: boolean };
  await writeFile(metaFile, JSON.stringify({ ...meta, expiresAt: Date.now() - 1 }));
  assert.equal((await claim(base, id)).status, 404);
  const left = (await readdir(dataDir)).filter((n) => n.includes(id));
  assert.deepEqual(left, []);
});

test("store refuses junk: bad expiry, non-handoff bytes, oversized payloads", async () => {
  const { base } = await startRelay({ maxBytes: 1024 });
  const { payload } = await sealHandoff(new TextEncoder().encode("x"));
  assert.equal((await store(base, payload, "forever")).status, 400);
  // prototype names must not walk Object.prototype into a truthy "ttl" —
  // that entry would string-concat its expiresAt and never expire
  for (const evil of ["constructor", "toString", "hasOwnProperty", "__proto__"])
    assert.equal((await store(base, payload, evil)).status, 400, evil);
  assert.equal(
    (await store(base, new TextEncoder().encode("PK not sealed at all, but long enough"), "7d"))
      .status,
    400
  );
  const big = new Uint8Array(2048);
  big.set(new TextEncoder().encode("SBH1"));
  assert.equal((await store(base, big, "7d")).status, 413);
});

test("claim ignores path-traversal-shaped ids", async () => {
  const { base } = await startRelay();
  const r = await fetch(`${base}/api/claim/..%2F..%2Fetc`, { method: "POST" });
  assert.equal(r.status, 404);
});

test("store token gates uploads but never claims", async () => {
  const { base } = await startRelay({ storeToken: "sekrit" });
  const { payload } = await sealHandoff(new TextEncoder().encode("x"));
  assert.equal((await store(base, payload, "7d")).status, 401);
  const ok = await store(base, payload, "7d", "sekrit");
  assert.equal(ok.status, 201);
  const { id } = (await ok.json()) as { id: string };
  assert.equal((await claim(base, id)).status, 200, "claim needs no token");
});

test("viewer page never leaks referrers, refuses indexing, ships a CSP", async () => {
  const { base } = await startRelay();
  const r = await fetch(`${base}/h/whatever1234567890`);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  const html = await r.text();
  assert.match(html, /sandbox=/, "document renders in a sandboxed iframe");
  assert.ok(!/sandbox="[^"]*allow-scripts/.test(html), "sandbox never allows scripts");
  assert.match(html, /SBH1/, "viewer checks the payload magic");
});
