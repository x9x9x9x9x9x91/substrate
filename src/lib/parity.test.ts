/** Mock↔engine behavioral parity — the mock half of the harness.
 *
 *  The mock backend in `mockBackend.ts`, which `tauri.ts` loads in place of the
 *  Tauri transport, is a second implementation of
 *  the vault engine, kept in step by hand, and every required e2e spec trusts
 *  it. `check:ipc` pins the command signatures; the BEHAVIOR behind them has
 *  drifted repeatedly and been fixed one case at a time: filename dedupe,
 *  rename and delete link/index mappings, trash and backlink order,
 *  control-character refusal, excerpt and case-collision handling. This runner
 *  replays fixtures —
 *  `parity/fixtures/*.json`, plain data — against the mock; `vault/parity.rs`
 *  replays the same files against the real `Engine` in a scratch vault. The two
 *  runners share nothing but the JSON, and compare observable outcomes
 *  (returned paths, titles, list orders, error text), never internals.
 *
 *  A fixture owns a folder no other fixture touches, and every listing, search
 *  and trash observation is scoped to it — which is why the mock's seeded demo
 *  vault and the engine's empty scratch vault can run the same file without a
 *  reset seam on either side.
 *
 *  Adding a pin is adding a JSON file. See `parity/README.md` for the op
 *  vocabulary and the fixture-level keys.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
// jsdom globals + the .ts loader hook, installed at import time: `tauri.ts`
// reads `"__TAURI_INTERNALS__" in window` while it evaluates, so the window has
// to exist before the dynamic import below pulls it in (same idiom as the
// component tests).
import "./componentHarness.ts";

export const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "parity",
  "fixtures",
);

export interface ParityOp {
  op: string;
  /** This one op is a known mock divergence: the engine's answer stays pinned
      in `expect`, and this runner asserts the mock still gets it WRONG, so the
      marker fails the run the day the mock is fixed. Only mark an op whose
      wrong answer leaves the rest of the scenario on script — a read, or a
      write whose divergence is confined to what a marked read observes. */
  pendingMock?: boolean;
  [key: string]: unknown;
}

export interface ParityFixture {
  name: string;
  summary: string;
  /** The past drift this scenario pins, named as behavior. */
  drift?: string[];
  folder: string;
  requires?: string[];
  /** Why some of this scenario's ops carry `pendingMock`: what the mock does
      instead, named as behavior. The Rust runner holds the whole pin; this one
      runs every op, strictly, and inverts the assertion on the marked ones. */
  pendingMock?: string;
  ops: ParityOp[];
}

export const loadFixtures = (): ParityFixture[] =>
  readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as ParityFixture);

/** A note meta as both backends project it. */
interface Meta {
  path: string;
  title: string;
  excerpt: string;
  props: Record<string, unknown>;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const inScope = (folder: string, path: string) =>
  path === folder || path.startsWith(`${folder}/`);

const scoped = (folder: string, paths: string[]) => paths.filter((p) => inScope(folder, p));

/** The observable outcome of one op — the same projection `vault/parity.rs`
    builds, so the two are comparable field for field. */
async function observe(
  invoke: Invoke,
  folder: string,
  op: ParityOp,
): Promise<Record<string, unknown>> {
  switch (op.op) {
    case "create": {
      const m = await invoke<Meta>("vault_create", {
        title: op.title,
        folder: (op.folder as string | undefined) ?? folder,
        noteType: op.type ?? null,
        body: op.body ?? null,
      });
      return { path: m.path, title: m.title };
    }
    case "rename": {
      const r = await invoke<{ meta: Meta; touched: string[] }>("vault_rename", {
        path: op.path,
        title: op.title,
      });
      // the engine collects link sources through a HashSet, so its `touched`
      // order is hash order — the SET is the shared observable
      return { path: r.meta.path, title: r.meta.title, touched: [...r.touched].sort() };
    }
    case "setProp": {
      const r = await invoke<{ meta: Meta; prior: unknown }>("vault_set_prop", {
        path: op.path,
        key: op.key,
        value: op.value ?? null,
      });
      return { value: r.meta.props[op.key as string] ?? null, prior: r.prior ?? null };
    }
    case "delete": {
      // the trash id embeds a clock stamp, so it is not a shared observable;
      // what the trash then LISTS is (see the trashList op)
      await invoke<string>("vault_delete", { path: op.path });
      return { trashed: true };
    }
    case "deleteMany": {
      const rows = await invoke<Array<{ Ok?: string; Err?: string }>>("vault_delete_many", {
        paths: op.paths,
      });
      return { results: rows.map((r) => ("Ok" in r ? "ok" : r.Err)) };
    }
    case "list": {
      const rows = await invoke<Meta[]>("vault_list");
      return { paths: scoped(folder, rows.map((r) => r.path)).sort() };
    }
    case "trashList": {
      // order is the observable here: `deleted_ms DESC, path ASC`
      const rows = await invoke<Array<{ path: string }>>("vault_trash_list");
      return { paths: scoped(folder, rows.map((r) => r.path)) };
    }
    case "search": {
      const rows = await invoke<Array<{ path: string }>>("vault_search", {
        q: op.q,
        scope: null,
        excludeAppFiles: false,
      });
      // FTS `rank` and the mock's own ranking are not a shared observable; the
      // hit set inside the fixture's folder is
      return { paths: scoped(folder, rows.map((r) => r.path)).sort() };
    }
    case "backlinks": {
      const rows = await invoke<Meta[]>("vault_backlinks", { path: op.path });
      // order is the observable here: title ASC
      return { paths: scoped(folder, rows.map((r) => r.path)) };
    }
    case "note": {
      const rows = await invoke<Meta[]>("vault_list");
      const m = rows.find((r) => r.path === op.path);
      if (!m) throw new Error("note not found");
      return { title: m.title, type: m.props.type ?? null, excerpt: m.excerpt };
    }
    case "body": {
      const c = await invoke<{ body: string }>("vault_read", { path: op.path });
      return { body: c.body };
    }
    default:
      throw new Error(`unknown parity op "${op.op}"`);
  }
}

/** The op as the failure message names it — everything but its expectation. */
export const describeOp = (op: ParityOp): string => {
  const { expect: _expect, ...rest } = op;
  return JSON.stringify(rest);
};

/** Shared with the Rust runner, word for word, so a divergence reads the same
    whichever side reported it. */
export const divergence = (
  fixture: string,
  index: number,
  op: ParityOp,
  expected: unknown,
  actual: unknown,
): string =>
  `parity divergence — fixture ${fixture}, op #${index + 1} ${describeOp(op)}\n` +
  `  expected (engine-pinned): ${JSON.stringify(expected)}\n` +
  `  actual (mock):            ${JSON.stringify(actual)}`;

/** The message a marked op fails with once the mock catches up. A pending
    marker that no longer describes anything is worse than no marker: it reads
    as a live gap and silences a real pin. So it expires by failing. */
export const resolved = (fixture: string, index: number, op: ParityOp): string =>
  `divergence resolved — remove the marker: fixture ${fixture}, op #${index + 1} ` +
  `${describeOp(op)} carries pendingMock, but the mock now matches the engine pin. ` +
  `Drop \`"pendingMock": true\` from this op (and the fixture's pendingMock note ` +
  `once no op in it is still marked).`;

const fixtures = loadFixtures();

test("parity fixtures exist", () => {
  assert.ok(fixtures.length > 0, `no fixtures under ${FIXTURE_DIR}`);
});

test("a pendingMock note names ops, and marked ops carry a note", () => {
  for (const fixture of fixtures) {
    const marked = fixture.ops.filter((op) => op.pendingMock);
    if (fixture.pendingMock) {
      // the whole-fixture skip this replaced hid every op the mock agrees on
      assert.ok(
        marked.length > 0,
        `fixture ${fixture.name} carries a pendingMock note but marks no op — a note ` +
          `without a marked op skips nothing and expires never; mark the diverging ops ` +
          `or drop the note`,
      );
      assert.ok(
        marked.length < fixture.ops.length,
        `fixture ${fixture.name} marks every op as pendingMock, which is the whole-fixture ` +
          `skip again; split the ops the mock agrees on into their own fixture`,
      );
    } else {
      assert.equal(
        marked.length,
        0,
        `fixture ${fixture.name} marks ops as pendingMock without a fixture-level note ` +
          `saying what the mock does instead`,
      );
    }
  }
});

for (const fixture of fixtures) {
  test(`parity (mock): ${fixture.name} — ${fixture.summary}`, async () => {
    const { invoke } = (await import("./tauri.ts")) as { invoke: Invoke };
    for (const [index, op] of fixture.ops.entries()) {
      let actual: Record<string, unknown>;
      try {
        actual = await observe(invoke, fixture.folder, op);
      } catch (error) {
        actual = { error: error instanceof Error ? error.message : String(error) };
      }
      const expected = op.expect as Record<string, unknown>;
      if (op.pendingMock) {
        // the engine's answer stays pinned in `expect`; here the mock is
        // asserted to still be wrong, so the marker cannot outlive the gap
        assert.notDeepStrictEqual(actual, expected, resolved(fixture.name, index, op));
        continue;
      }
      assert.deepStrictEqual(
        actual,
        expected,
        divergence(fixture.name, index, op, expected, actual),
      );
    }
  });
}
