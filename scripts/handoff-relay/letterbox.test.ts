import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { createHandoffRelay } from "./serve.ts";
import { sealHandoff } from "../../src/lib/handoff.ts";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

/** A clock the tests move by hand: lease timeouts and drop expiry are spans of
    minutes and days, and no test should sleep through either. */
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
    maxTotalBytes?: number;
    maxEntries?: number;
    letterboxDisabled?: boolean;
    letterboxMaxTotalBytes?: number;
    maxDropsPerBox?: number;
    maxBoxBytes?: number;
    leaseMs?: number;
    boxIdleTtlMs?: number;
    now?: () => number;
    storeToken?: string;
  } = {}
) {
  const dataDir = await mkdtemp(join(tmpdir(), "letterbox-relay-"));
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

interface Box {
  id: string;
  token: string;
}

async function register(
  base: string,
  body: Record<string, unknown> = {},
  token?: string
): Promise<Box> {
  const r = await fetch(`${base}/api/box/register`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 201);
  return (await r.json()) as Box;
}

/** The wire shape a sealing page produces: magic + age ciphertext. */
async function sealed(recipient: string, plaintext: string): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const ciphertext = await encrypter.encrypt(new TextEncoder().encode(plaintext));
  const payload = new Uint8Array(4 + ciphertext.length);
  payload.set(new TextEncoder().encode("SBL1"), 0);
  payload.set(ciphertext, 4);
  return payload;
}

async function drop(base: string, box: string, payload: Uint8Array) {
  return fetch(`${base}/api/box/${box}/drop`, { method: "POST", body: payload as BodyInit });
}

/** `null` sends no authorization header at all — an explicit `undefined` would
 *  fall back to the owner token through the helpers' default parameter. */
function auth(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function drops(base: string, box: Box, token: string | null = box.token) {
  return fetch(`${base}/api/box/${box.id}/drops`, { headers: auth(token) });
}

async function claim(base: string, box: Box, dropId: string, token: string | null = box.token) {
  return fetch(`${base}/api/box/${box.id}/claim/${dropId}`, {
    method: "POST",
    headers: auth(token),
  });
}

async function ack(base: string, box: Box, dropId: string, token: string | null = box.token) {
  return fetch(`${base}/api/box/${box.id}/drops/${dropId}`, {
    method: "DELETE",
    headers: auth(token),
  });
}

async function pending(base: string, box: Box): Promise<{ id: string; bytes: number }[]> {
  const r = await drops(base, box);
  assert.equal(r.status, 200);
  return ((await r.json()) as { drops: { id: string; bytes: number }[] }).drops;
}

// --- acceptance item 2: sealing page header parity with the viewer ---------

test("the sealing page ships the viewer's CSP, no-store and noindex headers", async () => {
  const { base } = await startRelay();
  const box = await register(base);
  const viewer = await fetch(`${base}/h/whatever1234567890`);
  const page = await fetch(`${base}/d/${box.id}`);
  assert.equal(page.status, 200);
  for (const header of [
    "referrer-policy",
    "x-robots-tag",
    "x-content-type-options",
    "cache-control",
    "content-security-policy",
  ])
    assert.equal(page.headers.get(header), viewer.headers.get(header), header);
  const html = await page.text();
  assert.match(html, /SBL1/, "the page uploads the letterbox magic");
  assert.match(html, /location\.hash/, "the recipient key is read from the fragment");
  assert.ok(!/<script src=/.test(html), "the page loads nothing over the network");
  assert.match(html, /trust the operator/, "the operator-honesty footer is present");
  assert.match(
    html,
    /<button id="send" type="submit" disabled>/,
    "the send button ships disabled — only the sealing script enables it"
  );
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /form-action 'none'/,
    "the browser refuses a form submit even if the sealing script never runs"
  );
});

test("the box endpoints disappear when the operator opts out", async () => {
  const { base } = await startRelay({ letterboxDisabled: true });
  const r = await fetch(`${base}/api/box/register`, { method: "POST", body: "{}" });
  assert.equal(r.status, 404);
  assert.equal((await fetch(`${base}/d/abcdefghijklmnop`)).status, 404);
});

// --- acceptance item 3: the relay refuses junk and oversized drops ---------

test("drops without the magic are refused, and oversized ones too", async () => {
  const { base } = await startRelay({ maxBytes: 4096 });
  const box = await register(base);
  const junk = new TextEncoder().encode("PK not sealed at all, but long enough to try");
  assert.equal((await drop(base, box.id, junk)).status, 400);

  const big = new Uint8Array(8192);
  big.set(new TextEncoder().encode("SBL1"));
  assert.equal((await drop(base, box.id, big)).status, 413);

  assert.equal(
    (await drop(base, "..%2F..%2Fetc", junk)).status,
    404,
    "path-traversal-shaped box ids never reach the store"
  );
});

// --- acceptance item 4: the relay holds ciphertext and nothing else -------

test("a stored drop is age ciphertext with no plaintext left in it", async () => {
  const { base, dataDir } = await startRelay();
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base);
  const secret = "the rehearsal room key is under the mat";
  assert.equal((await drop(base, box.id, await sealed(recipient, secret))).status, 201);

  const boxDir = join(dataDir, "letterbox", box.id);
  const stored = (await readdir(boxDir)).filter((n) => /^[A-Za-z0-9_-]{16,32}$/.test(n));
  assert.equal(stored.length, 1);
  const bytes = await readFile(join(boxDir, stored[0]));
  assert.equal(bytes.subarray(0, 4).toString("utf8"), "SBL1");
  assert.match(bytes.subarray(4, 40).toString("utf8"), /^age-encryption\.org\/v1/);
  assert.ok(!bytes.includes(Buffer.from(secret)), "no plaintext survives on the relay");
});

// --- acceptance item 5: pickup needs the owner bearer ---------------------

test("pickup requires the box token; the sender half never deletes", async () => {
  const { base } = await startRelay();
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base);
  assert.equal((await drop(base, box.id, await sealed(recipient, "hello"))).status, 201);

  assert.equal((await drops(base, box, null)).status, 401);
  assert.equal((await drops(base, box, "wrong")).status, 401);
  const listed = await pending(base, box);
  assert.equal(listed.length, 1);

  assert.equal((await claim(base, box, listed[0].id, null)).status, 401);
  assert.equal((await ack(base, box, listed[0].id, null)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/box/${box.id}`, { method: "DELETE" })).status,
    401,
    "revoke needs the token too"
  );
  assert.equal((await pending(base, box)).length, 1, "the refused deletes changed nothing");
});

// --- acceptance item 6: lease semantics ----------------------------------

test("two pollers racing one drop produce exactly one winner", async () => {
  const { base } = await startRelay();
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base);
  await drop(base, box.id, await sealed(recipient, "race"));
  const [only] = await pending(base, box);

  const responses = await Promise.all([
    claim(base, box, only.id),
    claim(base, box, only.id),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status).sort(),
    [200, 409]
  );
  assert.deepEqual(await pending(base, box), [], "a leased drop is not offered again");
});

test("an unacked lease returns to the pool after the lease timeout", async () => {
  const clock = fakeClock();
  const { base } = await startRelay({ now: clock.now, leaseMs: 60_000 });
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base);
  await drop(base, box.id, await sealed(recipient, "crashed mid-landing"));
  const [only] = await pending(base, box);
  assert.equal((await claim(base, box, only.id)).status, 200);
  assert.deepEqual(await pending(base, box), []);

  clock.advance(61_000);
  const back = await pending(base, box);
  assert.deepEqual(
    back.map((d) => d.id),
    [only.id],
    "the drop is re-offered rather than lost"
  );
  assert.equal((await claim(base, box, only.id)).status, 200, "and can be claimed again");
});

test("ack deletes the claimed ciphertext from the relay", async () => {
  const { base, dataDir } = await startRelay();
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base);
  await drop(base, box.id, await sealed(recipient, "landed"));
  const [only] = await pending(base, box);
  const claimed = await claim(base, box, only.id);
  assert.equal(claimed.status, 200);
  assert.equal(
    new Uint8Array(await claimed.arrayBuffer()).subarray(0, 4).join(),
    new TextEncoder().encode("SBL1").join()
  );

  assert.equal((await ack(base, box, only.id)).status, 204);
  const left = (await readdir(join(dataDir, "letterbox", box.id))).filter((n) =>
    n.startsWith(only.id)
  );
  assert.deepEqual(left, []);
  assert.deepEqual(await pending(base, box), []);
});

// --- acceptance item 10: one-shot boxes ----------------------------------

test("a one-shot box takes one drop and is gone after the ack", async () => {
  const { base, dataDir } = await startRelay();
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base, { mode: "one-shot" });
  assert.equal((await drop(base, box.id, await sealed(recipient, "first"))).status, 201);
  assert.equal(
    (await drop(base, box.id, await sealed(recipient, "second"))).status,
    410,
    "the second sender is told the link is spent"
  );

  const [only] = await pending(base, box);
  assert.equal((await claim(base, box, only.id)).status, 200);
  assert.equal((await ack(base, box, only.id)).status, 204);
  assert.ok(!(await readdir(join(dataDir, "letterbox"))).includes(box.id));
  assert.equal((await drops(base, box)).status, 404);
});

test("revoke removes the box and every drop still pending in it", async () => {
  const { base, dataDir } = await startRelay();
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base);
  await drop(base, box.id, await sealed(recipient, "unread"));
  const r = await fetch(`${base}/api/box/${box.id}`, {
    method: "DELETE",
    headers: auth(box.token),
  });
  assert.equal(r.status, 204);
  assert.ok(!(await readdir(join(dataDir, "letterbox"))).includes(box.id));
  assert.equal((await drop(base, box.id, await sealed(recipient, "after"))).status, 404);
});

// --- acceptance item 11: expiry ------------------------------------------

test("expired drops are swept and never offered to a poller", async () => {
  const clock = fakeClock();
  const { base, dataDir } = await startRelay({ now: clock.now });
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base, { expiry: "1d" });
  await drop(base, box.id, await sealed(recipient, "stale"));
  const [only] = await pending(base, box);

  clock.advance(86400_000 + 1000);
  assert.deepEqual(await pending(base, box), []);
  assert.equal((await claim(base, box, only.id)).status, 404);
  const left = (await readdir(join(dataDir, "letterbox", box.id))).filter((n) =>
    n.startsWith(only.id)
  );
  assert.deepEqual(left, [], "the sweeper removed the ciphertext and its metadata");
});

test("registration refuses a burn expiry and an unknown mode", async () => {
  const { base } = await startRelay();
  for (const body of [{ expiry: "burn" }, { expiry: "forever" }, { mode: "broadcast" }]) {
    const r = await fetch(`${base}/api/box/register`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  for (const evil of ["constructor", "toString", "__proto__"]) {
    const r = await fetch(`${base}/api/box/register`, {
      method: "POST",
      body: JSON.stringify({ expiry: evil }),
    });
    assert.equal(r.status, 400, evil);
  }
  // a non-string field is refused on its type, never stringified first
  for (const body of ['{"expiry":{}}', '{"expiry":["30d"]}', '{"mode":5}', "42", "null"]) {
    const r = await fetch(`${base}/api/box/register`, { method: "POST", body });
    assert.equal(r.status, 400, body);
  }
});

test("registration is gated by the relay's upload token when one is set", async () => {
  const { base } = await startRelay({ storeToken: "sekrit" });
  const r = await fetch(`${base}/api/box/register`, { method: "POST", body: "{}" });
  assert.equal(r.status, 401);
  const box = await register(base, {}, "sekrit");
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  assert.equal(
    (await drop(base, box.id, await sealed(recipient, "open door"))).status,
    201,
    "senders still need no account — the link is the capability"
  );
});

// --- acceptance item 18: the two pools do not touch ------------------------

test("a per-box flood is refused without touching the handoff pool", async () => {
  const { base } = await startRelay({ maxDropsPerBox: 2 });
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base);
  assert.equal((await drop(base, box.id, await sealed(recipient, "1"))).status, 201);
  assert.equal((await drop(base, box.id, await sealed(recipient, "2"))).status, 201);
  assert.equal((await drop(base, box.id, await sealed(recipient, "3"))).status, 507);

  const { payload } = await sealHandoff(new TextEncoder().encode("<p>example.md</p>"));
  const stored = await fetch(`${base}/api/store`, {
    method: "POST",
    headers: { "x-handoff-expiry": "7d" },
    body: payload as BodyInit,
  });
  assert.equal(stored.status, 201, "handoffs are unaffected by a full letterbox");
});

test("neither pool can close the other, on one relay", async () => {
  // a handoff ceiling so small that two handoffs do not fit in it
  const { base } = await startRelay({ maxTotalBytes: 150 });
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base);
  const { payload } = await sealHandoff(new TextEncoder().encode("<p>a shared note</p>"));
  const store = () =>
    fetch(`${base}/api/store`, {
      method: "POST",
      headers: { "x-handoff-expiry": "7d" },
      body: payload as BodyInit,
    });

  // a drop far larger than the whole handoff ceiling is stored, not refused
  assert.equal(
    (await drop(base, box.id, await sealed(recipient, "x".repeat(4000)))).status,
    201,
    "the letterbox has its own ceiling"
  );
  assert.equal((await store()).status, 201, "and it did not eat the handoff pool");

  // now the other direction: fill the handoff pool and drop again
  let full = false;
  for (let i = 0; i < 20 && !full; i += 1) full = (await store()).status === 507;
  assert.ok(full, "the handoff pool fills");
  assert.equal(
    (await drop(base, box.id, await sealed(recipient, "still accepted"))).status,
    201,
    "a full handoff pool does not close the letterbox"
  );
});

// --- box lifetime: nothing lives on the relay forever ----------------------

test("a box nobody uses is retired once its idle span passes", async () => {
  const clock = fakeClock();
  const { base, dataDir } = await startRelay({ now: clock.now, boxIdleTtlMs: 86400_000 });
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const idle = await register(base);
  const busy = await register(base);

  clock.advance(86400_000 / 2);
  await drop(base, busy.id, await sealed(recipient, "in use"));
  clock.advance(86400_000 / 2 + 1000);
  // every letterbox operation sweeps first; registering is the cheapest one
  await register(base);

  const boxes = await readdir(join(dataDir, "letterbox"));
  assert.ok(!boxes.includes(idle.id), "the box nobody touched is gone");
  assert.ok(boxes.includes(busy.id), "a box holding a pending drop stays");
  assert.equal((await drops(base, idle)).status, 404);
});

test("a spent one-shot box is cleaned up even when nobody ever collects", async () => {
  const clock = fakeClock();
  const { base, dataDir } = await startRelay({ now: clock.now });
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const box = await register(base, { mode: "one-shot", expiry: "1d" });
  assert.equal((await drop(base, box.id, await sealed(recipient, "once"))).status, 201);

  // the drop ages out unclaimed; the box can never take another one, so it
  // follows its drop off the relay rather than sitting there for the idle span
  clock.advance(86400_000 + 3600_000 + 1000);
  await register(base);
  assert.ok(
    !(await readdir(join(dataDir, "letterbox"))).includes(box.id),
    "the spent box is gone with its ciphertext"
  );
});
