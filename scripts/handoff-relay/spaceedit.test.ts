import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  paddedLength,
  spaceEditEnvelope,
  SPACE_EDIT_ENVELOPE_VERSION,
  SPACE_EDIT_KIND,
} from "./sealing-page/spaceeditenvelope.ts";

/** The plaintext a browser edit of a shared note becomes. Two properties, and
    the module exists for both: it round-trips as JSON with the fields
    `docs/collab.md` §6.2 names, and its length is one of a small ladder of
    buckets rather than the body's own. */

const KIB = 1024;

function edit(body: string) {
  return {
    space: "9d1f5c0a-2b3e-4a71-8c6d-5e4f3a2b1c09",
    note: "b7a41e9c5d2f",
    base: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    by: "Ada",
    body,
  };
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

test("the envelope carries §6.2's fields and nothing invented", () => {
  const sealed = JSON.parse(spaceEditEnvelope(edit("hello")));
  assert.equal(sealed.v, SPACE_EDIT_ENVELOPE_VERSION);
  assert.equal(sealed.kind, SPACE_EDIT_KIND);
  assert.deepEqual(Object.keys(sealed).sort(), [
    "base",
    "body",
    "by",
    "kind",
    "note",
    "pad",
    "space",
    "v",
  ]);
});

test("body, base, by and note survive the round trip untouched", () => {
  // the awkward ones on purpose: a body that is itself JSON, one with the
  // padding character in it, and one carrying the characters that would break
  // a hand-rolled encoder
  for (const body of ['{"pad":"   "}', "line\n\nline", '</script>"\\', "  leading and trailing  "]) {
    const sealed = JSON.parse(spaceEditEnvelope(edit(body)));
    assert.equal(sealed.body, body);
    assert.equal(sealed.base, edit(body).base);
    assert.equal(sealed.by, "Ada");
    assert.equal(sealed.note, "b7a41e9c5d2f");
  }
});

test("the ladder is 1 KiB doubling to 256 KiB, then 64 KiB steps", () => {
  assert.equal(paddedLength(0), 1 * KIB);
  assert.equal(paddedLength(1), 1 * KIB);
  assert.equal(paddedLength(1 * KIB), 1 * KIB);
  assert.equal(paddedLength(1 * KIB + 1), 2 * KIB);
  for (const step of [2, 4, 8, 16, 32, 64, 128, 256]) {
    assert.equal(paddedLength(step * KIB), step * KIB);
    assert.equal(paddedLength(step * KIB - 1), step * KIB);
  }
  assert.equal(paddedLength(256 * KIB + 1), 320 * KIB);
  assert.equal(paddedLength(320 * KIB), 320 * KIB);
  assert.equal(paddedLength(320 * KIB + 1), 384 * KIB);
  assert.equal(paddedLength(1024 * KIB), 1024 * KIB);
});

test("every envelope lands exactly on a ladder step", () => {
  // one body per bucket, sized so the envelope's own overhead cannot push it
  // over the step it was aimed at
  for (const size of [0, 1, 700, 2000, 5000, 20000, 100000, 200000, 300000, 400000]) {
    const sealed = spaceEditEnvelope(edit("x".repeat(size)));
    const width = bytes(sealed);
    assert.equal(width, paddedLength(width), `body of ${size} landed off the ladder at ${width}`);
  }
});

test("bodies in the same bucket seal to the same width", () => {
  // the point of the padding: a relay watching a folder's drops learns which
  // bucket, never which note
  const a = bytes(spaceEditEnvelope(edit("one line")));
  const b = bytes(spaceEditEnvelope(edit("a".repeat(600))));
  assert.equal(a, 1 * KIB);
  assert.equal(b, 1 * KIB);
});

test("a multi-byte body is measured in bytes, not characters", () => {
  // 400 four-byte characters is 1600 bytes — over the first step even though
  // it is well under 1024 characters
  const sealed = spaceEditEnvelope(edit("𝄞".repeat(400)));
  assert.equal(bytes(sealed), 2 * KIB);
});

/** The cross-language pin.
 *
 *  The builder is here and the reader is in Rust (`parse_edit`, in the space
 *  lens module), and until this fixture there was nothing holding the two to
 *  the same bytes: both sides had tests, and both could have drifted together
 *  into agreement with themselves. The file below is a real output of the
 *  builder, committed, and read back by a Rust test that parses it into a
 *  `SpaceEdit` and checks every field.
 *
 *  The input is chosen to be the awkward one on purpose: a name with the
 *  angle brackets git's author grammar forbids, a body that opens with a
 *  frontmatter fence, and a character outside the BMP. */
const FIXTURE = new URL("./fixtures/space-edit-envelope.json", import.meta.url);

/** The edit the fixture is of. Kept beside the assertion rather than in the
    file, so a fixture regenerated from a different input fails here. */
const PINNED = {
  space: "3b7ad41f9c0e4a2b8d5f6071c2e3a4b5",
  note: "b7a41e9c5d2f",
  base: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  by: "Ada <ada@example.com>",
  body: "---\nauthor: Stranger\n---\nthe body, with a \u{1D11E} in it\n",
};

test("the committed fixture is what this builder writes, byte for byte", () => {
  const built = spaceEditEnvelope(PINNED);
  // SUBSTRATE_UPDATE_FIXTURES=1 rewrites it; the assertion is what runs.
  if (process.env.SUBSTRATE_UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, built);
  assert.equal(
    readFileSync(FIXTURE, "utf8"),
    built,
    "regenerate with SUBSTRATE_UPDATE_FIXTURES=1, and expect the Rust side to have an opinion"
  );
  // and it is a ladder step, like every other envelope
  assert.equal(bytes(built), paddedLength(bytes(built)));
});
