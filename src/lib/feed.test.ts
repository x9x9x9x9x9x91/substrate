import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cycleFeedback,
  FEED_STALE_MS,
  feedStaleness,
  feedTopics,
  filterFeedItems,
  groupFeedByDay,
  isOpenableUrl,
  parseCuratedStamp,
  parseFeedItems,
  setFeedback,
} from "./feed.ts";

const HEADER = "date,topic,title,source,url,blurb,why,fb";

function bodyWith(rows: string[], header = HEADER): string {
  return ["Curated by the news agent.", "", "```csv", header, ...rows, "```", ""].join("\n");
}

test("parseFeedItems: typed items, quoted commas survive", () => {
  const items = parseFeedItems(
    bodyWith([
      '2026-07-26,plugins,"Zynaptiq ships Morph 3, finally",CDM,https://cdm.link/a,"Spectral morphing, now realtime","Sits right in your spectral chain, no CPU excuse",up',
    ]),
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    date: "2026-07-26",
    topic: "plugins",
    title: "Zynaptiq ships Morph 3, finally",
    source: "CDM",
    url: "https://cdm.link/a",
    blurb: "Spectral morphing, now realtime",
    why: "Sits right in your spectral chain, no CPU excuse",
    fb: "up",
    idx: 0,
  });
});

test("parseFeedItems: blank, missing and junk fb all read as no verdict", () => {
  const items = parseFeedItems(
    bodyWith([
      "2026-07-26,scene,With fb,Src,https://a.example,b,w,DOWN",
      "2026-07-26,scene,Blank fb,Src,https://b.example,b,w,",
      "2026-07-26,scene,Junk fb,Src,https://c.example,b,w,maybe",
    ]),
  );
  assert.deepEqual(
    items.map((i) => i.fb),
    ["down", "", ""],
  );
  // fb column missing entirely: still parses, no verdicts
  const noFb = parseFeedItems(
    bodyWith(["2026-07-26,scene,No column,Src,https://a.example,b,w"], "date,topic,title,source,url,blurb,why"),
  );
  assert.equal(noFb.length, 1);
  assert.equal(noFb[0].fb, "");
});

test("parseFeedItems: malformed rows are skipped, never thrown", () => {
  const items = parseFeedItems(
    bodyWith([
      "not-a-date,scene,Bad date,Src,https://a.example,b,w,",
      "2026-07-26,scene,,Src,https://b.example,b,w,", // no title
      "2026-07-26", // short row
      "2026-07-26,scene,Good,Src,https://c.example,b,w,",
    ]),
  );
  assert.deepEqual(
    items.map((i) => i.title),
    ["Good"],
  );
  assert.equal(items[0].idx, 3);
  // no fence / no columns / empty body: empty, no throw
  assert.deepEqual(parseFeedItems("just prose"), []);
  assert.deepEqual(parseFeedItems(bodyWith(["2026-07-26,x"], "date,topic")), []);
});

test("parseFeedItems: date desc, curator's intra-day order preserved", () => {
  const items = parseFeedItems(
    bodyWith([
      "2026-07-24,scene,Old A,Src,https://a.example,b,w,",
      "2026-07-26,scene,New 1,Src,https://b.example,b,w,",
      "2026-07-25,scene,Mid,Src,https://c.example,b,w,",
      "2026-07-26,scene,New 2,Src,https://d.example,b,w,",
      "2026-07-26,scene,New 3,Src,https://e.example,b,w,",
    ]),
  );
  assert.deepEqual(
    items.map((i) => i.title),
    ["New 1", "New 2", "New 3", "Mid", "Old A"],
  );
  // idx keeps pointing at the sheet row, not the stream position
  assert.deepEqual(
    items.map((i) => i.idx),
    [1, 3, 4, 2, 0],
  );
  const days = groupFeedByDay(items);
  assert.deepEqual(
    days.map((d) => [d.day, d.items.length]),
    [
      ["2026-07-26", 3],
      ["2026-07-25", 1],
      ["2026-07-24", 1],
    ],
  );
});

test("isOpenableUrl: http(s) only", () => {
  assert.equal(isOpenableUrl("https://a.example/x"), true);
  assert.equal(isOpenableUrl("  http://a.example "), true);
  assert.equal(isOpenableUrl(""), false);
  assert.equal(isOpenableUrl("a.example/x"), false);
  assert.equal(isOpenableUrl("file:///etc/passwd"), false);
  assert.equal(isOpenableUrl("javascript:alert(1)"), false);
});

test("cycleFeedback: clicking the active state clears it", () => {
  assert.equal(cycleFeedback("", "up"), "up");
  assert.equal(cycleFeedback("up", "up"), "");
  assert.equal(cycleFeedback("down", "up"), "up");
  assert.equal(cycleFeedback("down", "down"), "");
});

test("setFeedback: only the fb cell changes, quoting and other rows intact", () => {
  const body = bodyWith([
    '2026-07-26,plugins,"Morph 3, finally",CDM,https://a.example,"Spectral, realtime","Your chain, no excuse",',
    "2026-07-25,scene,Second,Src,https://b.example,b,w,down",
  ]);
  const { next, expected } = setFeedback(body, 0, "up");
  assert.equal(expected, body);
  assert.equal(
    next,
    bodyWith([
      '2026-07-26,plugins,"Morph 3, finally",CDM,https://a.example,"Spectral, realtime","Your chain, no excuse",up',
      "2026-07-25,scene,Second,Src,https://b.example,b,w,down",
    ]),
  );
  // round trip: the same click again clears it, restoring the original body
  assert.equal(setFeedback(next, 0, "up").next, body);
  // the untouched row keeps its own verdict, and only it changes on its click
  assert.equal(setFeedback(body, 1, "down").next, bodyWith([
    '2026-07-26,plugins,"Morph 3, finally",CDM,https://a.example,"Spectral, realtime","Your chain, no excuse",',
    "2026-07-25,scene,Second,Src,https://b.example,b,w,",
  ]));
});

test("setFeedback: no fence, no fb column or a bad index is a no-op", () => {
  const noCol = bodyWith(["2026-07-26,scene,T,Src,https://a.example,b,w"], "date,topic,title,source,url,blurb,why");
  assert.equal(setFeedback(noCol, 0, "up").next, noCol);
  assert.equal(setFeedback("just prose", 0, "up").next, "just prose");
  const body = bodyWith(["2026-07-26,scene,T,Src,https://a.example,b,w,"]);
  assert.equal(setFeedback(body, 9, "up").next, body);
  assert.equal(setFeedback(body, -1, "up").next, body);
});

test("feedTopics: distinct slugs in stream order, lowercased, empties skipped", () => {
  const items = parseFeedItems(
    bodyWith([
      "2026-07-27,wild,A,Src,https://a.example,b,w,",
      "2026-07-27,AI,B,Src,https://b.example,b,w,",
      "2026-07-26,,No topic,Src,https://c.example,b,w,",
      "2026-07-26,wild,C,Src,https://d.example,b,w,",
    ]),
  );
  assert.deepEqual(feedTopics(items), ["wild", "ai"]);
});

test("filterFeedItems: empty selection passes all; matching is case-insensitive", () => {
  const items = parseFeedItems(
    bodyWith([
      "2026-07-27,wild,A,Src,https://a.example,b,w,",
      "2026-07-27,AI,B,Src,https://b.example,b,w,",
      "2026-07-26,scene,C,Src,https://c.example,b,w,",
    ]),
  );
  assert.equal(filterFeedItems(items, []).length, 3);
  assert.deepEqual(filterFeedItems(items, ["ai"]).map((i) => i.title), ["B"]);
  assert.deepEqual(filterFeedItems(items, ["wild", "scene"]).map((i) => i.title), ["A", "C"]);
  // stale persisted slugs are inert, not errors
  assert.deepEqual(filterFeedItems(items, ["gone", "wild"]).map((i) => i.title), ["A"]);
  // idx survives filtering — it must stay a full-sheet row handle for fb writes
  assert.equal(filterFeedItems(items, ["scene"])[0].idx, 2);
});

// ---------- staleness ----------

const NOW = new Date(2026, 6, 31, 12, 0, 0).getTime(); // local noon, TZ-proof
/** local "YYYY-MM-DD HH:MM" of a fixed instant — the shape the curator writes */
const stamp = (msAgo: number): string => {
  const d = new Date(NOW - msAgo);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

test("parseCuratedStamp: the shapes agents write, local time", () => {
  assert.equal(parseCuratedStamp("2026-07-26 09:10"), new Date(2026, 6, 26, 9, 10).getTime());
  // T separator, seconds, and the bare day (midnight local) all parse
  assert.equal(parseCuratedStamp("2026-07-26T09:10"), new Date(2026, 6, 26, 9, 10).getTime());
  assert.equal(parseCuratedStamp("2026-07-26 09:10:30"), new Date(2026, 6, 26, 9, 10, 30).getTime());
  assert.equal(parseCuratedStamp("2026-07-26"), new Date(2026, 6, 26, 0, 0).getTime());
  // RFC 3339 carries its own offset
  assert.equal(parseCuratedStamp("2026-07-26T09:10:00Z"), Date.parse("2026-07-26T09:10:00Z"));
  assert.equal(
    parseCuratedStamp("2026-07-26T09:10:00+02:00"),
    Date.parse("2026-07-26T09:10:00+02:00"),
  );
  // surrounding whitespace is not part of the stamp
  assert.equal(parseCuratedStamp("  2026-07-26 09:10  "), new Date(2026, 6, 26, 9, 10).getTime());
});

test("parseCuratedStamp: anything else is null — never a guess", () => {
  assert.equal(parseCuratedStamp(undefined), null);
  assert.equal(parseCuratedStamp(""), null);
  assert.equal(parseCuratedStamp("   "), null);
  assert.equal(parseCuratedStamp("whenever the agent ran"), null);
  assert.equal(parseCuratedStamp("2026-07-26 09:10-ish"), null);
  // new Date() would roll these forward — reject instead
  assert.equal(parseCuratedStamp("2026-02-31 09:10"), null);
  assert.equal(parseCuratedStamp("2026-13-01 09:10"), null);
  assert.equal(parseCuratedStamp("2026-07-26 25:10"), null);
  assert.equal(parseCuratedStamp("2026-07-26 09:61"), null);
});

test("feedStaleness: fresh inside ~36h, stale past it — boundary included", () => {
  assert.deepEqual(feedStaleness(stamp(60_000), NOW), { stale: false, age: "" });
  assert.deepEqual(feedStaleness(stamp(35 * 3_600_000), NOW), { stale: false, age: "" });
  // exactly 36h is still fresh ("older than" is strict)
  assert.deepEqual(feedStaleness(stamp(FEED_STALE_MS), NOW), { stale: false, age: "" });
  // past it the feed reads stale, aged in the repo's compact voice
  assert.deepEqual(feedStaleness(stamp(FEED_STALE_MS + 60_000), NOW), {
    stale: true,
    age: "1d 12h",
  });
  assert.deepEqual(feedStaleness(stamp(5 * 86_400_000), NOW), { stale: true, age: "5d" });
  // a stamp from the future is odd, not stale
  assert.deepEqual(feedStaleness(stamp(-60_000), NOW), { stale: false, age: "" });
});

test("feedStaleness: missing or unparseable stamps classify fresh", () => {
  assert.deepEqual(feedStaleness(undefined, NOW), { stale: false, age: "" });
  assert.deepEqual(feedStaleness("", NOW), { stale: false, age: "" });
  assert.deepEqual(feedStaleness("whenever", NOW), { stale: false, age: "" });
});
