import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DATE_LOCALES,
  DEFAULT_DATE_LOCALE,
  dateLocale,
  dateLocaleSample,
  dateLocaleSetting,
  isDateLocale,
  setDateLocale,
} from "./dateLocale.ts";

test("default is de-DE — the same country number-locale defaults to", () => {
  assert.equal(DEFAULT_DATE_LOCALE, "de-DE");
  assert.equal(dateLocaleSetting({}), "de-DE");
  assert.equal(dateLocale(), "de-DE");
});

test("date-locale is read as a BCP-47 tag from the list", () => {
  assert.equal(dateLocaleSetting({ "date-locale": "en-US" }), "en-US");
  assert.equal(dateLocaleSetting({ "date-locale": "de-CH" }), "de-CH");
  assert.equal(dateLocaleSetting({ "date-locale": "fr-FR" }), "fr-FR");
  // hand-edited Settings.md: surrounding space and casing both survive
  assert.equal(dateLocaleSetting({ "date-locale": "  en-GB  " }), "en-GB");
  assert.equal(dateLocaleSetting({ "date-locale": "de-de" }), "de-DE");
});

test("an unreadable value falls back to the default rather than erroring", () => {
  assert.equal(dateLocaleSetting({ "date-locale": "klingon" }), "de-DE");
  assert.equal(dateLocaleSetting({ "date-locale": "" }), "de-DE");
  assert.equal(dateLocaleSetting({ "date-locale": 42 }), "de-DE");
  assert.equal(dateLocaleSetting({ "date-locale": true }), "de-DE");
  assert.equal(dateLocaleSetting({ "date-locale": null }), "de-DE");
});

test("number-locale does not decide dates — the two dials are independent", () => {
  assert.equal(dateLocaleSetting({ "number-locale": "en-US" }), "de-DE");
  assert.equal(
    dateLocaleSetting({ "number-locale": "en-US", "date-locale": "fr-FR" }),
    "fr-FR"
  );
});

test("isDateLocale guards the stored value", () => {
  for (const l of DATE_LOCALES) assert.equal(isDateLocale(l), true);
  assert.equal(isDateLocale("de"), false);
  assert.equal(isDateLocale("en"), false);
  assert.equal(isDateLocale(undefined), false);
});

test("each offered locale writes a visibly distinct dialect", () => {
  // 31 Jan 2026, 14:05 local. Separators and digit order are what differ;
  // the space before an en-US AM/PM marker is U+202F in some ICU builds and a
  // plain space in others — node's and the webview's differ — so the shape is
  // asserted, not the exact byte.
  assert.match(dateLocaleSample("de-DE"), /^31\.01\.2026,\s14:05$/u);
  assert.match(dateLocaleSample("de-CH"), /^31\.01\.2026,\s14:05$/u);
  assert.match(dateLocaleSample("en-GB"), /^31\/01\/2026,\s14:05$/u);
  assert.match(dateLocaleSample("fr-FR"), /^31\/01\/2026\s14:05$/u);
  // en-US is the one 12-hour clock in the list, and puts the month first
  assert.match(dateLocaleSample("en-US"), /^01\/31\/2026,\s02:05\sPM$/u);
});

test("the sample is a local date, so it cannot slide a day by timezone", () => {
  for (const l of DATE_LOCALES) {
    assert.match(dateLocaleSample(l), /31/u);
    assert.match(dateLocaleSample(l), /2026/u);
  }
});

test("the module binding is what module-scope formatters read", () => {
  try {
    setDateLocale("en-US");
    assert.equal(dateLocale(), "en-US");
    setDateLocale("fr-FR");
    assert.equal(dateLocale(), "fr-FR");
  } finally {
    setDateLocale(DEFAULT_DATE_LOCALE);
  }
  assert.equal(dateLocale(), "de-DE");
});
