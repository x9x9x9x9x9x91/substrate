import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  isAppFile,
  missingTerminalFonts,
  netAllowed,
  parseAutoSync,
  parseDbGrid,
  parseTaskStaleChips,
  parseDropHint,
  parseFeedTopics,
  parseFeedCurator,
  parseModHud,
  parseShowAppFiles,
  parseTerminalActions,
  parseTerminalSettings,
  parseUpcomingDock,
  parseWindowOpacity,
  terminalActionsToText,
  terminalFontFamily,
  textToTerminalActions,
} from "./settings.ts";
import { parseShareRelayUrl } from "./handoff.ts";

const MONO = "ui-monospace, Menlo, monospace";

test("parseFeedCurator: the trimmed command, cased key folded, else empty", () => {
  assert.equal(parseFeedCurator({ "feed-curator": "  ~/scripts/curate.sh " }), "~/scripts/curate.sh");
  assert.equal(parseFeedCurator({ "Feed-Curator": "curate" }), "curate");
  assert.equal(parseFeedCurator({}), "");
  // a non-string is a typo'd note, not a command to run
  assert.equal(parseFeedCurator({ "feed-curator": 3 }), "");
  assert.equal(parseFeedCurator({ "feed-curator": ["a", "b"] }), "");
});

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

test("settings keys read case-folded — Settings.md is hand-editable (SUB-924)", () => {
  const t = parseTerminalSettings({
    "Terminal-Command": "claude",
    "Terminal-Cwd": "~",
    "Terminal-Dock": "right",
    "Terminal-Height": "0.6",
    "Terminal-Width": "0.5",
    "Terminal-Font": "JetBrainsMono Nerd Font",
  });
  assert.equal(t.command, "claude");
  assert.equal(t.cwd, "~");
  assert.equal(t.dock, "right");
  assert.equal(t.height, 0.6);
  assert.equal(t.width, 0.5);
  assert.equal(t.font, "JetBrainsMono Nerd Font");

  assert.equal(parseDropHint({ "Drop-Hint": "false" }), false);
  assert.equal(parseModHud({ "Mod-HUD": "false" }), false);
  assert.equal(parseDbGrid({ "DB-Grid": "false" }), false);
  assert.equal(parseShowAppFiles({ "Show-Agent-Files": "true" }), true);

  assert.deepEqual(parseTerminalActions({ "Terminal-Actions": ["Cal: /cal"] }), [
    { label: "Cal", command: "/cal" },
  ]);

  // the share-relay pair lives in the same hand-edited Settings.md
  assert.equal(
    parseShareRelayUrl({ "Share-Relay-URL": "https://relay.example/" }),
    "https://relay.example"
  );
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

/* The hint on the settings row. `isAvailable` is stubbed here — in
   the app the pane measures the family against the generic bases on a canvas
   (widths move when the family is really installed). */
const installed = (...names: string[]) => (f: string) => names.includes(f);
const NONE = { missing: [], unusable: [] };

test("missingTerminalFonts: a resolving family reports nothing", () => {
  assert.deepEqual(missingTerminalFonts("Menlo", installed("Menlo")), NONE);
  assert.deepEqual(
    missingTerminalFonts("'JetBrainsMono Nerd Font'", installed("JetBrainsMono Nerd Font")),
    NONE
  );
});

test("missingTerminalFonts: an uninstalled family is reported as typed", () => {
  assert.deepEqual(missingTerminalFonts("JetBrainsMone Nerd Font", installed("Menlo")), {
    missing: ["JetBrainsMone Nerd Font"],
    unusable: [],
  });
});

test("missingTerminalFonts: a mixed chain reports only the families that fail", () => {
  assert.deepEqual(missingTerminalFonts("Fira Code, Menlo, Nope", installed("Menlo")), {
    missing: ["Fira Code", "Nope"],
    unusable: [],
  });
});

test("missingTerminalFonts: whitelist-dropped garbage lands in `unusable`, not `missing`", () => {
  // available() says yes to everything: these are reported because the
  // normalization drops them, not because they're uninstalled — and the pane
  // words them differently (Font Book can't help you find "0.45")
  const yes = () => true;
  assert.deepEqual(missingTerminalFonts("A}bad{", yes), { missing: [], unusable: ["A}bad{"] });
  assert.deepEqual(missingTerminalFonts("O'Brien Mono", yes), {
    missing: [],
    unusable: ["O'Brien Mono"],
  });
  assert.deepEqual(missingTerminalFonts("0.45", yes), { missing: [], unusable: ["0.45"] });
  assert.deepEqual(missingTerminalFonts("Menlo, A}bad{", installed("Menlo")), {
    missing: [],
    unusable: ["A}bad{"],
  });
});

test("missingTerminalFonts: the two causes are reported side by side", () => {
  assert.deepEqual(missingTerminalFonts("Nope, 0.45, Menlo", installed("Menlo")), {
    missing: ["Nope"],
    unusable: ["0.45"],
  });
});

test("missingTerminalFonts: generic keywords are never reported", () => {
  const no = () => false;
  for (const g of ["monospace", "sans-serif", "serif", "ui-monospace", "Monospace"]) {
    assert.deepEqual(missingTerminalFonts(g, no), NONE, g);
  }
  assert.deepEqual(missingTerminalFonts("Nope, monospace", no), {
    missing: ["Nope"],
    unusable: [],
  });
});

test("missingTerminalFonts: an empty or punctuation-only setting reports nothing", () => {
  const no = () => false;
  assert.deepEqual(missingTerminalFonts("", no), NONE);
  assert.deepEqual(missingTerminalFonts("   ", no), NONE);
  assert.deepEqual(missingTerminalFonts("Menlo,", installed("Menlo")), NONE);
  assert.deepEqual(missingTerminalFonts(",,", no), NONE);
});

test("missingTerminalFonts: a family repeated in the chain is reported once", () => {
  assert.deepEqual(missingTerminalFonts("Nope, Nope", () => false), {
    missing: ["Nope"],
    unusable: [],
  });
  assert.deepEqual(missingTerminalFonts("0.45, 0.45", () => true), {
    missing: [],
    unusable: ["0.45"],
  });
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
  // the whole point of the key: a machine that lists nothing gets
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

test("parseUpcomingDock: null when unasked, bottom when unreadable", () => {
  // absent is not the same answer as junk: an absent key means nothing has
  // written the note yet, and the boot read is allowed to honour an older
  // profile's stored placement instead
  assert.equal(parseUpcomingDock({}), null);
  assert.equal(parseUpcomingDock({ "terminal-dock": "right" }), null);
  // only the exact word rails it, trimmed and case-folded like its neighbour
  assert.equal(parseUpcomingDock({ "upcoming-dock": "right" }), "right");
  assert.equal(parseUpcomingDock({ "upcoming-dock": " RIGHT " }), "right");
  // a key that is present but says something else reads as the shape the
  // panel has always had — a typo costs nothing
  assert.equal(parseUpcomingDock({ "upcoming-dock": "bottom" }), "bottom");
  assert.equal(parseUpcomingDock({ "upcoming-dock": "rightish" }), "bottom");
  assert.equal(parseUpcomingDock({ "upcoming-dock": "" }), "bottom");
  assert.equal(parseUpcomingDock({ "upcoming-dock": true }), "bottom");
  assert.equal(parseUpcomingDock({ "upcoming-dock": 1 }), "bottom");
  assert.equal(parseUpcomingDock({ "upcoming-dock": null }), "bottom");
  assert.equal(parseUpcomingDock({ "upcoming-dock": ["right"] }), "bottom");
  // hand-cased keys read like every other setting
  assert.equal(parseUpcomingDock({ "Upcoming-Dock": "right" }), "right");
  assert.equal(parseUpcomingDock({ "UPCOMING-DOCK": "nonsense" }), "bottom");
});

test("parseFeedTopics: null when unasked, a clean slug list when asked", () => {
  // absent is not the same answer as empty: an absent key means nothing has
  // written the note yet, and the boot read is allowed to honour a selection
  // an older profile left in the browser store
  assert.equal(parseFeedTopics({}), null);
  assert.equal(parseFeedTopics({ "feed-curator": "curate.sh" }), null);
  // present and empty is a real answer — no filter, the whole stream
  assert.deepEqual(parseFeedTopics({ "feed-topics": [] }), []);
  // the shape the chips write: lowercased slugs in pick order
  assert.deepEqual(parseFeedTopics({ "feed-topics": ["plugins", "ai"] }), ["plugins", "ai"]);
  // hand-edited notes: cased, padded, duplicated, and a bare string for one
  assert.deepEqual(parseFeedTopics({ "feed-topics": [" Plugins ", "AI", "plugins"] }), [
    "plugins",
    "ai",
  ]);
  assert.deepEqual(parseFeedTopics({ "feed-topics": "Plugins" }), ["plugins"]);
  // junk hides nothing rather than hiding everything
  assert.deepEqual(parseFeedTopics({ "feed-topics": ["", "  "] }), []);
  assert.deepEqual(parseFeedTopics({ "feed-topics": [1, true, null, { a: 1 }] }), []);
  assert.deepEqual(parseFeedTopics({ "feed-topics": true }), []);
  assert.deepEqual(parseFeedTopics({ "feed-topics": null }), []);
  // a non-string entry never takes the good ones down with it
  assert.deepEqual(parseFeedTopics({ "feed-topics": ["scene", 7] }), ["scene"]);
  // hand-cased keys read like every other setting
  assert.deepEqual(parseFeedTopics({ "Feed-Topics": ["wild"] }), ["wild"]);
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

test("parseTaskStaleChips: only an explicit false turns the age chips off (SUB-1125)", () => {
  assert.equal(parseTaskStaleChips({ "task-stale-chips": false }), false);
  assert.equal(parseTaskStaleChips({ "task-stale-chips": "false" }), false);
  assert.equal(parseTaskStaleChips({ "task-stale-chips": " FALSE " }), false);
  // cased spellings read like the documented key
  assert.equal(parseTaskStaleChips({ "Task-Stale-Chips": false }), false);
  // default ON: an unset key, `true`, or a typo all keep the chips
  assert.equal(parseTaskStaleChips({}), true);
  assert.equal(parseTaskStaleChips({ "task-stale-chips": true }), true);
  assert.equal(parseTaskStaleChips({ "task-stale-chips": "off" }), true);
});

test("parseAutoSync: only an explicit false parks the timer lane (SUB-1235)", () => {
  assert.equal(parseAutoSync({ "auto-sync": false }), false);
  assert.equal(parseAutoSync({ "auto-sync": "false" }), false);
  assert.equal(parseAutoSync({ "auto-sync": " FALSE " }), false);
  assert.equal(parseAutoSync({ "Auto-Sync": false }), false);
  // default ON once a remote is configured: unset, `true`, or a typo
  assert.equal(parseAutoSync({}), true);
  assert.equal(parseAutoSync({ "auto-sync": true }), true);
  assert.equal(parseAutoSync({ "auto-sync": "off" }), true);
});

test("parseShowAppFiles: only an explicit true reveals the app files (SUB-831)", () => {
  // the inverse rule of the other bools: the blank slate is the default, so
  // an unset key, garbage, or `false` in any casing all keep them concealed.
  // The key keeps its pre-change name so existing vaults stay revealed.
  assert.equal(parseShowAppFiles({ "show-agent-files": true }), true);
  assert.equal(parseShowAppFiles({ "show-agent-files": "true" }), true);
  assert.equal(parseShowAppFiles({ "show-agent-files": " TRUE " }), true);
  assert.equal(parseShowAppFiles({}), false);
  assert.equal(parseShowAppFiles({ "show-agent-files": false }), false);
  assert.equal(parseShowAppFiles({ "show-agent-files": "false" }), false);
  assert.equal(parseShowAppFiles({ "show-agent-files": "yes" }), false);
  assert.equal(parseShowAppFiles({ "show-agent-files": 1 }), false);
});

test("parseWindowOpacity: 80–100, anything else falls back to 90 (SUB-951)", () => {
  assert.equal(parseWindowOpacity({}), 90);
  assert.equal(parseWindowOpacity({ "window-opacity": 80 }), 80);
  assert.equal(parseWindowOpacity({ "window-opacity": "100" }), 100);
  assert.equal(parseWindowOpacity({ "Window-Opacity": " 85 " }), 85);
  // YAML hands a bare number through as a number; a quoted one as a string
  assert.equal(parseWindowOpacity({ "window-opacity": 82.4 }), 82);
  // out of range or unreadable is a mistake, not a wish for the extreme
  assert.equal(parseWindowOpacity({ "window-opacity": 0 }), 90);
  // the floor is 80 for contrast reasons, so the old 70 proposal now falls back
  assert.equal(parseWindowOpacity({ "window-opacity": 79 }), 90);
  assert.equal(parseWindowOpacity({ "window-opacity": 70 }), 90);
  assert.equal(parseWindowOpacity({ "window-opacity": 150 }), 90);
  assert.equal(parseWindowOpacity({ "window-opacity": "ninety" }), 90);
  assert.equal(parseWindowOpacity({ "window-opacity": "" }), 90);
  assert.equal(parseWindowOpacity({ "window-opacity": true }), 90);
});

test("isAppFile: exact root names only (SUB-831, SUB-878)", () => {
  assert.equal(isAppFile("AGENTS.md"), true);
  assert.equal(isAppFile("CLAUDE.md"), true);
  // The settings note behind the ⌘, sheet is app chrome too
  assert.equal(isAppFile("Settings.md"), true);
  // a user's own note that happens to share a stem, or a nested copy, is
  // ordinary content — concealment is about the seeded root files
  assert.equal(isAppFile("agents.md"), false);
  assert.equal(isAppFile("Notes/AGENTS.md"), false);
  assert.equal(isAppFile("AGENTS notes.md"), false);
  assert.equal(isAppFile("settings.md"), false);
  assert.equal(isAppFile("Notes/Settings.md"), false);
});

test("netAllowed: only an explicit false closes an outbound call (SUB-834)", () => {
  for (const f of ["link-titles", "fx-rates", "share-relay"] as const) {
    const key = `net-${f}`;
    assert.equal(netAllowed({ [key]: false }, f), false);
    assert.equal(netAllowed({ [key]: "false" }, f), false);
    assert.equal(netAllowed({ [key]: " FALSE " }, f), false);
    // default ON: an unset key, `true`, or a typo all leave the feature working
    assert.equal(netAllowed({}, f), true);
    assert.equal(netAllowed({ [key]: true }, f), true);
    assert.equal(netAllowed({ [key]: "off" }, f), true);
    assert.equal(netAllowed({ [key]: 0 }, f), true);
  }
});

test("netAllowed: a hand-cased switch key still closes the call", () => {
  assert.equal(netAllowed({ "Net-Fx-Rates": false }, "fx-rates"), false);
  assert.equal(netAllowed({ "NET-SHARE-RELAY": "false" }, "share-relay"), false);
  // an exact key still wins when both spellings are in the file
  assert.equal(
    netAllowed({ "Net-Fx-Rates": false, "net-fx-rates": true }, "fx-rates"),
    true
  );
});

test("netAllowed: the three switches are independent", () => {
  // one closed toggle must not read as any other's state — the keys are
  // separate rows in Settings.md and a user turning off link titles keeps
  // currency rates and sharing
  const props = { "net-link-titles": false };
  assert.equal(netAllowed(props, "link-titles"), false);
  assert.equal(netAllowed(props, "fx-rates"), true);
  assert.equal(netAllowed(props, "share-relay"), true);
});

