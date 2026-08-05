import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DANGER, OK, RGB, RUNNING, WARN } from "./tokens.ts";

/* SUB-1152: the failure this guards is not a wrong colour, it's a colour that
   stops following the theme — a hex typed into a component looks right the
   day it's written and then silently ignores every later edit to the token it
   was copied from. */

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function declaredHex(token: string): string {
  const m = CSS.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(m, `${token} is not declared as a hex in styles.css`);
  return m[1].toLowerCase();
}

test("every exported status colour names a token styles.css actually declares", () => {
  for (const [name, value] of Object.entries({ OK, WARN, DANGER, RUNNING })) {
    const token = value.match(/var\((--[a-z0-9-]+)\)/)?.[1];
    assert.ok(token, `${name} should be a var() reference, got ${value}`);
    assert.ok(
      new RegExp(`${token}\\s*:`).test(CSS),
      `${name} points at ${token}, which styles.css does not declare`,
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

  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    if (entry.name === "tokens.test.ts") continue; // names them on purpose
    const path = join(entry.parentPath, entry.name);
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (literals.test(line)) offenders.push(`${entry.name}:${i + 1} ${line.trim()}`);
      });
  }

  assert.deepEqual(
    offenders,
    [],
    `re-typed token values — import them from src/lib/tokens instead:\n  ${offenders.join("\n  ")}`,
  );
});
