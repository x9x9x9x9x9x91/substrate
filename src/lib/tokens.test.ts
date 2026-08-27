import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { sourceFiles } from "../../scripts/live-tree.ts";
import { stylesheetSource } from "../../scripts/styles-source.ts";
import { DANGER, OK, RGB, RUNNING, WARN } from "./tokens.ts";

/* The failure this guards is not a wrong colour, it's a colour that
   stops following the theme — a hex typed into a component looks right the
   day it's written and then silently ignores every later edit to the token it
   was copied from. */

const CSS = stylesheetSource();

function declaredHex(token: string): string {
  const m = CSS.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(m, `${token} is not declared as a hex in the stylesheet`);
  return m[1].toLowerCase();
}

test("every exported status colour names a token the stylesheet actually declares", () => {
  for (const [name, value] of Object.entries({ OK, WARN, DANGER, RUNNING })) {
    const token = value.match(/var\((--[a-z0-9-]+)\)/)?.[1];
    assert.ok(token, `${name} should be a var() reference, got ${value}`);
    assert.ok(
      new RegExp(`${token}\\s*:`).test(CSS),
      `${name} points at ${token}, which the stylesheet does not declare`,
    );
  }
});

test("the numeric ring stops still match the hexes the tokens ship", () => {
  // a crossfading ring interpolates between these, so they can't be var() —
  // this is what keeps them honest instead of merely plausible
  const expect = (token: string, rgb: readonly number[]) => {
    const hex = declaredHex(token);
    const asHex = "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
    assert.equal(asHex, hex, `${token} is ${hex}, but RGB says ${asHex}`);
  };
  expect("--ok", RGB.ok);
  expect("--warn", RGB.warn);
  expect("--danger", RGB.danger);
});

test("no component re-types a status token as a literal", () => {
  // the drift itself: the same hex hand-copied into seven dashboards, each
  // copy invisible to a theme change
  const literals = /#(?:4cb782|eb5757|d9a02b|609ae8)\b/i;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const offenders: string[] = [];

  for (const file of sourceFiles(root)) {
    if (file.name === "tokens.test.ts") continue; // names them on purpose
    file.text.split("\n").forEach((line, i) => {
      if (literals.test(line)) offenders.push(`${file.name}:${i + 1} ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `re-typed token values — import them from src/lib/tokens instead:\n  ${offenders.join("\n  ")}`,
  );
});
