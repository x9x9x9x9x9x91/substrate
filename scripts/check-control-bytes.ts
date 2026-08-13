#!/usr/bin/env node
/**
 * Raw control bytes in tracked text files.
 *
 * A single 0x00 anywhere in the first 8000 bytes flips git's own text/binary
 * verdict for the whole file, and git never asks again: `git diff` prints
 * `Bin 50918 -> 66072 bytes` instead of hunks, `git grep` and plain `grep`
 * report nothing, and a reviewer reading either sees a clean, empty answer
 * rather than an error. docs/agent-friction.md shipped one NUL and went
 * unreadable that way for two days; the entry it was pasted into was itself
 * about a NUL a branch had shipped in scripts/check-kinds.ts. Both were
 * invisible to every gate in the suite until a rig run tripped over the
 * second one by accident.
 *
 * So: no raw C0 control byte, and no DEL, in any tracked file that is not a
 * declared binary asset. Tab and newline are the two exceptions — they are
 * what text is made of. Everything else has an escape spelling (`\0`,
 * `\x03`, `U+0000` in prose) that reads the same to a human and keeps the
 * file greppable.
 *
 * Binary assets are declared by extension in BINARY_EXTENSIONS. A tracked
 * file with an unknown extension is treated as TEXT: a new binary format
 * therefore fails loudly and asks to be declared, rather than opening a
 * silent hole the next NUL slips through.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Byte values that are legitimate inside text: tab and newline. */
export const ALLOWED_CONTROL_BYTES: ReadonlySet<number> = new Set([0x09, 0x0a]);

/**
 * Extensions whose contents are bytes, not prose. Lower case, dot included.
 * Anything not listed here is scanned — see the header on why the default
 * leans that way.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".gif",
  ".icns",
  ".ico",
  ".jpeg",
  ".jpg",
  ".otf",
  ".pdf",
  ".png",
  ".ttf",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

export type Violation = {
  file: string;
  /** 1-based line, counting newlines before the byte. */
  line: number;
  /** 1-based byte column within that line. */
  column: number;
  /** The offending byte value. */
  byte: number;
  /** How to spell it instead: `\0`, `\r`, `\x1b`, … */
  escape: string;
};

/** True when the path is a declared binary asset and is not scanned. */
export function isBinaryPath(file: string): boolean {
  return BINARY_EXTENSIONS.has(extname(file).toLowerCase());
}

/** The escape spelling a byte should have carried instead of being raw. */
export function escapeFor(byte: number): string {
  if (byte === 0x00) return "\\0";
  if (byte === 0x0d) return "\\r";
  return `\\x${byte.toString(16).padStart(2, "0")}`;
}

/** Every offending byte in one file's contents, in order. */
export function findControlBytes(file: string, bytes: Uint8Array): Violation[] {
  const out: Violation[] = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x0a) {
      line++;
      lineStart = i + 1;
      continue;
    }
    if (byte >= 0x20 && byte !== 0x7f) continue;
    if (ALLOWED_CONTROL_BYTES.has(byte)) continue;
    out.push({ file, line, column: i - lineStart + 1, byte, escape: escapeFor(byte) });
  }
  return out;
}

/** The tracked files of the checkout at `root`, in git's order. */
export function trackedFiles(root: string): string[] {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => f.length > 0);
}

/** Scan every tracked text file of the checkout at `root`. */
export function scanTree(root: string): Violation[] {
  const out: Violation[] = [];
  for (const file of trackedFiles(root)) {
    if (isBinaryPath(file)) continue;
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(resolve(root, file));
    } catch {
      // Tracked but absent from the working tree (sparse checkout, a deletion
      // staged elsewhere). Nothing to read, nothing to claim about it.
      continue;
    }
    out.push(...findControlBytes(file, bytes));
  }
  return out;
}

function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // An optional positional root scans another checkout; bare, this repo.
  const root = process.argv[2] ?? ROOT;
  let hits: Violation[];
  try {
    hits = scanTree(root);
  } catch (e) {
    console.error(`check-control-bytes: could not read the tree — ${(e as Error).message}`);
    process.exit(2);
  }
  if (hits.length === 0) {
    console.log("check-control-bytes: no raw control bytes in tracked text files ✓");
  } else {
    console.error(`\ncheck-control-bytes: ${hits.length} raw control byte(s):\n`);
    for (const h of hits) {
      console.error(
        `  • ${h.file}:${h.line}:${h.column}: 0x${h.byte.toString(16).padStart(2, "0")} — ` +
          `write "${h.escape}" instead`
      );
    }
    console.error(
      "\nA raw control byte makes git read the whole file as binary: no diff hunks,\n" +
        "no grep hits, no warning. If the file is a binary asset, declare its\n" +
        "extension in BINARY_EXTENSIONS (scripts/check-control-bytes.ts) instead.\n"
    );
    process.exit(1);
  }
}
