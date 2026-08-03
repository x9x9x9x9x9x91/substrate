import { byFoldedKey } from "../lib/schemalookup";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { NoteMeta, SchemaConfig } from "../lib/types";
import { foldedPropStr } from "../lib/types";
import { vaultRead, vaultResolve } from "../lib/ipc";
import { parseChartBlocks } from "../lib/chart";
import ChartsDashboard from "./ChartsDashboard";
import { fmtFx, fmtMoney, metricsColumns, sharpCardIndices } from "../lib/dashboard";
import { useUsdEur } from "./useFx";
import {
  evaluateSheet,
  findSummary,
  formatValue,
  parseSheet,
  type SheetEval,
  type SheetModel,
} from "../lib/sheet";
import { collectCrossRefs, ferr, isErr, type FErr, type FxResolver, type Value } from "../lib/formula";
import { DashHead, DashPrintButton } from "./DashHead";

interface MetricsDashboardProps {
  meta: NoteMeta;
  /** every vault note — chart fences below the cards aggregate over these */
  notes: NoteMeta[];
  schema: SchemaConfig;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
  onMutated: () => void;
}

interface MetricCard {
  label: string;
  bind: string;
  format?: string;
  digits?: number;
  /** contrast discipline (principle 11): this card keeps the sharp voice */
  emph?: boolean;
}

// Cards come from the dashboard note's frontmatter:
//   cards:
//     - label: Total value
//       bind: "{{Holdings.total}}"
//       format: eur
//       emph: true
function parseCards(props: Record<string, unknown>): MetricCard[] {
  const raw = byFoldedKey(props, "cards");
  if (!Array.isArray(raw)) return [];
  const out: MetricCard[] = [];
  for (const c of raw) {
    if (typeof c !== "object" || c === null) continue;
    const o = c as Record<string, unknown>;
    if (typeof o.label !== "string" || typeof o.bind !== "string") continue;
    out.push({
      label: o.label,
      bind: o.bind,
      format: typeof o.format === "string" ? o.format : undefined,
      digits: typeof o.digits === "number" ? o.digits : undefined,
      // anything but a literal true (absent, "yes", 1, garbage) is not emphasis
      emph: o.emph === true,
    });
  }
  return out;
}

// "{{Holdings.total}}" or "Holdings.total" → { sheet: "Holdings", name: "total" }
function parseBind(bind: string): { sheet: string; name: string } | null {
  const t = bind
    .trim()
    .replace(/^\{\{\s*/, "")
    .replace(/\s*\}\}$/, "")
    .trim();
  const m = /^([^.]+)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(t);
  return m ? { sheet: m[1].trim(), name: m[2] } : null;
}

function fmtCard(v: Value, format?: string, digits?: number): string {
  if (isErr(v)) return "—";
  if (typeof v !== "number") return formatValue(v);
  switch (format) {
    case "eur":
      return fmtMoney(v, "€", digits ?? 0);
    case "usd":
      return fmtMoney(v, "$", digits ?? 0);
    case "number":
      return v.toLocaleString("de-DE", {
        minimumFractionDigits: digits ?? 0,
        maximumFractionDigits: digits ?? 2,
      });
    case "pct":
      return (
        v.toLocaleString("de-DE", {
          minimumFractionDigits: digits ?? 1,
          maximumFractionDigits: digits ?? 1,
        }) + "%"
      );
    default:
      return formatValue(v);
  }
}

type SheetState = { ev: SheetEval } | { error: string };

export default function MetricsDashboard({
  meta,
  notes,
  schema,
  vaultEpoch,
  onOpenSource,
}: MetricsDashboardProps) {
  const { fx } = useUsdEur();
  const [sheets, setSheets] = useState<Map<string, SheetState>>(new Map());
  // the note's body, for chart fences below the cards (finance surface):
  // a metrics dashboard with ```chart blocks renders them like the charts
  // dashboard does, same visual language
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    vaultRead(meta.path).then((c) => {
      if (!gone) setBody(c.body);
    });
    return () => {
      gone = true;
    };
  }, [meta.path, vaultEpoch]);

  const cards = useMemo(() => parseCards(meta.props), [meta.props]);
  const binds = useMemo(() => cards.map((c) => parseBind(c.bind)), [cards]);
  const sharp = useMemo(() => sharpCardIndices(cards), [cards]);
  // how the strip wraps into a block (SUB-625) — card count, not viewport
  const cols = metricsColumns(cards.length);
  const sheetNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const b of binds) {
      if (b) seen.set(b.sheet.toLowerCase(), b.sheet);
    }
    return [...seen.values()];
  }, [binds]);

  const fxResolver: FxResolver = (from, to) => {
    if (!fx) return null;
    if (from === "USD" && to === "EUR") return fx.usdEur;
    if (from === "EUR" && to === "USD") return 1 / fx.usdEur;
    return null;
  };

  // Load every bound sheet — and transitively any sheet its formulas
  // reference — then evaluate each with the cross-sheet loader.
  useEffect(() => {
    let gone = false;
    (async () => {
      const models = new Map<string, SheetModel | FErr>();
      const queue = [...sheetNames];
      const queued = new Set(queue.map((n) => n.toLowerCase()));
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
          const m = parseSheet(content.body);
          models.set(name.toLowerCase(), m);
          for (const f of m.formulas) {
            if (isErr(f.expr)) continue;
            for (const cr of collectCrossRefs(f.expr)) {
              if (!queued.has(cr.sheet)) {
                queued.add(cr.sheet);
                queue.push(cr.sheet);
              }
            }
          }
        } catch (e) {
          models.set(name.toLowerCase(), ferr(String(e)));
        }
      }
      if (gone) return;
      const load = (name: string) =>
        models.get(name.toLowerCase()) ?? ferr(`no sheet named “${name}”`);
      const next = new Map<string, SheetState>();
      for (const name of sheetNames) {
        const m = models.get(name.toLowerCase());
        if (!m || isErr(m)) {
          next.set(name.toLowerCase(), { error: m ? m.err : "not loaded" });
          continue;
        }
        next.set(name.toLowerCase(), {
          ev: evaluateSheet(m, fxResolver, { self: name, load }),
        });
      }
      setSheets(next);
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.path, vaultEpoch, sheetNames.join("|"), fx]);

  // A bound summary that doesn't exist is the same class of miss the charts
  // name (SUB-749): renaming it left the card reading "—" with the reason
  // buried in a hover tooltip, which on a dashboard is indistinguishable from
  // a summary that legitimately has no value. The card now says the name it
  // couldn't find; the sheet's actual summary list stays in the tooltip, since
  // a card is too narrow to carry an inventory and hover already answers
  // "then what IS there".
  const cardValue = (i: number): { text: string; miss?: string; title?: string } => {
    const b = binds[i];
    if (!b) return { text: "—", title: `bad binding “${cards[i].bind}” — want {{Sheet.summary}}` };
    const state = sheets.get(b.sheet.toLowerCase());
    if (!state) return { text: "…" };
    if ("error" in state) return { text: "—", title: state.error };
    const hit = state.ev.summaries.find((s) => s.name.toLowerCase() === b.name.toLowerCase());
    if (!hit) {
      const has = state.ev.summaries.map((s) => s.name).join(", ");
      return {
        text: "—",
        miss: `no summary “${b.name}” on ${b.sheet}`,
        title: `no summary “${b.name}” on ${b.sheet}${has ? ` (has: ${has})` : " (it has none)"}`,
      };
    }
    const v = findSummary(state.ev, b.name);
    return {
      text: fmtCard(v, cards[i].format, cards[i].digits),
      title: isErr(v) ? v.err : undefined,
    };
  };

  return (
    <div className="note">
      <div className="dash-inner">
        {/* the head counts cards only — the sheet count named data sources
            that never render on this surface, and the footer already carries
            that provenance in words (a concept stated twice, principle 5) */}
        <DashHead
          title={meta.title}
          state={{
            label: `${cards.length} ${cards.length === 1 ? "card" : "cards"}`,
          }}
          actions={<DashPrintButton />}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        {cards.length === 0 ? (
          <div className="dash-foot">
            No cards yet — add a cards: list to this note’s frontmatter, each with a label and
            a {"{{Sheet.summary}}"} binding.
          </div>
        ) : (
          <div className="metrics-strip">
            <div
              className="dash-cards metrics-cards"
              // the column count is data, not a breakpoint (SUB-625): it depends
              // on how many cards the note declares, so the grid track comes from
              // the renderer and the stylesheet owns everything else
              style={{ "--metrics-cols": cols } as CSSProperties}
            >
              {cards.map((card, i) => {
                const v = cardValue(i);
                // the binding is chrome, not content — tooltip only, merged
                // with any error title (SUB-246)
                const title = v.title ? `${card.bind} — ${v.title}` : card.bind;
                // the tile that opens a row drops its leading hairline — the
                // rule divides tiles inside a row, it never fences the left
                // edge of one
                const cls = `dash-card${sharp.has(i) ? "" : " sunk"}${
                  i % cols === 0 ? " row-start" : ""
                }`;
                return (
                  <div className={cls} key={i} title={title}>
                    <div className="dash-label">{card.label}</div>
                    <div className="dash-card-eur">{v.text}</div>
                    {v.miss && <div className="dash-card-miss">{v.miss}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {body !== null && parseChartBlocks(body).length > 0 && (
          <ChartsDashboard
            meta={meta}
            notes={notes}
            body={body}
            vaultEpoch={vaultEpoch}
            schema={schema}
            onOpenSource={onOpenSource}
            embed
          />
        )}

        {/* the foot carries live facts only — how bindings work and where to
            edit cards is documentation, not state (SUB-527). With no FX in
            play there is nothing to say, so nothing is said. */}
        {fx && (
          <div className="dash-foot">
            USD→EUR {fmtFx(fx.usdEur)}
            {fx.live ? "" : " (cached)"}
          </div>
        )}
      </div>
    </div>
  );
}
