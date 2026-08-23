/* The containment surface, under jsdom.

   Every case here is one of the audit's probes written small: the timer that
   outlived its pane, the listener that did not, the kind that drew into
   `document.body` instead of the element it was handed. The point of testing
   them at this level rather than only in the browser is the asymmetry — a
   sandbox that clears too much (the host's own toast timer, React's
   scheduler) breaks the app in ways an e2e spec notices late and blames on
   something else. */
import { test } from "node:test";
import assert from "node:assert/strict";
import "./componentHarness.ts"; // jsdom globals at module scope
import { armKindSandbox, hostSurface, watchKindDom } from "./kindSandbox.ts";

/* In the webview `setInterval` IS `window.setInterval` — one object. Under
   jsdom they are two: bare calls reach node's timers, which the sandbox has
   no business patching. So the kind's side of every case below says `window.`
   out loud (what a kind's bare call compiles to in the app). The test's own
   side never sleeps: the timer cases hand-crank `KindClock` instead. */

/* A stand-in for the window's timers that only moves when the test says so.
   Installed BEFORE `armKindSandbox`, so the sandbox captures these as its
   originals, wraps them exactly as it wraps jsdom's, and `release` clears
   them through the same `window.clearInterval` the app reaches for.

   The timer cases used to sleep a fixed number of milliseconds and hope the
   chain had run by then — a wall-clock bet that loses whenever the box is
   busy. Cranking a clock we own settles the same facts with no race in
   either direction: a chain that has not run is a hang here rather than a
   quiet pass. */
type Due = { at: number; every: number | null; fn: (...a: unknown[]) => void; args: unknown[] };

class KindClock {
  now = 0;
  #next = 1;
  #due = new Map<number, Due>();
  #real: Record<string, unknown> | null = null;

  install() {
    const slots = window as unknown as Record<string, unknown>;
    this.#real = {
      setTimeout: slots.setTimeout,
      setInterval: slots.setInterval,
      clearTimeout: slots.clearTimeout,
      clearInterval: slots.clearInterval,
    };
    const arm =
      (repeat: boolean) =>
      (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => {
        const id = this.#next++;
        // a zero-period interval would spin `advance` forever; browsers clamp it too
        this.#due.set(id, { at: this.now + Math.max(0, ms), every: repeat ? Math.max(1, ms) : null, fn, args });
        return id;
      };
    const disarm = (id: number) => {
      this.#due.delete(id);
    };
    slots.setTimeout = arm(false);
    slots.setInterval = arm(true);
    slots.clearTimeout = disarm;
    slots.clearInterval = disarm;
  }

  restore() {
    if (this.#real) {
      const slots = window as unknown as Record<string, unknown>;
      for (const [name, fn] of Object.entries(this.#real)) slots[name] = fn;
      this.#real = null;
    }
    this.#due.clear();
  }

  /** Fire everything due up to `now + ms`, in due order, including whatever
      those callbacks arm inside that window. */
  async advance(ms: number) {
    const until = this.now + ms;
    for (let guard = 0; ; guard += 1) {
      assert.ok(guard < 10_000, "the clock never drained — a timer is re-arming faster than it fires");
      let pick: [number, Due] | undefined;
      for (const entry of this.#due) {
        if (entry[1].at > until) continue;
        if (!pick || entry[1].at < pick[1].at) pick = entry;
      }
      if (!pick) break;
      const [id, timer] = pick;
      this.now = timer.at;
      if (timer.every === null) this.#due.delete(id);
      else this.#due.set(id, { ...timer, at: timer.at + timer.every });
      timer.fn(...timer.args);
      await Promise.resolve(); // let a callback's promise continuations land before the next tick
    }
    this.now = until;
  }
}

test("timers a kind arms are cancelled when its pane goes", async (t) => {
  const clock = new KindClock();
  clock.install(); // before the sandbox arms, so the sandbox wraps the clock
  const sb = armKindSandbox();
  t.after(() => {
    sb.release(); // idempotent; keeps a failing assert from leaving a live interval behind
    clock.restore(); // after release, which clears through the clock
  });
  let ticks = 0;
  sb.run(() => {
    window.setInterval(() => {
      ticks += 1;
    }, 1);
  });
  assert.equal(sb.outstanding().timers, 1);
  sb.release();
  assert.equal(sb.outstanding().timers, 0);
  const before = ticks;
  await clock.advance(20);
  assert.equal(ticks, before, "a released kind's interval kept ticking");
});

test("a timer armed from inside the kind's own callback is caught too", async (t) => {
  const clock = new KindClock();
  clock.install(); // before the sandbox arms, so the sandbox wraps the clock
  const sb = armKindSandbox();
  t.after(() => {
    sb.release(); // idempotent; keeps a failing assert from leaving a live interval behind
    clock.restore(); // after release, which clears through the clock
  });
  let chained = 0;
  sb.run(() => {
    window.setTimeout(() => {
      window.setInterval(() => {
        chained += 1;
      }, 1);
    }, 1);
  });
  await clock.advance(15);
  assert.ok(chained > 0, "the chained interval never ran — test is not proving anything");
  assert.equal(sb.outstanding().timers, 1, "the chained interval was not recorded");
  sb.release();
  const before = chained;
  await clock.advance(20);
  assert.equal(chained, before, "the chained interval survived release");
});

test("what the host arms while serving the kind is the host's and survives", async (t) => {
  const clock = new KindClock();
  clock.install(); // before the sandbox arms, so the sandbox wraps the clock
  const sb = armKindSandbox();
  t.after(() => {
    sb.release(); // idempotent; keeps a failing assert from leaving a live interval behind
    clock.restore(); // after release, which clears through the clock
  });
  let hostTicks = 0;
  sb.run(() => {
    // what `ctx.toast` does: host code, called from the kind
    sb.host(() => {
      window.setTimeout(() => {
        hostTicks += 1;
      }, 5);
    });
  });
  assert.equal(sb.outstanding().timers, 0, "a host timer was attributed to the kind");
  sb.release();
  await clock.advance(25);
  assert.equal(hostTicks, 1, "the host's own timer was cancelled with the kind");
});

test("window and document listeners go with the pane", (t) => {
  const sb = armKindSandbox();
  t.after(() => sb.release()); // release is idempotent; this keeps a failing assert from leaving a live interval behind
  let heard = 0;
  sb.run(() => {
    window.addEventListener("resize", () => {
      heard += 1;
    });
    document.addEventListener("click", () => {
      heard += 1;
    });
  });
  assert.equal(sb.outstanding().listeners, 2);
  window.dispatchEvent(new Event("resize"));
  document.dispatchEvent(new Event("click"));
  assert.equal(heard, 2);
  sb.release();
  window.dispatchEvent(new Event("resize"));
  document.dispatchEvent(new Event("click"));
  assert.equal(heard, 2, "a released kind still heard window events");
});

test("a kind removing its own listener still works — it never sees the wrapper", (t) => {
  const sb = armKindSandbox();
  t.after(() => sb.release()); // release is idempotent; this keeps a failing assert from leaving a live interval behind
  let heard = 0;
  const onResize = () => {
    heard += 1;
  };
  sb.run(() => {
    window.addEventListener("resize", onResize);
    window.removeEventListener("resize", onResize);
  });
  assert.equal(sb.outstanding().listeners, 0);
  window.dispatchEvent(new Event("resize"));
  assert.equal(heard, 0);
  sb.release();
});

test("a listener removed from a promise continuation is really removed", async (t) => {
  const sb = armKindSandbox();
  t.after(() => sb.release());
  let heard = 0;
  const onResize = () => {
    heard += 1;
  };
  // the common shape: mount arms the listener, and something that finishes
  // later takes it back off — by which time no sandbox is attributed
  sb.run(() => window.addEventListener("resize", onResize));
  await Promise.resolve().then(() => window.removeEventListener("resize", onResize));
  assert.equal(sb.outstanding().listeners, 0, "the pair was not found off the stack");
  window.dispatchEvent(new Event("resize"));
  assert.equal(heard, 0, "the listener the kind removed still fired");
  sb.release();
});

test("an off-stack removal finds the right kind's pair when two are mounted", (t) => {
  const a = armKindSandbox();
  const b = armKindSandbox();
  t.after(() => {
    a.release();
    b.release();
  });
  const onA = () => {};
  const onB = () => {};
  a.run(() => window.addEventListener("resize", onA));
  b.run(() => window.addEventListener("resize", onB));
  window.removeEventListener("resize", onB); // no active sandbox
  assert.equal(a.outstanding().listeners, 1, "the other kind's listener was taken");
  assert.equal(b.outstanding().listeners, 0, "the owning kind kept a listener it no longer has");
});

test("release puts the globals back, and twice is harmless", (t) => {
  const before = window.setInterval;
  const sb = armKindSandbox();
  t.after(() => sb.release()); // release is idempotent; this keeps a failing assert from leaving a live interval behind
  assert.notEqual(window.setInterval, before, "the patch never went on");
  sb.release();
  sb.release();
  assert.equal(window.setInterval, before, "the patch outlived the kind");
});

test("two overlapping kinds keep their own timers, and the last one restores", (t) => {
  const before = window.setInterval;
  const a = armKindSandbox();
  const b = armKindSandbox();
  t.after(() => {
    a.release();
    b.release();
  });
  a.run(() => window.setInterval(() => {}, 1000));
  b.run(() => window.setInterval(() => {}, 1000));
  assert.equal(a.outstanding().timers, 1);
  assert.equal(b.outstanding().timers, 1);
  a.release();
  assert.notEqual(window.setInterval, before, "the patch left while a kind was still mounted");
  assert.equal(b.outstanding().timers, 1, "one kind's release took the other's timer");
  b.release();
  assert.equal(window.setInterval, before);
});

test("a ctx call is the host's work, even reached through the kind", async (t) => {
  const clock = new KindClock();
  clock.install(); // before the sandbox arms, so the sandbox wraps the clock
  const sb = armKindSandbox();
  t.after(() => {
    sb.release(); // idempotent; keeps a failing assert from leaving a live interval behind
    clock.restore(); // after release, which clears through the clock
  });
  let dismissed = 0;
  const ctx = {
    reads: 0,
    get note() {
      // the real ctx.note is a getter; the wrapper must not flatten it
      ctx.reads += 1;
      return { title: "Gear log" };
    },
    toast() {
      window.setTimeout(() => {
        dismissed += 1;
      }, 5);
    },
  };
  const wrapped = hostSurface(ctx, sb);
  sb.run(() => {
    assert.equal(wrapped.note.title, "Gear log");
    wrapped.toast();
  });
  assert.equal(ctx.reads, 1, "the getter was not read through the proxy");
  assert.equal(sb.outstanding().timers, 0, "the app's toast timer was billed to the kind");
  sb.release();
  await clock.advance(25);
  assert.equal(dismissed, 1, "unmounting the kind cancelled the app's own toast");
});

// ---------- DOM escapes ----------

function stage() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.className = "kind-host";
  const chrome = document.createElement("div");
  chrome.className = "dash-head";
  chrome.textContent = "gear-log";
  const own = document.createElement("div");
  own.className = "kind-body";
  host.append(chrome, own);
  document.body.append(host);
  return { host, chrome, own };
}

test("drawing inside the element it was given is not an escape", () => {
  const { own } = stage();
  const w = watchKindDom(own);
  own.appendChild(document.createElement("p"));
  assert.equal(w.stop(), null);
});

test("a kind that appends to the body has it taken away, and is named", () => {
  const { own } = stage();
  const w = watchKindDom(own);
  const stray = document.createElement("div");
  stray.id = "escapee";
  document.body.appendChild(stray);
  const esc = w.stop();
  assert.ok(esc, "the escape was not caught");
  assert.equal(esc.added, 1);
  assert.equal(document.getElementById("escapee"), null, "the escapee outlived its kind");
  assert.match(esc.summary, /wrote outside the element it was given/);
  assert.match(esc.summary, /<body>/);
  assert.ok(own.isConnected, "the repair took the pane with it");
});

test("chrome a kind tears out is put back where it was", () => {
  const { host, chrome, own } = stage();
  const after = document.createElement("div");
  after.className = "dash-source";
  host.appendChild(after);
  const w = watchKindDom(own);
  chrome.remove();
  const esc = w.stop();
  assert.ok(esc, "the host chrome was blanked with nothing said");
  assert.equal(esc.removed, 1);
  assert.ok(chrome.isConnected, "the head was not restored");
  assert.deepEqual(
    [...host.children].map((c) => c.className),
    ["dash-head", "kind-body", "dash-source"],
    "the head came back in the wrong place",
  );
});

test("the whole host emptied is caught, and the pane's own element comes back", () => {
  const { host, chrome, own } = stage();
  const w = watchKindDom(own);
  host.innerHTML = "";
  const esc = w.stop();
  assert.ok(esc, "blanking the pane went unnoticed");
  assert.equal(esc.removed, 2, "head and body were not both restored");
  assert.match(esc.summary, /2 elements removed/);
  assert.ok(chrome.isConnected && own.isConnected, "the pane stayed blank");
  assert.equal(own.parentElement, host);
});

/* The three redraw shapes. All of them leave a container the kind wrote into
   detached by the time the watcher drains, which is what used to read as a
   write outside `el` and cost the kind its pane. */

test("a redraw that re-sets innerHTML is not an escape", () => {
  const { own } = stage();
  const w = watchKindDom(own);
  const box = document.createElement("div");
  own.appendChild(box);
  box.appendChild(document.createElement("p")); // fills a container it owns
  own.innerHTML = "<span>second draw</span>"; // ...which this detaches
  assert.equal(w.stop(), null, "an ordinary redraw was called a stray write");
  assert.equal(own.textContent, "second draw", "the redraw was undone");
});

test("replaceChildren on the kind's own element is not an escape", () => {
  const { own } = stage();
  const w = watchKindDom(own);
  const first = document.createElement("ul");
  own.appendChild(first);
  first.appendChild(document.createElement("li"));
  const second = document.createElement("ul");
  second.appendChild(document.createElement("li"));
  own.replaceChildren(second);
  assert.equal(w.stop(), null, "replaceChildren was called a stray write");
  assert.equal(own.firstElementChild, second);
});

test("a scratch node built inside the element and thrown away is not an escape", () => {
  const { own } = stage();
  const w = watchKindDom(own);
  const scratch = document.createElement("div");
  own.appendChild(scratch);
  scratch.appendChild(document.createElement("b")); // measured, then discarded
  scratch.remove();
  own.appendChild(document.createElement("p"));
  assert.equal(w.stop(), null, "a discarded scratch node was called a stray write");
});

test("a stray write is still caught in the middle of a redraw", () => {
  const { own } = stage();
  const w = watchKindDom(own);
  const box = document.createElement("div");
  own.appendChild(box);
  box.appendChild(document.createElement("p"));
  const stray = document.createElement("div");
  stray.id = "escapee-2";
  document.body.appendChild(stray);
  own.innerHTML = "";
  const esc = w.stop();
  assert.ok(esc, "the escape hid behind the redraw");
  assert.equal(esc.added, 1);
  assert.equal(document.getElementById("escapee-2"), null, "the escapee outlived its kind");
});
