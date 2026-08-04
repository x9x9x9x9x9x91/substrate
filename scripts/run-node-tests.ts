import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Keep the suite's topology explicit. Shell globs that match nothing are
// passed literally to `node --test`, which exits successfully with zero tests;
// checking each root here turns a missing/excluded suite into a loud failure.
const roots = [
  "src/lib",
  "scripts",
  "scripts/lib",
  "scripts/vault-sync-server",
  "scripts/handoff-relay",
];

const files: string[] = [];
for (const root of roots) {
  let matches: string[];
  try {
    matches = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => join(root, entry.name))
      .sort();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`test suite root is missing or unreadable: ${root}\n${detail}`);
    process.exit(1);
  }
  if (matches.length === 0) {
    console.error(`test suite root matched no *.test.ts files: ${root}`);
    process.exit(1);
  }
  files.push(...matches);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
