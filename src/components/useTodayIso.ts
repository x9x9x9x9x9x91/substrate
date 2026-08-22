// Day rollover: panes used to compute "today" per render, but
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

/** The local minute of day (0–1439) as state, re-read on each minute
    boundary and on window focus. Same reasoning as the day above, one scale
    down: a surface that marks what is happening NOW has to be told the
    clock moved, and a sleeping laptop misses the timer that would say so. */
export function useMinuteOfDay(): number {
  const [min, setMin] = useState(minuteOfDay);
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      const now = new Date();
      // land just past the boundary, so the reading is never the minute before
      const ms = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
      timer = window.setTimeout(() => {
        setMin(minuteOfDay());
        arm();
      }, ms);
    };
    const onFocus = () => setMin(minuteOfDay());
    arm();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return min;
}

function minuteOfDay(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
