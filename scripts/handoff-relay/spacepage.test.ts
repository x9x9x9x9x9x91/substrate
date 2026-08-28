import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHandoffRelay } from "./serve.ts";
import { KEY_BYTES, openHandoff, sealHandoffWith, toBase64Url } from "../../src/lib/handoff.ts";

/** The folder routes: what `/f/` and `/e/` serve, and the round trip a shared
    space actually makes — an index sealed under the link's key, each note
    sealed under its own, and the whole of it opaque to the relay. */

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function startRelay(opts: { letterboxDisabled?: boolean; lensDisabled?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "space-relay-"));
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
  return { base: `http://127.0.0.1:${port}` };
}

function keyOf(seed: number): string {
  return toBase64Url(new Uint8Array(KEY_BYTES).map((_, i) => (i * seed + 7) % 256));
}

async function register(base: string) {
  const r = await fetch(`${base}/api/lens/register`, { method: "POST" });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()) as { id: string; token: string };
}

async function publish(base: string, id: string, token: string, key: string, text: string) {
  const { payload } = await sealHandoffWith(key, new TextEncoder().encode(text));
  const r = await fetch(`${base}/api/lens/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: payload,
  });
  assert.equal(r.status, 200, await r.clone().text());
}

test("the folder page is served for a well-formed slug on both prefixes", async () => {
  const { base } = await startRelay();
  const { id } = await register(base);
  for (const prefix of ["f", "e"]) {
    const page = await fetch(`${base}/${prefix}/${id}`);
    assert.equal(page.status, 200, prefix);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await page.text();
    assert.match(html, /Decrypting locally/);
    // the page's own class prefix, not the single-note viewer's
    assert.match(html, /\.sl-item/);
  }
});

test("the folder page never carries a slug, a key or an index", async () => {
  // the relay serves one static page for every folder: whatever it holds, it
  // does not hold anything that identifies whose folder is being opened
  const { base } = await startRelay();
  const { id } = await register(base);
  const html = await (await fetch(`${base}/f/${id}`)).text();
  assert.ok(!html.includes(id), "the served page names the slug");
});

test("the editable prefix is refused when the letterbox is off", async () => {
  // an edit is a drop; a page offering to send one into a door that is shut
  // would be a promise the relay cannot keep
  const { base } = await startRelay({ letterboxDisabled: true });
  const { id } = await register(base);
  assert.equal((await fetch(`${base}/f/${id}`)).status, 200);
  assert.equal((await fetch(`${base}/e/${id}`)).status, 404);
});

test("both folder prefixes are gone when the lens tier is off", async () => {
  const { base } = await startRelay({ lensDisabled: true });
  assert.equal((await fetch(`${base}/f/abcdefabcdefabcdefabcdef`)).status, 404);
  assert.equal((await fetch(`${base}/e/abcdefabcdefabcdefabcdef`)).status, 404);
});

test("an index and its notes round-trip under separate keys", async () => {
  const { base } = await startRelay();
  const indexSlug = await register(base);
  const noteSlug = await register(base);
  const indexKey = keyOf(11);
  const noteKey = keyOf(13);

  const note = {
    v: 1,
    title: "Trip",
    html: "<h1>Trip</h1>",
    body: "the body\n",
    base: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  await publish(base, noteSlug.id, noteSlug.token, noteKey, JSON.stringify(note));
  const index = {
    v: 1,
    space: "space-1",
    name: "Trip planning",
    stamp: "14:02 · 28 Aug 2026 (UTC+2)",
    notes: [{ id: noteSlug.id, title: "Trip", key: noteKey }],
  };
  await publish(base, indexSlug.id, indexSlug.token, indexKey, JSON.stringify(index));

  // what the page does: fetch the index with the fragment key, then each note
  // with the key the index carried
  const sealedIndex = new Uint8Array(await (await fetch(`${base}/api/lens/${indexSlug.id}`)).arrayBuffer());
  const opened = JSON.parse(new TextDecoder().decode(await openHandoff(sealedIndex, indexKey)));
  assert.equal(opened.name, "Trip planning");
  const sealedNote = new Uint8Array(
    await (await fetch(`${base}/api/lens/${opened.notes[0].id}`)).arrayBuffer()
  );
  const readBack = JSON.parse(
    new TextDecoder().decode(await openHandoff(sealedNote, opened.notes[0].key))
  );
  assert.equal(readBack.body, "the body\n");

  // and the index's key opens nothing but the index
  await assert.rejects(() => openHandoff(sealedNote, indexKey));
});

test("nothing about a folder reaches the relay in the clear", async () => {
  const { base } = await startRelay();
  const indexSlug = await register(base);
  const indexKey = keyOf(17);
  await publish(
    base,
    indexSlug.id,
    indexSlug.token,
    indexKey,
    JSON.stringify({ v: 1, space: "space-1", name: "Rehearsal notes", notes: [] })
  );
  const bytes = new Uint8Array(await (await fetch(`${base}/api/lens/${indexSlug.id}`)).arrayBuffer());
  const asText = new TextDecoder("latin1").decode(bytes);
  assert.ok(!asText.includes("Rehearsal"), "a folder name reached the relay readable");
  assert.ok(!asText.includes("space-1"), "a space id reached the relay readable");
});
