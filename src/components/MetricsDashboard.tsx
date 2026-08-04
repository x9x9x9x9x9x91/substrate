import { useEffect, useMemo, useState } from "react";
import type { NoteMeta, SchemaConfig } from "../lib/types";
import { vaultRead } from "../lib/ipc";
import { parseChartBlocks } from "../lib/chart";
import ChartsDashboard from "./ChartsDashboard";
import { fmtFx, sharpCardIndices } from "../lib/dashboard";
import { parseCards, type MetricCard } from "../lib/metriccards";
import { MetricCardStrip, useCardValues } from "./MetricCards";
import { useUsdEur } from "./useFx";
import { DashHead, DashPrintButton } from "./DashHead";

interface MetricsDashboardProps {
  meta: NoteMeta;
  /** every vault note — chart fences below the cards aggregate over these */
  notes: NoteMeta[];
  schema: SchemaConfig;
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  /** An embedding surface renders the card strip alone — no dashboard head,
      no footer, no body-level chart pass. The binding and evaluation path is
      the one every other card surface uses (SUB-964); only the chrome is
      dropped. */
  embed?: boolean;
  /** Cards the embedding surface already parsed from its own fence, in place
      of the hosting note's frontmatter. */
  cardsOverride?: MetricCard[];
  /** Sharp indices chosen board-wide by the caller — the emphasis cap is per
      BOARD, not per strip (principle 11). */
  sharpOverride?: Set<number>;
}

export default function MetricsDashboard({
  meta,
  notes,
  schema,
  vaultEpoch,
  onOpenSource,
  embed = false,
  cardsOverride,
  sharpOverride,
}: MetricsDashboardProps) {
  const { fx } = useUsdEur();
  // the note's body, for chart fences below the cards (finance surface):
  // a metrics dashboard with ```chart blocks renders them like the charts
  // dashboard does, same visual language
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    if (embed) return;
    let gone = false;
    vaultRead(meta.path).then((c) => {
      if (!gone) setBody(c.body);
    });
    return () => {
      gone = true;
    };
  }, [embed, meta.path, vaultEpoch]);

  const cards = useMemo(
    () => cardsOverride ?? parseCards(meta.props),
    [cardsOverride, meta.props]
  );
  const sharp = useMemo(() => sharpOverride ?? sharpCardIndices(cards), [cards, sharpOverride]);
  const cardValue = useCardValues(cards, vaultEpoch, meta.path, fx);

  const cardsSurface =
    cards.length === 0 ? (
      <div className="dash-foot">
        {embed ? (
          <>No cards yet — add cards with a label and a {"{{Sheet.summary}}"} binding.</>
        ) : (
          <>
            No cards yet — add a cards: list to this note’s frontmatter, each with a label and
            a {"{{Sheet.summary}}"} binding.
          </>
        )}
      </div>
    ) : (
      <MetricCardStrip cards={cards} sharp={sharp} cardValue={cardValue} />
    );

  if (embed) return cardsSurface;

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

        {cardsSurface}

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
