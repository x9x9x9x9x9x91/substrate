import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildViewEngine,
  VIEW_ENGINE_FILE,
  VIEW_ENGINE_STAGE,
  VIEW_ENGINE_TARGET,
} from "./build-view-engine.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A vault with one database, three tasks and a pin over them. */
function seedVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "view-engine-"));
  mkdirSync(join(dir, ".vault"), { recursive: true });
  mkdirSync(join(dir, "Tasks"), { recursive: true });
  writeFileSync(
    join(dir, ".vault/views.json"),
    JSON.stringify({
      $views: [
        {
          id: "open",
          name: "Open tasks",
          db: "task",
          query: "-status:done",
          columns: ["status", "due"],
          sorts: [{ key: "due", dir: 1 }],
        },
      ],
    }),
  );
  const note = (name: string, status: string, due: string) =>
    writeFileSync(
      join(dir, "Tasks", `${name}.md`),
      `---\ntype: task\nstatus: ${status}\ndue: ${due}\n---\n\n${name}\n`,
    );
  note("a", "doing", "2026-08-01");
  note("b", "done", "2026-07-01");
  note("c", "doing", "2026-06-01");
  return dir;
}

test("the built engine answers a request the way the source does", async () => {
  const out = mkdtempSync(join(tmpdir(), "view-engine-out-"));
  const built = await buildViewEngine(ROOT, join(out, VIEW_ENGINE_TARGET));
  const vault = seedVault();
  const request = JSON.stringify({ vault, view: "open", today: "2026-08-01" });

  // Bundling is where an engine quietly stops being one file that answers:
  // a module in the graph with a main block of its own would fire on the same
  // argv and print over this, and a CommonJS build would leave the entry's
  // own main block dead, so the request would be read and nothing written.
  // Both failures look like "no payload", which is what this asserts against.
  const answer = (script: string) =>
    JSON.parse(execFileSync(process.execPath, [script], { input: request, encoding: "utf8" }));

  const fromBuilt = answer(built);
  const fromSource = answer(join(ROOT, "scripts/view-read/viewengine.ts"));
  assert.equal(fromBuilt.ok, true, `the built engine refused: ${fromBuilt.error}`);
  assert.deepEqual(
    fromBuilt.payload.rows.map((r: { path: string }) => r.path),
    ["Tasks/c.md", "Tasks/a.md"],
    "the built engine's rows or their order drifted from the pin's own sort",
  );
  assert.deepEqual(fromBuilt, fromSource, "the built engine answers differently from its source");
});

test("the app names the built engine where the door looks for it", () => {
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")) as {
    build: { beforeDevCommand: string; beforeBuildCommand: string };
    bundle: { resources: Record<string, string> };
  };
  const key = `${VIEW_ENGINE_STAGE.replace("src-tauri/", "")}/`;
  assert.equal(
    conf.bundle.resources[key],
    VIEW_ENGINE_TARGET,
    `bundle.resources should carry the engine from ${key}`,
  );
  for (const hook of [conf.build.beforeDevCommand, conf.build.beforeBuildCommand]) {
    assert.match(hook, /build-view-engine\.ts/, "a build hook stopped building the engine");
  }

  // tauri-build copies every resource path on an ordinary `cargo build`, and a
  // path that is not there is a build error — so a bare `cargo build` needs
  // the directory seeded whether or not a hook ever ran.
  const buildRs = readFileSync(join(ROOT, "src-tauri/build.rs"), "utf8");
  assert.ok(buildRs.includes(`"${VIEW_ENGINE_TARGET}"`), "build.rs does not seed the engine's folder");

  // The resolver spells the target and the file name; three places have to
  // agree or the shipped door refuses on a machine that carries the engine.
  const resolver = readFileSync(join(ROOT, "src-tauri/src/mcpdoor/viewengine.rs"), "utf8");
  assert.ok(
    resolver.includes(`${VIEW_ENGINE_TARGET}/${VIEW_ENGINE_FILE}`),
    "the door resolves a different path than the build writes",
  );
});

test("run through a symlinked path, it still builds instead of reading as imported", () => {
  // A checkout reached through a symlink hands node the unresolved spelling
  // in argv while `import.meta.url` is the resolved one. Without realpath the
  // two never match, the file decides it was imported, and the build produces
  // nothing — while the app build around it still reports success and ships a
  // door that refuses every view read. The copy sits alone in a temp folder,
  // so a fired build fails loudly on its missing entry: exit 1 with the
  // script's own prefix is the guard firing, a silent exit 0 is it missing.
  const dir = mkdtempSync(join(tmpdir(), "view-engine-link-"));
  const real = join(dir, "build-view-engine.ts");
  const link = join(dir, "linked.ts");
  writeFileSync(real, readFileSync(join(ROOT, "scripts/build-view-engine.ts"), "utf8"));
  symlinkSync(real, link);

  const ran = spawnSync(process.execPath, [link], { encoding: "utf8" });
  assert.equal(ran.status, 1, `stdout: ${ran.stdout}\nstderr: ${ran.stderr}`);
  assert.match(ran.stderr, /build-view-engine:/);
});
