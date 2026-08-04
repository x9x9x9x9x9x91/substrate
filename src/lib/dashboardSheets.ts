import { vaultRead, vaultResolve } from "./ipc";
import { foldedPropStr } from "./types";
import { evaluateSheet, parseSheet, type SheetEval, type SheetModel } from "./sheet";
import { collectCrossRefs, ferr, isErr, type FErr, type FxResolver } from "./formula";
import { makeFxResolver, type FxRatesState } from "./fx";

export type DashboardSheetState =
  | { model: SheetModel; ev: SheetEval }
  | { error: string };

const cache = new Map<string, Promise<Map<string, DashboardSheetState>>>();

/** The whole rate table keys the cache, not just USD→EUR (SUB-834): a sheet
    may convert any quoted pair, so two tables that agree on that one pair
    while differing elsewhere are NOT interchangeable evaluations. */
function ratesKey(rates: FxRatesState | null): string {
  if (!rates) return "none";
  const pairs = Object.entries(rates.rates)
    .map(([code, rate]) => `${code.toUpperCase()}=${rate}`)
    .sort();
  return `${rates.base}|${rates.asOf}|${pairs.join(",")}`;
}

function cacheKey(sheetNames: string[], vaultEpoch: number, rates: FxRatesState | null): string {
  const names = [...new Set(sheetNames.map((name) => name.toLowerCase()))].sort();
  return `${vaultEpoch}\u0000${ratesKey(rates)}\u0000${names.join("\u0000")}`;
}

/** Load and evaluate a set of sheet roots plus their transitive cross-sheet
    references. Dashboard surfaces share the in-flight/result promise for the
    SAME root set at one vault epoch and FX rate, so composing five views of
    one sheet remains one IPC/BFS/evaluation pass rather than five. The key is
    the whole deduped set — surfaces bound to different (even overlapping)
    sets load independently. The sheet-type check folds the frontmatter key
    and value (`Type: Sheet` counts), matching the cards path. */
export function dashboardSheets(
  sheetNames: string[],
  vaultEpoch: number,
  rates: FxRatesState | null,
): Promise<Map<string, DashboardSheetState>> {
  const key = cacheKey(sheetNames, vaultEpoch, rates);
  const hit = cache.get(key);
  if (hit) return hit;

  // Epoch/rate keys make stale reuse impossible. Bound retained history so a
  // long-running app does not keep every old evaluated sheet graph forever.
  if (cache.size >= 64) cache.clear();

  const pending = (async () => {
    const models = new Map<string, SheetModel | FErr>();
    const queue = [...sheetNames];
    const queued = new Set(queue.map((name) => name.toLowerCase()));
    while (queue.length > 0) {
      const name = queue.shift()!;
      try {
        const resolved = await vaultResolve(name);
        if (!resolved) {
          models.set(name.toLowerCase(), ferr(`no note named “${name}”`));
          continue;
        }
        if (foldedPropStr(resolved.props, "type")?.toLowerCase() !== "sheet") {
          models.set(name.toLowerCase(), ferr(`“${name}” is not a sheet`));
          continue;
        }
        const content = await vaultRead(resolved.path);
        const model = parseSheet(content.body);
        models.set(name.toLowerCase(), model);
        for (const formula of model.formulas) {
          if (isErr(formula.expr)) continue;
          for (const ref of collectCrossRefs(formula.expr)) {
            if (!queued.has(ref.sheet)) {
              queued.add(ref.sheet);
              queue.push(ref.sheet);
            }
          }
        }
      } catch (error) {
        models.set(name.toLowerCase(), ferr(String(error)));
      }
    }

    // One shared resolver over the whole quoted table (SUB-834) — the same
    // one sheets, cards and charts use, so a GBP column converts here exactly
    // as it does in the grid.
    const fxResolver: FxResolver = makeFxResolver(rates);
    const load = (name: string) =>
      models.get(name.toLowerCase()) ?? ferr(`no sheet named “${name}”`);
    const result = new Map<string, DashboardSheetState>();
    for (const name of sheetNames) {
      const model = models.get(name.toLowerCase());
      if (!model || isErr(model)) {
        result.set(name.toLowerCase(), { error: model ? model.err : "not loaded" });
        continue;
      }
      result.set(name.toLowerCase(), {
        model,
        ev: evaluateSheet(model, fxResolver, { self: name, load }),
      });
    }
    return result;
  })();
  // A rejected pass must not stay cached for the rest of the epoch — one
  // thrown evaluation would poison every surface bound to these roots with
  // no retry until the next vault refresh. Evict so the next render retries.
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  cache.set(key, pending);
  return pending;
}
