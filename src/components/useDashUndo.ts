// The boards' ⌘Z / ⌘⇧Z stacks: which board a dashboard note renders
// can depend on its BODY (BodyScanDashboard reads the file before choosing), so App
// cannot tell from `dashboard:` whether undo or redo is available. The owning
// pane publishes its live history — same idiom as the workbook's pageStepRef.

import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

export interface DashUndoAvailability {
  canUndo: boolean;
  canRedo: boolean;
}

export interface DashUndoRegistration {
  set(next: DashUndoAvailability): void;
  unregister(): void;
}

/** A tiny observable aggregate of live board history.

    Registered per board, not a single pair of booleans: a workbook page swap
    mounts the next board before unmounting the last, and the outgoing pane's
    cleanup must not clear availability already published by the incoming one.

    Observable, not a bare ref: the panes register from a
    layout effect, after App's render has already read its inputs. A memo
    reading `ref.current` therefore served a stale answer on
    dashboard→dashboard navigation. */
export interface DashUndoStore {
  /** Register one live board; the registration publishes and withdraws it. */
  register(): DashUndoRegistration;
  /** Aggregate direction availability, stable until a direction changes. */
  getSnapshot(): DashUndoAvailability;
  subscribe(onChange: () => void): () => void;
}

export function createDashUndoStore(): DashUndoStore {
  const registrations = new Set<DashUndoAvailability>();
  let snapshot: DashUndoAvailability = { canUndo: false, canRedo: false };
  const listeners = new Set<() => void>();
  const publish = () => {
    const next = {
      canUndo: [...registrations].some((r) => r.canUndo),
      canRedo: [...registrations].some((r) => r.canRedo),
    };
    if (next.canUndo === snapshot.canUndo && next.canRedo === snapshot.canRedo) return;
    snapshot = next;
    for (const fn of listeners) fn();
  };
  return {
    register() {
      let state: DashUndoAvailability = { canUndo: false, canRedo: false };
      registrations.add(state);
      let done = false;
      return {
        set(next) {
          if (done || (next.canUndo === state.canUndo && next.canRedo === state.canRedo)) return;
          registrations.delete(state);
          state = next;
          registrations.add(state);
          publish();
        },
        unregister() {
          if (done) return;
          done = true;
          registrations.delete(state);
          publish();
        },
      };
    },
    getSnapshot: () => snapshot,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}

/** What a vault-resident kind publishes through `ctx.setUndo`, translated
    into the store's vocabulary.

    Two spellings on purpose. The store's is the app's, and predates kinds;
    the published one is the shorter pair a kind author reads in
    `docs/kind-api.d.ts`, where `ctx.setUndo({ undo, redo })` sits next to
    `ctx.setState` and repeating "can" in a setter's argument reads like
    noise. `null` is the withdrawal — a kind that empties its stack and a
    kind that stops keeping one say the same thing to the app. */
export function kindUndoAvailability(
  avail: { undo: boolean; redo: boolean } | null
): DashUndoAvailability {
  return { canUndo: !!avail?.undo, canRedo: !!avail?.redo };
}

/** App side: own the store and re-render when its answer flips. */
export function useDashUndoState(): { store: DashUndoStore; availability: DashUndoAvailability } {
  const store = useMemo(() => createDashUndoStore(), []);
  const availability = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, availability };
}

/** Pane side: register while mounted and publish after each stack mutation. */
export function useDashUndo(
  store?: DashUndoStore
): (canUndo: boolean, canRedo: boolean) => void {
  const registration = useRef<DashUndoRegistration | null>(null);
  const latest = useRef<DashUndoAvailability>({ canUndo: false, canRedo: false });
  useLayoutEffect(() => {
    if (!store) return;
    const live = store.register();
    registration.current = live;
    live.set(latest.current);
    return () => {
      registration.current = null;
      live.unregister();
    };
  }, [store]);
  return useCallback((canUndo, canRedo) => {
    const next = { canUndo, canRedo };
    latest.current = next;
    registration.current?.set(next);
  }, []);
}
