#!/usr/bin/env node

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MirrorOptions {
  source: string;
  mirror: string;
  /** Refresh even when the mirror holds commits the working vault lacks. */
  force?: boolean;
  /** Print nothing when the mirror is already up to date (launchd interval jobs). */
  quietIfFresh?: boolean;
}

export type MirrorResult = "created" | "refreshed" | "fresh";

/** A mirror branch that holds commits the working vault cannot reach. */
export interface MirrorDivergence {
  branch: string;
  /** Commits in the mirror branch unreachable from the working vault. */
  pending: number;
  /** True when the branch no longer exists upstream, so a prune would delete it. */
  deletedUpstream: boolean;
}

/** Divergence plus whether last-refresh markers were available to compare against. */
export interface MirrorDivergenceReport {
  divergences: MirrorDivergence[];
  /**
   * False for a mirror created before markers existed. Without them the guard
   * cannot tell a Mac history rewrite from a phone push, so it stays strict.
   */
  markersPresent: boolean;
}

/**
 * Namespace recording each branch tip as of the last successful refresh.
 *
 * Substrate rewrites vault history when the user purges notes or empties the
 * trash, which makes every superseded commit unreachable from the working
 * vault. Without a record of what the Mac itself published, the guard would
 * read those commits as unpulled phone work and refuse forever.
 */
const MARKER_PREFIX = "refs/substrate/last-refresh/";
const HEADS_PREFIX = "refs/heads/";

async function git(args: string[], options?: { env?: NodeJS.ProcessEnv; input?: string }): Promise<string> {
  try {
    const child = execFileAsync("git", args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    if (options?.input !== undefined) {
      child.child.stdin?.end(options.input);
    }
    const { stdout } = await child;
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Full `refname` -> `objectname` for every ref under the given namespaces.
 *
 * Keying on the full refname rather than `%(refname:short)` matters because
 * shortening is context dependent: a `v1` tag alongside a `v1` branch makes
 * that branch shorten to `heads/v1` in one repository and `v1` in the other,
 * so the two sides would no longer compare against each other.
 */
async function readRefs(gitArgs: string[], namespaces: string[]): Promise<Map<string, string>> {
  const output = await git([...gitArgs, "for-each-ref", "--format=%(refname) %(objectname)", ...namespaces]);
  const refs = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const separator = line.lastIndexOf(" ");
    if (separator === -1) continue;
    refs.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return refs;
}

/** `refs/heads/main` -> `main`; other namespaces keep their full name. */
function shortBranch(refname: string): string {
  return refname.startsWith(HEADS_PREFIX) ? refname.slice(HEADS_PREFIX.length) : refname;
}

/**
 * Quote a path for `GIT_ALTERNATE_OBJECT_DIRECTORIES`, whose entries are
 * `:`-separated. Git accepts a double-quoted entry with C-style escapes, which
 * is the only way a vault path containing a colon can be passed at all.
 */
export function quoteAlternatePath(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Let a command run in the mirror read the working repository's objects too.
 *
 * The working vault has never seen phone commits and the mirror has not yet
 * fetched new Mac commits, so neither repository alone can compare the two
 * sides. Borrowing the source object store makes the mirror the one place
 * where both tips are readable, without writing anything to either repo.
 */
async function sourceObjectsEnv(source: string): Promise<NodeJS.ProcessEnv> {
  const objects = await git(["-C", source, "rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  return { GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteAlternatePath(objects) };
}

/**
 * Fail loudly if the running Git cannot read the borrowed object store.
 *
 * Git reports an unusable alternates entry on stderr while still exiting 0, so
 * a silent misread would look like "no divergence" — the one wrong answer that
 * loses commits. Checking once up front turns that into a clear error.
 */
async function assertAlternateUsable(mirror: string, env: NodeJS.ProcessEnv): Promise<void> {
  let stderr = "";
  try {
    const result = await execFileAsync("git", ["--git-dir", mirror, "cat-file", "-t", "HEAD"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    stderr = result.stderr;
  } catch (error) {
    stderr = (error as { stderr?: string }).stderr ?? "";
  }
  if (/alternate object path|info\/alternates/.test(stderr)) {
    throw new Error(
      "this Git cannot read the working vault's object store through "
      + `GIT_ALTERNATE_OBJECT_DIRECTORIES (${env.GIT_ALTERNATE_OBJECT_DIRECTORIES}): ${stderr.trim()}. `
      + "Move the vault to a path without characters Git cannot quote, or upgrade Git.",
    );
  }
}

/**
 * Branches whose mirror tip holds commits neither the working vault nor the
 * last refresh can account for.
 *
 * Such commits are phone pushes that were never pulled into the working vault.
 * A `git fetch --prune` into a `--mirror` clone uses a forced refspec, so
 * refreshing while they exist would silently discard them.
 *
 * The last-refresh markers are the second exclusion set, and they are what
 * keeps the guard from firing on Substrate's own history rewrites: after a
 * purge or an amend the mirror still holds the pre-rewrite commits, but every
 * one of them is reachable from a marker, so nothing counts as pending.
 */
export async function findMirrorDivergenceReport(
  source: string,
  mirror: string,
): Promise<MirrorDivergenceReport> {
  const [sourceRefs, mirrorRefs, markerRefs, env] = await Promise.all([
    readRefs(["-C", source], ["refs/heads"]),
    readRefs(["--git-dir", mirror], ["refs/heads"]),
    readRefs(["--git-dir", mirror], [MARKER_PREFIX.replace(/\/$/, "")]),
    sourceObjectsEnv(source),
  ]);
  await assertAlternateUsable(mirror, env);

  const sourceTips = [...sourceRefs.values()];
  const markerTips = [...markerRefs.values()];
  const divergences: MirrorDivergence[] = [];

  for (const [refname, mirrorTip] of mirrorRefs) {
    const sourceTip = sourceRefs.get(refname);
    // A branch missing upstream is measured against every source branch: a
    // deleted branch already merged elsewhere carries no unique work.
    const upstream = sourceTip === undefined ? sourceTips : [sourceTip];
    // Markers are pooled across branches for the same reason: a rewrite can
    // move work between branches without any of it being new phone work.
    const exclusions = [...upstream, ...markerTips].map((tip) => `^${tip}`);
    const count = await git(
      ["--git-dir", mirror, "rev-list", "--count", mirrorTip, ...exclusions],
      { env },
    );
    const pending = Number(count);
    if (!Number.isInteger(pending)) {
      throw new Error(`could not count mirror-only commits on ${shortBranch(refname)}: ${count}`);
    }
    if (pending > 0) {
      divergences.push({
        branch: shortBranch(refname),
        pending,
        deletedUpstream: sourceTip === undefined,
      });
    }
  }

  return { divergences, markersPresent: markerRefs.size > 0 };
}

/** Backwards-compatible view of {@link findMirrorDivergenceReport}. */
export async function findMirrorDivergence(source: string, mirror: string): Promise<MirrorDivergence[]> {
  return (await findMirrorDivergenceReport(source, mirror)).divergences;
}

/**
 * Record the mirror's current branch tips as last-refresh markers.
 *
 * Always called *after* the fetch: the `--mirror` refspec `+refs/*:refs/*` with
 * `--prune` deletes anything the source lacks, which includes this namespace,
 * so markers written before a fetch would not survive it.
 */
export async function writeRefreshMarkers(mirror: string): Promise<void> {
  const [heads, markers] = await Promise.all([
    readRefs(["--git-dir", mirror], ["refs/heads"]),
    readRefs(["--git-dir", mirror], [MARKER_PREFIX.replace(/\/$/, "")]),
  ]);
  const commands: string[] = [];
  for (const [refname] of markers) {
    if (!heads.has(`${HEADS_PREFIX}${refname.slice(MARKER_PREFIX.length)}`)) {
      commands.push(`delete ${refname}`);
    }
  }
  for (const [refname, tip] of heads) {
    commands.push(`update ${MARKER_PREFIX}${shortBranch(refname)} ${tip}`);
  }
  if (commands.length === 0) return;
  await git(["--git-dir", mirror, "update-ref", "--stdin"], { input: `${commands.join("\n")}\n` });
}

export function describeDivergence(divergences: MirrorDivergence[], markersPresent = true): string {
  const branches = divergences
    .map((entry) => {
      const commits = entry.pending === 1 ? "1 commit" : `${entry.pending} commits`;
      const suffix = entry.deletedUpstream ? ", branch missing from the working vault" : "";
      return `${entry.branch} (${commits}${suffix})`;
    })
    .join(", ");
  const lines = [
    `refusing to refresh: the mirror holds commits the working vault cannot reach: ${branches}.`,
    "A mirror refresh fetches with a forced refspec and would discard them.",
  ];
  if (!markersPresent) {
    lines.push(
      "This mirror has no last-refresh markers yet (it predates them), so a Mac"
      + " history rewrite cannot be told apart from a phone push and every"
      + " superseded commit is counted. One forced refresh writes the markers"
      + " and later rewrites will pass on their own.",
    );
  }
  lines.push(
    "If the phone pushed them, pull them into the working vault first, for example:",
    '  git -C "$HOME/Vault" remote add vault-sync <mirror path>   # once',
    '  git -C "$HOME/Vault" pull --ff-only vault-sync main',
    "Then rerun this command.",
    "If instead these mirror-only commits are disposable, refresh with --force.",
    "  Warning: --force discards them permanently; they exist nowhere else.",
  );
  return lines.join("\n");
}

/**
 * Create or refresh the bare mirror served by the vault sync endpoint.
 *
 * This operation only copies from the working repository to the mirror. It
 * deliberately has no push-back mode: phone commits pushed to the mirror must
 * be pulled into the working vault with an explicit Git command. The refresh
 * path refuses to run while such commits are still only in the mirror, unless
 * `force` is set.
 */
export async function syncMirror(options: MirrorOptions): Promise<MirrorResult> {
  const requestedSource = resolve(options.source);
  const source = resolve(await git(["-C", requestedSource, "rev-parse", "--show-toplevel"]));
  const sourceIsBare = await git(["-C", source, "rev-parse", "--is-bare-repository"]);
  if (sourceIsBare !== "false") {
    throw new Error(`source must be a working repository, not a bare repository: ${source}`);
  }

  const mirror = resolve(options.mirror);
  if (mirror === source || mirror.startsWith(`${source}${sep}`)) {
    throw new Error("mirror must live outside the working repository");
  }

  if (!(await exists(mirror))) {
    await git(["clone", "--mirror", source, mirror]);
    await writeRefreshMarkers(mirror);
    return "created";
  }

  const mirrorIsBare = await git(["-C", mirror, "rev-parse", "--is-bare-repository"]);
  if (mirrorIsBare !== "true") {
    throw new Error(`mirror destination is not a bare Git repository: ${mirror}`);
  }

  if (!options.force) {
    const { divergences, markersPresent } = await findMirrorDivergenceReport(source, mirror);
    if (divergences.length > 0) throw new Error(describeDivergence(divergences, markersPresent));
  }

  // Keep origin truthful if the working vault moved since the first clone.
  await git(["-C", mirror, "remote", "set-url", "origin", source]);

  const namespaces = ["refs/heads", "refs/tags"];
  const [before, sourceRefs] = await Promise.all([
    readRefs(["--git-dir", mirror], namespaces),
    readRefs(["-C", source], namespaces),
  ]);
  const alreadyFresh = before.size === sourceRefs.size
    && [...sourceRefs].every(([name, tip]) => before.get(name) === tip);

  await git(["-C", mirror, "fetch", "--prune", "origin"]);
  // After the fetch, never before: `--prune` with the mirror refspec deletes
  // the marker namespace, which the source does not have.
  await writeRefreshMarkers(mirror);
  return alreadyFresh ? "fresh" : "refreshed";
}

export function parseMirrorArgs(argv: string[]): MirrorOptions {
  let source = "";
  let mirror = "";
  let force = false;
  let quietIfFresh = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };

    switch (argument) {
      case "--source":
        source = value();
        break;
      case "--mirror":
        mirror = value();
        break;
      case "--force":
        force = true;
        break;
      case "--quiet-if-fresh":
        quietIfFresh = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: node mirror.ts --source <working-repo> --mirror <bare-mirror> [--force] [--quiet-if-fresh]",
        );
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- the case above ends in process.exit()
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!source) throw new Error("missing required --source <working-repo>");
  if (!mirror) throw new Error("missing required --mirror <bare-mirror>");
  return { source, mirror, force, quietIfFresh };
}

async function main(): Promise<void> {
  const options = parseMirrorArgs(process.argv.slice(2));
  const result = await syncMirror(options);
  if (result === "fresh" && options.quietIfFresh) return;
  const label = result === "fresh" ? "already up to date:" : `${result}`;
  console.log(`${label} bare vault mirror at ${resolve(options.mirror)}`);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
