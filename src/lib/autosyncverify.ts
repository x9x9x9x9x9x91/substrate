/** Auto-sync verification driver — the in-app half of
 * `scripts/autosync-verify.sh`.
 *
 * The scheduler's own tests (`autosync.test.ts`) drive it with a fake clock,
 * and the e2e spec drives it over the mock backend; the blob tests drive the
 * transport with no app at all. Nothing joined the two: a real app, arming its
 * own auto lane at boot, pushing and pulling through real IPC against a real
 * hosted store, with a second device on the other side. That is what this
 * driver is for, and why it deliberately runs on the SHIPPED timings — two
 * minutes of debounce, five of pull interval — instead of the
 * `window.__mockAutoSync` seam the e2e specs use. A pass here is evidence
 * about the product, not about the harness.
 *
 * It never triggers a sync itself. It writes notes, waits, and reads status:
 * every push and pull it reports is one the app's own scheduler decided to do.
 * The one exception is stated where it happens (the focus leg dispatches the
 * same `focus` event the OS delivers, since the window is already frontmost).
 *
 * Loaded only when `VITE_SUBSTRATE_AUTOSYNC_VERIFY=1` was set at dev time (see
 * `main.tsx`), so it never reaches a production bundle.
 *
 * Contract with the script, through `$SUBSTRATE_SMOKE_DIR`:
 *   - `gate`         driver → script: the name of the step to perform now
 *   - `Harness/gate-<name>.md` in the vault, written from outside: its answer
 *   - `result.json`  driver → script: the verdict, per leg
 */
import {
  smokeExit,
  smokeSignal,
  vaultCreate,
  vaultRead,
  vaultRoot,
  vaultSealScope,
  vaultSyncConflicts,
  vaultSyncPush,
  vaultSyncResolveFinish,
  vaultSyncResolveSet,
  vaultSyncSetRemote,
  vaultSyncStatus,
  vaultWriteBody,
} from "./ipc";
import { listen } from "./tauri";
import type { VaultSyncStatus } from "./types";

const env = import.meta.env;
const URL_ = String(env.VITE_AUTOSYNC_URL ?? "");
const TOKEN = String(env.VITE_AUTOSYNC_TOKEN ?? "");
const PASSPHRASE = String(env.VITE_AUTOSYNC_PASSPHRASE ?? "");

/** Markers the script greps for in the store and on the second device. */
export const VERIFY_MARKERS = {
  settle: "autosync-settle-marker",
  sealed: "autosync-sealed-marker",
  local: "autosync-local-edit-marker",
};

const SETTLE_NOTE = "Harness/Settle.md";
const SEALED_NOTE = "Sealed/Secret.md";

type Leg = { leg: string; pass: boolean; detail: string; ms: number };
const legs: Leg[] = [];
const notes: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
function say(msg: string) {
  notes.push(`${stamp()} ${msg}`);
  console.debug(`[autosync-verify] ${msg}`);
}

class Fail extends Error {}
function assert(ok: boolean, msg: string): asserts ok {
  if (!ok) throw new Fail(msg);
}

async function leg(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = performance.now();
  say(`leg ${name}: start`);
  try {
    const detail = await fn();
    legs.push({ leg: name, pass: true, detail, ms: Math.round(performance.now() - t0) });
    say(`leg ${name}: PASS — ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    legs.push({ leg: name, pass: false, detail, ms: Math.round(performance.now() - t0) });
    say(`leg ${name}: FAIL — ${detail}`);
    throw e;
  }
}

/** Poll `probe` until it returns something, or give up. Deliberately slow:
    these waits are minutes long by design, and a tight loop would be its own
    kind of trigger (every status read is an IPC round trip). */
async function until<T>(label: string, ms: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = performance.now() + ms;
  let last: unknown = null;
  for (;;) {
    try {
      const got = await probe();
      if (got !== null && got !== undefined) return got;
    } catch (e) {
      last = e;
    }
    if (performance.now() > deadline) {
      throw new Fail(
        `timed out after ${Math.round(ms / 1000)}s waiting for ${label}${
          last ? ` (last error: ${last})` : ""
        } changed=${changeEvents} lastChange=${changeLast}`
      );
    }
    await sleep(2_000);
  }
}

/** Ask the script to do the next outside step, and wait for its answer note.
    The answer arrives as a file written into the vault from outside, exactly
    the way the smoke driver waits for its external edit.

    Most steps are a second device doing one thing and are done in seconds.
    One of them waits on a shipped timing of the app's own — the auto-snapshot
    bound — so the deadline is a parameter rather than a constant.

    Returns the answer's body, because for some steps the answer is the
    finding: the script writes what it saw out there, and a caller that only
    waited for the file to exist would throw away the one honest account of why
    a leg is about to fail. */
async function gate(name: string, ms = 240_000): Promise<string> {
  say(`gate ${name}: waiting on the script`);
  await smokeSignal("gate", name);
  const body = await until(`the script to finish "${name}"`, ms, async () => {
    const note = await vaultRead(`Harness/gate-${name}.md`).catch(() => null);
    return note ? note.body.trim() : null;
  });
  say(`gate ${name}: done — ${body}`);
  return body;
}

const status = () => vaultSyncStatus();

/** Every `vault:changed` the backend emits, counted. The frontend debounce and
    the backend's own snapshot window are both re-armed by this event, so a push
    that only ever fires at the ten-minute bound means something keeps emitting
    it; the payload names the paths, which is what tells an idle vault apart
    from a writer nobody asked for. Read-only: listening is not a trigger. */
let changeEvents = 0;
let changeLast = "none";
function watchChanges(): void {
  void listen<string[]>("vault:changed", (e) => {
    changeEvents += 1;
    const paths = Array.isArray(e.payload) ? e.payload : [];
    changeLast = `${stamp()} [${paths.slice(0, 4).join(", ")}]`;
  });
}

/** A push the app decided to do: a report carrying pushed commits, and one
    that is not the report that was already sitting there. Every pull the lane
    makes re-arms the debounce too, so "there is a push in the last slot" on its
    own can be a push that belongs to an earlier leg. */
async function awaitAutoPush(
  label: string,
  ms: number,
  notHead: string | undefined
): Promise<VaultSyncStatus> {
  // A wait this long is worth narrating: the push has two bounds (a two
  // minute quiet window and a ten minute one for a vault that never goes
  // quiet), and a timeout that says nothing cannot tell "the lane is dead"
  // from "the quiet window keeps being re-armed".
  let probes = 0;
  return until(label, ms, async () => {
    const s = await status();
    const r = s.last_result;
    if (probes++ % 15 === 0) {
      say(
        `still waiting (${probes * 2}s): pushed=${r?.pushed ?? "-"} pulled=${
          r?.pulled ?? "-"
        } head=${r?.head?.slice(0, 8) ?? "-"} error=${s.last_error ?? "none"} conflicted=${
          s.conflicted.length
        } changed=${changeEvents} lastChange=${changeLast}`
      );
    }
    return r && r.pushed > 0 && r.head !== notHead ? s : null;
  });
}

/** Put a body into a harness note, creating it the first time. The engine's
    body write never resurrects a missing file ("a missing file is an error,
    never a body-only resurrection" — `Engine::write_body`), and the pane
    creates before it edits; the harness owns both of its notes, so it does the
    same. The body is body-only: frontmatter is the engine's, byte-verbatim. */
async function putNote(path: string, body: string): Promise<void> {
  try {
    await vaultWriteBody(path, body, null);
    return;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("note no longer exists")) throw e;
  }
  const cut = path.lastIndexOf("/");
  const folder = cut < 0 ? "" : path.slice(0, cut);
  const title = path.slice(cut + 1).replace(/\.md$/, "");
  const meta = await vaultCreate(title, folder, "note", undefined, body);
  assert(meta.path === path, `created ${meta.path} where the harness expects ${path}`);
}

/** Phase A: a vault with no remote yet. Configure it the way the pane does,
    seed one note, push once by hand so the store has a ref for the second
    device to join — then reload, which is the fresh boot leg 1 measures. */
async function phaseA(): Promise<void> {
  const root = await vaultRoot();
  assert(
    root.includes("vault-smoke-autosync"),
    `refusing to run against ${root} — this driver only ever touches a throwaway harness vault`
  );
  const before = await status();
  assert(!before.configured, "the harness vault already had a remote configured");
  await putNote(SETTLE_NOTE, "seed\n");
  const setup = await vaultSyncSetRemote(URL_, TOKEN, undefined, PASSPHRASE);
  say(`remote configured: ${JSON.stringify(setup)}`);
  // the one hand-driven sync in the whole run, and it is setup rather than
  // evidence: the second device needs a ref to join before anything can be
  // observed arriving from it
  const seeded = await vaultSyncPush();
  say(`setup push (by hand, not the lane): ${seeded.pushed} commit(s)`);
  await gate("seed");
  sessionStorage.setItem("autosync-verify-phase", "B");
  say("reloading — everything after this is a fresh boot with a remote already saved");
  location.reload();
  // the reload tears this context down; nothing below it belongs to phase A
  await new Promise<void>(() => {});
}

/** Phase B: the app has booted with a remote configured and nobody has touched
    it. Every leg from here is the scheduler's own doing. */
async function phaseB(): Promise<void> {
  const root = await vaultRoot();
  assert(root.includes("vault-smoke-autosync"), `refusing to run against ${root}`);
  watchChanges();

  await leg("1-boot-engages", async () => {
    const s = await until("the boot pull to land a change from the other device", 120_000, async () => {
      const got = await status();
      return got.last_result && got.last_result.pulled > 0 ? got : null;
    });
    const note = await vaultRead("Peer/One.md");
    assert(note.body.includes("peer-seed"), "the pulled note is not the one the peer pushed");
    return `unaided boot pull adopted ${s.last_result?.pulled} commit(s), Peer/One.md present, head ${s.last_result?.head.slice(0, 8)}`;
  });

  await leg("2-settle-push", async () => {
    const before = (await status()).last_result?.head;
    await putNote(SETTLE_NOTE, `${VERIFY_MARKERS.settle}\n`);
    say("wrote the note; from here nothing touches the app until the debounce fires");
    const s = await awaitAutoPush("the settle debounce to push", 780_000, before);
    await gate("check-push");
    const receipt = await vaultRead("Harness/gate-check-push.md");
    assert(
      receipt.body.includes("PEER-HAS-SETTLE-MARKER"),
      `the second device did not find the pushed note: ${receipt.body.trim()}`
    );
    return `push fired unaided ${s.last_result?.pushed} commit(s) and the second device read the marker back off the remote`;
  });

  await leg("3-focus-pull", async () => {
    await gate("peer-two");
    // the window is already frontmost, so the OS has no focus change to
    // deliver — this dispatches the same event the app binds, and nothing else.
    // Repeated, because one focus is not one pull: a focus inside the lane's
    // sixty-second gap, or one landing while a push is in flight, is dropped by
    // design, and a user coming back to the window produces a stream of these
    // rather than a single one. The pull that lands is still the lane's.
    const started = performance.now();
    window.dispatchEvent(new Event("focus"));
    const note = await until("the focus pull to adopt the peer's change", 200_000, () => {
      window.dispatchEvent(new Event("focus"));
      return vaultRead("Peer/Two.md").catch(() => null);
    });
    say(`focus pull landed after ${Math.round((performance.now() - started) / 1000)}s`);
    return `focus pull adopted Peer/Two.md (${note.body.trim().split("\n").pop()})`;
  });

  await leg("4-interval-pull", async () => {
    await gate("peer-three");
    say("no trigger of any kind from here — the interval is the only thing that can pull");
    const note = await until("the background interval to pull", 400_000, () =>
      vaultRead("Peer/Three.md").catch(() => null)
    );
    return `the ~5 minute interval adopted Peer/Three.md with no user action (${note.body.trim().split("\n").pop()})`;
  });

  await leg("5-divergence-banner", async () => {
    // both devices change the same note: the peer's edit lands on the remote
    // while this one still holds an unpushed edit of its own
    await gate("peer-diverge");
    await putNote(SETTLE_NOTE, `${VERIFY_MARKERS.local}\n`);
    // An edit is not a divergence until it is a commit, and this vault's
    // commits are the auto-snapshot thread's to make: it waits two minutes of
    // quiet, and a vault that never goes quiet waits out its ten-minute bound
    // instead — the same bound the settle push above spent. A fixed sleep
    // shorter than that measured a dirty working tree and called it a
    // divergence, so the wait is on the commit itself, read from outside.
    const committed = await gate("local-committed", 720_000);
    // The script gives up on that wait at its own bound and says so in the
    // receipt. Read it: without this the leg walks on and fails three minutes
    // later as "the pull never parked the divergence", which is not what
    // happened — nothing was ever there to diverge from.
    assert(
      !committed.includes("LOCAL-EDIT-NEVER-COMMITTED"),
      "the local edit never became a commit: the auto-snapshot thread did not land it inside " +
        "its ten-minute bound, so the pull had nothing to diverge from and the divergence is " +
        "untested rather than broken"
    );
    window.dispatchEvent(new Event("focus"));
    const s = await until("the pull to park the divergence", 180_000, async () => {
      const got = await status();
      return got.conflicted.length > 0 || got.last_error ? got : null;
    });
    const back = await vaultRead(SETTLE_NOTE);
    assert(
      back.body.includes(VERIFY_MARKERS.local),
      "the local edit was overwritten — the divergence was resolved silently"
    );
    // park the app on the Sync pane so the script can photograph what the user
    // would be looking at
    const item = Array.from(document.querySelectorAll<HTMLElement>("button, a, li, div")).find(
      (el) => el.textContent?.trim() === "Vault sync" && el.getAttribute("role") !== "heading"
    );
    item?.click();
    await sleep(3_000);
    await gate("shot");
    // Finish the merge the way the pane does. A parked conflict pauses the
    // whole lane by design, and the leg below needs a lane that still runs:
    // leaving the merge open would make its silence mean nothing.
    const parked = await vaultSyncConflicts();
    for (const file of parked.files) await vaultSyncResolveSet(file.path, "mine");
    if (parked.files.length > 0) {
      const finished = await vaultSyncResolveFinish();
      say(`resolved the parked merge keeping this device's edit: head ${finished.head.slice(0, 8)}`);
    }
    const after = await status();
    assert(
      after.conflicted.length === 0,
      `the merge is still parked after resolving it: ${JSON.stringify(after.conflicted)}`
    );
    return `divergence parked: conflicted=${JSON.stringify(s.conflicted)} last_error=${
      s.last_error ?? "none"
    }; the local edit survived and the merge finished`;
  });

  // LAST, and it has to be: sealing a scope purges the plaintext out of this
  // device's git history, and a rewritten history is exactly what the hosted
  // transport refuses to push or pull until the remote is re-initialized
  // (`gitsync/blob.rs`). Every leg above needs a vault that still syncs.
  await leg("6-sealed-privacy", async () => {
    // written in the clear first, then sealed: that is the shape the privacy
    // cleanup exists for, and it puts the marker through the purge path rather
    // than around it. It is deliberately never pushed — Substrate does not
    // rewrite a remote, so plaintext that reached the store would stay there.
    await putNote(SEALED_NOTE, `${VERIFY_MARKERS.sealed}\n`);
    const scope = await vaultSealScope("Sealed", "harness sealed passphrase 1275");
    say(`sealed scope: ${JSON.stringify(scope)}`);
    // What the product owes from here is not a push — it is honesty. The lane
    // keeps its schedule, every leg is refused, and the refusal has to reach
    // the pane on the first attempt: retrying never clears it, and the quiet
    // window that keeps an offline device from repainting the pane would
    // otherwise hide a vault that has stopped syncing behind "Ready".
    const s = await until(
      "the lane to surface the post-seal refusal instead of hiding it",
      780_000,
      async () => {
        const got = await status();
        return got.last_error ? got : null;
      }
    );
    assert(s.privacy_error === null, `the sealing cleanup reported: ${s.privacy_error}`);
    assert(
      /rewritten/.test(s.last_error ?? ""),
      `the lane surfaced something else entirely: ${s.last_error}`
    );
    await gate("check-sealed");
    const receipt = await vaultRead("Harness/gate-check-sealed.md");
    assert(
      receipt.body.includes("SEALED-MARKER-ABSENT"),
      `the sealed note left this device in the clear: ${receipt.body.trim()}`
    );
    return `sealing purged the plaintext (no marker in the store, on the second device, or in this device's history) and the lane surfaced its refusal at once: ${s.last_error}`;
  });
}

export async function runAutoSyncVerify(): Promise<void> {
  const t0 = performance.now();
  let fatal: string | null = null;
  try {
    if (sessionStorage.getItem("autosync-verify-phase") === "B") await phaseB();
    else await phaseA();
  } catch (e) {
    fatal = e instanceof Error ? e.message : String(e);
  }
  const result = {
    pass: fatal === null && legs.every((l) => l.pass),
    fatal,
    ms: Math.round(performance.now() - t0),
    legs,
    log: notes,
  };
  try {
    await smokeSignal("result.json", `${JSON.stringify(result, null, 2)}\n`);
  } catch (e) {
    console.error("autosync-verify: could not write result.json", e);
  }
  try {
    await smokeExit(result.pass ? 0 : 1);
  } catch (e) {
    console.error("autosync-verify: could not exit", e);
  }
}
