import { test } from "node:test";
import assert from "node:assert/strict";
import { collapsedLabel, countLabel, dayLabel, lifespan, sizeLabel } from "./recall.ts";
import { setDateLocale } from "./dateLocale.ts";
import { DEFAULT_NUMBER_LOCALE, setNumberLocale } from "./numberLocale.ts";
import type { RecallGroup } from "./types.ts";

// the labels read the date dial, so the English assertions below name a
// locale instead of inheriting whatever country the machine is in
setDateLocale("en-GB");

const MARCH = Date.parse("2026-03-04T10:12:00Z");
const JUNE = Date.parse("2026-06-18T09:03:00Z");

function group(over: Partial<RecallGroup> = {}): RecallGroup {
  return {
    path: "Masters/veilwork.md",
    versions: [
      {
        oid: "a1b2c3d4",
        first_id: "3f9a1c2",
        first_ts_ms: MARCH,
        last_id: "77c0de1abcdef",
        last_ts_ms: JUNE,
        deleted: false,
        matches: [],
        total: 1,
      },
    ],
    total_versions: 1,
    first_ts_ms: MARCH,
    last_ts_ms: JUNE,
    deleted: false,
    ...over,
  };
}

test("a span across months names both ends", () => {
  const label = lifespan(group());
  assert.match(label, /March 2026/);
  assert.match(label, /June 2026/);
  assert.match(label, /rewritten since/);
});

test("text that never outlived its month is named once, not as a range", () => {
  const label = lifespan(group({ last_ts_ms: MARCH + 60_000 }));
  assert.equal(label.split("March 2026").length - 1, 1, `got: ${label}`);
  assert.ok(!label.includes("–"), `got: ${label}`);
});

test("a deleted group names the snapshot that removed it, abbreviated", () => {
  assert.match(lifespan(group({ deleted: true })), /deleted in 77c0de1$/);
});

test("a deleted group with no versions still reads as a sentence", () => {
  assert.match(lifespan(group({ deleted: true, versions: [] })), /deleted in a later snapshot$/);
});

test("collapsed tail counts only the versions not shown, and stays silent at zero", () => {
  assert.equal(collapsedLabel(group()), "");
  assert.equal(collapsedLabel(group({ total_versions: 2 })), "1 older version collapsed");
  assert.equal(collapsedLabel(group({ total_versions: 5 })), "4 older versions collapsed");
});

test("a version is dated to its day", () => {
  assert.match(dayLabel(MARCH), /2026/);
  assert.match(dayLabel(MARCH), /4/);
});

test("index size reads in the unit that fits it", () => {
  assert.equal(sizeLabel(512), "512 B");
  assert.equal(sizeLabel(4096), "4 KB");
  assert.equal(sizeLabel(5_412_864), "5.2 MB");
});

test("counts pluralize on the number they carry", () => {
  assert.equal(countLabel(1, "past version", "past versions"), "1 past version");
  assert.equal(countLabel(0, "past version", "past versions"), "0 past versions");
  // the vault's number dial, not the machine's country
  setNumberLocale("de-DE");
  assert.equal(countLabel(4416, "snapshot", "snapshots"), "4.416 snapshots");
  setNumberLocale("en-US");
  assert.equal(countLabel(4416, "snapshot", "snapshots"), "4,416 snapshots");
  setNumberLocale(DEFAULT_NUMBER_LOCALE);
});

test("the lifespan clause is written in the vault's date dialect", () => {
  setDateLocale("de-DE");
  try {
    assert.match(lifespan(group()), /März 2026 – Juni 2026/);
    // German writes the day first and puts a dot after it; the abbreviated
    // month spelling is the platform's business, so it is not asserted
    assert.match(dayLabel(MARCH), /^4\. /);
  } finally {
    setDateLocale("en-GB");
  }
});
