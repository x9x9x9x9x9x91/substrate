import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* Walking the LIVE source tree — the checkout the suite is running out of,
   not a fixture — is inherently racy. `node --test` runs one process per test
   file and several files at once, so while one test reads `src/` another can
   be writing a transient probe beside a component and removing it again a
   moment later. The walker discovers the entry, then finds it gone: ENOENT on
   a path `readdirSync` had just listed.

   That is a race, not a finding. A walker that lets it through reds an
   innocent branch on a file it never touched, and the same diff passes on the
   re-run — the worst shape a gate failure can take. So: a directory or file
   that vanishes mid-walk is SKIPPED. Anything else still throws; this is
   tolerance for one specific race, not a blanket catch. */

/** Suffix a test gives a file it plants in the live tree and removes again.
    Walkers skip these outright: a probe is a fixture that happens to live in
    `src/`, never a source file anyone is asserting about. Kept next to the
    walk so the two halves of the convention cannot drift apart. */
export const PROBE_SUFFIX = ".probe.tsx";

export type SourceFile = {
  /** Path as the walk found it, for messages that need to name the file. */
  path: string;
  name: string;
  text: string;
};

function vanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Read a file the walk just listed, or undefined if it vanished first. */
export function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (vanished(error)) return undefined;
    throw error;
  }
}

function* walk(dir: string): Generator<{ path: string; name: string }> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (vanished(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield { path, name: entry.name };
  }
}

/**
 * Every source file under `root`, read, with probes and mid-walk casualties
 * left out. Lazy on purpose — the directory listing is taken one level at a
 * time, so a caller that stops early does not pay for the rest of the tree.
 */
export function* sourceFiles(root: string, match = /\.tsx?$/): Generator<SourceFile> {
  for (const { path, name } of walk(root)) {
    if (!match.test(name)) continue;
    if (name.endsWith(PROBE_SUFFIX)) continue;
    const text = readIfPresent(path);
    if (text === undefined) continue;
    yield { path, name, text };
  }
}
