import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCellNumber } from "./aggregate.ts";
import { audioFileTarget, audioPropTarget, displayColLabel, displayType, displayValue, formatDateTimeHuman, formatFileSize } from "./display.ts";

test("displayType capitalizes db types like folder names (SUB-258)", () => {
  assert.equal(displayType("gear"), "Gear");
  assert.equal(displayType("dashboard"), "Dashboard");
  // already capitalized / multi-word pass through untouched
  assert.equal(displayType("Projects"), "Projects");
  assert.equal(displayType("field notes"), "Field notes");
  assert.equal(displayType(""), "");
});

test("displayColLabel capitalizes the first letter only (SUB-255)", () => {
  assert.equal(displayColLabel("status"), "Status");
  assert.equal(displayColLabel("cat#"), "Cat#");
  assert.equal(displayColLabel("artist"), "Artist");
  assert.equal(displayColLabel("Name"), "Name");
  assert.equal(displayColLabel("URL"), "URL");
  assert.equal(displayColLabel(""), "");
});

test("displayValue formats schema'd dates human, passes non-ISO through", () => {
  assert.equal(displayValue("2026-07-17", "date"), "Jul 17, 2026");
  assert.equal(displayValue("2026-08-02", "date"), "Aug 2, 2026");
  assert.equal(displayValue("next week", "date"), "next week");
});

test("formatDateTimeHuman appends an optional time; day-only is unchanged (SUB-270)", () => {
  assert.equal(formatDateTimeHuman("2026-07-17 14:30"), "Jul 17, 2026, 14:30");
  assert.equal(formatDateTimeHuman("2026-07-17T09:05"), "Jul 17, 2026, 09:05");
  assert.equal(formatDateTimeHuman("2026-07-17"), "Jul 17, 2026");
  assert.equal(formatDateTimeHuman("next week"), "next week");
  assert.equal(displayValue("2026-07-17 14:30", "date"), "Jul 17, 2026, 14:30");
});

test("formatDateTimeHuman collapses a range to what the endpoints share (SUB-596)", () => {
  assert.equal(formatDateTimeHuman("2026-09-01/2026-09-21"), "Sep 1 – 21, 2026");
  assert.equal(formatDateTimeHuman("2026-09-01/2026-10-03"), "Sep 1 – Oct 3, 2026");
  assert.equal(formatDateTimeHuman("2026-12-28/2027-01-03"), "Dec 28, 2026 – Jan 3, 2027");
  // a shown time is never collapsed away
  assert.equal(
    formatDateTimeHuman("2026-09-01 09:00/2026-09-03 17:00"),
    "Sep 1, 2026, 09:00 – Sep 3, 2026, 17:00"
  );
  // a reversed range is not a date value — it renders verbatim, never partly
  assert.equal(formatDateTimeHuman("2026-09-21/2026-09-01"), "2026-09-21/2026-09-01");
  assert.equal(displayValue("2026-09-01/2026-09-21", "date"), "Sep 1 – 21, 2026");
});

test("displayValue shows file-kind values by basename, embeds unwrapped", () => {
  assert.equal(displayValue("~/Music/masters/static-bouquet.wav", "file"), "static-bouquet.wav");
  assert.equal(displayValue("![[cover.png]]", "file"), "cover.png");
  assert.equal(displayValue("assets/cover.png", "file"), "cover.png");
});

test("displayValue unwraps embed wrappers for unschema'd props (SUB-167)", () => {
  assert.equal(displayValue("![[static-bouquet.png]]", undefined), "static-bouquet.png");
  assert.equal(displayValue("![[assets/cover.png]]", undefined), "cover.png");
  assert.equal(displayValue("[[Some Note]]", undefined), "Some Note");
  assert.equal(displayValue("[[Inbox/Capture anything]]", undefined), "Capture anything");
  // not a full wrap → untouched
  assert.equal(displayValue("![[a.png]] and text", undefined), "![[a.png]] and text");
});

test("displayValue basenames raw absolute and ~/ paths, keeps prose whole", () => {
  assert.equal(displayValue("~/Documents/missing contract.pdf", undefined), "missing contract.pdf");
  assert.equal(displayValue("/abs/path/x.pdf", undefined), "x.pdf");
  assert.equal(displayValue("AC/DC", undefined), "AC/DC");
  assert.equal(displayValue("24/7", undefined), "24/7");
  assert.equal(displayValue("in review", undefined), "in review");
  assert.equal(displayValue("SMP-030", undefined), "SMP-030");
});

test("displayValue shows url-kind values by stripped title (SUB-172)", () => {
  assert.equal(displayValue("https://www.sellpy.fr/", "url"), "sellpy.fr");
  assert.equal(displayValue("https://example.com/docs?q=1", "url"), "example.com/docs?q=1");
  assert.equal(displayValue("http://sub.domain.co.uk/path/", "url"), "sub.domain.co.uk/path");
  // not a URL — passes through as typed, never basename'd
  assert.equal(displayValue("AC/DC", "url"), "AC/DC");
  assert.equal(displayValue("", "url"), "");
});

test("displayValue shows checkbox kind as ✓ or blank (SUB-173)", () => {
  // v arrives via propStr: the YAML bool true surfaces as "true"
  assert.equal(displayValue("true", "checkbox"), "✓");
  // unchecked (absent/empty/false) reads blank, never "false"
  assert.equal(displayValue("", "checkbox"), "");
  assert.equal(displayValue("false", "checkbox"), "");
});

test("formatFileSize renders de-DE sizes across the unit boundaries (SUB-284)", () => {
  // bytes under 1 KB stay plain — including 0
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(1023), "1023 B");
  // KB under 10 keeps one decimal, with the de-DE comma (never "4.2 KB")
  assert.equal(formatFileSize(1024), "1,0 KB");
  assert.equal(formatFileSize(1536), "1,5 KB");
  assert.equal(formatFileSize(4300), "4,2 KB");
  // just under 10 KB rounds to "10,0" inside the decimal branch…
  assert.equal(formatFileSize(10239), "10,0 KB");
  // …while exactly 10 KB flips to the rounded-integer branch
  assert.equal(formatFileSize(10240), "10 KB");
  assert.equal(formatFileSize(102400), "100 KB");
  // just under 1 MB still rounds as KB
  assert.equal(formatFileSize(1048575), "1024 KB");
  // MB always keeps one decimal, de-DE comma
  assert.equal(formatFileSize(1048576), "1,0 MB");
  assert.equal(formatFileSize(1572864), "1,5 MB");
  assert.equal(formatFileSize(10485760), "10,0 MB");
  // GB-scale files group thousands de-DE too
  assert.equal(formatFileSize(2147483648), "2.048,0 MB");
});

test("displayValue formats number-kind values by display format (SUB-188)", () => {
  // euro: German grouping — dot thousands, comma decimals, 2 decimals only
  // when the value has decimals (no forced ",00"), trailing " €"
  assert.equal(displayValue("1299", "number", "euro"), "1.299 €");
  assert.equal(displayValue("1234.56", "number", "euro"), "1.234,56 €");
  assert.equal(displayValue("349.5", "number", "euro"), "349,5 €");
  assert.equal(displayValue("-1234.5", "number", "euro"), "-1.234,5 €");
  // percent (SUB-196): same de-DE path as euro — the stored number IS the
  // percent (no ×100 math), German grouping + " %"
  assert.equal(displayValue("12", "number", "percent"), "12 %");
  assert.equal(displayValue("8.5", "number", "percent"), "8,5 %");
  assert.equal(displayValue("12.50", "number", "percent"), "12,5 %");
  assert.equal(displayValue("1250.25", "number", "percent"), "1.250,25 %");
  assert.equal(displayValue("-3.5", "number", "percent"), "-3,5 %");
  // plain / no format: the number as stored
  assert.equal(displayValue("1234.56", "number", "plain"), "1234.56");
  assert.equal(displayValue("1234.56", "number"), "1234.56");
  // non-numeric junk renders exactly as typed — never destroyed, never hidden
  assert.equal(displayValue("ask", "number", "euro"), "ask");
  assert.equal(displayValue("ask", "number", "percent"), "ask");
  assert.equal(displayValue("", "number", "euro"), "");
});

test("number display parses with the footer aggregates' coercion (SUB-188)", () => {
  // the SAME parseCellNumber: whatever a sum counts as numeric formats as
  // numeric, whatever a sum skips renders exactly as typed
  for (const v of ["42", " 42 ", "-3.5", "1e3", "abc", "", "1,234", "NaN"]) {
    const n = parseCellNumber(v);
    const shown = displayValue(v, "number", "percent");
    const expected =
      n === null ? v : `${(Math.round(n * 100) / 100 || 0).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`;
    assert.equal(shown, expected, `percent agrees with the parser on ${JSON.stringify(v)}`);
  }
  // a summed cell shows its sum's format too: " 42 " is numeric to both
  assert.equal(displayValue(" 42 ", "number", "euro"), "42 €");
});

test("displayValue passes plain values and non-ISO dates without a kind through", () => {
  assert.equal(displayValue("2026-07-17", undefined), "2026-07-17");
  assert.equal(displayValue("chroma weather", "text"), "chroma weather");
  assert.equal(displayValue("", undefined), "");
});

test("audioFileTarget names only audio file values, unwrapped (SUB-674)", () => {
  // bare names, paths, and home/absolute forms all classify by extension
  assert.equal(audioFileTarget("master.wav"), "master.wav");
  assert.equal(audioFileTarget("~/Music/masters/static-bouquet.wav"), "~/Music/masters/static-bouquet.wav");
  assert.equal(audioFileTarget("/Volumes/Studio/bounce.flac"), "/Volumes/Studio/bounce.flac");
  assert.equal(audioFileTarget("![[opener-vocal-rough.mp3]]"), "opener-vocal-rough.mp3");
  assert.equal(audioFileTarget("MIX V2.AIF"), "MIX V2.AIF");
  // non-audio file values and prose stay null — the cell renders as before
  assert.equal(audioFileTarget("~/Documents/missing contract.pdf"), null);
  assert.equal(audioFileTarget("cover.png"), null);
  assert.equal(audioFileTarget("chroma weather"), null);
  assert.equal(audioFileTarget(""), null);
  assert.equal(audioFileTarget("![[scan.pdf]]"), null);
});

test("audioPropTarget finds a note's first audio-valued file prop (SUB-674)", () => {
  const schema = {
    status: { options: [] },
    artwork: { options: [], kind: "file" as const },
    contract: { options: [], kind: "file" as const },
  };
  // the audio prop wins over a non-audio file prop and non-file props
  assert.equal(
    audioPropTarget({ status: "live", artwork: "cover.png", contract: "master.wav" }, schema),
    "master.wav"
  );
  // no audio value anywhere → null (card renders as before)
  assert.equal(audioPropTarget({ artwork: "cover.png", contract: "deal.pdf" }, schema), null);
  // audio on a prop whose schema kind isn't file doesn't count
  assert.equal(audioPropTarget({ status: "master.wav" }, schema), null);
  // empty and missing values are skipped
  assert.equal(audioPropTarget({ contract: "" }, schema), null);
  assert.equal(audioPropTarget({}, schema), null);
});
