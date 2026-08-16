import { test } from "node:test";
import assert from "node:assert/strict";
import { hotkeyLabel, hotkeyRejectedMessage } from "./hotkey.ts";

// The toast is the only surface that says a typed capture-hotkey
// didn't take AND which chord still fires — pin both halves of the copy.

test("hotkeyLabel: modifier vocabulary in canonical glyph order", () => {
  assert.equal(hotkeyLabel("alt+space"), "⌥Space");
  assert.equal(hotkeyLabel("cmd+shift+j"), "⌘⇧J");
  assert.equal(hotkeyLabel("shift+alt+space"), "⌥⇧Space"); // stored order ≠ display order
  assert.equal(hotkeyLabel("ctrl+alt+delete"), "⌃⌥⌦");
  assert.equal(hotkeyLabel("command+option+k"), "⌘⌥K"); // parser aliases
});

test("hotkeyLabel: unknown modifier or empty key falls back to the raw chord", () => {
  assert.equal(hotkeyLabel("opt+space"), "opt+space"); // a chord that won't parse stays as typed
  assert.equal(hotkeyLabel(""), "");
  assert.equal(hotkeyLabel("shift+"), "shift+");
});

test("hotkeyRejectedMessage: parse-invalid names the typed chord and the live one", () => {
  assert.equal(
    hotkeyRejectedMessage({ kind: "invalid", typed: "opt+space", active: "alt+space" }),
    "Hotkey “opt+space” isn’t valid — still using “⌥Space”."
  );
});

test("hotkeyRejectedMessage: OS-taken names both chords", () => {
  assert.equal(
    hotkeyRejectedMessage({ kind: "unavailable", typed: "cmd+j", active: "alt+shift+space" }),
    "Hotkey “⌘J” is taken by another app — still using “⌥⇧Space”."
  );
});

// Both global chords ride one event, so a refused voice chord
// has to read as a voice problem — otherwise it sends the user to the wrong
// settings row.
test("hotkeyRejectedMessage: a refused voice chord names voice, not quick capture", () => {
  assert.equal(
    hotkeyRejectedMessage({ kind: "unavailable", typed: "alt+shift+space", active: "cmd+shift+v", which: "voice" }),
    "Voice hotkey “⌥⇧Space” is taken by another app — still using “⌘⇧V”."
  );
  assert.equal(
    hotkeyRejectedMessage({ kind: "invalid", typed: "opt+v", active: "", which: "voice" }),
    "Voice hotkey “opt+v” isn’t valid — voice notes have no working hotkey."
  );
  // the capture chord keeps its wording, named or not
  assert.equal(
    hotkeyRejectedMessage({ kind: "invalid", typed: "ctl+j", active: "", which: "capture" }),
    "Hotkey “ctl+j” isn’t valid — quick capture has no working hotkey."
  );
});

test("hotkeyRejectedMessage: no live chord says so instead of quoting an empty one", () => {
  assert.equal(
    hotkeyRejectedMessage({ kind: "invalid", typed: "ctl+j", active: "" }),
    "Hotkey “ctl+j” isn’t valid — quick capture has no working hotkey."
  );
  assert.equal(
    hotkeyRejectedMessage({ kind: "unavailable", typed: "alt+space", active: "  " }),
    "Hotkey “⌥Space” is taken by another app — quick capture has no working hotkey."
  );
});
