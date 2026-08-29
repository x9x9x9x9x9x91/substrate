/** Collapsing a sidebar section sweeps the collapsed list of group ids whose
 *  group no longer exists — housekeeping the user never asked for and cannot
 *  see. The entry that toggle records must not carry the swept ids back, or
 *  one ⌘Z after a collapse puts the orphans in views.json again and a folder
 *  the user later re-creates opens collapsed for no reason they can name. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h, useCallback, useEffect, useRef, useState } from "react";
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
/* the mock backend reads Vite's env at module scope, so it — and everything
   that pulls it in — is imported after the harness has stood one up */
let vaultSetSidebarOrder: typeof import("./ipc.ts").vaultSetSidebarOrder;
let vaultSidebarOrder: typeof import("./ipc.ts").vaultSidebarOrder;

before(async () => {
  ({ useSidebarOrderModel } = await import("../hooks/useSidebarOrderModel.ts"));
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
  dashGroupIds,
  record,
  sink,
}: {
  order: SidebarOrder;
  dashGroupIds: Set<string>;
  record: (e: Entry) => void;
  sink: (model: Model) => void;
}): null {
  const model = useSidebarOrderModel({
    sidebarOrder: order,
    // the model builds every edit from the ref; here the two agree
    sidebarOrderRef: { current: order },
    setSidebarOrder: () => undefined,
    dashGroupIds,
    record,
    apply,
    onWriteError: () => undefined,
  });
  useEffect(() => {
    sink(model);
  }, [model, sink]);
  return null;
}

test("collapsing a section does not put retired group ids back on undo", async (t) => {
  // "dashgroup:Gone" names a subfolder whose last dashboard moved out
  const stored: SidebarOrder = {
    dashboards: [],
    databases: [],
    collapsed: ["savedviews", "dashgroup:Gone"],
  };
  await vaultSetSidebarOrder(stored);

  const box: { entry: Entry | null } = { entry: null };
  let model: Model | null = null;
  await renderComponent(
    t,
    h(Probe, {
      order: stored,
      dashGroupIds: new Set(["dashgroup:Live"]),
      record: (e: Entry) => {
        box.entry = e;
      },
      sink: (exposed: Model) => {
        model = exposed;
      },
    })
  );
  assert.ok(model, "the probe rendered without exposing the model");

  await act(async () => {
    (model as Model).toggleCollapsed("folders");
  });
  const entry = box.entry;
  assert.ok(entry, "collapsing a section recorded nothing");
  assert.equal(entry.label, "Collapse section");
  assert.deepEqual(entry.paths, [".vault/views.json"]);
  assert.deepEqual(
    (await vaultSidebarOrder()).collapsed,
    ["savedviews", "folders"],
    "the collapse kept the retired group id"
  );

  await act(async () => {
    await entry.undo();
  });
  assert.deepEqual(
    (await vaultSidebarOrder()).collapsed,
    ["savedviews"],
    "undoing the collapse resurrected the retired group id"
  );
});


/** Two sidebar gestures inside ONE render batch. Each edit folds its change
 *  into the order it reads first, so reading the render's copy means the
 *  second gesture starts from the pre-batch order and its write drops the
 *  first gesture's change outright — the pin that went in a moment earlier is
 *  simply not in the object that reaches disk. Reading the ref the setter
 *  keeps, both changes are there. */
function LiveProbe({
  initial,
  sink,
}: {
  initial: SidebarOrder;
  sink: (model: Model) => void;
}): null {
  // the app's `useLive`, minus the app
  const [order, setOrder] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: SidebarOrder | ((cur: SidebarOrder) => SidebarOrder)) => {
    ref.current = typeof next === "function" ? next(ref.current) : next;
    setOrder(ref.current);
  }, []);
  const model = useSidebarOrderModel({
    sidebarOrder: order,
    sidebarOrderRef: ref,
    setSidebarOrder: set,
    dashGroupIds: new Set<string>(),
    record: () => undefined,
    apply,
    onWriteError: () => undefined,
  });
  useEffect(() => {
    sink(model);
  }, [model, sink]);
  return null;
}

test("two sidebar gestures in one batch both reach disk", async (t) => {
  const stored: SidebarOrder = { dashboards: [], databases: [], pins: [] };
  await vaultSetSidebarOrder(stored);

  let model: Model | null = null;
  await renderComponent(
    t,
    h(LiveProbe, {
      initial: stored,
      sink: (exposed: Model) => {
        model = exposed;
      },
    })
  );
  assert.ok(model, "the probe rendered without exposing the model");

  await act(async () => {
    (model as Model).setPinned("Field/One.md", true);
    (model as Model).setPinned("Field/Two.md", true);
  });

  assert.deepEqual(
    (await vaultSidebarOrder()).pins,
    ["Field/One.md", "Field/Two.md"],
    "the second gesture wrote over the first instead of adding to it"
  );
});
