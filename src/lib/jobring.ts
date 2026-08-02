/** The jobs dashboard's exit-history ring (SUB-706). `jobs_read` samples each
    launchd job's (pid, last exit) picture on the 60s poll into a per-label
    ring of recent run outcomes (0 = ok), oldest first, capped at 10 app-side
    at `.vault/jobs-exit.json`. This catches what a single LastExitStatus
    can't: a job that runs on schedule and fails every time — one lucky
    success would otherwise paint the row green.

    Counts are APPROXIMATE: the poll sees only the latest run, so a run that
    starts and ends between two polls leaves no trace. The ring is a floor on
    how often the job ran, never an exact tally. */

export interface RingStats {
  /** runs observed in the held window (≤ 10) */
  runs: number;
  /** how many of them exited nonzero */
  failed: number;
}

export function ringStats(ring: number[]): RingStats {
  return { runs: ring.length, failed: ring.filter((s) => s !== 0).length };
}

/** How the ring folds into the row's health: "alert" when most of the window
    failed, "warn" when some of it did. A single observation adds nothing over
    the row's own last-exit chip, so the ring only speaks from two runs up. */
export function ringVerdict(ring: number[]): "alert" | "warn" | null {
  const { runs, failed } = ringStats(ring);
  if (runs < 2 || failed === 0) return null;
  return failed * 2 > runs ? "alert" : "warn";
}

/** The row-detail chip text — "3 of last 5 runs failed". Only meaningful when
    ringVerdict is non-null. */
export function ringChipText(ring: number[]): string {
  const { runs, failed } = ringStats(ring);
  return `${failed} of last ${runs} runs failed`;
}
