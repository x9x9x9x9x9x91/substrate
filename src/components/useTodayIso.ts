// Day rollover (SUB-153): panes used to compute "today" per render, but
// nothing re-renders at midnight, so a long-lived window showed yesterday
// forever. This hook holds todayIso as state, re-arms a timeout for the
// next local midnight after every fire, and re-checks on window focus —
// a sleeping laptop misses timers.

import { useEffect, useState } from "react";
import { msUntilNextMidnight, todayIso } from "../lib/dates";

/** Today's ISO date as state — updates at local midnight and on refocus. */
export function useTodayIso(): string {
  const [iso, setIso] = useState(todayIso);
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      timer = window.setTimeout(() => {
        setIso(todayIso());
        arm();
      }, msUntilNextMidnight(new Date()));
    };
    const onFocus = () => setIso(todayIso());
    arm();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return iso;
}
