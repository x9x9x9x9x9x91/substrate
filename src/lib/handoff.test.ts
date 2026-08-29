import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_MAGIC,
  KEY_BYTES,
  buildHandoffDocument,
  docCss,
  SHIPPED_PAPER_ACCENT,
  buildHandoffLink,
  fromBase64Url,
  openHandoff,
  parseShareRelayUrl,
  HOSTED_HANDOFF_RELAY_URL,
  sealHandoff,
  toBase64Url,
} from "./handoff.ts";

test("base64url round-trips arbitrary bytes without padding", () => {
  for (const len of [0, 1, 2, 3, 31, 32, 33]) {
    const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 251) % 256);
    const s = toBase64Url(bytes);
    assert.ok(!s.includes("="), "no padding");
    assert.ok(!s.includes("+") && !s.includes("/"), "url-safe alphabet");
    assert.deepEqual(fromBase64Url(s), bytes);
  }
});

test("fromBase64Url rejects non-base64url input", () => {
  assert.throws(() => fromBase64Url("has/slash"));
  assert.throws(() => fromBase64Url("has+plus"));
  assert.throws(() => fromBase64Url("pad=="));
});

test("seal → open round-trips, and payload carries magic + version", async () => {
  const pt = new TextEncoder().encode("<!doctype html><p>press one-sheet</p>");
  const { payload, keyB64 } = await sealHandoff(pt);
  assert.equal(new TextDecoder().decode(payload.slice(0, 4)), HANDOFF_MAGIC);
  assert.equal(fromBase64Url(keyB64).length, KEY_BYTES);
  const back = await openHandoff(payload, keyB64);
  assert.deepEqual(back, pt);
});

test("ciphertext reveals nothing of the plaintext and differs per seal", async () => {
  const pt = new TextEncoder().encode("SECRET-TRACKLIST-CONTENT");
  const a = await sealHandoff(pt);
  const b = await sealHandoff(pt);
  const ascii = (u: Uint8Array) => new TextDecoder("latin1").decode(u);
  assert.ok(!ascii(a.payload).includes("SECRET-TRACKLIST-CONTENT"));
  assert.notDeepEqual(a.payload, b.payload, "fresh key+IV per send");
  assert.notEqual(a.keyB64, b.keyB64);
});

test("open with the wrong key fails loudly, not with garbage output", async () => {
  const { payload } = await sealHandoff(new TextEncoder().encode("x"));
  const wrong = toBase64Url(new Uint8Array(KEY_BYTES));
  await assert.rejects(() => openHandoff(payload, wrong), /decrypt failed/);
});

test("open rejects a non-handoff payload by magic before touching the key", async () => {
  const junk = new TextEncoder().encode("PK\x03\x04 definitely a zip");
  await assert.rejects(
    () => openHandoff(junk, toBase64Url(new Uint8Array(KEY_BYTES))),
    /not a handoff payload/
  );
});

test("open rejects a truncated key", async () => {
  const { payload } = await sealHandoff(new TextEncoder().encode("x"));
  await assert.rejects(() => openHandoff(payload, toBase64Url(new Uint8Array(16))), /key length/);
});

test("link puts the key in the fragment and never doubles slashes", () => {
  assert.equal(
    buildHandoffLink("https://relay.example/", "abc123", "KEY"),
    "https://relay.example/h/abc123#KEY"
  );
  const url = new URL(buildHandoffLink("https://relay.example", "abc123", "KEY"));
  assert.equal(url.hash, "#KEY");
  assert.equal(url.pathname, "/h/abc123");
});

test("document is standalone html with escaped title and rendered body", () => {
  const html = buildHandoffDocument({
    title: 'Master notes <v2> & "final"',
    propsLine: "type: note",
    body: "## Tracklist\n\n1. opener",
    assetSrc: () => undefined,
  });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /<style>/);
  assert.ok(!html.includes("<v2>"), "title escaped");
  assert.match(html, /Master notes &lt;v2&gt;/);
  assert.match(html, /<h2>Tracklist<\/h2>/);
  assert.match(html, /<ol><li>opener<\/li><\/ol>/);
});

test("the document sheet paints its accent as a literal at a paper weight", () => {
  // the recipient's browser has none of the app's CSS, so a token reference in
  // this sheet would resolve to nothing; and the page is white, so the screen
  // family's light weights would be the wrong end of the family
  const sheet = docCss();
  // `--columns` is the exception that proves the rule: the document's own
  // markup sets it inline on every column row, so it resolves in a browser
  // that has never seen the app. Every OTHER var() would resolve to nothing.
  assert.ok(
    !sheet.replace(/var\(--columns, 1\)/g, "").includes("var(--"),
    "the standalone sheet leans on an app token"
  );
  assert.match(sheet, /a \{ color: #14597a; \}/);
  assert.match(sheet, /\.print-link \{ color: #14597a; \}/);
  assert.match(sheet, /\.print-task\.done \.print-box \{ background: #14597a;/);
  // the same sheet takes whatever family the author is wearing, which is what
  // a document built inside the app hands it
  assert.match(docCss("#4a2f7a"), /\.print-link \{ color: #4a2f7a; \}/);
});

test("a document built with no app around it carries the shipped family", () => {
  // node has no document to read the live tone out of — the fallback is the
  // shipped default, never a broken colour string
  const html = buildHandoffDocument({
    title: "t",
    propsLine: "",
    body: "x",
    assetSrc: () => undefined,
  });
  assert.ok(html.includes(`a { color: ${SHIPPED_PAPER_ACCENT}; }`));
});

test("document inlines image embeds via assetSrc", () => {
  const html = buildHandoffDocument({
    title: "t",
    propsLine: "",
    body: "![[cover.png]]",
    assetSrc: (n) => (n === "cover.png" ? "data:image/png;base64,AAAA" : undefined),
  });
  assert.match(html, /<img src="data:image\/png;base64,AAAA"/);
});

test("share-relay-url defaults hosted, preserves custom URLs, and honors opt-out", () => {
  assert.equal(parseShareRelayUrl({ "share-relay-url": "https://s.zone/" }), "https://s.zone");
  assert.equal(parseShareRelayUrl({ "share-relay-url": " http://my.box:8787 " }), "http://my.box:8787");
  assert.equal(parseShareRelayUrl({}), HOSTED_HANDOFF_RELAY_URL);
  assert.equal(parseShareRelayUrl({ "share-relay-url": "off" }), "");
  assert.equal(parseShareRelayUrl({ "share-relay-url": "disabled" }), "");
  assert.equal(parseShareRelayUrl({ "share-relay-url": "" }), "");
  assert.equal(parseShareRelayUrl({ "share-relay-url": "ftp://nope" }), "");
  assert.equal(parseShareRelayUrl({ "share-relay-url": 7 }), "");
});
