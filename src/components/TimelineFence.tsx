import { useMemo } from "react";
import type { NoteMeta, SchemaConfig } from "../lib/types";
import {
  layoutTimeline,
  parseTimelineConfig,
  timelineData,
  timelineItemLabel,
} from "../lib/timeline";
import { useTodayIso } from "./useTodayIso";

interface TimelineFenceProps {
  inner: string;
  notes: NoteMeta[];
  schema: SchemaConfig;
  onOpenSource: (path: string) => void;
}

export default function TimelineFence({ inner, notes, schema, onOpenSource }: TimelineFenceProps) {
  const today = useTodayIso();
  const result = useMemo(() => {
    try {
      const config = parseTimelineConfig(inner);
      const data = timelineData(config, notes, schema);
      return { config, data, layout: data.error ? null : layoutTimeline(data.items, today) };
    } catch (error) {
      return {
        config: null,
        data: { items: [], skipped: 0, error: error instanceof Error ? error.message : String(error) },
        layout: null,
      };
    }
  }, [inner, notes, schema, today]);

  if (result.data.error) return <div className="hub-timeline-err">{result.data.error}</div>;
  if (!result.layout || !result.config) {
    return <div className="hub-timeline-empty">No dated {result.config?.source ?? "timeline"} entries.</div>;
  }

  const { layout, config } = result;
  return (
    <section className="hub-timeline" aria-label={`${config.source} timeline`}>
      <div className="hub-timeline-head">
        <span>{config.source}</span>
        <span>
          {result.data.items.length} {result.data.items.length === 1 ? "item" : "items"}
          {result.data.skipped > 0 ? ` · ${result.data.skipped} skipped` : ""}
        </span>
      </div>
      <div className="hub-timeline-scroll">
        <div className="hub-timeline-canvas">
          <div className="hub-timeline-axis" aria-hidden="true">
            {layout.ticks.map((tick) => (
              // Labels are centred on their tick, so one sitting near either
              // edge would render half outside the canvas: pin those to the
              // edge instead of centring them.
              <span
                key={tick.date}
                className={tick.left > 94 ? "at-end" : tick.left < 6 ? "at-start" : undefined}
                style={{ left: `${tick.left}%` }}
              >
                {tick.label}
              </span>
            ))}
          </div>
          <div className="hub-timeline-grid" aria-hidden="true">
            {layout.ticks.map((tick) => (
              <i key={tick.date} style={{ left: `${tick.left}%` }} />
            ))}
            {layout.today !== null && (
              <i className="today" style={{ left: `${layout.today}%` }} title="Today" />
            )}
          </div>
          <div className="hub-timeline-lanes">
            {layout.lanes.map((lane) => (
              <div
                className="hub-timeline-lane"
                key={lane.key}
                style={{ height: `${Math.max(1, lane.tracks) * 30 + (lane.label ? 30 : 10)}px` }}
              >
                {lane.label && <div className="hub-timeline-lane-label">{lane.label}</div>}
                {lane.items.map((item) => {
                  const label = timelineItemLabel(item);
                  const style = {
                    left: `${item.left}%`,
                    top: `${item.track * 30 + (lane.label ? 25 : 7)}px`,
                  };
                  return item.end ? (
                    <button
                      type="button"
                      className="hub-timeline-bar"
                      key={item.path}
                      style={{ ...style, width: `${item.width}%` }}
                      title={label}
                      aria-label={label}
                      onClick={() => onOpenSource(item.path)}
                    >
                      {item.label}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="hub-timeline-milestone"
                      key={item.path}
                      style={style}
                      title={label}
                      aria-label={label}
                      onClick={() => onOpenSource(item.path)}
                    >
                      <i aria-hidden="true" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="dash-foot hub-timeline-foot">
        {layout.start} – {layout.end}
      </div>
    </section>
  );
}
