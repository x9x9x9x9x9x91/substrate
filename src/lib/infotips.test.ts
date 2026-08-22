import { test } from "node:test";
import assert from "node:assert/strict";
import { TIPS, VIEW_KINDS, infoTipForElement, infoTipForView } from "./infotips.ts";
import type { View } from "./types.ts";

/* The project has no jsdom (and no test that needs one), so the resolver is
   exercised against a tiny stub that implements just the DOM surface
   `infoTipForElement` touches: closest(), getAttribute(), querySelector(),
   dataset, textContent, placeholder. `closest` walks the stub's parent chain
   and matches the small selector grammar the registry actually uses:
   ".a", ".a.b", ".a .b", "tag", "tag.cls", "[attr]", ".a[attr='v']", and
   comma-separated groups of those. */

interface StubInit {
  classes?: string[];
  tag?: string;
  attrs?: Record<string, string>;
  data?: Record<string, string>;
  text?: string;
  placeholder?: string;
  children?: Stub[];
}

class Stub {
  tag: string;
  classes: Set<string>;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  textContent: string;
  placeholder: string;
  parent: Stub | null = null;
  children: Stub[];

  constructor(init: StubInit = {}) {
    this.tag = (init.tag ?? "div").toLowerCase();
    this.classes = new Set(init.classes ?? []);
    this.attrs = { ...(init.attrs ?? {}) };
    this.dataset = { ...(init.data ?? {}) };
    // real elements expose data-* both as an attribute and on dataset
    for (const [key, value] of Object.entries(this.dataset)) {
      this.attrs[`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = value;
    }
    this.textContent = init.text ?? "";
    this.placeholder = init.placeholder ?? "";
    this.children = init.children ?? [];
    for (const c of this.children) c.parent = this;
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }

  /** matches one simple compound like `.a.b`, `button.x`, `[title]`, `.a[k='v']` */
  private matchesCompound(compound: string): boolean {
    for (const part of compound.match(/\.[^.[\]]+|\[[^\]]+\]|^[a-z]+/gi) ?? []) {
      if (part.startsWith(".")) {
        if (!this.classes.has(part.slice(1))) return false;
      } else if (part.startsWith("[")) {
        const m = part.slice(1, -1).match(/^([^=]+?)(?:=['"]?([^'"]*)['"]?)?$/);
        if (!m) return false;
        const value = this.getAttribute(m[1]);
        if (value === null) return false;
        if (m[2] !== undefined && value !== m[2]) return false;
      } else if (part.toLowerCase() !== this.tag) {
        return false;
      }
    }
    return true;
  }

  /** matches a descendant selector like `.a .b` against this node + ancestors */
  private matchesSimple(selector: string): boolean {
    const parts = selector.trim().split(/\s+/);
    const last = parts[parts.length - 1];
    if (!this.matchesCompound(last)) return false;
    let node: Stub | null = this.parent;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (node && !node.matchesCompound(parts[i])) node = node.parent;
      if (!node) return false;
      node = node.parent;
    }
    return true;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((s) => this.matchesSimple(s));
  }

  closest(selector: string): Stub | null {
    // the walk starts at self and reassigns upward — that is what Element.closest does
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: Stub | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelector(selector: string): Stub | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }
}

/** the stub stands in for Element; the resolver only uses the members above */
const el = (init: StubInit) => new Stub(init) as unknown as Element;

/* ---------- structure of the registry ---------- */

test("the view-kind list is the tip record's own keys, so it cannot go stale", () => {
  // a spot check on the derivation, not a second inventory: these four are
  // the kinds a hand-written list had already lost
  for (const kind of ["tagfolder", "tag", "mount", "changelog"]) {
    assert.ok(VIEW_KINDS.includes(kind as View["kind"]), `${kind} missing from VIEW_KINDS`);
  }
  assert.equal(new Set(VIEW_KINDS).size, VIEW_KINDS.length, "a kind is listed twice");
});

test("every tip entry has a non-empty title and body", () => {
  for (const entry of TIPS) {
    const probe = el({ classes: ["probe"], text: "Probe" });
    const tip = typeof entry.tip === "function" ? entry.tip(probe) : entry.tip;
    assert.ok(tip.title.trim().length > 0, `${entry.selector} has an empty title`);
    assert.ok(tip.body.trim().length > 0, `${entry.selector} has an empty body`);
  }
});

test("no selector is registered twice", () => {
  const seen = new Set<string>();
  for (const entry of TIPS) {
    assert.ok(!seen.has(entry.selector), `duplicate selector: ${entry.selector}`);
    seen.add(entry.selector);
  }
});

test("bodies explain rather than restate the title", () => {
  for (const entry of TIPS) {
    if (typeof entry.tip === "function") continue;
    const { title, body } = entry.tip;
    assert.notEqual(
      body.toLowerCase().replace(/[.\s]/g, ""),
      title.toLowerCase().replace(/[.\s]/g, ""),
      `${entry.selector} body just repeats its title`
    );
    assert.ok(body.length > title.length, `${entry.selector} body is too thin`);
  }
});

test("copy stays plain — no exclamation marks", () => {
  for (const entry of TIPS) {
    if (typeof entry.tip === "function") continue;
    assert.ok(!entry.tip.body.includes("!"), `${entry.selector} body shouts`);
    assert.ok(!entry.tip.title.includes("!"), `${entry.selector} title shouts`);
  }
});

test("every view kind has a static tip", () => {
  for (const kind of VIEW_KINDS) {
    const tip = infoTipForView({ kind } as View);
    assert.ok(tip, `no static tip for view kind ${kind}`);
    assert.ok(tip.title.trim().length > 0 && tip.body.trim().length > 0, kind);
  }
});

test("no tip mentions the removed yield-apr dashboard kind (SUB-447)", () => {
  const haystack: string[] = [];
  for (const kind of VIEW_KINDS) {
    const t = infoTipForView({ kind } as View);
    haystack.push(t.title, t.body);
  }
  for (const entry of TIPS) {
    if (typeof entry.tip === "function") continue;
    haystack.push(entry.tip.title, entry.tip.body);
  }
  for (const text of haystack) {
    assert.ok(!/yield|\bAPR\b/i.test(text), `stale yield/APR copy: ${text}`);
  }
});

/* ---------- resolution ---------- */

test("a data-info override beats every registered selector", () => {
  const target = el({
    classes: ["side-item"],
    data: { infoTitle: "Custom", infoBody: "Explained here." },
  });
  assert.deepEqual(infoTipForElement(target), {
    title: "Custom",
    body: "Explained here.",
  });
});

test("the closest registered selector wins over the surface fallback", () => {
  const button = new Stub({ tag: "button", classes: ["side-item"], text: "Calendar" });
  new Stub({ classes: ["sidebar"], children: [button] });
  const tip = infoTipForElement(button as unknown as Element);
  assert.equal(tip?.title, "Calendar");
  assert.notEqual(tip?.title, "Sidebar");
});

test("shared classnames resolve to the specific control, not the generic one", () => {
  // `db-new` is worn by four different buttons; the specific ones come first
  const today = el({ tag: "button", classes: ["db-new", "cal-today"] });
  const newDb = el({ tag: "button", classes: ["db-new", "dbmgr-new"] });
  const newEntry = el({ tag: "button", classes: ["db-new"] });
  assert.equal(infoTipForElement(today)?.title, "Jump to today");
  assert.equal(infoTipForElement(newDb)?.title, "New database");
  assert.equal(infoTipForElement(newEntry)?.title, "New database entry");
});

test("the tasks quick-add is not described as the day-scoped form it shares a class with", () => {
  // the compose form wears `dash-form tasks-compose`; the day-scoped copy
  // belongs to the food log's form, which has no day-free variant
  const input = new Stub({ tag: "input", classes: ["tasks-compose-input"] });
  const submit = new Stub({ tag: "button", classes: ["dash-add"] });
  const compose = new Stub({
    tag: "form",
    classes: ["dash-form", "tasks-compose"],
    children: [input, submit],
  });
  new Stub({ classes: ["dash-inner", "tasks-compact"], children: [compose] });

  const plain = el({ tag: "form", classes: ["dash-form"] });
  for (const node of [compose, input, submit]) {
    const tip = infoTipForElement(node as unknown as Element);
    assert.equal(tip?.title, "Add a task", "the quick-add resolves to its own entry");
    assert.doesNotMatch(tip?.body ?? "", /selected day/i);
  }
  // the shared class keeps its own tip for the boards that do use it
  assert.equal(infoTipForElement(plain)?.title, "Add entry");
});

test("a dashboard control resolves to its own pane's tip, not the shared dashboard chrome", () => {
  const vote = new Stub({ tag: "button", classes: ["feed-vote"] });
  const item = new Stub({ tag: "article", classes: ["feed-item"], children: [vote] });
  new Stub({ classes: ["dash-inner"], children: [item] });
  assert.equal(infoTipForElement(vote as unknown as Element)?.title, "Rate this item");

  // the claim button sits inside the snapshot form and must beat it
  const claim = new Stub({ tag: "button", classes: ["dash-claim"] });
  new Stub({ classes: ["dash-form"], children: [claim] });
  assert.equal(infoTipForElement(claim as unknown as Element)?.title, "Claim balance");

  // a chart slot beats the chart it is plotted in
  const slot = new Stub({ classes: ["chart-line-slot"] });
  new Stub({ classes: ["chart-line"], children: [slot] });
  assert.equal(infoTipForElement(slot as unknown as Element)?.title, "Data point");

  // a metric card keeps the per-card tip inside the strip
  const card = new Stub({ classes: ["dash-card"] });
  new Stub({ classes: ["metrics-strip"], children: [card] });
  assert.equal(infoTipForElement(card as unknown as Element)?.title, "Metric");
});

test("a hero reads as its own board's, not as the board that first got a tip", () => {
  const food = new Stub({ classes: ["dash-hero", "food-hero"] });
  const label = new Stub({ classes: ["dash-label"], text: "net kcal today" });
  const foodInner = new Stub({ classes: ["dash-apr"], text: "1820" });
  food.children = [label, foodInner];
  for (const c of food.children) c.parent = food;
  const foodTip = infoTipForElement(food as unknown as Element);
  assert.equal(foodTip?.title, "Today's balance");

  // the bare class is worn by the accrual board and by vault kind bundles, so
  // it has to stay true of a headline figure in general
  const shared = infoTipForElement(el({ classes: ["dash-hero"] }));
  assert.equal(shared?.title, "Headline figure");
  assert.doesNotMatch(shared?.body ?? "", /snapshot|steady/i);
  assert.notEqual(foodTip?.body, shared?.body);
});

test("deleting in Assets is described as permanent, unlike the Trash", () => {
  const trashBtn = new Stub({ tag: "button", classes: ["trash-danger"] });
  new Stub({ classes: ["trash"], children: [trashBtn] });
  const assetBtn = new Stub({ tag: "button", classes: ["trash-danger"] });
  new Stub({ classes: ["trash", "assets"], children: [assetBtn] });

  const inTrash = infoTipForElement(trashBtn as unknown as Element);
  const inAssets = infoTipForElement(assetBtn as unknown as Element);
  assert.notEqual(inTrash?.body, inAssets?.body);
  assert.match(inAssets?.title ?? "", /asset/i);
});

test("doctor findings read as read-only, unlike the Trash rows they share chrome with", () => {
  const trashRow = new Stub({
    classes: ["trash-row"],
    children: [new Stub({ classes: ["trash-row-title"], text: "old note" })],
  });
  new Stub({ classes: ["trash"], children: [trashRow] });

  const doctorRow = new Stub({
    classes: ["trash-row"],
    children: [
      new Stub({ classes: ["doctor-dot", "sev-error"], attrs: { title: "error" } }),
      new Stub({ classes: ["trash-row-title"], text: "[[missing]]" }),
    ],
  });
  new Stub({ classes: ["trash", "doctor"], children: [doctorRow] });

  const inTrash = infoTipForElement(trashRow as unknown as Element);
  const inDoctor = infoTipForElement(doctorRow as unknown as Element);
  assert.equal(inTrash?.title, "old note");
  assert.equal(inDoctor?.title, "[[missing]]");
  assert.match(inDoctor?.body ?? "", /error/i);
  assert.match(inDoctor?.body ?? "", /nothing on disk has changed/i);
  assert.doesNotMatch(inDoctor?.body ?? "", /restore/i);
});

test("the doctor's two trash-restore buttons get their own distinct tips", () => {
  const copy = new Stub({ tag: "button", classes: ["trash-restore", "doctor-copy"] });
  const path = new Stub({
    tag: "button",
    classes: ["trash-restore", "doctor-path"],
    text: "notes/inbox.md",
  });
  new Stub({ classes: ["trash", "doctor"], children: [copy, path] });
  const restore = new Stub({ tag: "button", classes: ["trash-restore"] });
  new Stub({ classes: ["trash"], children: [restore] });

  const copyTip = infoTipForElement(copy as unknown as Element);
  const pathTip = infoTipForElement(path as unknown as Element);
  assert.match(copyTip?.title ?? "", /JSON/);
  assert.match(pathTip?.title ?? "", /open/i);
  assert.match(pathTip?.body ?? "", /notes\/inbox\.md/);
  assert.notEqual(copyTip?.body, pathTip?.body);
  // the generic Trash restore tip is untouched
  assert.equal(infoTipForElement(restore as unknown as Element)?.title, "Restore");
});

test("labelled controls without an entry fall back to their label and shortcut", () => {
  const target = el({
    tag: "button",
    classes: ["not-registered-anywhere"],
    attrs: { title: "Show sidebar (⌘\\)" },
  });
  const tip = infoTipForElement(target);
  assert.equal(tip?.title, "Show sidebar");
  assert.match(tip?.body ?? "", /Keyboard shortcut: ⌘\\/);
});

test("an unlabelled input falls back to its placeholder", () => {
  const target = el({
    tag: "input",
    classes: ["not-registered-anywhere"],
    placeholder: "Filter entries",
  });
  assert.deepEqual(infoTipForElement(target), {
    title: "Text field",
    body: "Filter entries",
  });
});

test("an unknown element outside every surface yields no tip", () => {
  assert.equal(infoTipForElement(el({ classes: ["floating-nowhere"] })), null);
});

test("an unknown element inside a known surface falls back to that surface", () => {
  const inner = new Stub({ classes: ["floating-nowhere"] });
  new Stub({ classes: ["sidebar"], children: [inner] });
  assert.equal(infoTipForElement(inner as unknown as Element)?.title, "Sidebar");
});
