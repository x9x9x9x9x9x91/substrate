import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { placeTip, tipDelay, NO_TIP_INSET, type TipInset, type TipPlacement } from "../lib/tooltip";

/* The app's own hover tooltip.
 *
 * `title=` hands hover copy to the OS: ~1s before it appears, system font,
 * unstyleable, unpositionable, and gone the moment you look at a touch screen.
 * This replaces it with one small in-app surface built on the overlay grammar
 * already here — portal to <body>, fixed position measured off the trigger,
 * flip-and-clamp like CalPeek, the 90ms pop the context menu uses.
 *
 * Two pieces:
 *   • `<TooltipHost />` — mounted ONCE per window root; renders the bubble.
 *   • `tooltip(text)`   — spread onto any element to give it that bubble.
 *
 * A surface adopts it by swapping `title={x}` for `{...tooltip(x)}`; nothing
 * here knows about any particular pane, so the panes this round didn't touch
 * adopt it with no change to this file.
 *
 * Accessibility: `title` was often the ACCESSIBLE NAME of an icon-only control,
 * so `tooltip()` puts that text back as `aria-label` by default. Elements that
 * already have visible text pass `{ label: false }` — their name is that text,
 * and the tooltip is supplementary, exactly what a `title` on a text-bearing
 * element was. The bubble itself is aria-hidden: its words are already in the
 * accessible name, and announcing them twice is worse than not at all.
 *
 * KNOWN COST, and the rule that follows from it: on a `{ label: false }` site
 * the copy reaches NO assistive surface at all. The bubble is aria-hidden, the
 * element gets no `aria-describedby`, and the words survive only as `data-tip`,
 * which nothing announces — a screen-reader user gets the visible text and
 * nothing else. That is an accurate port of `title` on a text-bearing element
 * (browsers vary on whether they announce it, and it is widely advised against
 * relying on them to), not a regression this primitive introduced, but it IS a
 * hole. So: before a later wave migrates a site whose tooltip copy is the ONLY
 * carrier of the information — not a restatement of visible text — description
 * semantics have to be solved first (an `aria-describedby` mode pointing at the
 * bubble, or a visually-hidden node). The live examples are the dense-row panes
 * still on `title` today: a full identifier the row truncates, and an expiry
 * countdown. Migrating those under `{ label: false }` as it stands would take
 * information away from assistive tech, and the rule exists so nobody does it
 * by momentum.
 */

interface TipState {
  /** distinguishes two openings with the same text, so the bubble remounts
      (fresh node = the pop-in replays, and no stale position leaks through) */
  id: number;
  el: HTMLElement;
  text: string;
}

let nextId = 1;
let current: TipState | null = null;
let timer: number | undefined;
let lastCloseMs = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function snapshot() {
  return current;
}

function clearTimer() {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
}

function openTip(el: HTMLElement, text: string) {
  // the trigger can be unmounted between the dwell starting and firing
  if (!el.isConnected) return;
  current = { id: nextId++, el, text };
  emit();
}

function showTip(el: HTMLElement, text: string, instant: boolean) {
  clearTimer();
  if (current?.el === el && current.text === text) return;
  const wait = instant ? 0 : tipDelay(Date.now(), lastCloseMs);
  if (wait === 0) {
    openTip(el, text);
    return;
  }
  timer = window.setTimeout(() => {
    timer = undefined;
    openTip(el, text);
  }, wait);
}

/** Close whatever is showing (and cancel anything pending). Exported for the
    rare caller that changes the world under its own trigger — a menu opening
    from an icon button, say. */
export function hideTip() {
  clearTimer();
  if (!current) return;
  current = null;
  lastCloseMs = Date.now();
  emit();
}

/**
 * Did this element get focus from the keyboard?
 *
 * `:focus-visible` is the browser's own answer and the right one, but it is a
 * selector some engines don't know — an unsupported selector makes `matches()`
 * THROW (SyntaxError), and a jsdom test run without the polyfill is the case
 * that actually bites. Unknown means show: a tooltip that appears once on a
 * mouse click is a small annoyance, one that never appears on Tab is the
 * feature missing.
 */
function isFocusVisible(el: HTMLElement): boolean {
  if (typeof el.matches !== "function") return true;
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export interface TooltipOpts {
  /** Also expose the text as `aria-label` (default true — the migrated
      controls are icon-only and `title` WAS their accessible name). Pass false
      for an element whose visible text already names it. */
  label?: boolean;
}

export interface TooltipProps {
  onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerDown: () => void;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  "aria-label"?: string;
  /** The copy, left on the element itself. `title` used to be readable in the
   *  DOM without hovering — inspectors and tests leaned on that — so the swap
   *  keeps a plain attribute carrying the same words. Never rendered. */
  "data-tip"?: string;
}

/**
 * Props giving an element a hover tooltip. Spread them:
 *
 *   <button {...tooltip("Hide sidebar (⌘\\)")}>…</button>
 *
 * A falsy `text` yields inert handlers, so a conditional tooltip needs no
 * conditional spread. Merge by hand if the element already has one of these
 * handlers — a blind spread silently drops the existing one.
 */
export function tooltip(text: string | undefined | null | false, opts?: TooltipOpts): TooltipProps {
  const copy = text || "";
  const props: TooltipProps = {
    onPointerEnter: (e) => {
      // touch has no hover: a tap would open a bubble with nothing to close it
      if (e.pointerType === "touch") return;
      if (copy) showTip(e.currentTarget, copy, false);
    },
    // only the element that is actually showing may close the bubble. Triggers
    // nest (two such pairs exist in the app today), and a leave from an inner
    // one must not take down a bubble that now belongs to somebody else.
    onPointerLeave: (e) => {
      if (current && current.el !== e.currentTarget) {
        // somebody else's bubble is up — leave it alone, but a dwell this
        // element started must not fire now that the pointer has gone
        clearTimer();
        return;
      }
      hideTip();
    },
    onPointerDown: hideTip,
    onFocus: (e) => {
      // keyboard focus is deliberate — show at once. Mouse focus (the click
      // that just fired) must NOT pop a bubble over what was clicked.
      if (!copy) return;
      const el = e.currentTarget;
      if (!isFocusVisible(el)) return;
      showTip(el, copy, true);
    },
    onBlur: hideTip,
  };
  if (copy) props["data-tip"] = copy;
  if (copy && opts?.label !== false) props["aria-label"] = copy;
  return props;
}

/** Fixed chrome that paints over the bubble (z 150 / 190 vs the tooltip's 115,
    which is deliberate — a tooltip belongs under banners and toasts). */
const CHROME_SELECTOR = ".miniplayer, .timebar";

/**
 * How far the app's fixed chrome intrudes from the top and bottom edges right
 * now, so the geometry can treat those bands as unusable (see `TipInset`).
 *
 * Measured rather than hard-coded: the mini-player is only there with a queue,
 * the time-travel banner only in the past, and both change height with the
 * window. Anything with no box (`display:none`, unmounted) contributes nothing.
 */
function measureChromeInset(viewportHeight: number): TipInset {
  let top = 0;
  let bottom = 0;
  for (const el of document.querySelectorAll(CHROME_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // whichever edge it hugs is the edge it eats into
    if (r.top <= viewportHeight - r.bottom) top = Math.max(top, r.bottom);
    else bottom = Math.max(bottom, viewportHeight - r.top);
  }
  return top === 0 && bottom === 0 ? NO_TIP_INSET : { top, bottom };
}

/** The single bubble. Mount once per window root, near the other overlays. */
export default function TooltipHost() {
  const tip = useSyncExternalStore(subscribe, snapshot, snapshot);
  const boxRef = useRef<HTMLDivElement>(null);

  // measure, then place the node directly: the bubble sizes to its own copy,
  // and the copy is whatever the trigger passed. It renders hidden at 0,0 and
  // is moved before the browser paints, so it never flashes at the wrong spot
  // on the way to the right one.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!tip || !box) return;
    const r = tip.el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const view = { width: window.innerWidth, height: window.innerHeight };
    const pos: TipPlacement = placeTip(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      { width: b.width, height: b.height },
      view,
      undefined,
      undefined,
      measureChromeInset(view.height)
    );
    box.style.left = `${pos.left}px`;
    box.style.top = `${pos.top}px`;
    box.style.visibility = "";
    box.classList.add(`tip-${pos.side}`);
  }, [tip]);

  // anything that moves the trigger or takes attention closes it. A tooltip
  // is never worth fighting for — cheap to re-earn with another hover.
  useEffect(() => {
    if (!tip) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideTip();
    };
    const onDown = () => hideTip();
    window.addEventListener("scroll", hideTip, true);
    window.addEventListener("resize", hideTip);
    window.addEventListener("blur", hideTip);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    // a trigger can vanish without a pointerleave (its menu closed, its row
    // re-rendered) — poll cheaply rather than leave a bubble pointing at air
    const poll = window.setInterval(() => {
      if (!tip.el.isConnected) hideTip();
    }, 300);
    return () => {
      window.removeEventListener("scroll", hideTip, true);
      window.removeEventListener("resize", hideTip);
      window.removeEventListener("blur", hideTip);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.clearInterval(poll);
    };
  }, [tip]);

  if (!tip) return null;

  return createPortal(
    <div
      key={tip.id}
      ref={boxRef}
      className="tooltip"
      role="tooltip"
      aria-hidden="true"
      style={{ left: 0, top: 0, visibility: "hidden" }}
    >
      {tip.text}
    </div>,
    document.body
  );
}
