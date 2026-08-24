import { widgetConfiguredIds, widgetSummaryWrite } from "./ipc.ts";
import { parseCards, type MetricCard } from "./metriccards.ts";
import { foldedPropStr, type NoteMeta } from "./types.ts";

const WIDGET_SUMMARY_SCHEMA = 2;

/** One pickable card in the widget gallery: names only, never values. */
export interface WidgetCardIndexEntry {
  id: string;
  dashboardPath: string;
  dashboardTitle: string;
  label: string;
}

/** One exported value — present only for cards a placed widget references. */
export interface WidgetCardValue {
  id: string;
  value: string;
  detail?: string;
}

export interface WidgetSummary {
  schema: typeof WIDGET_SUMMARY_SCHEMA;
  generatedAt: string;
  index: WidgetCardIndexEntry[];
  cards: WidgetCardValue[];
}

/** What the evaluator answers per card — the on-screen strip's CardValue. */
interface EvaluatedCard {
  text: string;
  miss?: string;
  title?: string;
}

export type CardEvaluator = (cards: MetricCard[]) => Promise<EvaluatedCard[]>;

function metricsDashboards(notes: NoteMeta[]): NoteMeta[] {
  // sealed notes never reach the App Group: a locked one indexes with no
  // props anyway, but an unlocked-this-session one indexes normally, and its
  // encrypted-at-rest content must not persist in a plaintext file the
  // extension reads without any unlock
  return notes.filter(
    (note) =>
      !note.sealed &&
      foldedPropStr(note.props, "type")?.toLowerCase() === "dashboard" &&
      foldedPropStr(note.props, "dashboard")?.toLowerCase() === "metrics",
  );
}

/** Build the extension's entire read model. WidgetKit never enters the vault:
    it receives already-formatted values and a timestamp, then stays honest
    about that snapshot's age until the app refreshes it.

    Export is allow-listed by placement: `configured` is the
    set of card ids that widgets on the home screen actually reference, and
    only those cards are evaluated and written. The index half always lists
    every card by name so the gallery's picker works — labels carry no
    numbers. No placed widgets means no values leave the app. */
export async function buildWidgetSummary(
  notes: NoteMeta[],
  configured: string[],
  evaluate: CardEvaluator,
  now = new Date(),
): Promise<WidgetSummary> {
  const index: WidgetCardIndexEntry[] = [];
  const wanted: { id: string; card: MetricCard }[] = [];
  const want = new Set(configured);
  for (const dashboard of metricsDashboards(notes)) {
    parseCards(dashboard.props).forEach((card, i) => {
      const id = `${dashboard.path}#${i}`;
      index.push({
        id,
        dashboardPath: dashboard.path,
        dashboardTitle: dashboard.title,
        label: card.label,
      });
      if (want.has(id)) wanted.push({ id, card });
    });
  }

  let cards: WidgetCardValue[] = [];
  if (wanted.length > 0) {
    const values = await evaluate(wanted.map((w) => w.card));
    cards = wanted.map((w, i) => {
      const value = values[i];
      return {
        id: w.id,
        value: value?.text ?? "—",
        ...(value?.miss || value?.title ? { detail: value.miss ?? value.title } : {}),
      };
    });
  }

  return { schema: WIDGET_SUMMARY_SCHEMA, generatedAt: now.toISOString(), index, cards };
}

/** The last payload written this app process, minus the timestamp: an
    unchanged summary skips the write entirely, because each write costs a
    WidgetKit timeline reload and that budget is rationed per day. */
let lastPayload: string | null = null;
/** Writes are chained so a slow older refresh can never land after a newer
    one — each link re-checks its own currency just before writing. */
let writeChain: Promise<void> = Promise.resolve();

/** Called only after the backend confirms this is the iOS build. Desktop and
    the browser mock do zero dashboard work for a feature they cannot show.
    The evaluator is the on-screen strip's resolver, handed in by the hook so
    this module stays free of component imports. A failed allow-list read
    rejects and skips the refresh — the previous snapshot survives, because
    "could not ask WidgetKit" must not present as "no widgets placed".
    Resolves with the number of configured widgets, so the hook knows whether
    live FX rates are worth paying for. */
export async function refreshWidgetSummary(
  notes: NoteMeta[],
  evaluate: CardEvaluator,
  stillCurrent: () => boolean = () => true,
): Promise<number> {
  const configured = await widgetConfiguredIds();
  const summary = await buildWidgetSummary(notes, configured, evaluate);
  const payload = JSON.stringify({ index: summary.index, cards: summary.cards });
  if (payload === lastPayload || !stillCurrent()) return configured.length;
  const link = writeChain
    .catch(() => {})
    .then(async () => {
      if (!stillCurrent()) return;
      await widgetSummaryWrite(summary);
      lastPayload = payload;
    });
  writeChain = link.catch(() => {});
  await link;
  return configured.length;
}
