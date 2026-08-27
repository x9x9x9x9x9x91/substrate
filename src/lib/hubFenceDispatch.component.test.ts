/** The hub canvas's fence roster, rendered for real (harness pattern in
    `docs/component-tests.md`).

    Which fences the hub draws live is declared once, in the registry, and the
    canvas holds one renderer per `hub: true` row. That the two sets MATCH is
    the compiler's job now — the map is keyed by `HubFenceId`, so a declared
    fence with no renderer and a renderer for an undeclared fence are both
    build errors, which is what replaced the source scan that used to count
    `lang === "…"` comparisons in HubDashboard.tsx.

    What a type cannot say is that the map is REACHED: a complete roster wired
    to nothing renders every fence as a code box. So each declared fence is
    rendered here and asked to produce its own widget — and the two openers
    that must NOT reach the map (a language with no row, and a bare-form
    language written with a tail) are asked for the code box. The corpus is
    keyed by `HubFenceId` too: a fence added to the registry does not compile
    until it is given a body and the widget it should draw. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import { HUB_FENCE_LANGS, type HubFenceId } from "./fenceRegistry.ts";
import type { NoteMeta } from "./types.ts";

/* the hub reads its own note for the body, so the fixture is a real note in
   the mock vault — a clone of a seeded hub, body replaced per test */
const BOARD = "Dashboards/Hub Fence Roster.md";

let win: MockWindow;

/** jsdom implements no layout, and `Range.getBoundingClientRect` is the one
    measurement it does not even stub — the chart's label-fit effect calls it
    and throws. Zeros are what every other rect answers here, and that effect
    already ignores a zero advance, so this decides nothing: it only lets the
    surface mount where a browser would measure. Whether the fit decision is
    RIGHT is a pixel question, and pixels are `e2e/`'s. */
function stubRangeMeasurement() {
  const proto = Object.getPrototypeOf(document.createRange()) as {
    getBoundingClientRect?: () => DOMRect;
  };
  if (typeof proto.getBoundingClientRect === "function") return;
  const zero = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
  proto.getBoundingClientRect = () => zero;
}

before(async () => {
  win = await mockBackend();
  stubRangeMeasurement();
  win.__mockCloneNote("Dashboards/Umbra Home.md", BOARD);
});

after(() => {
  win.__mockDeleteNote(BOARD);
});

const meta: NoteMeta = {
  path: BOARD,
  stem: "Hub Fence Roster",
  title: "Hub Fence Roster",
  folder: "Dashboards",
  props: { type: "dashboard", dashboard: "hub" },
  updated_ms: 0,
  excerpt: "",
  sealed: false,
};

function note(title: string, props: Record<string, unknown>, folder: string): NoteMeta {
  return {
    path: `${folder}/${title}.md`,
    stem: title,
    title,
    folder,
    props: props as NoteMeta["props"],
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

/* the vault snapshot the query-backed fences read: a view fence names a
   database, and a timeline needs dated rows of one — with none of either they
   would render their "unknown database" voice, which is not a code box but is
   not the widget under test either */
const NOTES: NoteMeta[] = [
  note("Gero", { type: "contact", role: "mix engineer" }, "People"),
  note("Noa", { type: "contact", role: "booking" }, "People"),
  note("Slow Bloom EP", { type: "release", created: "2026-01-05", name: "Slow Bloom EP" }, "Releases"),
  note("Vessel Songs", { type: "release", created: "2026-03-02", name: "Vessel Songs" }, "Releases"),
];

async function render(t: Parameters<typeof renderComponent>[0], body: string) {
  win.__mockEditNote(BOARD, body);
  const { default: HubDashboard } = await import("../components/HubDashboard.tsx");
  return renderComponent(
    t,
    h(HubDashboard, {
      meta,
      notes: NOTES,
      schema: {},
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );
}

/** One declared hub fence: a body that fence would really be written with,
    and the widget the canvas must mount for it. */
interface FenceCase {
  body: string;
  /** a selector only this fence's renderer produces */
  widget: string;
}

const CASES: Record<HubFenceId, FenceCase> = {
  view: { body: "```view\ntype: contact\nview: table\n```\n", widget: ".hub-view" },
  chart: {
    body: "```chart\nsource: release\nx: created\ny: count\n```\n",
    widget: ".hub-chart",
  },
  progress: {
    body: "```progress\nlabel: Contacts logged\nvalue: count\nsource: contact\ntarget: 8\n```\n",
    widget: ".hub-progress",
  },
  cards: {
    body: '```cards\n- label: Total value\n  bind: "{{Holdings.total}}"\n```\n',
    widget: ".metrics-strip",
  },
  heatmap: {
    body: "```heatmap\nsource: release\ndate: created\n```\n",
    widget: ".hub-heatmap",
  },
  calendar: {
    body: "```calendar\nsource: release\ndate: created\n```\n",
    widget: ".hub-calendar",
  },
  timeline: {
    body: "```timeline\nsource: release\nstart: created\nlabel: name\n```\n",
    widget: ".hub-timeline",
  },
};

for (const lang of HUB_FENCE_LANGS) {
  const c = CASES[lang as HubFenceId];
  test(`the hub draws a \`\`\`${lang} fence with its own widget, not a code box`, async (t) => {
    const rendered = await render(t, `Roster fixture.\n\n${c.body}`);

    assert.ok(rendered.one(c.widget), `${lang} mounted ${c.widget}`);
    assert.equal(rendered.all(".hub-pre").length, 0, `${lang} did not fall through to a code box`);
  });
}

test("a language with no registry row stays a code box", async (t) => {
  // the roster is a closed set: a user's own fence is prose, and prose on a
  // dashboard is a code box
  const rendered = await render(t, "Roster fixture.\n\n```ts\nconst secret = 1;\n```\n");

  const box = rendered.one(".hub-pre");
  assert.ok(box, "the unknown language rendered as a code box");
  assert.match(box.textContent ?? "", /const secret = 1;/);
});

test("a bare-form fence written with a tail never reaches the roster", async (t) => {
  // ```calendar month names a second word its parser does not read, so the
  // block is someone's prose — and search keeps such a block indexed, which
  // is why mounting it live here would publish its config through the index
  const rendered = await render(t, "Roster fixture.\n\n```calendar month\nsource: release\n```\n");

  const box = rendered.one(".hub-pre");
  assert.ok(box, "the tailed opener rendered as a code box");
  assert.match(box.textContent ?? "", /source: release/);
  assert.equal(rendered.all(".hub-calendar").length, 0, "and drew no month grid");
});
