import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { SLIP_META_PATTERN, createHandoffRelay } from "./serve.ts";
import { KEY_BYTES, openHandoff, sealHandoffWith, toBase64Url } from "../../src/lib/handoff.ts";
import { SLIP_ENVELOPE_VERSION, slipEnvelope } from "./sealing-page/slipenvelope.ts";

/** The lens tier of the relay: register a slug, rewrite what sits under it any
    number of times, read it without credentials, revoke it once. The property
    every test here is really about is that the URL never changes and the
    server never holds anything it can read. */

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

function fakeClock(start = 1_700_000_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

async function startRelay(
  opts: {
    maxBytes?: number;
    lensDisabled?: boolean;
    lensMaxTotalBytes?: number;
    lensMaxLenses?: number;
    lensIdleTtlMs?: number;
    letterboxDisabled?: boolean;
    now?: () => number;
    storeToken?: string;
  } = {}
) {
  const dataDir = await mkdtemp(join(tmpdir(), "lens-relay-"));
  const server = createHandoffRelay({ dataDir, ...opts });
  const port = await new Promise<number>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (!a || typeof a === "string") return rej(new Error("no port"));
      res(a.port);
    });
  });
  cleanups.push(async () => {
    await new Promise<void>((res) => (server as Server).close(() => res()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, dataDir };
}

const KEY = toBase64Url(new Uint8Array(KEY_BYTES).map((_, i) => (i * 11 + 3) % 256));

async function sealed(html: string): Promise<Uint8Array> {
  const { payload } = await sealHandoffWith(KEY, new TextEncoder().encode(html));
  return payload;
}

async function register(base: string, token?: string) {
  const r = await fetch(`${base}/api/lens/register`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()) as { id: string; token: string };
}

function publish(base: string, id: string, token: string, payload: Uint8Array) {
  return fetch(`${base}/api/lens/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: payload,
  });
}

test("one slug, republished, keeps serving the newest snapshot", async () => {
  const { base } = await startRelay();
  const { id, token } = await register(base);

  // registered but never published: nothing to show yet
  assert.equal((await fetch(`${base}/api/lens/${id}`)).status, 404);

  assert.equal((await publish(base, id, token, await sealed("<p>one</p>"))).status, 200);
  const first = await fetch(`${base}/api/lens/${id}`);
  assert.equal(first.status, 200);
  assert.equal(
    new TextDecoder().decode(await openHandoff(new Uint8Array(await first.arrayBuffer()), KEY)),
    "<p>one</p>"
  );

  assert.equal((await publish(base, id, token, await sealed("<p>two</p>"))).status, 200);
  const second = await fetch(`${base}/api/lens/${id}`);
  assert.equal(
    new TextDecoder().decode(await openHandoff(new Uint8Array(await second.arrayBuffer()), KEY)),
    "<p>two</p>",
    "the same URL now reads the newer page"
  );
});

test("reading a lens needs no credential; publishing and revoking need the token", async () => {
  const { base } = await startRelay();
  const { id, token } = await register(base);
  await publish(base, id, token, await sealed("<p>hi</p>"));

  assert.equal((await fetch(`${base}/api/lens/${id}`)).status, 200, "the link is the capability");

  const wrongPut = await publish(base, id, "not-the-token", await sealed("<p>mine now</p>"));
  assert.equal(wrongPut.status, 401);
  const wrongDelete = await fetch(`${base}/api/lens/${id}`, {
    method: "DELETE",
    headers: { authorization: "Bearer not-the-token" },
  });
  assert.equal(wrongDelete.status, 401);

  // and the content is untouched by either attempt
  const still = await fetch(`${base}/api/lens/${id}`);
  assert.equal(
    new TextDecoder().decode(await openHandoff(new Uint8Array(await still.arrayBuffer()), KEY)),
    "<p>hi</p>"
  );
});

test("revoke takes the slug and its ciphertext off the relay", async () => {
  const { base, dataDir } = await startRelay();
  const { id, token } = await register(base);
  await publish(base, id, token, await sealed("<p>secret</p>"));

  const gone = await fetch(`${base}/api/lens/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(gone.status, 204);
  assert.equal((await fetch(`${base}/api/lens/${id}`)).status, 404);
  assert.deepEqual(await readdir(join(dataDir, "lens")), [], "no ciphertext left behind");
  // and a republish cannot resurrect a revoked slug
  assert.equal((await publish(base, id, token, await sealed("<p>back</p>"))).status, 404);
});

test("the relay refuses anything that is not a sealed payload", async () => {
  const { base } = await startRelay();
  const { id, token } = await register(base);
  const plain = await publish(base, id, token, new TextEncoder().encode("PLAIN html with no magic at all, but long enough"));
  assert.equal(plain.status, 400);
  assert.match(await plain.text(), /not a lens payload/);
  const tiny = await publish(base, id, token, new TextEncoder().encode("SBH1"));
  assert.equal(tiny.status, 400);
});

test("a payload over the cap is refused and leaves no partial file", async () => {
  const { base, dataDir } = await startRelay({ maxBytes: 1024 });
  const { id, token } = await register(base);
  const big = await publish(base, id, token, await sealed("<p>" + "x".repeat(4096) + "</p>"));
  assert.equal(big.status, 413);
  const files = await readdir(join(dataDir, "lens", id));
  assert.deepEqual(files.sort(), ["lens.json"], "only the metadata, no half payload");
});

test("the lens pool has its own ceiling, and a republish counts only its delta", async () => {
  // room for one ~600-byte page but not two of them
  const { base } = await startRelay({ lensMaxTotalBytes: 900 });
  const { id, token } = await register(base);
  const page = "<p>" + "y".repeat(500) + "</p>";
  assert.equal((await publish(base, id, token, await sealed(page))).status, 200);
  assert.equal(
    (await publish(base, id, token, await sealed(page))).status,
    200,
    "republishing the same size replaces rather than accumulates"
  );
  const second = await register(base);
  assert.equal(
    (await publish(base, second.id, second.token, await sealed(page))).status,
    507,
    "a second lens does not fit"
  );
});

test("a HEAD says whether the slug is still there, and says which answer it is", async () => {
  const { base } = await startRelay();
  const { id, token } = await register(base);
  await publish(base, id, token, await sealed("<p>live</p>"));

  const live = await fetch(`${base}/api/lens/${id}`, { method: "HEAD" });
  assert.equal(live.status, 204);
  assert.equal(live.headers.get("x-substrate-lens"), "live");
  assert.equal(await live.text(), "", "HEAD carries no body");

  await fetch(`${base}/api/lens/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const gone = await fetch(`${base}/api/lens/${id}`, { method: "HEAD" });
  assert.equal(gone.status, 404);
  assert.equal(
    gone.headers.get("x-substrate-lens"),
    "gone",
    "a 404 without this header is an unrecognised route, not a retired lens"
  );
});

test("asking whether a lens is alive does not keep it alive", async () => {
  const clock = fakeClock();
  const { base } = await startRelay({ now: clock.now, lensIdleTtlMs: 86400_000 });
  const { id, token } = await register(base);
  await publish(base, id, token, await sealed("<p>abandoned</p>"));

  // a ledger left open, refreshing every day, must not hold the idle sweep off
  for (let day = 0; day < 5; day += 1) {
    clock.advance(20 * 3600_000);
    await fetch(`${base}/api/lens/${id}`, { method: "HEAD" });
  }
  await register(base); // drives a sweep
  assert.equal((await fetch(`${base}/api/lens/${id}`)).status, 404);
});

test("the live-lens ceiling bounds registration", async () => {
  const { base } = await startRelay({ lensMaxLenses: 2 });
  await register(base);
  await register(base);
  const third = await fetch(`${base}/api/lens/register`, { method: "POST" });
  assert.equal(third.status, 507);
});

test("an idle lens is swept away with its ciphertext", async () => {
  const clock = fakeClock();
  const { base, dataDir } = await startRelay({ now: clock.now, lensIdleTtlMs: 86400_000 });
  const { id, token } = await register(base);
  await publish(base, id, token, await sealed("<p>abandoned</p>"));
  assert.ok(await stat(join(dataDir, "lens", id, "payload")));

  clock.advance(3 * 86400_000);
  // the sweep runs lazily ahead of the next registration
  await register(base);
  assert.equal((await fetch(`${base}/api/lens/${id}`)).status, 404);
});

test("reading and republishing keep a lens alive past the idle span", async () => {
  const clock = fakeClock();
  const { base } = await startRelay({ now: clock.now, lensIdleTtlMs: 86400_000 });
  const { id, token } = await register(base);
  await publish(base, id, token, await sealed("<p>in use</p>"));
  for (let day = 0; day < 5; day += 1) {
    clock.advance(20 * 3600_000);
    assert.equal((await publish(base, id, token, await sealed(`<p>day ${day}</p>`))).status, 200);
  }
  await register(base); // drives a sweep
  assert.equal((await fetch(`${base}/api/lens/${id}`)).status, 200);
});

test("the store token gates registration when the relay sets one", async () => {
  const { base } = await startRelay({ storeToken: "s3cret" });
  assert.equal((await fetch(`${base}/api/lens/register`, { method: "POST" })).status, 401);
  const ok = await register(base, "s3cret");
  assert.ok(ok.id);
});

test("LENS_DISABLED turns every lens route into a 404", async () => {
  const { base } = await startRelay({ lensDisabled: true });
  assert.equal((await fetch(`${base}/api/lens/register`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/l/aaaaaaaaaaaaaaaa`)).status, 404);
  // and the handoff half is untouched
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test("the viewer page is served for a well-formed slug and nothing else", async () => {
  const { base } = await startRelay();
  const page = await fetch(`${base}/l/aaaaaaaaaaaaaaaa`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Substrate lens/);
  assert.match(html, /visibilitychange/, "the living half is in the page");
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  assert.equal((await fetch(`${base}/l/short`)).status, 404);
});

test("the lens pool does not disturb the handoff pool's accounting", async () => {
  const { base } = await startRelay();
  const { id, token } = await register(base);
  await publish(base, id, token, await sealed("<p>lens</p>"));
  const stored = await fetch(`${base}/api/store`, {
    method: "POST",
    headers: { "x-handoff-expiry": "7d" },
    body: await sealed("<p>handoff</p>"),
  });
  assert.equal(stored.status, 201);
  const { id: handoffId } = (await stored.json()) as { id: string };
  const claimed = await fetch(`${base}/api/claim/${handoffId}`, { method: "POST" });
  assert.equal(claimed.status, 200);
});

/* ── the return slip ─────────────────────────────────────────────────────── */

test("the chips' sealing code is its own route, and a plain lens never fetches it", async () => {
  const { base } = await startRelay();
  const page = await fetch(`${base}/l/aaaaaaaaaaaaaaaa`);
  const html = await page.text();
  // the viewer references it, but only from inside the branch a decrypted
  // question takes — nothing is loaded by a page that asks nothing
  assert.match(html, /tag\.src = "\/slip\.js"/, "the viewer knows where the chips come from");
  assert.ok(
    !html.includes("age-encryption") && html.length < 40_000,
    "the sealing library must not be inlined into every lens page"
  );

  const script = await fetch(`${base}/slip.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /javascript/);
  assert.equal(script.headers.get("x-content-type-options"), "nosniff");
  const source = await script.text();
  assert.match(source, /SBL1/, "an answer goes out on the inbound door's wire format");
  assert.match(source, /\/api\/box\//, "and to the inbound door itself");
});

test("the viewer may load that script — and only from this origin", async () => {
  const { base } = await startRelay();
  const csp = (await fetch(`${base}/l/aaaaaaaaaaaaaaaa`)).headers.get("content-security-policy");
  assert.match(csp ?? "", /script-src 'self' 'unsafe-inline'/);
  // the widening is exactly one source keyword: nothing else may be reached
  assert.match(csp ?? "", /default-src 'none'/);
  assert.match(csp ?? "", /connect-src 'self'/);
  assert.ok(!/script-src[^;]*https?:/.test(csp ?? ""), "no off-origin script source");
});

test("a relay with no inbound door serves no chips, because an answer would have nowhere to go", async () => {
  const { base } = await startRelay({ letterboxDisabled: true });
  assert.equal((await fetch(`${base}/slip.js`)).status, 404);
  // the lens itself is untouched: a page can still be shared, it just cannot ask
  assert.equal((await fetch(`${base}/l/aaaaaaaaaaaaaaaa`)).status, 200);
});

test("the served viewer carries the one pattern that reads a question", async () => {
  const { base } = await startRelay();
  const html = await (await fetch(`${base}/l/aaaaaaaaaaaaaaaa`)).text();
  assert.ok(
    html.includes(SLIP_META_PATTERN.source),
    `the viewer's pattern has drifted from ${SLIP_META_PATTERN.source}`
  );
});

test("every option of one slip seals to the same number of bytes", async () => {
  // Unpadded, the POST body is a constant plus the tapped option's own byte
  // length — and an answer is one of N KNOWN strings, so `todo / doing / done`
  // hands the relay operator the answer from the size alone, and `yes / no`
  // hands it over outright. That is not the drop's threat model (free text of
  // arbitrary length) and it must not inherit its silence.
  const lens = "aaaaaaaaaaaaaaaa";
  for (const options of [
    ["todo", "doing", "done"],
    ["yes", "no"],
    ["approve", "reject"],
    ["a", "an option long enough to cross more than one padding block " + "x".repeat(300)],
  ]) {
    const lengths = new Set(
      options.map((o) => new TextEncoder().encode(slipEnvelope(lens, options, o)).length)
    );
    assert.equal(lengths.size, 1, `options ${options.join("/")} leak their length`);
  }
});

test("an answer is its own envelope version, so an older engine refuses it rather than eating it", () => {
  // `.vault/letterbox.json` is synced vault data and every device holding it
  // polls the same box, so a staged rollout guarantees a window in which an
  // older engine claims an answer. That build reads an unknown `kind` as
  // absent, files the answer as an empty-bodied Inbox note, and ACKS it — the
  // answer destroyed rather than deferred. A version it refuses outright
  // leaves the drop on the relay for a device that understands it.
  const parsed = JSON.parse(slipEnvelope("aaaaaaaaaaaaaaaa", ["yes", "no"], "yes")) as {
    v: number;
    kind: string;
    lens: string;
    value: string;
  };
  assert.equal(parsed.v, SLIP_ENVELOPE_VERSION);
  assert.notEqual(SLIP_ENVELOPE_VERSION, 1, "a message is version 1 and must stay readable");
  assert.equal(parsed.kind, "slip");
  assert.equal(parsed.value, "yes", "the padding never touches what was tapped");
  assert.equal(parsed.lens, "aaaaaaaaaaaaaaaa");
});
