/** Real-app smoke driver (SUB-426).
 *
 * The 312 e2e flows run against the handwritten mock backend in `tauri.ts` —
 * fast, but the Rust↔TS bridge is never crossed, so real-IPC-only bugs (a
 * snake_case arg silently dropped, a live-only crash) sail through that gate.
 * tauri-driver/WebDriver has no macOS support, so instead of driving the app
 * from outside, this module runs a scripted flow from INSIDE the real app,
 * through the real `ipc.ts` wrappers, against a real scratch vault on disk.
 *
 * It is loaded only when `VITE_SUBSTRATE_SMOKE=1` was set at build/dev time
 * (see `main.tsx`); with the flag unset the dynamic import sits behind a
 * statically-false condition and never reaches the production bundle. Its two
 * Rust hooks refuse without `SUBSTRATE_SMOKE=1` on top of that.
 *
 * Contract with `scripts/smoke-real.sh`:
 *   - `$SUBSTRATE_SMOKE_DIR/external-ready`  driver → script: touch the file now
 *   - `$SUBSTRATE_SMOKE_DIR/external-done`   script → driver: it is touched
 *   - `$SUBSTRATE_SMOKE_DIR/result.json`     driver → script: the verdict
 * The script asserts the disk effects itself; a pass here is necessary, not
 * sufficient.
 */
import { listen } from "./tauri";
import {
  smokeExit,
  smokeSignal,
  vaultDelete,
  vaultList,
  vaultRead,
  vaultRoot,
  vaultSearch,
  vaultTrashList,
  vaultTrashRestore,
  vaultWriteBody,
} from "./ipc";

/** Tokens the outside script greps for on disk — keep in sync with the script. */
export const SMOKE_TOKENS = {
  /** written by the app through vault_write_body */
  app: "smokeneedle-app",
  /** written by the script straight to the file, behind the app's back */
  external: "smokeneedle-external",
} as const;

/** The note every phase operates on — ships in `examples/vault`. */
const TARGET = "Welcome.md";
/** Trashed and restored — a second note keeps the edit assertions isolated. */
const TRASH_TARGET = "Releases/Fern Static.md";

interface Step {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const steps: Step[] = [];

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    steps.push({ name, ok: true, detail, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    steps.push({
      name,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      ms: Math.round(performance.now() - t0),
    });
    throw e; // a failed phase aborts the run; later phases assume its effects
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Poll `probe` until it returns non-null, or give up. Phases that wait on the
    OS file watcher need this — `vault:changed` is debounced 300ms in the
    engine and the FTS reindex lands after it. */
async function until<T>(label: string, ms: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    try {
      const got = await probe();
      if (got !== null && got !== undefined) return got;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${ms}ms waiting for ${label}${last ? ` (last error: ${last})` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function flow(): Promise<void> {
  // 1. boot — the real engine, rooted at the scratch vault the script seeded
  let root = "";
  await step("boot: vault_root points at the scratch vault", async () => {
    root = await vaultRoot();
    assert(root.includes("vault-smoke"), `root is not a scratch vault: ${root}`);
    return root;
  });

  // 1.5 styles — the packaged app's CSP must let runtime styles through.
  //     Tauri appends a nonce to style-src at bundle time, and a nonce voids
  //     'unsafe-inline' (CSP spec) — which shipped 0.16.0 with CodeMirror's
  //     entire style-mod-injected theme blocked (SUB-610). Only the bundled
  //     build has the nonce, so only the bundle smoke mode can catch a
  //     regression; in dev this step is a cheap tautology. The probe uses the
  //     same mechanism CodeMirror does: a <style> element created at runtime.
  await step("styles: runtime style injection survives the CSP", async () => {
    const csp =
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        // Tauri delivers the policy as a response header on macOS, so no
        // meta tag is normal even in the bundle — the header is invisible
        // from JS, we can only name what we see
        ?.getAttribute("content") ?? "(no CSP meta tag; header-delivered or dev mode)";
    const probe = document.createElement("div");
    probe.id = "smoke-style-probe";
    const tag = document.createElement("style");
    tag.textContent = "#smoke-style-probe { margin-left: 7px; }";
    document.head.appendChild(tag);
    document.body.appendChild(probe);
    try {
      const injected = getComputedStyle(probe).marginLeft;
      assert(
        injected === "7px",
        `a runtime-injected <style> did not apply (margin-left=${injected}) — ` +
          `style-src is blocking style elements, the SUB-610 class. CSP: ${csp}`
      );
      // style="" attributes are a separate CSP gate (style-src-attr); widget
      // HTML uses them, so probe that path too
      probe.setAttribute("style", "margin-top: 9px");
      const attr = getComputedStyle(probe).marginTop;
      assert(
        attr === "9px",
        `a style attribute did not apply (margin-top=${attr}) — style-src-attr is blocking. CSP: ${csp}`
      );
      return `style element + style attribute both apply; csp: ${csp.slice(0, 60)}…`;
    } finally {
      probe.remove();
      tag.remove();
    }
  });

  // 2. list — the real index over real files
  await step("list: real index sees the seeded notes", async () => {
    const notes = await vaultList();
    assert(notes.length >= 5, `expected the example vault's notes, got ${notes.length}`);
    for (const rel of [TARGET, TRASH_TARGET]) {
      assert(
        notes.some((n) => n.path === rel),
        `${rel} missing from vault_list`
      );
    }
    return `${notes.length} notes`;
  });

  // 3. read — frontmatter split and body come back over the real bridge
  let body = "";
  await step("read: body + parsed props cross the bridge", async () => {
    const got = await vaultRead(TARGET);
    body = got.body;
    assert(body.length > 0, "empty body");
    assert(typeof got.props === "object" && got.props !== null, "props did not deserialize");
    assert("created" in got.props, `expected a created prop, got ${Object.keys(got.props).join(",")}`);
    return `${body.length} bytes, props: ${Object.keys(got.props).join(",")}`;
  });

  // 4. edit + save — the disk effect the script greps for. Also the arg-shape
  //    check that the mock cannot make: vault_write_body's third arg is
  //    `expectedBody` in TS and `expected_body` in Rust.
  await step("save: vault_write_body writes through to the .md", async () => {
    body = `${body.trimEnd()}\n\n${SMOKE_TOKENS.app}\n`;
    const meta = await vaultWriteBody(TARGET, body, null);
    assert(meta.path === TARGET, `write returned ${meta.path}`);
    const back = await vaultRead(TARGET);
    assert(back.body.includes(SMOKE_TOKENS.app), "the token did not survive the round trip");
    assert("created" in back.props, "the write dropped the frontmatter block");
    return `wrote ${body.length} bytes, frontmatter preserved`;
  });

  // 5. search — proves the write reindexed, not just landed. FTS is engine-side
  //    only; the mock's substring scan can never fail this the same way.
  await step("search: the saved token is indexed", async () => {
    const hits = await until("the FTS index to pick the token up", 15_000, async () => {
      const h = await vaultSearch(SMOKE_TOKENS.app);
      return h.some((x) => x.path === TARGET) ? h : null;
    });
    return `${hits.length} hit(s)`;
  });

  // 6. external edit — a file changed behind the app's back, adopted through
  //    the real OS watcher (the mock fakes this with __mockEditNote). The
  //    script does the writing; we hand off and wait.
  await step("external: the OS watcher adopts an edit made outside the app", async () => {
    let changed = 0;
    const unlisten = await listen("vault:changed", () => {
      changed += 1;
    });
    try {
      await smokeSignal("external-ready", TARGET);
      // the script's write is what we are waiting for — the index is the
      // proof, since vault_read would show it watcher or no watcher
      await until("the external token to reach the index", 20_000, async () => {
        const hits = await vaultSearch(SMOKE_TOKENS.external);
        return hits.some((h) => h.path === TARGET) ? hits : null;
      });
      const back = await vaultRead(TARGET);
      assert(back.body.includes(SMOKE_TOKENS.external), "external text not in the note body");
      assert(back.body.includes(SMOKE_TOKENS.app), "the external edit clobbered the app's write");
      assert(changed > 0, "vault:changed never fired — the watcher bridge is dead");
      body = back.body;
      return `adopted after ${changed} vault:changed event(s)`;
    } finally {
      unlisten();
    }
  });

  // 7. conflict — the guard that made the external edit safe. A stale
  //    expectedBody must be refused, and refused WITHOUT writing.
  await step("conflict: a stale expectedBody is refused, file untouched", async () => {
    let err = "";
    try {
      await vaultWriteBody(TARGET, "clobbered\n", "a body the file never had\n");
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    assert(err.includes("conflict"), `expected a conflict error, got ${err || "success"}`);
    const back = await vaultRead(TARGET);
    assert(back.body === body, "the refused write still changed the file");
    // …and the same write with the current body as the guard goes through
    const ok = await vaultWriteBody(TARGET, body, body);
    assert(ok.path === TARGET, "a matching guard was refused");
    return `refused with: ${err}`;
  });

  // 8. trash — a real rename into .trash/, the file leaves its folder
  let trashId = "";
  await step("trash: delete moves the file into .trash/", async () => {
    await vaultDelete(TRASH_TARGET);
    const entry = await until("the trash listing", 10_000, async () => {
      const list = await vaultTrashList();
      return list.find((t) => t.path === TRASH_TARGET) ?? null;
    });
    trashId = entry.id;
    const notes = await vaultList();
    assert(!notes.some((n) => n.path === TRASH_TARGET), "trashed note still in vault_list");
    return `trash id ${trashId}`;
  });

  // 9. restore — back to its original path, content intact
  await step("restore: the trashed note returns to its path", async () => {
    const meta = await vaultTrashRestore(trashId);
    assert(meta.path === TRASH_TARGET, `restored to ${meta.path}, expected ${TRASH_TARGET}`);
    const back = await vaultRead(TRASH_TARGET);
    assert(back.body.length > 0, "restored note is empty");
    const notes = await vaultList();
    assert(notes.some((n) => n.path === TRASH_TARGET), "restored note missing from vault_list");
    const left = await vaultTrashList();
    assert(!left.some((t) => t.id === trashId), "restored entry still in the trash listing");
    return `${back.body.length} bytes back at ${TRASH_TARGET}`;
  });
}

/** Run the flow, write the verdict, quit the app. Never throws — a crash here
    would leave the app running and the script waiting on its timeout. */
export async function runSmoke(): Promise<void> {
  const t0 = performance.now();
  let fatal: string | null = null;
  try {
    await flow();
  } catch (e) {
    fatal = e instanceof Error ? `${e.message}` : String(e);
  }
  const result = {
    pass: fatal === null,
    fatal,
    ms: Math.round(performance.now() - t0),
    tokens: SMOKE_TOKENS,
    target: TARGET,
    trashTarget: TRASH_TARGET,
    steps,
  };
  try {
    await smokeSignal("result.json", `${JSON.stringify(result, null, 2)}\n`);
  } catch (e) {
    // no channel to the script left — the console is the last resort, and the
    // script will report its own wait timeout
    console.error("smoke: could not write result.json", e);
  }
  try {
    await smokeExit(result.pass ? 0 : 1);
  } catch (e) {
    console.error("smoke: could not exit", e);
  }
}
