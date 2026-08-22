/** @type {SubstrateKind} */
export default {
  mount(el, ctx) {
    const props = ctx.note.props;
    // frontmatter is unknown-typed, so coerce everything before using it
    const type = String(props.track ?? "release");
    const dateKey = String(props.date ?? "released");
    const year = Number(props.year) || new Date().getFullYear();

    const draw = async () => {
      const notes = await ctx.notes((n) => n.props.type === type);
      const weeks = new Map(); // week number -> notes
      let undated = 0;
      for (const n of notes) {
        const iso = isoWeek(String(n.props[dateKey] ?? ""));
        if (!iso || iso.year !== year) {
          undated++;
          continue;
        }
        const bucket = weeks.get(iso.week) ?? [];
        bucket.push(n);
        weeks.set(iso.week, bucket);
      }

      const now = isoWeek(today());
      const current = now && now.year === year ? now.week : 0;
      const dated = [...weeks.values()].reduce((a, b) => a + b.length, 0);
      const busiest = Math.max(1, ...[...weeks.values()].map((b) => b.length));

      const cells = [];
      for (let w = 1; w <= weeksInYear(year); w++) {
        const bucket = weeks.get(w) ?? [];
        const level = bucket.length === 0 ? 0 : Math.ceil((bucket.length / busiest) * 3);
        cells.push(
          `<button class="wk-cell" data-level="${level}"${w === current ? ' data-now="1"' : ""}` +
            ` data-path="${escape(bucket[0]?.path ?? "")}"` +
            ` title="${escape(bucket.map((n) => n.title).join(", ") || "nothing")}">` +
            `<span class="wk-num">${w}</span>` +
            `<span class="wk-count">${bucket.length || ""}</span>` +
            `</button>`
        );
      }

      el.innerHTML = `
        <div class="${ctx.css["dash-metrics"]}">
          <div class="${ctx.css["dash-metric"]}">
            <div class="${ctx.css["dash-label"]}">This week</div>
            <div class="${ctx.css["dash-value"]}">${current ? `W${current}` : "—"}</div>
          </div>
          <div class="${ctx.css["dash-metric"]}">
            <div class="${ctx.css["dash-label"]}">Weeks used</div>
            <div class="${ctx.css["dash-value"]}">${weeks.size}</div>
          </div>
          <div class="${ctx.css["dash-metric"]}">
            <div class="${ctx.css["dash-label"]}">Busiest week</div>
            <div class="${ctx.css["dash-value"]}">${busiest}</div>
          </div>
        </div>
        <div class="${ctx.css["dash-section-label"]}">${year} by ISO week</div>
        <div class="wk-grid">${cells.join("")}</div>
        <div class="${ctx.css["dash-foot"]}">
          ${dated} ${escape(type)} note${dated === 1 ? "" : "s"} dated by ${escape(dateKey)}${
            undated ? `, ${undated} outside ${year}` : ""
          }
        </div>`;

      ctx.setState({ label: current ? `week ${current}` : String(year) });
    };

    // one delegated listener on el — the cells are replaced on every redraw
    el.addEventListener("click", (e) => {
      const cell = e.target instanceof Element ? e.target.closest(".wk-cell") : null;
      const path = cell?.getAttribute("data-path");
      if (path) ctx.openNote(path);
    });

    draw().catch((err) => ctx.toast(`week numbers: ${err}`));
    const off = ctx.onChange(() => {
      draw().catch((err) => ctx.toast(`week numbers: ${err}`));
    });
    return () => off();
  },
};

/** Local ISO date of today, as the notes write it. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** ISO-8601 week of a `YYYY-MM-DD` string, or null when it isn't one. */
function isoWeek(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  // shift to the Thursday of this week — the ISO year is the year that holds it
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return {
    year: d.getUTCFullYear(),
    week: Math.ceil(((d.getTime() - start) / 86400000 + 1) / 7),
  };
}

/** 52 or 53, decided by where December 28th falls — it is always in the last
    ISO week of its year. */
function weeksInYear(year) {
  return isoWeek(`${year}-12-28`)?.week ?? 52;
}

function escape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
