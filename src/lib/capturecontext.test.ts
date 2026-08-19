import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contextChipIcon,
  contextChipLabel,
  contextProps,
  type CaptureContext,
} from "./capturecontext.ts";

const ctx = (over: Partial<CaptureContext>): CaptureContext => ({
  app: "Safari",
  doc: null,
  file: null,
  ...over,
});

test("an open file names itself, not the four folders above it", () => {
  const c = ctx({
    app: "Ableton Live 12 Suite",
    file: "/Users/a/Music/My Track/My Track.als",
    doc: null,
  });
  assert.equal(contextChipLabel(c), "My Track.als");
  assert.equal(contextChipIcon(c), "⏺");
});

test("without a file the chip is the app, plus what it was showing", () => {
  assert.equal(contextChipLabel(ctx({ doc: "Hyperdub — Releases" })), "Safari — Hyperdub — Releases");
  assert.equal(contextChipLabel(ctx({})), "Safari");
  assert.equal(contextChipIcon(ctx({})), "⌁");
  // an app-less snapshot never reaches the window, but a blank one must not
  // render as a lone em dash if it ever did
  assert.equal(contextChipLabel(ctx({ app: "  ", doc: "Notes" })), "Notes");
});

test("the filed props are flat context-* keys, blanks dropped", () => {
  assert.deepEqual(contextProps(ctx({ doc: " Releases " })), [
    ["context-app", "Safari"],
    ["context-doc", "Releases"],
  ]);
  assert.deepEqual(
    contextProps(
      ctx({
        app: "Ableton Live 12 Suite",
        file: "/Users/a/Music/My Track.als",
      })
    ),
    [
      ["context-app", "Ableton Live 12 Suite"],
      ["context-file", "/Users/a/Music/My Track.als"],
    ]
  );
  // nothing readable → nothing written, rather than empty frontmatter rows
  assert.deepEqual(contextProps(ctx({ app: "", doc: "  ", file: "" })), []);
});

test("none of the keys collide with the engine-owned frontmatter", () => {
  const keys = contextProps(
    ctx({ doc: "Releases", file: "/Users/a/Music/My Track.als" })
  ).map(([k]) => k);
  assert.deepEqual(keys, ["context-app", "context-doc", "context-file"]);
  for (const reserved of ["created", "type", "title"]) {
    assert.ok(!keys.includes(reserved));
  }
});
