import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TERMINAL_HEIGHT,
  isAgentFile,
  parseDbGrid,
  parseDropHint,
  parseModHud,
  parseShowAgentFiles,
  parseTerminalActions,
  parseTerminalSettings,
  terminalActionsToText,
  textToTerminalActions,
} from "./settings.ts";

test("parseTerminalSettings: reads the three terminal keys", () => {
  const s = parseTerminalSettings({
    "terminal-command": " my-agent-cli ",
    "terminal-cwd": "~/Coding/substrate",
    "terminal-height": "0.6",
  });
  assert.equal(s.command, "my-agent-cli");
  assert.equal(s.cwd, "~/Coding/substrate");
  assert.equal(s.height, 0.6);
});

test("parseTerminalSettings: missing keys → empty command/cwd, default height", () => {
  const s = parseTerminalSettings({});
  assert.equal(s.command, "");
  assert.equal(s.cwd, "");
  assert.equal(s.height, DEFAULT_TERMINAL_HEIGHT);
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

test("parseShowAgentFiles: only an explicit true reveals the agent files (SUB-831)", () => {
  // the inverse rule of the other bools: the blank slate is the default, so
  // an unset key, garbage, or `false` in any casing all keep them concealed
  assert.equal(parseShowAgentFiles({ "show-agent-files": true }), true);
  assert.equal(parseShowAgentFiles({ "show-agent-files": "true" }), true);
  assert.equal(parseShowAgentFiles({ "show-agent-files": " TRUE " }), true);
  assert.equal(parseShowAgentFiles({}), false);
  assert.equal(parseShowAgentFiles({ "show-agent-files": false }), false);
  assert.equal(parseShowAgentFiles({ "show-agent-files": "false" }), false);
  assert.equal(parseShowAgentFiles({ "show-agent-files": "yes" }), false);
  assert.equal(parseShowAgentFiles({ "show-agent-files": 1 }), false);
});

test("isAgentFile: exact root names only (SUB-831)", () => {
  assert.equal(isAgentFile("AGENTS.md"), true);
  assert.equal(isAgentFile("CLAUDE.md"), true);
  // a user's own note that happens to share a stem, or a nested copy, is
  // ordinary content — concealment is about the two seeded root files
  assert.equal(isAgentFile("agents.md"), false);
  assert.equal(isAgentFile("Notes/AGENTS.md"), false);
  assert.equal(isAgentFile("AGENTS notes.md"), false);
  assert.equal(isAgentFile("Settings.md"), false);
});
