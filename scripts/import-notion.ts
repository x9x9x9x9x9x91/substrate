#!/usr/bin/env node
/**
 * Notion → Substrate vault importer (one-shot, pilot: 🛒 Shopping List).
 *
 * Pulls one Notion database via the public API and writes one markdown note
 * per row into a vault folder for in-app review. Notion properties become
 * frontmatter props (names lowercased, spaces → _), `type` is forced so the
 * rows form a Substrate database, and page bodies become the note body.
 *
 * Usage:
 *   NOTION_TOKEN=secret_… node scripts/import-notion.ts [options]
 *
 * Options:
 *   --database <id|name>   Database id, or name to find via search
 *                          (default: env NOTION_DATABASE_ID / NOTION_DATABASE_NAME,
 *                           else "🛒 Shopping List")
 *   --folder <path>        Vault-relative target folder (default: "Import/Shopping List")
 *   --type <value>         Frontmatter `type` for imported rows (default: "shopping")
 *   --dry-run              Print the notes that would be written, write nothing
 *   --map <prop>=<key>     Rename a Notion property in frontmatter (repeatable);
 *                          use for props whose derived key collides with a
 *                          reserved key, e.g. --map type=category
 *   --fixture <file.json>  Read a saved API payload instead of calling Notion
 *                          (shape: { database, pages: [], blocks: { pageId: [] } })
 *
 * Environment:
 *   NOTION_TOKEN  Integration token — required for live runs, never stored or logged.
 *   VAULT_DIR     Vault root — REQUIRED, there is no default: an
 *                 unset target would silently write into the real ~/Vault.
 *                 Point at a scratch dir to test.
 *
 * Re-running is safe: pages whose `notion_id` already exists in the target
 * folder are skipped, so a second run only picks up new rows. A page whose
 * title collides with an existing note in the folder (a different Notion
 * page, or a note that was never imported) is written under a numeric
 * suffix — existing files are never overwritten.
 *
 * Titles run through the same guards as the engine (mirrored in
 * scripts/vault-title.ts): a page titled with a leading dot or `[`/`]` is
 * rejected and never written — the scripts write files directly, so the
 * engine's own create-time validation never sees them.
 */

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { guardedSlug } from "./vault-title.ts";
import { resolveVault, writeAtomic } from "./vault-target.ts";

const NOTION_VERSION = "2022-06-28";
const DEFAULT_DATABASE_NAME = "🛒 Shopping List";

// ---------- Notion API shapes (only the fields this script reads) ----------

interface RichText {
  plain_text: string;
}

interface NotionDatabase {
  id: string;
  title: RichText[];
}

interface NotionProperty {
  type: string;
  [key: string]: unknown;
}

interface NotionPage {
  id: string;
  created_time: string;
  properties: Record<string, NotionProperty>;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

interface Fixture {
  database: NotionDatabase;
  pages: NotionPage[];
  blocks: Record<string, NotionBlock[]>;
}

// ---------- CLI ----------

export interface Options {
  database?: string;
  folder: string;
  type: string;
  dryRun: boolean;
  fixture?: string;
  /** Notion property name → frontmatter key overrides (applied before propKey). */
  map?: Record<string, string>;
}

export interface ImportReport {
  /** Vault-relative note paths written (or that would be written, on dry-run). */
  written: string[];
  /** notion_ids skipped — already imported into the target folder. */
  skipped: string[];
  /** Pages whose title the engine's guards refuse — never written. */
  rejected: { title: string; reason: string }[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    folder: "Import/Shopping List",
    type: "shopping",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--database": opts.database = value(); break;
      case "--folder": opts.folder = value().replace(/^\/+|\/+$/g, ""); break;
      case "--type": opts.type = value(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--fixture": opts.fixture = value(); break;
      case "--map": {
        const [from, to] = value().split("=");
        if (!from || !to) throw new Error("--map needs <notion prop>=<frontmatter key>");
        (opts.map ??= {})[from] = to;
        break;
      }
      case "--help":
      case "-h":
        console.log("See header comment of scripts/import-notion.ts");
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- the case above ends in process.exit()
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

// ---------- Notion client (fetch, token from env) ----------

export type NotionClient = {
  findDatabase: (nameOrId: string) => Promise<NotionDatabase>;
  queryPages: (databaseId: string) => Promise<NotionPage[]>;
  blockChildren: (blockId: string) => Promise<NotionBlock[]>;
};

export function liveClient(token: string): NotionClient {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    // Notion's public API allows ~3 req/s and long imports will hit 429s;
    // 5xx blips happen on big paginated pulls. Both are retryable.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://api.notion.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 5) {
        throw new Error(`Notion ${method} ${path} failed: ${res.status} ${await res.text()}`);
      }
      const header = res.headers.get("retry-after");
      const retryAfter = header === null ? NaN : Number(header);
      const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter * 1000
        : Math.min(30_000, 1000 * 2 ** attempt);
      console.error(`  Notion ${res.status} on ${path}, retrying in ${Math.round(waitMs / 1000)}s…`);
      await res.text().catch(() => {});
      await sleep(waitMs);
    }
  }

  const looksLikeId = (s: string) => /^[0-9a-f]{32}$/i.test(s.replace(/-/g, ""));

  return {
    async findDatabase(nameOrId) {
      if (looksLikeId(nameOrId)) {
        return await call<NotionDatabase>(`/v1/databases/${nameOrId}`);
      }
      const res = await call<{ results: NotionDatabase[] }>("/v1/search", "POST", {
        query: nameOrId,
        filter: { property: "object", value: "database" },
        page_size: 10,
      });
      const exact = res.results.find(
        (d) => d.title.map((t) => t.plain_text).join("") === nameOrId,
      );
      const db = exact ?? res.results[0];
      if (!db) {
        throw new Error(
          `no Notion database found for "${nameOrId}". Is the integration shared with it?`,
        );
      }
      if (!exact) {
        console.log(
          `note: no exact title match; using "${db.title.map((t) => t.plain_text).join("")}"`,
        );
      }
      return db;
    },

    async queryPages(databaseId) {
      const pages: NotionPage[] = [];
      let cursor: string | undefined;
      do {
        const res: { results: NotionPage[]; has_more: boolean; next_cursor: string | null } =
          await call(`/v1/databases/${databaseId}/query`, "POST", {
            page_size: 100,
            start_cursor: cursor,
          });
        pages.push(...res.results);
        cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
      } while (cursor);
      return pages;
    },

    async blockChildren(blockId) {
      const blocks: NotionBlock[] = [];
      let cursor: string | undefined;
      do {
        const qs = cursor ? `?start_cursor=${cursor}` : "";
        const res: { results: NotionBlock[]; has_more: boolean; next_cursor: string | null } =
          await call(`/v1/blocks/${blockId}/children${qs}`);
        blocks.push(...res.results);
        cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
      } while (cursor);
      return blocks;
    },
  };
}

function fixtureClient(fixture: Fixture): NotionClient {
  return {
    async findDatabase() {
      return fixture.database;
    },
    async queryPages() {
      return fixture.pages;
    },
    async blockChildren(blockId) {
      return fixture.blocks[blockId] ?? [];
    },
  };
}

// ---------- Property mapping ----------

const richText = (v: unknown): string =>
  Array.isArray(v) ? (v as RichText[]).map((t) => t.plain_text).join("") : "";

/** Notion property name → frontmatter key ("Store Section" → "store_section"). */
function propKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** One Notion date endpoint → the vault's date grammar, or undefined if it
    isn't date-shaped. Notion writes a bare `2026-09-01` for a day and a full
    ISO instant (`2026-09-01T09:00:00.000+02:00`) when the date carries a
    time; the vault keeps `YYYY-MM-DD` with an optional ` HH:MM` and
    stores no seconds or zone, so the instant is truncated to its minute as
    written. */
function notionDate(raw: string | null | undefined): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(raw ?? "");
  if (!m) return undefined;
  return m[2] ? `${m[1]} ${m[2]}` : m[1];
}

/** Notion property → frontmatter value; undefined means "skip this prop".
    multi_select maps to a string list — the engine's `multi` kind expects a
    YAML block list on disk, not a comma-joined scalar. */
function propValue(prop: NotionProperty): string | number | boolean | string[] | undefined {
  switch (prop.type) {
    case "rich_text":
      return richText(prop.rich_text) || undefined;
    case "select":
    case "status": {
      const v = prop[prop.type] as { name?: string } | null;
      return v?.name || undefined;
    }
    case "multi_select": {
      const names = ((prop.multi_select as { name: string }[]) ?? []).map((o) => o.name);
      return names.length ? names : undefined;
    }
    case "number":
      return (prop.number as number | null) ?? undefined;
    case "date": {
      const d = prop.date as { start?: string; end?: string | null } | null;
      const start = notionDate(d?.start);
      if (!start) return undefined;
      const end = notionDate(d?.end);
      // Notion's end dates used to be dropped on the floor; the vault's date
      // grammar carries them now as `start/end`. An end that isn't
      // after the start is not a span — keep the plain start rather than
      // writing a value the engine would reject
      return end && end > start ? `${start}/${end}` : start;
    }
    case "checkbox":
      return Boolean(prop.checkbox);
    case "url":
    case "email":
    case "phone_number": {
      const v = prop[prop.type] as string | null;
      return v || undefined;
    }
    case "people": {
      const names = ((prop.people as { name?: string }[]) ?? [])
        .map((p) => p.name)
        .filter((n): n is string => Boolean(n));
      return names.length ? names.join(", ") : undefined;
    }
    case "created_time":
    case "last_edited_time": {
      const v = prop[prop.type] as string | null;
      return v ? v.slice(0, 10) : undefined;
    }
    default:
      // relation, formula, rollup, files, … — not mapped in the pilot
      return undefined;
  }
}

// ---------- Blocks → markdown ----------

function blockLine(block: NotionBlock): string {
  const payload = (block[block.type] ?? {}) as Record<string, unknown>;
  const text = richText(payload.rich_text);
  switch (block.type) {
    case "heading_1": return `# ${text}`;
    case "heading_2": return `## ${text}`;
    case "heading_3": return `### ${text}`;
    case "bulleted_list_item": return `- ${text}`;
    case "numbered_list_item": return `1. ${text}`;
    case "to_do": return `- [${payload.checked ? "x" : " "}] ${text}`;
    case "toggle": return `- ${text}`;
    case "quote":
    case "callout": return `> ${text}`;
    case "code": return `\`\`\`${payload.language ?? ""}\n${text}\n\`\`\``;
    case "divider": return "---";
    default: return text;
  }
}

export async function pageBody(client: NotionClient, pageId: string): Promise<string> {
  const lines: string[] = [];
  for (const block of await client.blockChildren(pageId)) {
    lines.push(blockLine(block));
    if (block.has_children) {
      for (const child of await client.blockChildren(block.id)) {
        const line = blockLine(child);
        if (line) lines.push(`  ${line}`);
      }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- Vault writing ----------

/** Minimal YAML scalar; quoted form stays valid for the engine's serde_yaml parse. */
function yamlScalar(v: string | number | boolean): string {
  if (typeof v !== "string") return String(v);
  // quote strings YAML would re-type as bool/null/number (e.g. an all-digit notion_id)
  if (/^(true|false|null|yes|no|on|off)$/i.test(v) || /^-?[\d.]+$/.test(v)) {
    return JSON.stringify(v);
  }
  // no `#` in the bare class: in YAML " #" starts a comment, so an unquoted
  // "SMP-030 # draft" would read back as just "SMP-030"
  if (/^[A-Za-z0-9][A-Za-z0-9 .,_&()+/'-]*$/.test(v) && !v.endsWith(":")) return v;
  return JSON.stringify(v);
}

function renderNote(props: Record<string, string | number | boolean | string[]>, body: string): string {
  const yaml = Object.keys(props)
    .sort()
    .map((k) => {
      const v = props[k];
      // block list — the on-disk form the engine writes for `multi` values
      if (Array.isArray(v)) return `${k}:\n${v.map((item) => `  - ${yamlScalar(item)}`).join("\n")}`;
      return `${k}: ${yamlScalar(v)}`;
    })
    .join("\n");
  return `---\n${yaml}\n---\n${body ? `${body}\n` : ""}`;
}

async function existingNotionIds(dir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return ids; // folder doesn't exist yet
  }
  for (const f of files.filter((f) => f.endsWith(".md"))) {
    const raw = await readFile(join(dir, f), "utf8");
    const m = raw.match(/^notion_id:\s*"?([0-9a-f]{32})"?\s*$/m);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// ---------- Import ----------

export async function run(opts: Options, vaultEnv?: string): Promise<ImportReport> {
  const vault = resolveVault(vaultEnv);
  const target = join(vault, ...opts.folder.split("/"));
  const dbRef =
    opts.database ?? process.env.NOTION_DATABASE_ID ?? process.env.NOTION_DATABASE_NAME ?? DEFAULT_DATABASE_NAME;

  let client: NotionClient;
  if (opts.fixture) {
    client = fixtureClient(JSON.parse(await readFile(opts.fixture, "utf8")) as Fixture);
  } else {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      throw new Error("NOTION_TOKEN is not set (provide it in the environment; it is never stored)");
    }
    client = liveClient(token);
  }

  const db = await client.findDatabase(dbRef);
  const dbTitle = db.title.map((t) => t.plain_text).join("");
  const pages = await client.queryPages(db.id);
  console.log(
    `${opts.dryRun ? "[dry-run] " : ""}database "${dbTitle}" → ${pages.length} row(s) → ${opts.folder}/`,
  );

  const known = await existingNotionIds(target);
  // Names already taken in the target folder (case-insensitive, like the
  // engine), seeded from disk so a page titled like an existing note gets a
  // numeric suffix instead of overwriting that note. The notion_id
  // skip in the loop runs before the name check, so a page's own
  // already-imported file is never treated as a collision.
  const usedNames = new Set(
    (await readdir(target).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.toLowerCase()),
  );
  const report: ImportReport = { written: [], skipped: [], rejected: [], dryRun: opts.dryRun };
  const unmapped = new Set<string>();

  for (const page of pages) {
    const notionId = page.id.replace(/-/g, "");
    if (known.has(notionId)) {
      report.skipped.push(notionId);
      continue;
    }

    const props: Record<string, string | number | boolean | string[]> = { type: opts.type };
    let title = "";
    for (const [name, prop] of Object.entries(page.properties)) {
      if (prop.type === "title") {
        title = richText(prop.title);
        continue;
      }
      const value = propValue(prop);
      if (value === undefined) {
        unmapped.add(`${name} (${prop.type})`);
        continue;
      }
      const key = opts.map?.[name] !== undefined ? opts.map[name] : propKey(name);
      if (key && !(key in props)) props[key] = value;
    }
    props.type = opts.type;
    if (page.created_time) props.created = page.created_time.slice(0, 10);
    props.notion_id = notionId;

    // Guards, mirrored for direct-to-disk imports: a title
    // the engine would refuse is reported, never written as an invisible
    // (dot-stem) or link-toxic (brackets) note
    let base: string;
    try {
      base = guardedSlug(title);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.log(`  ! rejected "${title}": ${reason}`);
      report.rejected.push({ title, reason });
      continue;
    }
    let name = base;
    for (let n = 2; usedNames.has(`${name.toLowerCase()}.md`); n++) name = `${base} ${n}`;
    usedNames.add(`${name.toLowerCase()}.md`);

    const body = await pageBody(client, page.id);
    const rel = `${opts.folder}/${name}.md`;
    if (opts.dryRun) {
      console.log(`\n--- ${rel}\n${renderNote(props, body)}`);
    } else {
      await mkdir(target, { recursive: true });
      // atomic: a truncated note would be skipped forever by the notion_id
      // dedupe above, so a retry could never heal it
      await writeAtomic(join(target, `${name}.md`), renderNote(props, body));
      console.log(`  wrote ${rel}`);
    }
    report.written.push(rel);
  }

  const skippedTypes = [...unmapped].filter((s) => !s.endsWith("(undefined)"));
  const failed =
    pages.length - report.written.length - report.skipped.length - report.rejected.length;
  console.log(
    `\n${opts.dryRun ? "would write" : "wrote"} ${report.written.length}, skipped ${report.skipped.length} already imported` +
      (report.rejected.length > 0 ? `, ${report.rejected.length} rejected by the title guard` : "") +
      (failed > 0 ? `, ${failed} failed` : ""),
  );
  if (skippedTypes.length) {
    console.log(`props left unmapped (empty or unsupported type): ${skippedTypes.join(", ")}`);
  }
  return report;
}

// ---------- Main ----------

async function main() {
  await run(parseArgs(process.argv.slice(2)));
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`import failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
