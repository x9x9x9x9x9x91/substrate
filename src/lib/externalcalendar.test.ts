import { test } from "node:test";
import assert from "node:assert/strict";
import { externalEntries } from "./externalcalendar.ts";
import type { ExternalCalendarEvent } from "./types.ts";

const event = (patch: Partial<ExternalCalendarEvent> = {}): ExternalCalendarEvent => ({
  id: "feed:1",
  feedUrl: "https://example.test/a.ics",
  feedName: "Outside",
  tint: "teal",
  title: "Appointment",
  startDay: "2026-08-03",
  startTime: null,
  endDay: null,
  endTime: null,
  allDay: true,
  location: null,
  ...patch,
});

test("external entries segment an inclusive multi-day occurrence", () => {
  const entries = externalEntries([event({ endDay: "2026-08-05" })]);
  assert.deepEqual(entries.map((e) => [e.day, e.spanPos]), [
    ["2026-08-03", "start"],
    ["2026-08-04", "mid"],
    ["2026-08-05", "end"],
  ]);
});

test("timed spans carry time only on their start day", () => {
  const entries = externalEntries([
    event({
      startTime: "23:00",
      endDay: "2026-08-04",
      endTime: "01:00",
      allDay: false,
    }),
  ]);
  assert.equal(entries[0].time, "23:00");
  assert.equal(entries[1].time, undefined);
});

test("invalid external dates disappear instead of breaking the surface", () => {
  assert.deepEqual(externalEntries([event({ startDay: "2026-02-30" })]), []);
  assert.deepEqual(externalEntries([event({ endDay: "2026-08-01" })]), []);
});
