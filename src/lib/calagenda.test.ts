import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENDA_DAYS_MAX,
  AGENDA_HEIGHT_DEFAULT,
  AGENDA_HEIGHT_MAX,
  AGENDA_HEIGHT_MIN,
  AGENDA_PREFS_DEFAULT,
  AGENDA_RAIL_MIN_PANE,
  AGENDA_WIDTH_MAX,
  AGENDA_WIDTH_MIN,
  CAL_GRID_MIN_WIDTH,
  agendaWindowDays,
  clampAgendaHeight,
  clampAgendaWidth,
  clampRailWidth,
  effectivePlacement,
  parseAgendaPrefs,
  railWidthMax,
} from "./calagenda.ts";

test("an unwritten profile reads as today's look", () => {
  assert.deepEqual(parseAgendaPrefs(null), AGENDA_PREFS_DEFAULT);
  assert.equal(AGENDA_PREFS_DEFAULT.placement, "bottom");
  assert.equal(AGENDA_PREFS_DEFAULT.folded, false);
  assert.equal(AGENDA_PREFS_DEFAULT.height, AGENDA_HEIGHT_DEFAULT);
});

test("junk in the store never costs the panel", () => {
  assert.deepEqual(parseAgendaPrefs("not json"), AGENDA_PREFS_DEFAULT);
  assert.deepEqual(parseAgendaPrefs("null"), AGENDA_PREFS_DEFAULT);
  assert.deepEqual(parseAgendaPrefs("[1,2]").placement, "bottom");
  assert.deepEqual(
    parseAgendaPrefs('{"height":"tall","width":null,"placement":"sideways"}'),
    AGENDA_PREFS_DEFAULT,
  );
});

test("a partial record keeps the defaults it does not name", () => {
  const prefs = parseAgendaPrefs('{"placement":"right"}');
  assert.equal(prefs.placement, "right");
  assert.equal(prefs.height, AGENDA_HEIGHT_DEFAULT);
  assert.equal(prefs.folded, false);
});

test("stored sizes land inside the clamps", () => {
  assert.equal(parseAgendaPrefs('{"height":5}').height, AGENDA_HEIGHT_MIN);
  assert.equal(parseAgendaPrefs('{"height":9000}').height, AGENDA_HEIGHT_MAX);
  assert.equal(parseAgendaPrefs('{"width":10}').width, AGENDA_WIDTH_MIN);
  assert.equal(parseAgendaPrefs('{"width":9000}').width, AGENDA_WIDTH_MAX);
  assert.equal(parseAgendaPrefs('{"height":240.6}').height, 241);
});

test("the clamps round and bound whatever the drag hands them", () => {
  assert.equal(clampAgendaHeight(-40), AGENDA_HEIGHT_MIN);
  assert.equal(clampAgendaHeight(300.4), 300);
  assert.equal(clampAgendaWidth(1000), AGENDA_WIDTH_MAX);
});

test("the rail falls back to the bottom in a narrow pane", () => {
  const right = { ...AGENDA_PREFS_DEFAULT, placement: "right" as const };
  assert.equal(effectivePlacement(right, AGENDA_RAIL_MIN_PANE), "right");
  assert.equal(effectivePlacement(right, AGENDA_RAIL_MIN_PANE - 1), "bottom");
  // unmeasured: the stated preference wins over a fallback nobody asked for
  assert.equal(effectivePlacement(right, 0), "right");
  assert.equal(effectivePlacement(AGENDA_PREFS_DEFAULT, 4000), "bottom");
});

test("the feed window follows the room the panel has", () => {
  assert.equal(agendaWindowDays(AGENDA_PREFS_DEFAULT), 14);
  assert.equal(agendaWindowDays({ ...AGENDA_PREFS_DEFAULT, height: 288 }), 21);
  assert.equal(
    agendaWindowDays({ ...AGENDA_PREFS_DEFAULT, height: AGENDA_HEIGHT_MAX }),
    35,
  );
  // the rail is a full-height column, taller than any bottom strip
  assert.equal(
    agendaWindowDays({ ...AGENDA_PREFS_DEFAULT, placement: "right" }),
    AGENDA_DAYS_MAX,
  );
  // a rail preference rendering as a bottom strip reads the strip's height
  assert.equal(
    agendaWindowDays({ ...AGENDA_PREFS_DEFAULT, placement: "right" }, "bottom"),
    14,
  );
});

test("the rail never takes the grid below its own floor", () => {
  // a pane with room to spare: the rail's own ceiling is the only limit
  assert.equal(railWidthMax(2000), AGENDA_WIDTH_MAX);
  assert.equal(clampRailWidth(9000, 2000), AGENDA_WIDTH_MAX);
  // a pane that only just qualifies: the widest stored rail is cut back to
  // what is left over the grid's floor, rather than rendering at 520 and
  // pushing the day columns into horizontal scrolling
  const tight = AGENDA_RAIL_MIN_PANE + 60;
  assert.equal(clampRailWidth(AGENDA_WIDTH_MAX, tight), AGENDA_WIDTH_MIN + 60);
  assert.ok(tight - clampRailWidth(AGENDA_WIDTH_MAX, tight) >= CAL_GRID_MIN_WIDTH);
  // exactly at the breakpoint only the narrowest rail fits, and it does
  assert.equal(clampRailWidth(AGENDA_WIDTH_MAX, AGENDA_RAIL_MIN_PANE), AGENDA_WIDTH_MIN);
  // below it nothing fits — the placement itself falls back to the strip
  assert.equal(railWidthMax(600), AGENDA_WIDTH_MIN);
  // a drag still cannot go under the rail's readable minimum
  assert.equal(clampRailWidth(40, 2000), AGENDA_WIDTH_MIN);
  // unmeasured pane: the stored wish stands, same reading as the placement's
  assert.equal(railWidthMax(0), AGENDA_WIDTH_MAX);
});
