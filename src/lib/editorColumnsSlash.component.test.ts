/** The `/columns` row of the slash palette, driven through a mounted editor
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    The empty insert is a pure function and is pinned as one in
    `slashmenu.test.ts`. The half that can only be pinned here is the wrap:
    typing `/` REPLACES whatever was selected, so by the time the palette
    opens the text it is standing in for is already out of the document. The
    editor remembers it for exactly one command; nothing about that survives
    outside a real CodeMirror. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow, Rendered } from "./componentHarness.ts";

let win: MockWindow;

before(async () => {
  win = await mockBackend();
  void win;
});

interface Mounted {
  rendered: Rendered;
  view: {
    state: {
      doc: { toString(): string };
      selection: { main: { head: number; anchor: number } };
    };
    dispatch: (spec: unknown) => void;
  };
}

async function editor(
  t: Parameters<typeof renderComponent>[0],
  body: string,
  toasts: string[] = []
): Promise<Mounted> {
  const { default: Editor } = await import("../components/Editor.tsx");
  const rendered = await renderComponent(
    t,
    createElement(Editor, {
      docKey: "Slash Note.md",
      initial: body,
      onChange: () => {},
      onFollowLink: () => {},
      onToast: (msg: string) => toasts.push(msg),
    })
  );
  const { EditorView } = await import("@codemirror/view");
  const host = rendered.one(".cm-editor");
  assert.ok(host, "the editor mounted");
  const view = EditorView.findFromDOM(host as HTMLElement);
  assert.ok(view, "CodeMirror is reachable from the rendered DOM");
  return { rendered, view: view as unknown as Mounted["view"] };
}

/** Type `/` over `[from, to)` and pick the named row, the way the palette
    does: the option's own `apply` is what runs on Enter. */
async function pickSlash(
  mounted: Mounted,
  range: { from: number; to: number },
  name: string
): Promise<void> {
  const { setEditorFocus } = await import("./editorfocus.ts");
  const { startCompletion, currentCompletions } = await import("@codemirror/autocomplete");
  const { view, rendered } = mounted;
  view.dispatch({ effects: setEditorFocus.of(true) });
  // the pick is a real selection first — that is what the `/` is traded for,
  // and what an undo of the whole gesture has to give back
  view.dispatch({ selection: { anchor: range.from, head: range.to } });
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: "/" },
    selection: { anchor: range.from + 1 },
    userEvent: "input.type",
  });
  await rendered.settle();

  (view as unknown as { focus(): void }).focus();
  startCompletion(view as never);
  // the palette debounces before it asks its sources; `settle` buys macrotask
  // turns, not wall-clock, so this waits out the timer the plugin actually set
  await new Promise((done) => setTimeout(done, 120));
  await rendered.settle();
  const options = currentCompletions((view as never as { state: never }).state);
  const option = options.find((o) => o.label === `/${name}`);
  assert.ok(option, `the palette offers /${name} (got ${options.map((o) => o.label).join(", ")})`);
  assert.equal(typeof option!.apply, "function", "the row applies itself");
  (option!.apply as (v: unknown, c: unknown, from: number, to: number) => void)(
    view,
    option,
    range.from,
    range.from + 1
  );
  await rendered.settle();
}

test("/columns on an empty line inserts the two-column skeleton", async (t) => {
  const mounted = await editor(t, "Above.\n\n");
  await pickSlash(mounted, { from: 8, to: 8 }, "columns");

  assert.equal(
    mounted.view.state.doc.toString(),
    "Above.\n\n<!-- columns -->\n\n<!-- col -->\n\n<!-- /columns -->"
  );
  // the caret opens the first column — the line under the opener
  assert.equal(mounted.view.state.selection.main.head, 8 + "<!-- columns -->\n".length);
});

test("/columns over a selection makes it the first column and opens the second", async (t) => {
  const body = "## Left\n- one\n- two";
  const mounted = await editor(t, body);
  // the whole body picked, `/` typed over it — which is what the palette sees
  await pickSlash(mounted, { from: 0, to: body.length }, "columns");

  assert.equal(
    mounted.view.state.doc.toString(),
    "<!-- columns -->\n## Left\n- one\n- two\n<!-- col -->\n\n<!-- /columns -->",
    "the picked text is the left column, verbatim"
  );
  const { parseColumnRegions } = await import("./columns.ts");
  const [region] = parseColumnRegions(mounted.view.state.doc.toString());
  assert.ok(region, "and it parses as a real region");
  assert.equal(region.columns[0].text, body);
  assert.equal(region.columns[1].text.trim(), "");
  // the caret opens the empty half, the one still to be written
  assert.equal(
    mounted.view.state.doc.toString().slice(0, mounted.view.state.selection.main.head),
    "<!-- columns -->\n## Left\n- one\n- two\n<!-- col -->\n"
  );
});

test("another slash command over a selection still just replaces it", async (t) => {
  // only /columns asks back for the text the `/` was typed over; /table taking
  // a selection into a header cell would be a surprise, not a feature
  const body = "notes";
  const mounted = await editor(t, body);
  await pickSlash(mounted, { from: 0, to: body.length }, "table");
  assert.doesNotMatch(mounted.view.state.doc.toString(), /notes/, "the selection was spent");
  assert.match(mounted.view.state.doc.toString(), /^\|\s+\|\s+\|/);
});

test("/columns over a part-line pick takes in the rest of the line", async (t) => {
  // a drag that stops mid-word is how a paragraph usually gets picked; wrapping
  // it literally would strand the tail after the close marker, where it is part
  // of no region at all
  const body = "alpha beta gamma";
  const mounted = await editor(t, body);
  await pickSlash(mounted, { from: 0, to: "alpha beta".length }, "columns");

  const doc = mounted.view.state.doc.toString();
  assert.equal(doc, "<!-- columns -->\nalpha beta gamma\n<!-- col -->\n\n<!-- /columns -->");
  const { parseColumnRegions } = await import("./columns.ts");
  const [region] = parseColumnRegions(doc);
  assert.ok(region, "the round trip parses as a region");
  assert.equal(region.columns[0].text, body, "tail and all");
});

test("/columns refuses a pick that already holds column markers", async (t) => {
  const body = "<!-- columns -->\nleft\n<!-- col -->\nright\n<!-- /columns -->";
  const toasts: string[] = [];
  const mounted = await editor(t, body, toasts);
  await pickSlash(mounted, { from: 0, to: body.length }, "columns");

  assert.equal(mounted.view.state.doc.toString(), body, "the document is untouched");
  assert.equal(toasts.length, 1, "and the refusal is said out loud");
  assert.match(toasts[0], /column/i);
});

test("/columns refuses a pick that cuts a code fence in half", async (t) => {
  const body = "```js\nlet a = 1;\n```\ntail";
  const toasts: string[] = [];
  const mounted = await editor(t, body, toasts);
  // stops on the code line, so the pick carries an opener with no closer
  await pickSlash(mounted, { from: 0, to: "```js\nlet a =".length }, "columns");

  assert.equal(mounted.view.state.doc.toString(), body, "the document is untouched");
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /code block/i);
});

test("one undo takes the whole /columns gesture back, selection and all", async (t) => {
  const body = "## Left\n- one";
  const mounted = await editor(t, body);
  await pickSlash(mounted, { from: 0, to: body.length }, "columns");
  assert.match(mounted.view.state.doc.toString(), /<!-- columns -->/);

  const { undo } = await import("@codemirror/commands");
  undo(mounted.view as never);
  await mounted.rendered.settle();
  assert.equal(
    mounted.view.state.doc.toString(),
    body,
    "the first undo gives back the text, not the bare `/` it was traded for"
  );
  const { anchor, head } = mounted.view.state.selection.main;
  assert.deepEqual(
    [Math.min(anchor, head), Math.max(anchor, head)],
    [0, body.length],
    "and the pick that started it"
  );
});

test("a dismissed palette drops the text it was standing in for", async (t) => {
  // the trade is only good for the palette it opened: escape it, and the `/`
  // left on the line is a fresh command with nothing owed to it
  const body = "keepme";
  const mounted = await editor(t, body);
  const { setEditorFocus } = await import("./editorfocus.ts");
  const { startCompletion, closeCompletion, currentCompletions } = await import(
    "@codemirror/autocomplete"
  );
  const { view, rendered } = mounted;
  view.dispatch({ effects: setEditorFocus.of(true) });
  view.dispatch({
    changes: { from: 0, to: body.length, insert: "/" },
    selection: { anchor: 1 },
    userEvent: "input.type",
  });
  await rendered.settle();
  (view as unknown as { focus(): void }).focus();
  startCompletion(view as never);
  await new Promise((done) => setTimeout(done, 120));
  await rendered.settle();
  closeCompletion(view as never);
  await rendered.settle();
  // the clear is dispatched off a microtask, since a view plugin may not
  // dispatch inside its own update
  await new Promise((done) => setTimeout(done, 0));
  await rendered.settle();

  // reopen on the same `/`, without retyping it — the stash is what is on trial
  startCompletion(view as never);
  await new Promise((done) => setTimeout(done, 120));
  await rendered.settle();
  const option = currentCompletions((view as never as { state: never }).state).find(
    (o) => o.label === "/columns"
  );
  assert.ok(option, "the palette offers /columns again");
  (option!.apply as (v: unknown, c: unknown, from: number, to: number) => void)(view, option, 0, 1);
  await rendered.settle();

  assert.doesNotMatch(mounted.view.state.doc.toString(), /keepme/, "the stashed text stayed gone");
  assert.equal(
    mounted.view.state.doc.toString(),
    "<!-- columns -->\n\n<!-- col -->\n\n<!-- /columns -->"
  );
});
