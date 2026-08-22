import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NoteMeta, SavedView, SchemaConfig } from "../lib/types";
import { vaultRead } from "../lib/ipc";
import { gridCardSharpIndices, gridSpans, parseGridBlocks, type GridTile } from "../lib/grid";
import { embedQueryFor } from "../lib/embeds";
import { DashHead } from "./DashHead";
import MetricsDashboard from "./MetricsDashboard";
import ChartsDashboard from "./ChartsDashboard";
import EmbedViewTable, { type EmbedEdit } from "./EmbedViewTable";
import { DashAlert, DashEmpty } from "./DashNotice";

/* The row gap between tiles, and the tile's own top rule and padding — the
   pixels a packed tile owes on top of what its content measures. Both halves
   live in `.grid-tiles` / `.grid-tile` (src/styles.css) and have to agree with
   these, or a packed board gaps unevenly. */
const TILE_GAP = 16;
const TILE_LEAD = 17; // 16px padding-top over a 1px rule

interface GridDashboardProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  schema: SchemaConfig;
  savedViews?: SavedView[];
  vaultEpoch: number;
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  /** the write path a tile's live cells commit through */
  embedEdit?: EmbedEdit;
}

function GridViewTile({
  tile,
  notes,
  schema,
  savedViews,
  onOpenSource,
  embedEdit,
}: {
  tile: Extract<GridTile, { kind: "view" }>;
  notes: NoteMeta[];
  schema: SchemaConfig;
  savedViews: SavedView[];
  onOpenSource: (path: string) => void;
  embedEdit?: EmbedEdit;
}) {
  const result = useMemo(
    () => embedQueryFor(tile.view, notes, schema, savedViews),
    [notes, savedViews, schema, tile.view]
  );
  if ("error" in result) return <DashAlert fill>{result.error}</DashAlert>;
  return <EmbedViewTable result={result} onOpenSource={onOpenSource} edit={embedEdit} />;
}

export default function GridDashboard({
  meta,
  notes,
  schema,
  savedViews = [],
  vaultEpoch,
  onOpenSource,
  onMutated,
  embedEdit,
}: GridDashboardProps) {
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    vaultRead(meta.path).then((content) => {
      if (!gone) setBody(content.body);
    });
    return () => {
      gone = true;
    };
  }, [meta.path, vaultEpoch]);

  const blocks = useMemo(() => parseGridBlocks(body ?? ""), [body]);
  // Principle 11 is board-wide: flatten every cards tile before choosing the
  // maximum two sharp values, then project those indices back into each tile.
  const cardSharp = useMemo(() => gridCardSharpIndices(blocks), [blocks]);
  // a tile left alone on its row takes the whole row
  const spans = useMemo(() => gridSpans(blocks), [blocks]);

  /* Tiles pack instead of leaving a hole. A CSS grid row is as tall
     as its tallest cell, so a short cards tile beside a chart left ~160px of
     dead space under it and the board read as a hole rather than a layout.
     Native `masonry` is not portable yet, and multi-column would scramble
     document order and lose `span-2`, so the packing is measured: the track
     becomes 1px rows with no row gap, and each tile spans as many of them as
     its content is tall. The height is read off an inner box the row height
     never touches — reading the tile itself would feed its own span back in
     and grow it every pass.

     One track (the narrow container query) is already packed by definition, so
     the class comes off and the rows go back to auto — measuring there would
     only be a way to get it wrong. */
  const tilesRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const host = tilesRef.current;
    if (!host) return;
    let frame = 0;

    const measure = () => {
      frame = 0;
      const tiles = Array.from(host.children) as HTMLElement[];
      const tracks = getComputedStyle(host).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
      if (tracks < 2) {
        host.classList.remove("is-packed");
        for (const tile of tiles) tile.style.gridRow = "";
        return;
      }
      host.classList.add("is-packed");
      for (const tile of tiles) {
        const inner = tile.firstElementChild as HTMLElement | null;
        const h = inner ? inner.getBoundingClientRect().height : 0;
        tile.style.gridRow = `span ${Math.max(1, Math.ceil(h) + TILE_LEAD + TILE_GAP)}`;
      }
    };
    // charts, sheet reads and font swaps land after the effect, and the
    // container resizes with the pane — one frame of coalescing keeps a burst
    // of those to a single pass
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    for (const tile of Array.from(host.children)) {
      if (tile.firstElementChild) ro.observe(tile.firstElementChild);
    }
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [blocks]);

  return (
    <div className="note">
      <div className="dash-inner grid-dashboard">
        <DashHead
          title={meta.title}
          state={{ label: `${blocks.length} ${blocks.length === 1 ? "tile" : "tiles"}` }}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        {body !== null && blocks.length === 0 ? (
          <DashEmpty>No tiles yet — add a ```tile fence to this note.</DashEmpty>
        ) : (
          <div className="grid-tiles" ref={tilesRef}>
            {blocks.map((block, i) => {
              const tile = block.tile;
              return (
                <section
                  className={`grid-tile${spans[i] === 2 ? " span-2" : ""}`}
                  key={i}
                >
                  {/* the box the packing measures: its own formatting context,
                      so a child's top margin is inside the number rather than
                      collapsing out of it and short-changing the span */}
                  <div className="grid-tile-in">
                    {block.error ? (
                      <DashAlert fill>{block.error}</DashAlert>
                    ) : tile?.kind === "cards" ? (
                      <MetricsDashboard
                        meta={meta}
                        notes={notes}
                        schema={schema}
                        vaultEpoch={vaultEpoch}
                        onOpenSource={onOpenSource}
                        onMutated={onMutated}
                        embed
                        cardsOverride={tile.cards}
                        sharpOverride={cardSharp[i]}
                      />
                    ) : tile?.kind === "chart" ? (
                      <ChartsDashboard
                        meta={meta}
                        notes={notes}
                        schema={schema}
                        vaultEpoch={vaultEpoch}
                        onOpenSource={onOpenSource}
                        body=""
                        configOverride={tile.chart}
                        embed
                      />
                    ) : tile?.kind === "view" ? (
                      <GridViewTile
                        tile={tile}
                        notes={notes}
                        schema={schema}
                        savedViews={savedViews}
                        onOpenSource={onOpenSource}
                        embedEdit={embedEdit}
                      />
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        <div className="dash-foot">
          Tiles are plain-text fences in this note — edit their order or span to reshape the board.
        </div>
      </div>
    </div>
  );
}
