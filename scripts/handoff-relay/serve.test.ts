import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

async function startRelay(
  opts: {
    maxBytes?: number;
    maxTotalBytes?: number;
    maxEntries?: number;
    maxConcurrentStores?: number;
    beforeCreate?: (dataDir: string) => Promise<void>;
  } & { storeToken?: string } = {}
) {
  const dataDir = await mkdtemp(join(tmpdir(), "handoff-relay-"));
  await opts.beforeCreate?.(dataDir);
  const server = createHandoffRelay({
    dataDir,
    maxBytes: opts.maxBytes,
    maxTotalBytes: opts.maxTotalBytes,
    maxEntries: opts.maxEntries,
    maxConcurrentStores: opts.maxConcurrentStores,
    storeToken: opts.storeToken,
  });
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

test("concurrent burn claims have exactly one winner", async () => {
  const { base } = await startRelay();
  const { payload } = await sealHandoff(new TextEncoder().encode("one-shot race"));
  const { id } = (await (await store(base, payload, "burn")).json()) as { id: string };

  const responses = await Promise.all([claim(base, id), claim(base, id)]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 404]
  );
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

test("concurrent stores cannot race past the entry quota", async () => {
  const { base, dataDir } = await startRelay({ maxEntries: 1 });
  const { payload } = await sealHandoff(new TextEncoder().encode("quota"));
  const responses = await Promise.all([store(base, payload, "7d"), store(base, payload, "7d")]);
  assert.deepEqual(
    responses.map((r) => r.status).sort(),
    [201, 507]
  );
  assert.equal(
    (await readdir(dataDir)).filter((name) => /^[A-Za-z0-9_-]{16,32}$/.test(name)).length,
    1
  );
});

test("concurrent stores cannot race past the byte quota", async () => {
  const { payload } = await sealHandoff(new TextEncoder().encode("byte quota"));
  const { base } = await startRelay({ maxTotalBytes: payload.length + 100 });
  const responses = await Promise.all([store(base, payload, "7d"), store(base, payload, "7d")]);
  assert.deepEqual(
    responses.map((r) => r.status).sort(),
    [201, 507]
  );
});

test("startup sweep reclaims a crash-orphaned payload after the grace period", async () => {
  const orphan = "orphanedPayload123456";
  const { dataDir } = await startRelay({
    beforeCreate: async (dir) => {
      const path = join(dir, orphan);
      await writeFile(path, "ciphertext without metadata");
      const old = new Date(Date.now() - 2 * 3600_000);
      await utimes(path, old, old);
    },
  });
  const deadline = Date.now() + 1000;
  while ((await readdir(dataDir)).includes(orphan) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!(await readdir(dataDir)).includes(orphan));
});

test("startup sweep preserves a fresh temporary metadata write", async () => {
  const temporary = ".tmp-pending.json";
  const { dataDir } = await startRelay({
    beforeCreate: async (dir) => {
      await writeFile(join(dir, temporary), "pending metadata");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok((await readdir(dataDir)).includes(temporary));
});

test("viewer page never leaks referrers, refuses indexing, ships a CSP", async () => {
  const { base } = await startRelay();
  const r = await fetch(`${base}/h/whatever1234567890`);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  const html = await r.text();
  assert.match(html, /sandbox=/, "document renders in a sandboxed iframe");
  assert.ok(!/sandbox="[^"]*allow-scripts/.test(html), "sandbox never allows scripts");
  assert.ok(
    !/sandbox="[^"]*allow-popups-to-escape-sandbox/.test(html),
    "shared content cannot open an unsandboxed branded popup"
  );
  assert.match(html, /SBH1/, "viewer checks the payload magic");
});
