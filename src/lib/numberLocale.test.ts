import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_NUMBER_LOCALE,
  NUMBER_LOCALES,
  isNumberLocale,
  numberLocale,
  numberLocaleSample,
  numberLocaleSetting,
  platformLocaleTag,
  setNumberLocale,
  systemNumberLocale,
} from "./numberLocale.ts";

test("the pure formatters' fallback is still de-DE", () => {
  // what a call site that threads no locale renders in, and the last resort
  // behind both the stored key and the machine — unchanged, so nothing that
  // formats without a locale moved
  assert.equal(DEFAULT_NUMBER_LOCALE, "de-DE");
  assert.equal(numberLocale(), "de-DE");
});

test("a fresh vault follows the machine's locale", () => {
  // no `number-locale`, no retired key — nothing stored at all, which is
  // exactly a first run. The machine's dialect is injected rather than read,
  // so this pins the behaviour on any machine.
  assert.equal(numberLocaleSetting({}, "en-US"), "en-US");
  assert.equal(numberLocaleSetting({}, "fr-FR"), "fr-FR");
  assert.equal(numberLocaleSetting({}, "de-DE"), "de-DE");
  // and the un-injected call is wired to the machine, not to a constant
  assert.equal(numberLocaleSetting({}), systemNumberLocale());
});

test("a stored setting is preserved exactly, whatever the machine says", () => {
  // the migration test: every vault that already persisted a dialect keeps
  // it, with a machine locale that disagrees on every read
  for (const stored of NUMBER_LOCALES) {
    assert.equal(numberLocaleSetting({ "number-locale": stored }, "fr-FR"), stored);
    assert.equal(numberLocaleSetting({ "number-locale": stored }, "en-US"), stored);
  }
  // the retired key is a stored choice too — both of its values
  assert.equal(numberLocaleSetting({ "number-format": "intl" }, "de-DE"), "en-US");
  assert.equal(numberLocaleSetting({ "number-format": "de" }, "en-US"), "de-DE");
  // a hand-cased key is still a stored choice
  assert.equal(numberLocaleSetting({ "NUMBER-LOCALE": "de-CH" }, "en-US"), "de-CH");
});

test("a machine locale maps onto the offered grammar family", () => {
  // the five are grammar families, not an ISO catalogue, so an arbitrary
  // system tag is matched on how it punctuates a number
  for (const l of NUMBER_LOCALES) assert.equal(systemNumberLocale(l), l);
  assert.equal(systemNumberLocale("EN-us"), "en-US");
  assert.equal(systemNumberLocale("en-AU"), "en-US"); // 1,234.56
  assert.equal(systemNumberLocale("ja-JP"), "en-US"); // 1,234.56
  assert.equal(systemNumberLocale("pt-BR"), "de-DE"); // 1.234,56
  assert.equal(systemNumberLocale("sv-SE"), "fr-FR"); // space-grouped
  // es-ES leaves a four-figure number ungrouped (1234,56) — the decimal
  // separator alone decides
  assert.equal(systemNumberLocale("es-ES"), "de-DE");
  // a tag ICU refuses is not worth throwing over
  assert.equal(systemNumberLocale(""), DEFAULT_NUMBER_LOCALE);
  assert.equal(systemNumberLocale("en_US"), DEFAULT_NUMBER_LOCALE);
});

test("the platform tag is read from the platform, not guessed", () => {
  const tag = platformLocaleTag();
  // whatever this machine is set to, it is a real tag ICU resolved
  assert.equal(typeof tag, "string");
  assert.equal(new Intl.NumberFormat(tag).resolvedOptions().locale, tag);
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

test("an unreadable value falls back rather than erroring", () => {
  // a typo is not a stored dialect, so it lands where an unset key lands —
  // the machine's locale, injected here
  assert.equal(numberLocaleSetting({ "number-locale": "klingon" }, "en-GB"), "en-GB");
  assert.equal(numberLocaleSetting({ "number-locale": "" }, "en-GB"), "en-GB");
  assert.equal(numberLocaleSetting({ "number-locale": 42 }, "en-GB"), "en-GB");
  assert.equal(numberLocaleSetting({ "number-locale": true }, "en-GB"), "en-GB");
  assert.equal(numberLocaleSetting({ "number-locale": null }, "en-GB"), "en-GB");
});

test("the retired number-format key still moves vaults that set it", () => {
  assert.equal(numberLocaleSetting({ "number-format": "intl" }), "en-US");
  assert.equal(numberLocaleSetting({ "number-format": "INTL" }), "en-US");
  assert.equal(numberLocaleSetting({ "number-format": "de" }), "de-DE");
  // a value neither of the two the key ever took is unreadable, not a choice
  assert.equal(numberLocaleSetting({ "number-format": "nonsense" }, "en-GB"), "en-GB");
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
