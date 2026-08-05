#!/usr/bin/env node
/**
 * Notion body backfill: the MCP-based migration copied properties
 * but often not page bodies. This walks the vault for notes carrying a
 * `notion_id` whose body is EMPTY, fetches the page's blocks, and writes the
 * rendered markdown below the frontmatter. Props and non-empty bodies are
 * never touched — a note the user has since written into is left alone.
 *
 * Usage:
 *   NOTION_TOKEN=... node scripts/backfill-notion-bodies.ts [--dry-run] [--folder <path>]
 *
 *   --dry-run          Print which notes would gain a body, write nothing
 *   --folder <path>    Restrict to one vault-relative folder (repeatable)
 *
 * Env:
 *   NOTION_TOKEN  Integration token (required)
 *   VAULT_DIR     Vault root — REQUIRED, there is no default: an
 *                 unset target would silently rewrite the real ~/Vault.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { liveClient, pageBody, type NotionClient } from "./import-notion.ts";
import { resolveVault, writeAtomic } from "./vault-target.ts";

interface BackfillOptions {
  dryRun: boolean;
  folders: string[]; // vault-relative; empty = whole vault
}

export interface BackfillReport {
  /** vault-relative paths that gained a body */
  filled: string[];
  /** notion_ids whose page has no content blocks */
  emptyInNotion: string[];
  /** notion_ids the API refused (page deleted / not shared) */
  failed: string[];
}

function parseArgs(argv: string[]): BackfillOptions {
  const opts: BackfillOptions = { dryRun: false, folders: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--folder": {
        const v = argv[++i];
        if (!v) throw new Error("--folder needs a value");
        opts.folders.push(v.replace(/^\/+|\/+$/g, ""));
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function mdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await mdFiles(p)));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export async function backfill(
  opts: BackfillOptions,
  client: NotionClient,
  vaultEnv?: string,
): Promise<BackfillReport> {
  const vault = resolveVault(vaultEnv);
  const roots = opts.folders.length
    ? opts.folders.map((f) => join(vault, ...f.split("/")))
    : [vault];

  const report: BackfillReport = { filled: [], emptyInNotion: [], failed: [] };
  for (const root of roots) {
    for (const file of await mdFiles(root)) {
      const raw = await readFile(file, "utf8");
      const m = FRONTMATTER.exec(raw);
      if (!m || m[2].trim() !== "") continue; // no frontmatter, or body already written
      const id = /^notion_id:\s*"?([0-9a-f]{32})"?\s*$/m.exec(m[1])?.[1];
      if (!id) continue;

      const rel = relative(vault, file);
      let body: string;
      try {
        body = await pageBody(client, id);
      } catch (e) {
        report.failed.push(id);
        console.error(`  FAILED ${rel}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (!body) {
        report.emptyInNotion.push(id);
        continue;
      }
      report.filled.push(rel);
      if (opts.dryRun) {
        console.log(`[dry-run] would fill ${rel} (${body.length} chars)`);
      } else {
        await writeAtomic(file, `---\n${m[1]}\n---\n${body}\n`);
        console.log(`  filled ${rel}`);
      }
    }
  }
  return report;
}

const invokedDirectly =
  process.argv[1]?.endsWith("backfill-notion-bodies.ts") ?? false;

if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error("NOTION_TOKEN is required");
    process.exit(1);
  }
  backfill(opts, liveClient(token))
    .then((r) => {
      const verb = opts.dryRun ? "would fill" : "filled";
      console.log(
        `\n${verb} ${r.filled.length}, empty in Notion ${r.emptyInNotion.length}, failed ${r.failed.length}`,
      );
      if (r.failed.length) process.exit(1);
    })
    .catch((e) => {
      console.error(`backfill failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
