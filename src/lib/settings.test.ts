import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  isAppFile,
  parseDbGrid,
  parseDropHint,
  parseModHud,
  parseShowAppFiles,
  parseTerminalActions,
  parseTerminalSettings,
  terminalActionsToText,
  terminalFontFamily,
  textToTerminalActions,
} from "./settings.ts";

const MONO = "ui-monospace, Menlo, monospace";

test("parseTerminalSettings: reads the terminal keys", () => {
  const s = parseTerminalSettings({
    "terminal-command": " my-agent-cli ",
    "terminal-cwd": "~/Coding/substrate",
    "terminal-height": "0.6",
    "terminal-width": "0.55",
    "terminal-dock": "right",
  });
  assert.equal(s.command, "my-agent-cli");
  assert.equal(s.cwd, "~/Coding/substrate");
  assert.equal(s.height, 0.6);
  assert.equal(s.width, 0.55);
  assert.equal(s.dock, "right");
});

test("parseTerminalSettings: missing keys → empty command/cwd, default geometry", () => {
  const s = parseTerminalSettings({});
  assert.equal(s.command, "");
  assert.equal(s.cwd, "");
  assert.equal(s.dock, "bottom");
  assert.equal(s.height, DEFAULT_TERMINAL_HEIGHT);
  assert.equal(s.width, DEFAULT_TERMINAL_WIDTH);
});

test("parseTerminalSettings: both sizes are read whatever the dock is (SUB-864)", () => {
  // flipping the dock must not need a re-read — each side keeps the size last
  // chosen for it, so both keys parse regardless of which one is in use
  const s = parseTerminalSettings({
    "terminal-dock": "bottom",
    "terminal-height": "0.8",
    "terminal-width": "0.3",
  });
  assert.equal(s.height, 0.8);
  assert.equal(s.width, 0.3);
});

test("parseTerminalSettings: each size is judged by its OWN range (SUB-864)", () => {
  // 0.85 is a fine height and an out-of-range width; the shared-clamp bug
  // would let the width through
  const s = parseTerminalSettings({ "terminal-height": "0.85", "terminal-width": "0.85" });
  assert.equal(s.height, 0.85);
  assert.equal(s.width, DEFAULT_TERMINAL_WIDTH);
});

test("parseTerminalSettings: out-of-band or garbage width falls back (SUB-864)", () => {
  for (const bad of ["7", "0.1", "0.75", "wide", "", null, true]) {
    const s = parseTerminalSettings({ "terminal-width": bad });
    assert.equal(s.width, DEFAULT_TERMINAL_WIDTH, `width ${JSON.stringify(bad)}`);
  }
});

test("parseTerminalSettings: out-of-band or garbage height falls back", () => {
  for (const bad of ["7", "0.1", "0.95", "tall", "", null, true]) {
    const s = parseTerminalSettings({ "terminal-height": bad });
    assert.equal(s.height, DEFAULT_TERMINAL_HEIGHT, `height ${JSON.stringify(bad)}`);
  }
});

test("parseTerminalSettings: YAML-numeric height still parses", () => {
  // frontmatter `terminal-height: 0.5` may arrive as a number, not a string
  const s = parseTerminalSettings({ "terminal-height": 0.5 });
  assert.equal(s.height, 0.5);
});

test("parseTerminalSettings: non-string command is ignored, not stringified", () => {
  const s = parseTerminalSettings({ "terminal-command": ["rm", "-rf"] });
  assert.equal(s.command, "");
});

test("parseTerminalSettings: terminal-font is read and trimmed, absent = empty", () => {
  assert.equal(parseTerminalSettings({}).font, "");
  assert.equal(
    parseTerminalSettings({ "terminal-font": "  JetBrainsMono Nerd Font  " }).font,
    "JetBrainsMono Nerd Font",
  );
  // non-strings are ignored the same way `terminal-command` ignores them
  assert.equal(parseTerminalSettings({ "terminal-font": ["Menlo"] }).font, "");
});

test("terminalFontFamily: empty stays byte-identical to the app's mono chain", () => {
  assert.equal(terminalFontFamily("", MONO), MONO);
  assert.equal(terminalFontFamily("   ", MONO), MONO);
});

test("terminalFontFamily: a single token is used bare, with mono appended", () => {
  assert.equal(terminalFontFamily("Menlo", MONO), `Menlo, ${MONO}`);
});

test("terminalFontFamily: a spaced family name gets quoted", () => {
  assert.equal(
    terminalFontFamily("JetBrainsMono Nerd Font", MONO),
    `"JetBrainsMono Nerd Font", ${MONO}`,
  );
});

test("terminalFontFamily: a user-written chain is normalized name by name", () => {
  assert.equal(
    terminalFontFamily("'Fira Code', Menlo", MONO),
    `"Fira Code", Menlo, ${MONO}`,
  );
  assert.equal(terminalFontFamily('"Hack Nerd Font"', MONO), `"Hack Nerd Font", ${MONO}`);
});

test("terminalFontFamily: typos degrade to mono instead of an invalid declaration", () => {
  // trailing comma, a number in the wrong row, an unbalanced quote — each of
  // these as raw CSS would invalidate the whole rule (proportional fallback)
  assert.equal(terminalFontFamily("Menlo,", MONO), `Menlo, ${MONO}`);
  assert.equal(terminalFontFamily("0.45", MONO), MONO);
  assert.equal(terminalFontFamily('"Hack', MONO), MONO);
  assert.equal(terminalFontFamily("O'Brien Mono", MONO), MONO);
});

test("terminalFontFamily: CSS metacharacters never pass through (vault content is untrusted)", () => {
  // Settings.md syncs/imports; xterm interpolates fontFamily raw into a
  // <style> tag — a brace-carrying value must die at the whitelist, not ship
  assert.equal(terminalFontFamily("A}.dbform-foot{display:none}.x{a:b", MONO), MONO);
  assert.equal(terminalFontFamily("x;background:url(//evil)", MONO), MONO);
  assert.equal(terminalFontFamily("Menlo, A}bad{", MONO), `Menlo, ${MONO}`);
});

test("parseTerminalActions: `Label: command` entries, in order (SUB-441)", () => {
  const a = parseTerminalActions({
    "terminal-actions": ["Sweep inbox: /inbox-sweep", " Log calories : /cal "],
  });
  assert.deepEqual(a, [
    { label: "Sweep inbox", command: "/inbox-sweep" },
    { label: "Log calories", command: "/cal" },
  ]);
});

test("parseTerminalActions: a bare command labels itself", () => {
  assert.deepEqual(parseTerminalActions({ "terminal-actions": ["/standup"] }), [
    { label: "/standup", command: "/standup" },
  ]);
});

test("parseTerminalActions: a colon inside the command survives", () => {
  assert.deepEqual(parseTerminalActions({ "terminal-actions": ["Deploy: sh -c 'a: b'"] }), [
    { label: "Deploy", command: "sh -c 'a: b'" },
  ]);
});

test("parseTerminalActions: a lone string is one action", () => {
  assert.deepEqual(parseTerminalActions({ "terminal-actions": "Cal: /cal" }), [
    { label: "Cal", command: "/cal" },
  ]);
});

test("parseTerminalActions: unset or unusable entries yield no rows", () => {
  // the whole point of the key (SUB-441): a machine that lists nothing gets
  // no quick-action rows at all, rather than someone else's
  assert.deepEqual(parseTerminalActions({}), []);
  assert.deepEqual(parseTerminalActions({ "terminal-actions": 7 }), []);
  assert.deepEqual(
    parseTerminalActions({ "terminal-actions": ["", "   ", ": /cal", "Label:", 3, null] }),
    []
  );
});

test("parseTerminalActions: an unquoted `Label: command` entry is a YAML map (SUB-476)", () => {
  // docs/vault-format.md documents the format as `Label: command`; written
  // unquoted, YAML hands us a single-pair map rather than a string
  assert.deepEqual(parseTerminalActions({ "terminal-actions": [{ "Sweep inbox": "/inbox-sweep" }] }), [
    { label: "Sweep inbox", command: "/inbox-sweep" },
  ]);
  // multi-pair maps and non-string values stay unreadable, as before
  assert.deepEqual(parseTerminalActions({ "terminal-actions": [{ a: "1", b: "2" }, { c: 3 }] }), []);
});

test("terminalActionsToText: list → one entry per line (SUB-476)", () => {
  assert.equal(
    terminalActionsToText(["Sweep inbox: /inbox-sweep", "Log calories: /cal"]),
    "Sweep inbox: /inbox-sweep\nLog calories: /cal"
  );
  // a scalar is one line; unset or non-string entries contribute nothing
  assert.equal(terminalActionsToText("Cal: /cal"), "Cal: /cal");
  assert.equal(terminalActionsToText(undefined), "");
  assert.equal(terminalActionsToText(7), "");
  assert.equal(terminalActionsToText(["Cal: /cal", 3, null]), "Cal: /cal");
});

test("terminalActionsToText: a map-shaped entry survives the box (SUB-476)", () => {
  // it used to be filtered out here, and the next commit wrote the box back
  // without it — deleting a row the user never touched
  assert.equal(
    terminalActionsToText([{ "Sweep inbox": "/inbox-sweep" }, "Cal: /cal"]),
    "Sweep inbox: /inbox-sweep\nCal: /cal"
  );
});

test("textToTerminalActions: lines → list, trimmed, empties dropped (SUB-476)", () => {
  assert.deepEqual(textToTerminalActions("  Cal: /cal  \n\n  Inbox: /inbox-sweep\n  \n"), [
    "Cal: /cal",
    "Inbox: /inbox-sweep",
  ]);
  assert.deepEqual(textToTerminalActions("   \n\n"), []);
});

test("terminal actions survive the form round trip unchanged (SUB-476)", () => {
  // the form stays dumb: what parseTerminalActions would reject still comes
  // back out of the box verbatim, so a half-typed line isn't eaten
  const stored = ["Cal: /cal", "bare-command", "Label:"];
  assert.deepEqual(textToTerminalActions(terminalActionsToText(stored)), stored);
});

test("parseDropHint: only an explicit false hides the hint (SUB-438)", () => {
  // YAML `drop-hint: false` may arrive as a boolean or a string
  assert.equal(parseDropHint({ "drop-hint": false }), false);
  assert.equal(parseDropHint({ "drop-hint": "false" }), false);
  assert.equal(parseDropHint({ "drop-hint": " FALSE " }), false);
  // unset, true, or garbage all keep the affordance discoverable
  assert.equal(parseDropHint({}), true);
  assert.equal(parseDropHint({ "drop-hint": true }), true);
  assert.equal(parseDropHint({ "drop-hint": "true" }), true);
  assert.equal(parseDropHint({ "drop-hint": "off" }), true);
  assert.equal(parseDropHint({ "drop-hint": 0 }), true);
});

test("parseModHud: only an explicit false disables the hold HUD (SUB-490)", () => {
  assert.equal(parseModHud({ "mod-hud": false }), false);
  assert.equal(parseModHud({ "mod-hud": "false" }), false);
  assert.equal(parseModHud({ "mod-hud": " FALSE " }), false);
  // default ON: an unset key, `true`, or a typo all keep the HUD armed
  assert.equal(parseModHud({}), true);
  assert.equal(parseModHud({ "mod-hud": true }), true);
  assert.equal(parseModHud({ "mod-hud": "yes" }), true);
});

test("parseDbGrid: only an explicit false turns table grid lines off (SUB-607)", () => {
  assert.equal(parseDbGrid({ "db-grid": false }), false);
  assert.equal(parseDbGrid({ "db-grid": "false" }), false);
  assert.equal(parseDbGrid({ "db-grid": " FALSE " }), false);
  // default ON: an unset key, `true`, or a typo all keep the grid drawn
  assert.equal(parseDbGrid({}), true);
  assert.equal(parseDbGrid({ "db-grid": true }), true);
  assert.equal(parseDbGrid({ "db-grid": "off" }), true);
});

test("parseShowAppFiles: only an explicit true reveals the app files (SUB-831)", () => {
  // the inverse rule of the other bools: the blank slate is the default, so
  // an unset key, garbage, or `false` in any casing all keep them concealed.
  // The key keeps its pre-SUB-878 name so existing vaults stay revealed.
  assert.equal(parseShowAppFiles({ "show-agent-files": true }), true);
  assert.equal(parseShowAppFiles({ "show-agent-files": "true" }), true);
  assert.equal(parseShowAppFiles({ "show-agent-files": " TRUE " }), true);
  assert.equal(parseShowAppFiles({}), false);
  assert.equal(parseShowAppFiles({ "show-agent-files": false }), false);
  assert.equal(parseShowAppFiles({ "show-agent-files": "false" }), false);
  assert.equal(parseShowAppFiles({ "show-agent-files": "yes" }), false);
  assert.equal(parseShowAppFiles({ "show-agent-files": 1 }), false);
});

test("isAppFile: exact root names only (SUB-831, SUB-878)", () => {
  assert.equal(isAppFile("AGENTS.md"), true);
  assert.equal(isAppFile("CLAUDE.md"), true);
  // SUB-878: the settings note behind the ⌘, sheet is app chrome too
  assert.equal(isAppFile("Settings.md"), true);
  // a user's own note that happens to share a stem, or a nested copy, is
  // ordinary content — concealment is about the seeded root files
  assert.equal(isAppFile("agents.md"), false);
  assert.equal(isAppFile("Notes/AGENTS.md"), false);
  assert.equal(isAppFile("AGENTS notes.md"), false);
  assert.equal(isAppFile("settings.md"), false);
  assert.equal(isAppFile("Notes/Settings.md"), false);
});
