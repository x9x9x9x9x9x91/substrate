/** Re-homing a HIDDEN database is one gesture over two stores: the home lands
 *  in schema.json and the reveal in views.json. Before grouping, that cost two
 *  ⌘Z presses and the first landed on a state no gesture produced — the home
 *  moved, the row still hidden. The reveal now carries the gesture's token, so
 *  the stack folds the two pushes into one entry (lib/undo.ts `push`) and a
 *  single keystroke puts BOTH halves back. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h, useEffect } from "react";
import * as react from "react";
import { renderComponent } from "./componentHarness.ts";
import type { SidebarOrder } from "./types.ts";
import type { UndoEntry } from "./undo.ts";
/* imported inside `before`, not at module scope: the hook reaches for
   `../lib/undoviews` extensionless, which only the harness's module resolver
   (installed as it evaluates) can follow. */
type UseModel = typeof import("../hooks/useSidebarOrderModel.ts").useSidebarOrderModel;

const act = react.act as unknown as (scope: () => Promise<void>) => Promise<void>;

type Model = ReturnType<UseModel>;
type Entry = Omit<UndoEntry, "id"> & { id?: number };

let useSidebarOrderModel: UseModel;
let undo: typeof import("./undo.ts");
let vaultSetSidebarOrder: typeof import("./ipc.ts").vaultSetSidebarOrder;
let vaultSidebarOrder: typeof import("./ipc.ts").vaultSidebarOrder;

before(async () => {
  ({ useSidebarOrderModel } = await import("../hooks/useSidebarOrderModel.ts"));
  undo = await import("./undo.ts");
  ({ vaultSetSidebarOrder, vaultSidebarOrder } = await import("./ipc.ts"));
});

/** the app's queued writer, minus React */
const apply = async <T,>(write: () => Promise<T>, adopt: (value: T) => void): Promise<T> => {
  const value = await write();
  adopt(value);
  return value;
};

function Probe({
  order,
  record,
  sink,
}: {
  order: SidebarOrder;
  record: (e: Entry) => void;
  sink: (model: Model) => void;
}): null {
  const model = useSidebarOrderModel({
    sidebarOrder: order,
    // the model builds every edit from the ref; here the two agree
    sidebarOrderRef: { current: order },
    setSidebarOrder: () => undefined,
    dashGroupIds: new Set<string>(),
    record,
    apply,
    onWriteError: () => undefined,
    homeByDb: { tracks: "Music/Tracks" },
  });
  useEffect(() => {
    sink(model);
  }, [model, sink]);
  return null;
}

test("re-homing a hidden database is one undo step, home and visibility together", async (t) => {
  const stored: SidebarOrder = { dashboards: [], databases: [], hidden_dbs: ["tracks"] };
  await vaultSetSidebarOrder(stored);

  /* the schema half, stood in for: the real one is `recordSchemaHomeUndo`
     over schema.json, and what matters here is that its entry and the
     reveal's share a token and unwind in the right order */
  let home: string | null = "Music/Tracks";
  const gesture = undo.nextUndoGroup();
  const homeEntry: Entry = {
    label: "Home “tracks” in “Music/Sets”",
    scope: "vault",
    group: gesture,
    at: Date.now(),
    paths: [".vault/schema.json"],
    undo: async () => {
      home = "Music/Tracks";
    },
    redo: async () => {
      home = "Music/Sets";
    },
  };
  home = "Music/Sets";
  let stack = undo.push(undo.emptyUndo, homeEntry);

  let model: Model | null = null;
  await renderComponent(
    t,
    h(Probe, {
      order: stored,
      record: (e: Entry) => {
        stack = undo.push(stack, e);
      },
      sink: (exposed: Model) => {
        model = exposed;
      },
    })
  );
  assert.ok(model, "the probe rendered without exposing the model");

  // the reveal the re-home fires, carrying the gesture it belongs to
  await act(async () => {
    (model as Model).setDbHidden("tracks", false, gesture);
  });

  assert.deepEqual((await vaultSidebarOrder()).hidden_dbs ?? [], [], "the reveal didn't land");
  assert.equal(stack.entries.length, 1, "the gesture pushed a second entry");
  const entry = undo.peekUndo(stack)!;
  assert.equal(entry.label, "Home “tracks” in “Music/Sets”", "the gesture kept its own name");
  assert.deepEqual(entry.paths, [".vault/schema.json", ".vault/views.json"]);

  // ONE ⌘Z: the true prior state, not the half-way one
  await act(async () => {
    await entry.undo();
  });
  assert.equal(home, "Music/Tracks", "the home half wasn't taken back");
  assert.deepEqual(
    (await vaultSidebarOrder()).hidden_dbs ?? [],
    ["tracks"],
    "the database stayed visible — the first ⌘Z landed on a state no gesture produced"
  );
  stack = undo.advance(stack, entry.id, -1);
  assert.equal(undo.peekUndo(stack), null, "a second press would undo the gesture twice");

  // and ⇧⌘Z replays both halves
  await act(async () => {
    await undo.peekRedo(stack)!.redo!();
  });
  assert.equal(home, "Music/Sets");
  assert.deepEqual((await vaultSidebarOrder()).hidden_dbs ?? [], []);
});

test("a plain hide is still an entry of its own", async (t) => {
  const stored: SidebarOrder = { dashboards: [], databases: [], hidden_dbs: [] };
  await vaultSetSidebarOrder(stored);

  const recorded: Entry[] = [];
  let model: Model | null = null;
  await renderComponent(
    t,
    h(Probe, {
      order: stored,
      record: (e: Entry) => {
        recorded.push(e);
      },
      sink: (exposed: Model) => {
        model = exposed;
      },
    })
  );
  assert.ok(model, "the probe rendered without exposing the model");

  await act(async () => {
    (model as Model).setDbHidden("tracks", true);
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].label, "Remove from sidebar");
  assert.equal(recorded[0].group, undefined, "an ungrouped edit must not fold into its neighbour");
});
