/** A dashboard fence pasted into an ordinary note, rendered for real through
    the component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    The block used to sit there as a dead code box: the config was plainly
    written, no picture arrived, and nothing said which of the two had gone
    wrong. The hint is the sentence that closes that silence, so what is pinned
    here is where it appears and — the half that would rot quietly — where it
    must not: the same fence in a note that DOES draw it says nothing, because
    a hint over a drawn board is a lie about the surface a reader is looking
    at. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

const HEATMAP = "```heatmap\nsource: Session\ndate: date\n```\n";

/* the hub reads its own note off the vault, so the hub half needs a real note
   there — a clone of a seeded hub with the fence written into its body */
const BOARD = "Dashboards/Hint Fixture.md";

let win: MockWindow;

before(async () => {
  win = await mockBackend();
  win.__mockCloneNote("Dashboards/Umbra Home.md", BOARD);
  win.__mockEditNote(BOARD, `Some prose above it.\n\n${HEATMAP}`);
});

after(() => {
  win.__mockDeleteNote(BOARD);
});

const boardMeta: NoteMeta = {
  path: BOARD,
  stem: "Hint Fixture",
  title: "Hint Fixture",
  folder: "Dashboards",
  props: { type: "dashboard", dashboard: "hub" },
  updated_ms: 0,
  excerpt: "",
  sealed: false,
};

async function editor(
  t: Parameters<typeof renderComponent>[0],
  body: string,
  dashboardNote = false
) {
  const { default: Editor } = await import("../components/Editor.tsx");
  return renderComponent(
    t,
    createElement(Editor, {
      docKey: "Plain Note.md",
      initial: body,
      dashboardNote,
      onChange: () => {},
      onFollowLink: () => {},
    })
  );
}

test("a heatmap fence in a plain note says where it draws", async (t) => {
  const rendered = await editor(t, `Some prose above it.\n\n${HEATMAP}`);

  const hint = rendered.one(".cm-dash-hint");
  assert.ok(hint, "the fence gets a hint under it");
  assert.match(hint.textContent ?? "", /A heatmap draws on a dashboard note/);
  // the calm state's mark, not a banner: this is the boards' "nothing is
  // wrong, here is why" voice, and the dot is what makes the two tellable
  // apart at a glance
  assert.equal(hint.querySelectorAll(".cm-dash-hint-dot").length, 1);
  // additive, never a replacement — the source the author typed is still there
  assert.match(rendered.text(), /source: Session/);
});

test("each dashboard-only fence is named by the word the docs use for it", async (t) => {
  const rendered = await editor(
    t,
    "```chart\ntype: Release\n```\n\n```progress\ntarget: 10\n```\n\n```cards\nsheet: Log\n```\n"
  );

  assert.deepEqual(
    rendered.all(".cm-dash-hint").map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim()),
    [
      "A chart draws on a dashboard note — here it stays as text.",
      "A goal thermometer draws on a dashboard note — here it stays as text.",
      "A stat-card row draws on a dashboard note — here it stays as text.",
    ]
  );
});

test("blocks that draw here, or nowhere, are left alone", async (t) => {
  // a ```view embeds a table in an ordinary note already, and a ```sh block is
  // someone's code on purpose — a hint under either would be a lie
  const rendered = await editor(
    t,
    "```view\ntype: Release\n```\n\n```sh\nnpm test\n```\n\n```\nplain\n```\n"
  );

  assert.equal(rendered.all(".cm-dash-hint").length, 0);
});

test("a tailed bare-form opener is prose, and is not sent somewhere it still would not draw", async (t) => {
  // ```calendar month parses nowhere — its parser reads the bare opener only —
  // so telling its author to move it to a dashboard would be wrong twice
  const rendered = await editor(t, "```calendar month\nsource: Session\n```\n");

  assert.equal(rendered.all(".cm-dash-hint").length, 0);
});

test("a fence quoted inside a blockquote gets no hint — it draws nowhere, dashboards included", async (t) => {
  const quoted = HEATMAP.trimEnd()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const rendered = await editor(t, `${quoted}\n`);

  assert.equal(rendered.all(".cm-dash-hint").length, 0);
});

test("the same fence in a dashboard note's own source says nothing", async (t) => {
  const rendered = await editor(t, `Some prose above it.\n\n${HEATMAP}`, true);

  assert.equal(rendered.all(".cm-dash-hint").length, 0);
  assert.match(rendered.text(), /source: Session/);
});

test("the hub that actually draws the fence carries no hint over it", async (t) => {
  const { default: HubDashboard } = await import("../components/HubDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(HubDashboard, {
      meta: boardMeta,
      notes: [],
      schema: {},
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );

  assert.equal(rendered.all(".cm-dash-hint").length, 0);
  // and it is drawing, rather than quietly leaving the fence as a code box —
  // otherwise "no hint here" would pass on a hub that shows the same dead
  // block the note used to
  assert.ok(rendered.one(".hub-heatmap"), "the hub drew the year grid");
});
