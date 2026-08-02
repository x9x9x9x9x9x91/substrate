#!/usr/bin/env node

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { findMirrorDivergence, quoteAlternatePath } from "./mirror.ts";

const execFileAsync = promisify(execFile);

export interface StatusOptions {
  source: string;
  mirror: string;
}

/** Exit codes, chosen so a shell check can branch on them directly. */
export const STATUS_FRESH = 0;
export const STATUS_STALE = 1;
export const STATUS_DIVERGED = 2;
export const STATUS_ERROR = 3;

export type StatusCode =
  | typeof STATUS_FRESH
  | typeof STATUS_STALE
  | typeof STATUS_DIVERGED
  | typeof STATUS_ERROR;

export interface StatusReport {
  code: StatusCode;
  /** One plain-text summary line, suitable for a dashboard or shell check. */
  line: string;
}

async function git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
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

function commits(count: number): string {
  return count === 1 ? "1 commit" : `${count} commits`;
}

/** True when HEAD names a branch that has no commit yet. */
async function isUnborn(source: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", source, "rev-parse", "--verify", "--quiet", "HEAD"], {
      encoding: "utf8",
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * Compare the served mirror against the working vault without changing either.
 *
 * Divergence outranks staleness: unpulled phone commits are the state that
 * blocks a refresh, so they are what an operator has to act on first.
 */
export async function reportMirrorStatus(options: StatusOptions): Promise<StatusReport> {
  const requestedSource = resolve(options.source);
  const mirror = resolve(options.mirror);

  if (!(await exists(requestedSource))) {
    return { code: STATUS_ERROR, line: `error: source working repository not found: ${requestedSource}` };
  }
  if (!(await exists(mirror))) {
    return { code: STATUS_ERROR, line: `error: bare mirror not found: ${mirror}` };
  }

  let source: string;
  try {
    source = resolve(await git(["-C", requestedSource, "rev-parse", "--show-toplevel"]));
    if (await git(["-C", source, "rev-parse", "--is-bare-repository"]) !== "false") {
      return { code: STATUS_ERROR, line: `error: source is a bare repository, not a working vault: ${source}` };
    }
    if (await git(["--git-dir", mirror, "rev-parse", "--is-bare-repository"]) !== "true") {
      return { code: STATUS_ERROR, line: `error: mirror is not a bare Git repository: ${mirror}` };
    }
  } catch (error) {
    return { code: STATUS_ERROR, line: `error: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    const divergences = await findMirrorDivergence(source, mirror);
    if (divergences.length > 0) {
      const total = divergences.reduce((sum, entry) => sum + entry.pending, 0);
      const detail = divergences
        .map((entry) => `${entry.branch} +${entry.pending}${entry.deletedUpstream ? " (missing upstream)" : ""}`)
        .join(", ");
      return {
        code: STATUS_DIVERGED,
        line: `diverged: mirror holds ${commits(total)} not in the working vault — ${detail}; pull before refreshing`,
      };
    }

    // The vault's own current branch is the one the phone exchanges.
    const branch = await git(["-C", source, "branch", "--show-current"]);
    if (!branch) {
      return { code: STATUS_ERROR, line: `error: source working repository has no current branch: ${source}` };
    }
    // An unborn HEAD has a branch name but no commit; asking rev-parse for it
    // spills a multi-line Git hint, so check reachability first and stay to one
    // line as every other branch of this function does.
    if (await isUnborn(source)) {
      return {
        code: STATUS_ERROR,
        line: `error: source working repository has no commits on ${branch} yet: ${source}`,
      };
    }
    const sourceTip = await git(["-C", source, "rev-parse", branch]);
    const mirrorRef = await git(["--git-dir", mirror, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]);
    if (!mirrorRef) {
      return {
        code: STATUS_STALE,
        line: `stale: mirror has no ${branch} branch yet; refresh to publish it`,
      };
    }
    if (mirrorRef === sourceTip) {
      return { code: STATUS_FRESH, line: `fresh: mirror ${branch} matches the working vault at ${sourceTip.slice(0, 12)}` };
    }

    const objects = await git(["-C", source, "rev-parse", "--path-format=absolute", "--git-path", "objects"]);
    const behind = Number(await git(
      ["--git-dir", mirror, "rev-list", "--count", sourceTip, `^${mirrorRef}`],
      // Entries are `:`-separated, so a vault path containing a colon only
      // works quoted. See mirror.ts for the same treatment.
      { GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteAlternatePath(objects) },
    ));
    if (!Number.isInteger(behind)) {
      return { code: STATUS_ERROR, line: `error: could not count commits behind on ${branch}` };
    }
    return {
      code: STATUS_STALE,
      line: `stale: mirror ${branch} is ${commits(behind)} behind the working vault; run mirror.ts to refresh`,
    };
  } catch (error) {
    return { code: STATUS_ERROR, line: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function parseStatusArgs(argv: string[]): StatusOptions {
  let source = "";
  let mirror = "";

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
      case "--help":
      case "-h":
        console.log(
          "Usage: node status.ts --source <working-repo> --mirror <bare-mirror>"
          + "  (exit 0 fresh, 1 stale, 2 diverged, 3 error)",
        );
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- the case above ends in process.exit()
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!source) throw new Error("missing required --source <working-repo>");
  if (!mirror) throw new Error("missing required --mirror <bare-mirror>");
  return { source, mirror };
}

async function main(): Promise<void> {
  const report = await reportMirrorStatus(parseStatusArgs(process.argv.slice(2)));
  console.log(report.line);
  process.exitCode = report.code;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = STATUS_ERROR;
  });
}
