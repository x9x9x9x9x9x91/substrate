import { readFileSync } from "node:fs";

/* The app's stylesheet is no longer one file: src/styles.css is an import
   list and the themed sheets under src/styles/ hold the rules. Tests that
   assert on the CSS want the cascade the browser sees, not one sheet of it,
   so they read it through here — concatenating the sheets in import order
   reproduces exactly the text the single stylesheet used to hold. */

const ENTRY = new URL("../src/styles.css", import.meta.url);

/** the themed sheets, in the order the entry sheet imports them */
export function styleSheetNames(): string[] {
  const entry = readFileSync(ENTRY, "utf8");
  return [...entry.matchAll(/@import "\.\/styles\/([a-z]+\.css)";/g)].map((m) => m[1]);
}

/** every themed sheet concatenated in cascade order — the whole stylesheet */
export function stylesheetSource(): string {
  return styleSheetNames()
    .map((name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), "utf8"))
    .join("");
}
