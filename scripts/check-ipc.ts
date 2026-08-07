#!/usr/bin/env node
/**
 * IPC inventory drift check.
 *
 * Three hand-maintained inventories describe the same set of Tauri commands:
 *
 *   1. Rust    — `generate_handler![…]` in src-tauri/src/lib.rs, plus each
 *                `#[tauri::command]` fn's argument names (commands/*.rs,
 *                term.rs, smoke.rs).
 *   2. TS      — `invoke<T>("cmd", { … })` wrappers in src/lib/ipc.ts, plus
 *                the handful of direct invokes elsewhere under src/.
 *   3. Mock    — `case "cmd":` arms of the mock backend's dispatch switch in
 *                src/lib/tauri.ts, which the e2e suite runs against.
 *
 * Nothing keeps them in step but attention, and attention has already lost:
 * Shipped a snake_case arg key that the real IPC dropped silently
 * because the mock reads `args?.x` and never cared about the casing.
 *
 * This script re-derives all three inventories mechanically and fails on any
 * divergence. It is deliberately unforgiving about input it cannot parse:
 * a signature shape it doesn't understand is thrown, never skipped, because
 * a silently-skipped command is exactly the drift it exists to catch.
 *
 * Tauri converts Rust snake_case parameter names to camelCase on the JS side,
 * so the Rust inventory's arg names are camelCased before comparison.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ── shared helpers ─────────────────────────────────────────────────────── */

/** Tauri's JS-side name for a Rust parameter: `expected_body` → `expectedBody`. */
export function camel(snake: string): string {
  return snake.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Strip comments and string literals from Rust or TS source, replacing each
 * with same-length whitespace so byte offsets survive. Keeps the scanners
 * below from tripping over braces or quotes inside comments and strings.
 *
 * TS mode also handles `'…'` and template literals — the `${…}` holes stay
 * code, so an `invoke()` inside one is still seen. Rust mode treats `/* … *\/`
 * as nesting (which Rust allows) and blanks char literals (`'"'` would
 * otherwise open a phantom string) while leaving lifetimes (`&'a str`) alone.
 */
export function blankNonCode(src: string, mode: "ts" | "rust" = "ts"): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  const quotes = mode === "ts" ? ['"', "'"] : ['"'];
  // open template literals whose `${…}` hole we are currently inside; the
  // depth remembers when the hole's `}` closes and the literal resumes
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  /** last non-whitespace code character — decides `/` as divide vs regex */
  let prev = "";
  const setPrev = (from: number, to: number) => {
    for (let k = to - 1; k >= from; k--) {
      if (!/\s/.test(src[k])) {
        prev = src[k];
        return;
      }
    }
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      // Rust nests block comments; TS does NOT — a prose `/*` inside a TS
      // comment (e.g. a path like `.vault/*.json`) is just text, so nesting
      // there would swallow the rest of the file.
      let j: number;
      if (mode === "rust") {
        let d = 0;
        j = i;
        while (j < src.length) {
          if (src.slice(j, j + 2) === "/*") {
            d++;
            j += 2;
          } else if (src.slice(j, j + 2) === "*/") {
            d--;
            j += 2;
            if (d === 0) break;
          } else j++;
        }
        if (d !== 0) throw new Error("unterminated block comment");
      } else {
        const end = src.indexOf("*/", i + 2);
        if (end === -1) throw new Error("unterminated block comment");
        j = end + 2;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // Rust char literal: `'x'` or `'\n'` — but NOT a lifetime (`&'a str`,
    // `'static`), which has no closing quote. `'"'` in particular must not
    // open a string.
    if (mode === "rust" && src[i] === "'") {
      const esc = src[i + 1] === "\\";
      const close = esc ? src.indexOf("'", i + 2) : i + 2;
      if (!esc && src[close] === "'") {
        blank(i + 1, close);
        prev = "'";
        i = close + 1;
        continue;
      }
      if (esc && close !== -1 && close - i <= 8) {
        blank(i + 1, close);
        prev = "'";
        i = close + 1;
        continue;
      }
      // lifetime — ordinary code
    }
    if (quotes.includes(src[i])) {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) throw new Error(`unterminated ${quote} literal`);
      blank(i + 1, j);
      prev = quote;
      i = j + 1;
      continue;
    }
    // TS regex literal — its body routinely contains quotes and backticks
    // (`/[&<>"]/g`), which would otherwise open a phantom string. `/` starts a
    // regex only where a value cannot precede it.
    if (mode === "ts" && src[i] === "/" && !/[A-Za-z0-9_$)\]]/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const c = src[j];
        if (c === "\\") j += 2;
        else if (c === "\n") break;
        else if (c === "[") {
          inClass = true;
          j++;
        } else if (c === "]") {
          inClass = false;
          j++;
        } else if (c === "/" && !inClass) break;
        else j++;
      }
      if (j < src.length && src[j] === "/") {
        blank(i + 1, j);
        prev = "/";
        i = j + 1;
        while (i < src.length && /[gimsuyd]/.test(src[i])) i++;
        continue;
      }
      // not a regex after all (a bare `/` division after e.g. `)`) — fall
      // through and treat the character as ordinary code
    }
    if (mode === "ts" && src[i] === "`") {
      // scan the literal, blanking text but leaving each `${…}` hole as code
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "`") break;
        else if (src.slice(j, j + 2) === "${") {
          blank(i + 1, j + 2); // literal text plus the `${` itself
          templates.push(depth);
          depth++;
          i = j + 2;
          break;
        } else j++;
      }
      if (j >= src.length) throw new Error("unterminated ` literal");
      if (i === j + 2) {
        prev = "{"; // inside a hole: a leading `/` there starts a regex
        continue;
      }
      blank(i + 1, j);
      prev = "`";
      i = j + 1;
      continue;
    }
    if (src[i] === "{" || src[i] === "(" || src[i] === "[") depth++;
    else if (src[i] === "}" || src[i] === ")" || src[i] === "]") {
      depth--;
      if (templates.length && depth === templates[templates.length - 1]) {
        // this `}` closed a template hole — the literal continues after it
        templates.pop();
        out[i] = " ";
        let j = i + 1;
        while (j < src.length) {
          if (src[j] === "\\") j += 2;
          else if (src[j] === "`") break;
          else if (src.slice(j, j + 2) === "${") {
            blank(i + 1, j + 2); // literal text plus the `${` itself
            templates.push(depth);
            depth++;
            i = j + 1;
            break;
          } else j++;
        }
        if (j >= src.length) throw new Error("unterminated ` literal");
        if (i === j + 1) {
          prev = "{";
          i = j + 2; // past the `${`; the hole's contents are code again
          continue;
        }
        blank(i + 1, j);
        prev = "`";
        i = j + 1;
        continue;
      }
    }
    setPrev(i, i + 1);
    i++;
  }
  if (templates.length) throw new Error("unterminated ` literal");
  return out.join("");
}

/**
 * Given the index of an opening delimiter, return the index of its match.
 * Throws when the source runs out — unparseable input must fail loudly.
 */
export function matchDelim(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]", "<": ">" };
  const o = src[open];
  const c = pairs[o];
  if (!c) throw new Error(`matchDelim: ${o} at ${open} is not an opening delimiter`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`matchDelim: unbalanced ${o} starting at ${open}`);
}

/** Split on commas that sit at nesting depth 0 across (), {}, [] and <>. */
export function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "}" || c === "]" || c === ">") depth--;
    else if (c === "," && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/* ── 1. Rust inventory ──────────────────────────────────────────────────── */

/** Parameter types Tauri injects — never sent from JS, so never compared. */
const INJECTED = [
  /^&?State\s*</,
  /^&?tauri::State\s*</,
  /^&?tauri::AppHandle\b/,
  /^&?AppHandle\b/,
  /^&?tauri::WebviewWindow\b/,
  /^&?WebviewWindow\b/,
  /^&?tauri::Window\b/,
  /^&?Window\b/,
];

export interface RustCommand {
  /** JS-visible arg names, camelCased, in declaration order */
  args: string[];
  /** args declared `Option<…>` — Tauri fills these with None when omitted */
  optional: Set<string>;
}

/** Command names listed in `generate_handler![…]`, module paths stripped. */
export function parseHandlerList(libRs: string): string[] {
  const code = blankNonCode(libRs, "rust");
  const marker = code.indexOf("generate_handler!");
  if (marker === -1) throw new Error("no generate_handler! found in lib.rs");
  const open = code.indexOf("[", marker);
  if (open === -1) throw new Error("generate_handler! has no [ … ] list");
  const close = matchDelim(code, open);
  const body = libRs.slice(open + 1, close);
  const names: string[] = [];
  for (const entry of splitTopLevel(blankNonCode(body, "rust"))) {
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*::)*([a-z_][a-z0-9_]*)$/.exec(entry);
    if (!m) throw new Error(`unparseable generate_handler! entry: ${JSON.stringify(entry)}`);
    names.push(m[1]);
  }
  if (names.length === 0) throw new Error("generate_handler! list parsed as empty");
  return names;
}

/**
 * Every `#[tauri::command]` fn in a Rust source, with its JS-visible args.
 * A name declared twice (the desktop/mobile `term` stubs) must agree on its
 * argument list once leading underscores are stripped — otherwise the two
 * builds disagree about the wire format and that is itself drift.
 */
export function parseRustCommands(src: string, label: string): Map<string, RustCommand> {
  const code = blankNonCode(src, "rust");
  const out = new Map<string, RustCommand>();
  const attr = /#\[tauri::command\]/g;
  let m: RegExpExecArray | null;
  while ((m = attr.exec(code))) {
    const after = code.slice(m.index + m[0].length);
    const sig = /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)\s*\(/.exec(
      after
    );
    if (!sig) {
      const peek = after.slice(0, 80).replace(/\s+/g, " ").trim();
      throw new Error(`${label}: #[tauri::command] not followed by a fn signature — saw "${peek}"`);
    }
    const name = sig[1];
    const openParen = m.index + m[0].length + sig[0].length - 1;
    const closeParen = matchDelim(code, openParen);
    const params = splitTopLevel(code.slice(openParen + 1, closeParen));
    const args: string[] = [];
    const optional = new Set<string>();
    for (const p of params) {
      const pm = /^(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(p);
      if (!pm) throw new Error(`${label}: unparseable parameter in ${name}: ${JSON.stringify(p)}`);
      const [, rawName, type] = pm;
      if (INJECTED.some((re) => re.test(type.trim()))) continue;
      const argName = camel(rawName.replace(/^_/, ""));
      args.push(argName);
      if (/^Option\s*</.test(type.trim())) optional.add(argName);
    }
    const prev = out.get(name);
    if (prev) {
      if (prev.args.join(",") !== args.join(",")) {
        throw new Error(
          `${label}: ${name} declared twice with different args ` +
            `([${prev.args}] vs [${args}]) — the cfg variants disagree on the wire format`
        );
      }
      continue;
    }
    out.set(name, { args, optional });
  }
  return out;
}

/* ── 2. TS inventory ────────────────────────────────────────────────────── */

export interface TsInvoke {
  cmd: string;
  args: string[];
  /** true when the call passes no argument object at all */
  bare: boolean;
  where: string;
}

/**
 * Every `invoke("cmd", { … })` in a TS/TSX source. The generic parameter is
 * optional; the argument object, when present, must be an object literal —
 * a spread or a variable is thrown, because its keys can't be verified.
 */
export function parseTsInvokes(src: string, label: string): TsInvoke[] {
  const code = blankNonCode(src);
  const out: TsInvoke[] = [];
  // `invoke` / `invoke<T>` / `tauriInvoke`, then `("cmd"` — the command name
  // is read from the ORIGINAL source at the same offset (blanking hollowed it)
  const call = /\binvoke\s*(?:<[^()]*?>)?\s*\(\s*"/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(code))) {
    const quoteAt = m.index + m[0].length - 1;
    const end = src.indexOf('"', quoteAt + 1);
    if (end === -1) throw new Error(`${label}: unterminated command name at offset ${quoteAt}`);
    const cmd = src.slice(quoteAt + 1, end);
    if (!/^[a-z][a-z0-9_]*$/.test(cmd)) {
      throw new Error(`${label}: invoke() first argument is not a command name: ${JSON.stringify(cmd)}`);
    }
    // walk past the closing quote to the next non-space token
    let i = end + 1;
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === ")") {
      out.push({ cmd, args: [], bare: true, where: label });
      continue;
    }
    if (code[i] !== ",") {
      throw new Error(`${label}: unexpected token after "${cmd}": ${JSON.stringify(code[i])}`);
    }
    i++;
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === ")") {
      out.push({ cmd, args: [], bare: true, where: label });
      continue;
    }
    if (code[i] !== "{") {
      const peek = code.slice(i, i + 40).replace(/\s+/g, " ").trim();
      throw new Error(
        `${label}: invoke("${cmd}") second argument is not an object literal — saw "${peek}"`
      );
    }
    const close = matchDelim(code, i);
    const args: string[] = [];
    for (const entry of splitTopLevel(code.slice(i + 1, close))) {
      if (entry.startsWith("...")) {
        throw new Error(`${label}: invoke("${cmd}") spreads its args — keys can't be verified`);
      }
      const km = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|$)/.exec(entry);
      if (!km) throw new Error(`${label}: unparseable arg key in invoke("${cmd}"): ${JSON.stringify(entry)}`);
      args.push(km[1]);
    }
    out.push({ cmd, args, bare: false, where: label });
  }
  return out;
}

/* ── 3. Mock inventory ──────────────────────────────────────────────────── */

/** Commands the mock backend's dispatch switch handles. */
export function parseMockCases(src: string, label: string): string[] {
  const code = blankNonCode(src);
  /* Exact name, not a prefix: `function mockDispatch` also matches
     mockDispatchAfterLatency, which is declared first. That only ever worked
     because the wrapper carries no switch of its own — the day it grows one,
     or the day dispatch moves below another mockDispatch* helper, a prefix
     anchor would parse the wrong function's cases and pass quietly. */
  const anchor = code.search(/\bfunction\s+mockDispatch\s*\(/);
  if (anchor === -1) throw new Error(`${label}: mockDispatch not found — the mock moved`);
  const sw = code.indexOf("switch", anchor);
  if (sw === -1) throw new Error(`${label}: mockDispatch has no switch statement`);
  const open = code.indexOf("{", code.indexOf(")", sw));
  const close = matchDelim(code, open);
  const body = src.slice(open, close);
  const names = [...body.matchAll(/\bcase\s+"([a-z][a-z0-9_]*)"\s*:/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`${label}: mock switch parsed as empty`);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) throw new Error(`${label}: duplicate mock cases: ${[...new Set(dupes)].join(", ")}`);
  return names;
}

/* ── allowlist ──────────────────────────────────────────────────────────── */

export interface Allowlist {
  noTs: Set<string>;
  noMock: Set<string>;
}

/** `no-ts <cmd>` / `no-mock <cmd>`, `#` comments and blank lines ignored. */
export function parseAllowlist(text: string, label = "allowlist"): Allowlist {
  const noTs = new Set<string>();
  const noMock = new Set<string>();
  text.split("\n").forEach((raw, idx) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const m = /^(no-ts|no-mock)\s+([a-z][a-z0-9_]*)$/.exec(line);
    if (!m) throw new Error(`${label}:${idx + 1}: unparseable entry ${JSON.stringify(raw.trim())}`);
    (m[1] === "no-ts" ? noTs : noMock).add(m[2]);
  });
  return { noTs, noMock };
}

/* ── cross-check ────────────────────────────────────────────────────────── */

export interface Inventories {
  rustRegistered: string[];
  rustCommands: Map<string, RustCommand>;
  tsInvokes: TsInvoke[];
  mockCases: string[];
  allow: Allowlist;
}

/** Every drift class, as human-readable lines. Empty array = inventories agree. */
export function crossCheck(inv: Inventories): string[] {
  const { rustRegistered, rustCommands, tsInvokes, mockCases, allow } = inv;
  const problems: string[] = [];
  const registered = new Set(rustRegistered);
  const mock = new Set(mockCases);

  // registration sanity: every listed command must have a parsed fn
  for (const name of rustRegistered) {
    if (!rustCommands.has(name)) {
      problems.push(
        `rust: generate_handler! lists "${name}" but no #[tauri::command] fn of that name was found`
      );
    }
  }
  for (const name of rustCommands.keys()) {
    if (!registered.has(name)) {
      problems.push(`rust: #[tauri::command] fn "${name}" is never registered in generate_handler!`);
    }
  }

  // TS side, one entry per command (several call sites collapse into one)
  const byCmd = new Map<string, TsInvoke[]>();
  for (const inv of tsInvokes) {
    const list = byCmd.get(inv.cmd) ?? [];
    list.push(inv);
    byCmd.set(inv.cmd, list);
  }

  for (const [cmd, calls] of byCmd) {
    if (!registered.has(cmd)) {
      problems.push(
        `ts: ${calls[0].where} invokes "${cmd}", which Rust does not register in generate_handler!`
      );
      continue;
    }
    const rust = rustCommands.get(cmd);
    if (!rust) continue; // already reported above
    for (const call of calls) {
      const passed = new Set(call.args);
      const extra = call.args.filter((a) => !rust.args.includes(a));
      const missing = rust.args.filter((a) => !passed.has(a) && !rust.optional.has(a));
      if (extra.length) {
        problems.push(
          `args: ${call.where} passes ${extra.map((a) => `"${a}"`).join(", ")} to "${cmd}", ` +
            `which takes [${rust.args.join(", ") || "no args"}] — the extra key is dropped silently`
        );
      }
      if (missing.length) {
        problems.push(
          `args: ${call.where} omits required ${missing.map((a) => `"${a}"`).join(", ")} ` +
            `for "${cmd}" (Rust takes [${rust.args.join(", ")}])`
        );
      }
    }
  }

  for (const cmd of rustRegistered) {
    if (byCmd.has(cmd) || allow.noTs.has(cmd)) continue;
    problems.push(
      `ts: Rust registers "${cmd}" but nothing under src/ invokes it — ` +
        `wrap it in src/lib/ipc.ts or allowlist it as \`no-ts ${cmd}\``
    );
  }
  for (const cmd of allow.noTs) {
    if (byCmd.has(cmd)) {
      problems.push(`allowlist: \`no-ts ${cmd}\` is stale — the TS layer does invoke it now`);
    } else if (!registered.has(cmd)) {
      problems.push(`allowlist: \`no-ts ${cmd}\` names a command Rust no longer registers`);
    }
  }

  for (const cmd of byCmd.keys()) {
    if (mock.has(cmd) || allow.noMock.has(cmd)) continue;
    problems.push(
      `mock: the TS layer invokes "${cmd}" but the mock backend has no case for it — ` +
        `e2e would hit \`unknown command\` (or allowlist it as \`no-mock ${cmd}\`)`
    );
  }
  for (const cmd of mockCases) {
    if (!registered.has(cmd)) {
      problems.push(`mock: handles "${cmd}", which Rust no longer registers — dead mock arm`);
    }
  }
  for (const cmd of allow.noMock) {
    if (mock.has(cmd)) {
      problems.push(`allowlist: \`no-mock ${cmd}\` is stale — the mock does handle it now`);
    } else if (!registered.has(cmd)) {
      problems.push(`allowlist: \`no-mock ${cmd}\` names a command Rust no longer registers`);
    }
  }

  return problems;
}

/* ── driver ─────────────────────────────────────────────────────────────── */

/** All .ts/.tsx under src/, minus the mock backend itself and test files. */
function tsSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
    }
  };
  walk(join(ROOT, "src"));
  return out.filter((p) => p !== join(ROOT, "src", "lib", "tauri.ts"));
}

export function collect(): Inventories {
  const libRs = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
  const termRs = readFileSync(join(ROOT, "src-tauri/src/term.rs"), "utf8");
  const smokeRs = readFileSync(join(ROOT, "src-tauri/src/smoke.rs"), "utf8");
  const mockTs = readFileSync(join(ROOT, "src/lib/tauri.ts"), "utf8");
  const allowPath = join(ROOT, "scripts/ipc-allowlist.txt");

  // The command bodies live in src-tauri/src/commands/*.rs; lib.rs
  // keeps only the generate_handler! list, so the fns have to be read from
  // there too or every registered name looks unimplemented.
  const commandsDir = join(ROOT, "src-tauri/src/commands");
  const commandModules = readdirSync(commandsDir)
    .filter((f) => f.endsWith(".rs") && f !== "mod.rs")
    .sort()
    .map((f) => [readFileSync(join(commandsDir, f), "utf8"), `src-tauri/src/commands/${f}`] as const);

  const rustCommands = new Map<string, RustCommand>([
    ...parseRustCommands(libRs, "src-tauri/src/lib.rs"),
    ...commandModules.flatMap(([src, label]) => [...parseRustCommands(src, label)]),
    ...parseRustCommands(termRs, "src-tauri/src/term.rs"),
    ...parseRustCommands(smokeRs, "src-tauri/src/smoke.rs"),
  ]);

  // Cheap prefilter: only files that textually contain an `invoke(` are worth
  // lexing. This keeps the scanner off JSX-heavy view files whose prose text
  // (apostrophes, stray quotes) is not TS at all — and off files that could
  // never contribute an inventory entry anyway. Any file that DOES call invoke
  // is still parsed strictly, and a parse failure there is fatal.
  const tsInvokes: TsInvoke[] = [];
  for (const file of tsSources()) {
    const src = readFileSync(file, "utf8");
    if (!/\binvoke\s*[<(]/.test(src)) continue;
    tsInvokes.push(...parseTsInvokes(src, relative(ROOT, file)));
  }

  return {
    rustRegistered: parseHandlerList(libRs),
    rustCommands,
    tsInvokes,
    mockCases: parseMockCases(mockTs, "src/lib/tauri.ts"),
    allow: parseAllowlist(readFileSync(allowPath, "utf8"), "scripts/ipc-allowlist.txt"),
  };
}

function main(): void {
  let inv: Inventories;
  try {
    inv = collect();
  } catch (e) {
    console.error(`check-ipc: could not build the inventories — ${(e as Error).message}`);
    console.error("This is a parse failure, not a clean tree. Fix the parser or the source.");
    process.exit(2);
  }

  const commands = new Set(inv.tsInvokes.map((i) => i.cmd));
  const problems = crossCheck(inv);

  console.log(
    `check-ipc: ${inv.rustRegistered.length} Rust commands, ` +
      `${commands.size} invoked from TS, ${inv.mockCases.length} mock cases`
  );
  if (problems.length === 0) {
    console.log("check-ipc: inventories agree ✓");
    return;
  }
  console.error(`\ncheck-ipc: ${problems.length} drift problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
