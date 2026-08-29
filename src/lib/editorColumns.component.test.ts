/** Columns in the editor, rendered for real through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    Three things are worth pinning and only a mounted editor can pin them: the
    region becomes a grid rather than five stacked lines; the caret entering it
    gives back the plain markdown that was always on disk; and — the half that
    would rot silently — an edit made in there is ordinary text to ⌘Z, while
    the app adopting an external change to the same buffer is not. Columns are
    a rendering, and a rendering that quietly ate someone's undo stack would
    be a worse deal than no columns at all. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement, useState } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { Rendered } from "./componentHarness.ts";

const TWO_COLUMNS = [
  "Above the columns.",
  "",
  "<!-- columns -->",
  "## Left",
  "- one",
  "- two",
  "<!-- col -->",
  "## Right",
  "Right body with a [[Static Bouquet]] link.",
  "<!-- /columns -->",
  "",
  "Below the columns.",
].join("\n");

let win: MockWindow;

before(async () => {
  win = await mockBackend();
});

after(() => {
  void win;
});

interface Mounted {
  rendered: Rendered;
  /** the live CodeMirror view behind the rendered surface */
  view: {
    state: { doc: { toString(): string }; selection: { main: { head: number } } };
    dispatch: (spec: unknown) => void;
  };
}

async function editor(
  t: Parameters<typeof renderComponent>[0],
  body: string,
  props: Record<string, unknown> = {}
): Promise<Mounted> {
  const { default: Editor } = await import("../components/Editor.tsx");
  const rendered = await renderComponent(
    t,
    createElement(Editor, {
      docKey: "Columns Note.md",
      initial: body,
      onChange: () => {},
      onFollowLink: () => {},
      ...props,
    })
  );
  const { EditorView } = await import("@codemirror/view");
  const host = rendered.one(".cm-editor");
  assert.ok(host, "the editor mounted");
  const view = EditorView.findFromDOM(host as HTMLElement);
  assert.ok(view, "CodeMirror is reachable from the rendered DOM");
  return { rendered, view: view as unknown as Mounted["view"] };
}

test("a column region renders as a grid of columns, markers and all hidden", async (t) => {
  const { rendered } = await editor(t, TWO_COLUMNS);

  const grid = rendered.one(".cm-columns");
  assert.ok(grid, "the region is one block widget, not stacked lines");
  assert.equal(rendered.all(".cm-column").length, 2, "two columns");

  // each column is ordinary markdown, rendered
  const [left, right] = rendered.all(".cm-column");
  assert.equal(left.querySelector("h2")?.textContent, "Left");
  assert.equal(left.querySelectorAll("li").length, 2);
  assert.equal(right.querySelector("h2")?.textContent, "Right");

  // a wikilink inside a column is the editor's own link mark, so it follows
  // on the same click one outside a column does
  const link = right.querySelector(".cm-wikilink");
  assert.equal(link?.getAttribute("data-link"), "Static Bouquet");

  // the layout comments are layout: nothing on screen says `<!-- col -->`
  assert.ok(!rendered.text().includes("<!-- col -->"), "no marker leaked into the page");
  assert.ok(!rendered.text().includes("<!-- columns -->"));
  // and the prose either side is untouched
  assert.match(rendered.text(), /Above the columns\./);
  assert.match(rendered.text(), /Below the columns\./);
});

test("the caret inside the region gives back the markdown underneath", async (t) => {
  const { rendered, view } = await editor(t, TWO_COLUMNS);
  assert.ok(rendered.one(".cm-columns"), "rendered to begin with");

  const { setEditorFocus } = await import("./editorfocus.ts");
  const insideLeftColumn = TWO_COLUMNS.indexOf("## Left") + 3;
  view.dispatch({
    selection: { anchor: insideLeftColumn },
    effects: setEditorFocus.of(true),
  });
  await rendered.settle();

  assert.equal(rendered.one(".cm-columns"), null, "the widget stood down");
  assert.match(rendered.text(), /<!-- col -->/, "the source is what you edit");
  assert.match(rendered.text(), /<!-- \/columns -->/);
});

test("an edit inside a column undoes and redoes as ordinary text", async (t) => {
  const { rendered, view } = await editor(t, TWO_COLUMNS);
  const { undo, redo } = await import("@codemirror/commands");
  const { setEditorFocus } = await import("./editorfocus.ts");

  const at = TWO_COLUMNS.indexOf("- two") + "- two".length;
  view.dispatch({ selection: { anchor: at }, effects: setEditorFocus.of(true) });
  view.dispatch({ changes: { from: at, insert: " and a half" }, selection: { anchor: at + 11 } });
  await rendered.settle();
  assert.match(view.state.doc.toString(), /- two and a half/);

  undo(view as never);
  await rendered.settle();
  assert.equal(view.state.doc.toString(), TWO_COLUMNS, "one ⌘Z, the edit is gone");

  redo(view as never);
  await rendered.settle();
  assert.match(view.state.doc.toString(), /- two and a half/, "and ⇧⌘Z brings it back");
});

test("an external adopt of the buffer stays out of the undo history", async (t) => {
  const docRef: { current: ((body: string) => void) | null } = { current: null };
  const { rendered, view } = await editor(t, TWO_COLUMNS, { docRef });
  const { undo } = await import("@codemirror/commands");
  const { setEditorFocus } = await import("./editorfocus.ts");

  // the person's own edit first, so there IS something on the stack to eat
  const at = TWO_COLUMNS.indexOf("- two") + "- two".length;
  view.dispatch({ selection: { anchor: at }, effects: setEditorFocus.of(true) });
  view.dispatch({ changes: { from: at, insert: " (mine)" }, selection: { anchor: at + 7 } });
  const mine = view.state.doc.toString();
  await rendered.settle();
  assert.match(mine, /- two \(mine\)/, "the edit inside the column landed");

  // then the app adopts a changed file from outside — a sync, another window
  assert.ok(docRef.current, "the editor published its adopt door");
  const adopted = mine.replace("Below the columns.", "Below the columns, rewritten elsewhere.");
  docRef.current!(adopted);
  await rendered.settle();
  assert.equal(view.state.doc.toString(), adopted, "the external body landed");

  // ⌘Z must never roll the adopt back: the editor would autosave the stale
  // body straight over whatever the other window just wrote. The adopt is a
  // whole-buffer replace, so it also maps the earlier edit out of reach —
  // that is the adopt's bargain, and it is the same with or without columns.
  undo(view as never);
  await rendered.settle();
  assert.equal(view.state.doc.toString(), adopted, "⌘Z left the external body alone");
});

const NESTED = [
  "<!-- columns -->",
  "## Left",
  "- [ ] open task",
  "- [x] done task",
  "<!-- col -->",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```view",
  "from: notes",
  "```",
  "<!-- /columns -->",
].join("\n");

test("a caret key walks into the region and the source appears", async (t) => {
  const { rendered, view } = await editor(t, TWO_COLUMNS);
  const { cursorCharRight } = await import("@codemirror/commands");
  const { setEditorFocus } = await import("./editorfocus.ts");

  // caret on the prose line above, focused, region rendered. (Character
  // movement, not ↓: vertical motion asks the view for coordinates, and this
  // harness has no layout to give it. What is being pinned is the same thing
  // either key would pin — a block widget must not be a wall the caret slides
  // past, leaving a page nobody can get into.)
  const before = TWO_COLUMNS.indexOf("<!-- columns -->") - 1;
  view.dispatch({ selection: { anchor: before }, effects: setEditorFocus.of(true) });
  await rendered.settle();
  assert.ok(rendered.one(".cm-columns"), "rendered while the caret is outside");

  for (let i = 0; i < 3 && rendered.one(".cm-columns"); i++) {
    cursorCharRight(view as never);
    await rendered.settle();
  }
  assert.equal(rendered.one(".cm-columns"), null, "the caret key got in");
  const head = view.state.selection.main.head;
  assert.ok(
    head > before && head < TWO_COLUMNS.indexOf("<!-- /columns"),
    `the caret is inside the region, not jumped past it (at ${head})`
  );
  assert.match(rendered.text(), /<!-- col -->/, "and the markdown is there to edit");
});

const DASH_FENCE = ["<!-- columns -->", "```chart", "type: bar", "```", "<!-- /columns -->"].join(
  "\n"
);

/** Two rows and a column, enough for a fence to have visibly drawn something.
    The shape is the resolved half of `EmbedResult` (src/lib/embeds.ts). */
const VIEW_ANSWER = {
  dbType: "release",
  columns: ["status"],
  rows: [
    { path: "Kite.md", title: "Kite", updated_ms: 0, cells: ["mixing"], props: {} },
    { path: "Ember.md", title: "Ember", updated_ms: 0, cells: ["done"], props: {} },
  ],
  total: 2,
  typeSchema: {},
  query: "type:release",
};

test("a task inside a column is a live toggle; a table stays the print table", async (t) => {
  const { rendered, view } = await editor(t, NESTED);

  const [left, right] = rendered.all(".cm-column");
  assert.ok(left && right, "two columns");

  // the print classes stay (done fading rides them), but the box is a control
  assert.equal(left.querySelectorAll("li.print-task").length, 2);
  assert.equal(left.querySelectorAll("li.print-task.done").length, 1);
  const boxes = left.querySelectorAll<HTMLInputElement>("input.cm-task-toggle");
  assert.equal(boxes.length, 2, "each task carries a real toggle");
  assert.equal(boxes[0].checked, false);
  assert.equal(boxes[1].checked, true);

  // a table is the print table, not the editor's TableWidget
  const printed = right.querySelector("table:not(.embed-view-table)");
  assert.equal(printed?.querySelectorAll("th").length, 2);
  assert.equal(right.querySelectorAll(".cm-table").length, 0);

  // clicking the open task writes the flip back to ITS source line…
  boxes[0].click();
  await rendered.settle();
  assert.match(view.state.doc.toString(), /- \[x\] open task/);
  assert.match(view.state.doc.toString(), /- \[x\] done task/, "the other task untouched");
  // …and the region stays rendered: the toggle never moved the caret inside
  assert.ok(rendered.one(".cm-columns"), "the grid did not stand down");
});

test("a toggle finds its own line when two columns carry the same task text", async (t) => {
  const SAME = [
    "<!-- columns -->",
    "- [ ] water the ferns",
    "<!-- col -->",
    "- [ ] water the ferns",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered, view } = await editor(t, SAME);

  const [, right] = rendered.all(".cm-column");
  const box = right.querySelector<HTMLInputElement>("input.cm-task-toggle");
  assert.ok(box, "the right column's toggle");
  box!.click();
  await rendered.settle();
  const lines = view.state.doc.toString().split("\n");
  assert.equal(lines[1], "- [ ] water the ferns", "the left twin did not flip");
  assert.equal(lines[3], "- [x] water the ferns", "the clicked one did");
});

test("a view fence inside a column draws through the app's own view widget", async (t) => {
  const { rendered } = await editor(t, NESTED, {
    embedQuery: () => ({
      dbType: "notes",
      columns: ["title"],
      rows: [
        { path: "A.md", title: "A", updated_ms: 0, cells: ["A"], props: { title: "A" } },
      ],
      total: 1,
      typeSchema: {},
      query: "",
    }),
  });

  const [, right] = rendered.all(".cm-column");
  const embed = right.querySelector(".embed-view");
  assert.ok(embed, "the fence mounted the view widget");
  assert.match(embed!.textContent ?? "", /Notes/, "the widget drew its header");
  assert.ok(!/from: notes/.test(right.textContent ?? ""), "the source is not on screen");
});

test("a callout inside a column renders as a callout, accent and all", async (t) => {
  const CALLOUT = [
    "<!-- columns -->",
    "> [!warn|red] Careful",
    "> The body line.",
    "<!-- col -->",
    "> just a quote",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, CALLOUT);

  const [left, right] = rendered.all(".cm-column");
  const box = left.querySelector(".cm-colcallout");
  assert.ok(box, "the callout box rendered");
  assert.ok(box!.querySelector(".cm-callout-glyph-warn"), "the glyph carries the kind");
  assert.equal(box!.getAttribute("data-accent"), "red", "the author's accent rode along");
  assert.match(box!.querySelector(".cm-callout-glyph")?.textContent ?? "", /warn/);
  assert.match(box!.textContent ?? "", /Careful/);
  assert.match(box!.textContent ?? "", /The body line\./);
  assert.ok(!/\[!warn/.test(left.textContent ?? ""), "no marker leaked as text");

  // a plain quote is still the print blockquote, not a callout
  assert.ok(right.querySelector("blockquote"), "plain quote kept");
  assert.equal(right.querySelector(".cm-colcallout"), null);
});

test("audio and file embeds inside a column mount live widgets, not placeholders", async (t) => {
  const EMBEDS = [
    "<!-- columns -->",
    "![[render-v3.wav]]",
    "",
    "![[stems.zip]]",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, EMBEDS);

  const [cell] = rendered.all(".cm-column");
  // the inner widgets own their loading/missing states; what the column owes
  // is that each embed became a MOUNT rather than print's named placeholder
  assert.equal(cell.querySelectorAll("[data-live-mount]").length, 2);
  assert.ok(!/embedded file ·/.test(cell.textContent ?? ""), "no print placeholder");
});

test("an embed in a heading mounts live, and quote interiors stay print", async (t) => {
  const MIXED = [
    "<!-- columns -->",
    "## ![[intro-take.wav]]",
    "",
    "> ![[quoted.wav]]",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, MIXED);

  const [cell] = rendered.all(".cm-column");
  // outside a region the embed decorator reads heading lines too, so parity
  // says the heading's player mounts…
  assert.equal(cell.querySelectorAll("h2 [data-live-mount]").length, 1);
  // …while a quote interior is quoted material and keeps the print placeholder
  assert.match(cell.querySelector("blockquote")?.textContent ?? "", /embedded file ·/);
});

test("a toggle in a SECOND region writes back through its own region's position", async (t) => {
  const TWO_REGIONS = [
    "<!-- columns -->",
    "- [ ] first region task",
    "<!-- /columns -->",
    "",
    "middle prose",
    "",
    "<!-- columns -->",
    "- [ ] second region task",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered, view } = await editor(t, TWO_REGIONS);

  const grids = rendered.all(".cm-columns");
  assert.equal(grids.length, 2, "both regions rendered");
  const box = grids[1].querySelector<HTMLInputElement>("input.cm-task-toggle");
  assert.ok(box, "the second region's toggle");
  box!.click();
  await rendered.settle();
  const lines = view.state.doc.toString().split("\n");
  assert.equal(lines[1], "- [ ] first region task", "region one untouched");
  assert.equal(lines[7], "- [x] second region task", "region two flipped its own line");
});

test("an indented callout header is still a callout, and quoted markers stay quoted", async (t) => {
  const TRICKY = [
    "<!-- columns -->",
    ">   [!idea] Spaced header",
    "> body",
    "<!-- col -->",
    "> [!note] Holder",
    "> <!-- columns -->",
    "> quoted marker line",
    "> <!-- /columns -->",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, TRICKY);

  const [left, right] = rendered.all(".cm-column");
  // the quote strip leaves the header's own indent behind; the source view,
  // the hub and print all still call this a callout, so the cell must too
  assert.ok(left.querySelector(".cm-colcallout .cm-callout-glyph-idea"), "spaced header parsed");
  // markers inside a callout body are quoted material — the linear pass
  // renders them as the literal lines they are, never as a nested grid
  const body = right.querySelector(".cm-colcallout-body");
  assert.ok(body, "the callout body rendered");
  // .print-columns is the class the region pass WOULD emit here — its absence
  // is what discriminates the linear pass from renderPrintBody
  assert.equal(body!.querySelector(".print-columns, .cm-columns"), null, "no nested grid");
  assert.match(body!.textContent ?? "", /<!-- columns -->/, "the marker stays text");
});

test("an epoch-only change repaints the region's DOM in place", async (t) => {
  let queries = 0;
  const { rendered } = await editor(t, NESTED, {
    embedQuery: () => {
      queries++;
      return {
        dbType: "notes",
        columns: ["title"],
        rows: [
          { path: "A.md", title: "A", updated_ms: 0, cells: ["A"], props: { title: "A" } },
        ],
        total: 1,
        typeSchema: {},
        query: "",
      };
    },
  });
  const { ColumnsWidget } = await import("./editor-widgets.ts");
  const { EditorView } = await import("@codemirror/view");
  const view = EditorView.findFromDOM(rendered.one(".cm-editor") as HTMLElement)!;

  const src = NESTED;
  const w0 = new ColumnsWidget(src, 0);
  const dom = w0.toDOM(view as never);
  const table = dom.querySelector(".embed-view");
  assert.ok(table, "the view mounted");

  // same source, new epoch: the DOM is kept and the mounted view repaints —
  // this is what carries an open cell editor across a vault change
  const before = queries;
  const w1 = new ColumnsWidget(src, 1);
  assert.equal(w1.eq(w0), false, "the epoch is part of the identity here");
  assert.equal(w1.updateDOM(dom, view as never, w0), true, "…but the DOM survives");
  assert.equal(dom.querySelector(".embed-view"), table, "same node…");
  assert.ok(queries > before, "…and the repaint really re-asked for the rows");

  // a source change is a different region: full rebuild
  const w2 = new ColumnsWidget(src.replace("open task", "renamed task"), 1);
  assert.equal(w2.updateDOM(dom, view as never, w1), false);

  // a widget whose images failed refuses the in-place path too — the flag
  // lives on the DOM, because the rejection can land after an adoption
  const w3 = new ColumnsWidget(src, 2);
  dom.setAttribute("data-column-img-failed", "");
  assert.equal(w3.updateDOM(dom, view as never, w1), false, "image failure forces the rebuild");
  w1.destroy(dom);
});

test("a failed image load stamps the region DOM, not just the widget instance", async (t) => {
  const IMAGE = [
    "<!-- columns -->",
    "![[cover-shot.png]]",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, IMAGE);
  // the mock vault has no such asset: the blob fetch rejects, the missing
  // span lands, and the DOM carries the rebuild signal a later widget reads
  await new Promise((r) => setTimeout(r, 80));
  await rendered.settle();
  const wrap = rendered.one(".cm-columns");
  assert.ok(wrap, "region rendered");
  assert.match(wrap!.textContent ?? "", /missing image ·/);
  assert.ok(wrap!.hasAttribute("data-column-img-failed"), "the DOM remembers the failure");
});

test("a task line only one grammar recognizes keeps the printed mark", async (t) => {
  // NBSP indentation: the scanner's \s* accepts it, TASK_RE's [ \t]* does not
  // — outside a region this line gets no live checkbox either, so the cell
  // draws the print mark rather than a control whose click would no-op
  const ODD = [
    "<!-- columns -->",
    " - [ ] pasted with odd indent",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, ODD);
  const [cell] = rendered.all(".cm-column");
  assert.equal(cell.querySelectorAll("input.cm-task-toggle").length, 0, "no live control");
  assert.ok(cell.querySelector("li.print-task .print-box"), "the printed mark instead");
});

test("the epoch joins the identity for every spelling the renderer mounts", async () => {
  const { ColumnsWidget } = await import("./editor-widgets.ts");
  const region = (fence: string) =>
    `<!-- columns -->\n\`\`\`${fence}\nfrom: notes\n\`\`\`\n<!-- /columns -->`;
  // the renderer matches the info string's first word case-folded; the
  // identity test must not be narrower or a vault change draws stale rows
  assert.equal(new ColumnsWidget(region("view"), 0).liveData, true);
  assert.equal(new ColumnsWidget(region("View"), 0).liveData, true);
  assert.equal(new ColumnsWidget(region("view saved:pins"), 0).liveData, true);
  assert.equal(new ColumnsWidget(region("viewport"), 0).liveData, false);
  assert.equal(new ColumnsWidget("<!-- columns -->\nprose\n<!-- /columns -->", 0).liveData, false);
  // a file embed's FAILURE state rides the epoch (a missing .wav heals when
  // the file lands); a healthy image keeps its cheap name-only identity
  assert.equal(new ColumnsWidget("<!-- columns -->\n![[x.wav]]\n<!-- /columns -->", 0).liveData, true);
  assert.equal(new ColumnsWidget("<!-- columns -->\n![[x.png]]\n<!-- /columns -->", 0).liveData, false);
});

test("a dashboard fence inside a column keeps its source and says where it draws", async (t) => {
  const { rendered } = await editor(t, DASH_FENCE);
  const [column] = rendered.all(".cm-column");
  assert.ok(column, "the region rendered");

  // a chart has no headless draw, and a column that drew one would be more
  // capable than the paragraph beside it — so it gets exactly what the same
  // fence gets outside a column: the source box plus the line saying where
  // it comes alive
  assert.match(column.textContent ?? "", /type: bar/, "the source box is still the source box");
  const hint = column.querySelector(".cm-dash-hint");
  assert.ok(hint, "and the same hint line the fence gets outside a column");
  assert.match(hint!.textContent ?? "", /dashboard/i);
});

test("the same chart fence in a dashboard note's own source says nothing", async (t) => {
  // outside a column the hint is suppressed on the note that draws the board
  // (dashFenceHint.component.test.ts) — the region has to keep that rule, or
  // a dashboard's own source would nag about itself the moment its fences
  // were laid out in columns
  const { rendered } = await editor(t, DASH_FENCE, { dashboardNote: true });
  const [column] = rendered.all(".cm-column");
  assert.ok(column, "the region rendered");
  assert.match(column.textContent ?? "", /type: bar/, "the source box is still there");
  assert.equal(column.querySelector(".cm-dash-hint"), null, "and nothing nags about it");
});

test("flipping the note's type: rebuilds the region and the hint follows", async (t) => {
  // the flag rides the widget's identity (constructor + eq) and columnsRender
  // recomputes on a dashboardNoteField change — this is the pair of behaviors
  // that would rot silently if either half were dropped
  const { rendered, bump } = await bumpableEditor(t, DASH_FENCE, (flip) => ({
    dashboardNote: flip > 0,
  }));
  assert.ok(rendered.one(".cm-column .cm-dash-hint"), "a plain note's column carries the hint");

  await bump(1); // the note's type: becomes a dashboard's, buffer still mounted
  assert.ok(rendered.one(".cm-columns"), "the region is still rendered");
  assert.equal(rendered.one(".cm-column .cm-dash-hint"), null, "the hint stood down in place");

  await bump(0); // and back
  assert.ok(rendered.one(".cm-column .cm-dash-hint"), "the hint returned with the plain type");
});

test("a link's own markup survives the swap into an editor link mark", async (t) => {
  const { rendered } = await editor(
    t,
    "<!-- columns -->\nSee [[Static Bouquet|the **master** notes]].\n<!-- /columns -->"
  );
  const mark = rendered.one(".cm-wikilink");
  assert.ok(mark, "the wikilink became the editor's own mark");
  // the follower parses the target off the front, alias and all, the way it
  // does for a mark outside a column
  assert.match(mark!.getAttribute("data-link") ?? "", /^Static Bouquet\|/);
  assert.equal(mark!.querySelector("strong")?.textContent, "master", "the label kept its bold");
});

const FENCE_AND_PLAYER = [
  "<!-- columns -->",
  "![[Deep Cut.wav]]",
  "<!-- col -->",
  "```view",
  "from: notes",
  "```",
  "<!-- /columns -->",
].join("\n");

/** The same shape as VIEW_ANSWER, one different row: what the fence answers
    after the vault moved. */
const MOVED_ANSWER = {
  ...VIEW_ANSWER,
  rows: [{ path: "Sable.md", title: "Sable", updated_ms: 0, cells: ["mixing"], props: {} }],
  total: 1,
};

/** Mount an editor whose vault epoch this test can move, the way App moves it
    when the watcher reports a change. */
async function bumpableEditor(
  t: Parameters<typeof renderComponent>[0],
  body: string,
  props: (epoch: number) => Record<string, unknown>
): Promise<{ rendered: Rendered; bump: (epoch: number) => Promise<void> }> {
  const { default: Editor } = await import("../components/Editor.tsx");
  let set: (epoch: number) => void = () => {};
  const Host = () => {
    const [epoch, setEpoch] = useState(0);
    set = setEpoch;
    return createElement(Editor, {
      docKey: "Columns Note.md",
      initial: body,
      onChange: () => {},
      onFollowLink: () => {},
      ...props(epoch),
    });
  };
  const rendered = await renderComponent(t, createElement(Host));
  const bump = async (epoch: number) => {
    await act(async () => {
      set(epoch);
    });
    await rendered.settle();
  };
  return { rendered, bump };
}

test("a view fence in a column redraws on a vault bump, and the player beside it keeps its element", async (t) => {
  // A region holding live data rides the vault epoch, but `updateDOM` turns
  // the rebuild into an in-place repaint — a vault change must not rebuild a
  // cell around a playing track. A drawn fence is the one thing in there that
  // answers a question about the vault, so it has to notice anyway — and both
  // halves of that bargain are pinned here, through the full component mount.
  let answered = VIEW_ANSWER;
  const { rendered, bump } = await bumpableEditor(t, FENCE_AND_PLAYER, (epoch) => ({
    embedQuery: () => answered,
    vaultEpoch: epoch,
  }));

  const drawn = () => rendered.one(".embed-view .embed-view-table");
  assert.equal(drawn()?.querySelectorAll("tbody tr").length, 2, "the fence drew the answer");
  assert.equal(drawn()?.querySelector("tbody tr td")?.textContent, "Kite");
  const player = rendered.one('[class*="cm-audio"]');
  assert.ok(player, "and the player mounted beside it");

  // the vault moved, and the same fence outside a column would now say Sable
  answered = MOVED_ANSWER as typeof VIEW_ANSWER;
  await bump(1);

  assert.equal(drawn()?.querySelectorAll("tbody tr").length, 1, "the drawn table caught up");
  assert.equal(drawn()?.querySelector("tbody tr td")?.textContent, "Sable");
  assert.equal(
    rendered.one('[class*="cm-audio"]'),
    player,
    "and the transport beside it is the same element — a bump is a redraw, not a rebuild"
  );
});

test("a file embed that missed heals on the next vault bump", async (t) => {
  const body = "<!-- columns -->\n![[Late Arrival.zip]]\n<!-- /columns -->";
  const { rendered, bump } = await bumpableEditor(t, body, (epoch) => ({ vaultEpoch: epoch }));

  assert.ok(rendered.one(".cm-filechip-missing"), "nothing of that name in the vault yet");

  // the file lands — which is a vault change, and the bump that follows one is
  // the region's cue to look again
  (win as unknown as { __mockSaveAsset?: (name: string, data: string) => void }).__mockSaveAsset?.(
    "Late Arrival.zip",
    "PK"
  );
  await bump(1);

  assert.equal(rendered.one(".cm-filechip-missing"), null, "the missing chip stood down");
  assert.ok(rendered.one(".cm-filechip"), "and the named chip is what stands there");
});

test("a tilde view fence inside a column draws, like every other spelling", async (t) => {
  // lezer recognizes every fence spelling outside a column, so the column's
  // own scanner has to as well — a `~~~view` used to render as paragraph text
  const TILDE = [
    "<!-- columns -->",
    "~~~view",
    "from: notes",
    "~~~",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, TILDE, { embedQuery: () => VIEW_ANSWER });

  const [column] = rendered.all(".cm-column");
  assert.ok(column.querySelector(".embed-view"), "the fence mounted the view widget");
  assert.ok(!/from: notes/.test(column.textContent ?? ""), "and its config is not on screen");
});

test("an indented dashboard fence keeps its source box and its hint", async (t) => {
  const INDENTED = [
    "<!-- columns -->",
    "  ```chart",
    "  type: bar",
    "  ```",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, INDENTED);

  const [column] = rendered.all(".cm-column");
  assert.match(column.textContent ?? "", /type: bar/, "the source box rendered");
  const hint = column.querySelector(".cm-dash-hint");
  assert.ok(hint, "and the hint the same fence gets outside a column");
  assert.match(hint!.textContent ?? "", /dashboard/i);
});

test("a dashboard fence under a list item gets the hint it gets outside a column", async (t) => {
  const IN_LIST = [
    "<!-- columns -->",
    "- the numbers",
    "  ```chart",
    "  type: bar",
    "  ```",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, IN_LIST);

  const [column] = rendered.all(".cm-column");
  assert.equal(column.querySelectorAll("li").length, 1, "the item is still an item");
  assert.match(column.textContent ?? "", /type: bar/, "the fence is a source box, not prose");
  assert.ok(column.querySelector(".cm-dash-hint"), "and it says where it draws");
});

test("the epoch joins the identity for a view fence in any spelling", async () => {
  const { ColumnsWidget } = await import("./editor-widgets.ts");
  const region = (open: string, close: string) =>
    `<!-- columns -->\n${open}\nfrom: notes\n${close}\n<!-- /columns -->`;
  assert.equal(new ColumnsWidget(region("~~~view", "~~~"), 0).liveData, true);
  assert.equal(new ColumnsWidget(region("````view", "````"), 0).liveData, true);
  assert.equal(new ColumnsWidget(region("  ```view", "  ```"), 0).liveData, true);
  assert.equal(new ColumnsWidget(region("~~~viewport", "~~~"), 0).liveData, false);
});

test("a slot character pasted into a cell's text mounts nothing of its own", async (t) => {
  // the private-use pair that holds a live mount's place is invisible, so it
  // can ride in on a paste. Left in the author's text it reads as a slot: the
  // player on the same line was mounted twice, once where the paste sat.
  const PASTED = [
    "<!-- columns -->",
    "before \uE0000\uE001 after ![[render-v3.wav]]",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, PASTED);

  const [cell] = rendered.all(".cm-column");
  assert.equal(cell.querySelectorAll("[data-live-mount]").length, 1, "one player, not two");
  assert.match(cell.textContent ?? "", /before/, "the text either side survives");
  assert.match(cell.textContent ?? "", /after/);
});

test("emphasis opened before an embed and closed after it is still emphasis", async (t) => {
  const ACROSS = [
    "<!-- columns -->",
    "**a ![[render-v3.wav]] b**",
    "",
    "`![[literal.wav]]` stays a code span",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, ACROSS);

  const [cell] = rendered.all(".cm-column");
  const strong = cell.querySelector("strong");
  assert.ok(strong, "the run closed across the mount");
  assert.match(strong!.textContent ?? "", /a/, "the text either side is inside it");
  assert.ok(strong!.querySelector("[data-live-mount]"), "and the player is inside it too");
  assert.ok(!/\*\*/.test(cell.textContent ?? ""), "no marker printed literally");
  // a code span is still the literal it is everywhere else
  assert.match(cell.querySelector("code")?.textContent ?? "", /!\[\[literal\.wav\]\]/);
});

test("an annotations fence inside a column binds to its player", async (t) => {
  const BOUND = [
    "<!-- columns -->",
    "![[render-v3.wav]]",
    "```annotations",
    "audio: render-v3.wav",
    "00:12 — the drop lands early",
    "```",
    "",
    "After the fence.",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered } = await editor(t, BOUND);

  const [cell] = rendered.all(".cm-column");
  // outside a region this pair is one block: the player carries the marker and
  // the note, and the fence is not a code box on the page
  assert.ok(!/audio: render-v3\.wav/.test(cell.textContent ?? ""), "the fence is not source");
  assert.equal(cell.querySelectorAll(".cm-audio-marker").length, 1, "the timestamp is a marker");
  assert.match(cell.textContent ?? "", /the drop lands early/, "and the note is listed");
  assert.ok(cell.querySelector(".cm-audio-annotation-compose"), "the composer is there to write with");
  // the prose under the block still renders, in its own right
  assert.match(cell.textContent ?? "", /After the fence\./);
});

test("an annotation written inside a column lands in its own fence", async (t) => {
  const TWO_PLAYERS = [
    "<!-- columns -->",
    "![[one.wav]]",
    "```annotations",
    "audio: one.wav",
    "00:05 — first",
    "```",
    "<!-- col -->",
    "![[two.wav]]",
    "```annotations",
    "audio: two.wav",
    "00:09 — second",
    "```",
    "<!-- /columns -->",
  ].join("\n");
  const { rendered, view } = await editor(t, TWO_PLAYERS);

  // the write-back address is resolved from the REGION's position plus the
  // player's own line offset — the second column's player must not write into
  // the first column's fence
  const [, right] = rendered.all(".cm-column");
  const input = right.querySelector(".cm-audio-annotation-compose input") as HTMLInputElement;
  assert.ok(input, "the second player carries a composer");
  input.value = "written from the right column";
  await act(async () => {
    input.closest("form")!.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("submit", { bubbles: true, cancelable: true }));
  });
  await rendered.settle();

  const doc = view.state.doc.toString();
  const inSecondFence = doc.slice(doc.indexOf("audio: two.wav"));
  assert.match(inSecondFence, /written from the right column/, "it landed under audio: two.wav");
  assert.ok(
    !/written from the right column/.test(doc.slice(0, doc.indexOf("audio: two.wav"))),
    "and nothing was written into the first column's fence"
  );
});

test("a video embed inside a column is the chip it is outside one", async (t) => {
  // the app ships no video player anywhere — outside a region `![[clip.mp4]]`
  // is the named file chip, so that is what the column owes it
  const VIDEO = ["<!-- columns -->", "![[clip.mp4]]", "<!-- /columns -->"].join("\n");
  const { rendered } = await editor(t, VIDEO);

  const [cell] = rendered.all(".cm-column");
  assert.equal(cell.querySelectorAll("[data-live-mount]").length, 1, "one mount, not print text");
  assert.match(cell.textContent ?? "", /clip\.mp4/, "and it says which file it stands for");
  assert.ok(!/embedded file ·/.test(cell.textContent ?? ""), "no print placeholder");
});
