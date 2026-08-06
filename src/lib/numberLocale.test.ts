import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_NUMBER_LOCALE,
  NUMBER_LOCALES,
  isNumberLocale,
  numberLocale,
  numberLocaleSample,
  numberLocaleSetting,
  setNumberLocale,
} from "./numberLocale.ts";

test("default is de-DE — an existing vault renders unchanged", () => {
  assert.equal(DEFAULT_NUMBER_LOCALE, "de-DE");
  assert.equal(numberLocaleSetting({}), "de-DE");
  assert.equal(numberLocale(), "de-DE");
});

test("number-locale is read as a BCP-47 tag from the list", () => {
  assert.equal(numberLocaleSetting({ "number-locale": "en-US" }), "en-US");
  assert.equal(numberLocaleSetting({ "number-locale": "de-CH" }), "de-CH");
  assert.equal(numberLocaleSetting({ "number-locale": "fr-FR" }), "fr-FR");
  // hand-edited Settings.md: surrounding space and casing both survive
  assert.equal(numberLocaleSetting({ "number-locale": "  en-GB  " }), "en-GB");
  assert.equal(numberLocaleSetting({ "number-locale": "de-de" }), "de-DE");
});

test("a hand-edited Settings.md key is read whatever its casing", () => {
  assert.equal(numberLocaleSetting({ "Number-Locale": "en-US" }), "en-US");
  assert.equal(numberLocaleSetting({ "NUMBER-LOCALE": "fr-FR" }), "fr-FR");
  // the retired narrower key folds too
  assert.equal(numberLocaleSetting({ "Number-Format": "intl" }), "en-US");
  // an exact key still wins when both spellings are in the file
  assert.equal(
    numberLocaleSetting({ "Number-Locale": "en-US", "number-locale": "de-CH" }),
    "de-CH"
  );
});

test("an unreadable value falls back to the default rather than erroring", () => {
  assert.equal(numberLocaleSetting({ "number-locale": "klingon" }), "de-DE");
  assert.equal(numberLocaleSetting({ "number-locale": "" }), "de-DE");
  assert.equal(numberLocaleSetting({ "number-locale": 42 }), "de-DE");
  assert.equal(numberLocaleSetting({ "number-locale": true }), "de-DE");
  assert.equal(numberLocaleSetting({ "number-locale": null }), "de-DE");
});

test("the retired number-format key still moves vaults that set it", () => {
  assert.equal(numberLocaleSetting({ "number-format": "intl" }), "en-US");
  assert.equal(numberLocaleSetting({ "number-format": "INTL" }), "en-US");
  assert.equal(numberLocaleSetting({ "number-format": "de" }), "de-DE");
  assert.equal(numberLocaleSetting({ "number-format": "nonsense" }), "de-DE");
});

test("number-locale wins over the legacy key when both are set", () => {
  assert.equal(
    numberLocaleSetting({ "number-locale": "fr-FR", "number-format": "intl" }),
    "fr-FR"
  );
  assert.equal(
    numberLocaleSetting({ "number-locale": "de-DE", "number-format": "intl" }),
    "de-DE"
  );
  // an unreadable number-locale still defers to the legacy key rather than
  // jumping straight to the default — the user's older choice is real intent
  assert.equal(
    numberLocaleSetting({ "number-locale": "klingon", "number-format": "intl" }),
    "en-US"
  );
});

test("isNumberLocale guards the stored value", () => {
  for (const l of NUMBER_LOCALES) assert.equal(isNumberLocale(l), true);
  assert.equal(isNumberLocale("de"), false);
  assert.equal(isNumberLocale("intl"), false);
  assert.equal(isNumberLocale(undefined), false);
});

// en-US and en-GB render four-figure samples identically — the picker shows
// two rows with the same number. Kept apart deliberately (the locales differ
// elsewhere), so the name claims what is actually asserted: each locale's
// sample is the grammar of ITS family, not that all five differ from each
// other.
test("each offered locale writes its own family's grammar", () => {
  assert.equal(numberLocaleSample("de-DE"), "1.234,56");
  assert.equal(numberLocaleSample("en-US"), "1,234.56");
  assert.equal(numberLocaleSample("en-GB"), "1,234.56");
  // de-CH's group separator is an apostrophe, fr-FR's a narrow no-break space
  // (U+202F). Which codepoint either is depends on the ICU build — node's and
  // the webview's differ — so the shape is asserted, not the exact byte.
  assert.match(numberLocaleSample("de-CH"), /^1['’]234\.56$/u);
  assert.match(numberLocaleSample("fr-FR"), /^1\s234,56$/u);
});

test("the module binding is what module-scope formatters read", () => {
  try {
    setNumberLocale("en-US");
    assert.equal(numberLocale(), "en-US");
    setNumberLocale("fr-FR");
    assert.equal(numberLocale(), "fr-FR");
  } finally {
    setNumberLocale(DEFAULT_NUMBER_LOCALE);
  }
  assert.equal(numberLocale(), "de-DE");
});
