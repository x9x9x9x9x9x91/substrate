import { useCallback, useEffect, useState } from "react";

/**
 * Vertical scroll affordance. The sidebar tree and the
 * table edges each grew their own copy of the same gate: a
 * mask-image fade that paints only on the side the scroller can still move
 * toward, so the row at a scroll stop stays crisp and a surface that fits
 * never fades at all. This is that gate, once — a caller opts in by calling
 * the hook and spreading its props; the hook emits `edge-fade-y` and the
 * direction classes itself.
 *
 * Spread the returned props onto the scrolling element:
 *
 *   const fade = useEdgeFade();
 *   <div className={`cal-agenda-body${fade.className}`} {...fade.props} />
 *
 * `props.ref` is a callback ref, so a scroller that mounts and unmounts
 * inside a live component (the palette's results list swaps against the
 * capture footer) re-attaches its observers on every appearance. The
 * ResizeObserver catches geometry changes that fire no scroll event (pane
 * resize, sheet reflow); the MutationObserver catches content swapped in or
 * grown underneath a scroller that never moved — characterData included, so
 * a pure text-node write deep in the list re-gates too.
 */
export function useEdgeFade<T extends HTMLElement = HTMLDivElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [more, setMore] = useState(false);

  const sync = useCallback(() => {
    if (!el) return;
    setScrolled(el.scrollTop > 0);
    setMore(el.scrollTop < el.scrollHeight - el.clientHeight - 1);
  }, [el]);

  // The gate state belongs to the node, so it is re-taken at every attach and
  // dropped at every detach. One hook instance can serve a scroller that MOVES
  // — the calendar's expanded month cell rides a single instance as expansion
  // travels between days — and carrying the old cell's `scrolled/more` across
  // the swap paints the next cell's fade from the previous cell's overflow
  // until the post-attach gate lands a frame later.
  //
  // Measuring here rather than merely clearing is what keeps that honest for
  // callers whose merged ref is an inline closure (a new ref identity every
  // render, so React detaches and re-attaches the SAME node): clearing alone
  // would blank the fade on every render and never restore it, because `el`
  // never changes and the effect below never re-runs.
  const ref = useCallback((node: T | null) => {
    setEl(node);
    setScrolled(!!node && node.scrollTop > 0);
    setMore(!!node && node.scrollTop < node.scrollHeight - node.clientHeight - 1);
  }, []);

  useEffect(() => {
    if (!el) return;
    // first gate a frame later: setState synchronously inside an effect
    // cascades a render; one frame of ungated (mask-free) paint is invisible
    const raf = requestAnimationFrame(sync);
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    const mo = new MutationObserver(sync);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [el, sync]);

  return {
    className: ` edge-fade-y${scrolled ? " edge-scrolled-y" : ""}${more ? " edge-more-y" : ""}`,
    props: { ref, onScroll: sync },
  };
}
