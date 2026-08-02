import { CHANGELOG, type ChangelogRelease } from "../lib/changelog";
import { DashHead } from "./DashHead";

/* The in-app release history (SUB-452). Read-only by construction: it renders
   the CHANGELOG constant and touches no vault IPC, so nothing here is indexed
   by search, lists, or databases. Dressed in the instrument language — the
   shared DashHead, numbered section labels per release, round dots carrying
   the kind. */

const KIND_COLOR: Record<NonNullable<ChangelogRelease["items"][number]["kind"]>, string> = {
  new: "var(--ok)",
  improved: "var(--opt-blue)",
  fixed: "var(--opt-gray)",
};

function releaseDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export default function ChangelogPane() {
  const current = CHANGELOG[0];

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title="What's new"
          state={{ label: `version ${current?.version ?? "—"}` }}
        />

        {CHANGELOG.map((release) => (
          <section key={release.version} className="chlog-release">
            <div className="dash-section-label">
              <span>{release.version}</span>
              <span className="chlog-release-title">{release.title}</span>
              <span className="chlog-release-date">{releaseDate(release.date)}</span>
            </div>
            <ul className="chlog-items">
              {release.items.map((item, i) => (
                <li key={i} className="chlog-item">
                  <span
                    className="dash-dot chlog-mark"
                    style={{ background: KIND_COLOR[item.kind ?? "improved"] }}
                    title={item.kind ?? "improved"}
                  />
                  <span className="chlog-text">{item.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
