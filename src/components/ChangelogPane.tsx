import {
  CHANGELOG,
  KIND_LABEL,
  groupRelease,
  type ChangelogKind,
} from "../lib/changelog";
import { DashHead } from "./DashHead";

/* The in-app release history (SUB-452). Read-only by construction: it renders
   the CHANGELOG constant and touches no vault IPC, so nothing here is indexed
   by search, lists, or databases. Dressed in the instrument language — the
   shared DashHead, numbered section labels per release, round dots carrying
   the kind.

   Structured per SUB-817: a release leads with its headline items at sentence
   prominence, then the remaining items grouped New / Improved / Fixed. The
   kind dot rides the group label once instead of repeating on every row. */

const KIND_COLOR: Record<ChangelogKind, string> = {
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

        {CHANGELOG.map((release) => {
          const { headlines, groups } = groupRelease(release);
          return (
            <section key={release.version} className="chlog-release">
              <div className="dash-section-label">
                <span>{release.version}</span>
                <span className="chlog-release-title">{release.title}</span>
                <span className="chlog-release-date">{releaseDate(release.date)}</span>
              </div>

              {headlines.length > 0 && (
                <ul className="chlog-headlines">
                  {headlines.map((item, i) => (
                    <li key={i} className="chlog-headline">
                      <span
                        className="dash-dot chlog-mark"
                        style={{ background: KIND_COLOR[item.kind ?? "improved"] }}
                        title={item.kind ?? "improved"}
                      />
                      <span className="chlog-headline-text">{item.text}</span>
                    </li>
                  ))}
                </ul>
              )}

              {groups.map((group) => (
                <div key={group.kind} className="chlog-group">
                  <div className="chlog-group-label">
                    <span
                      className="dash-dot chlog-mark"
                      style={{ background: KIND_COLOR[group.kind] }}
                    />
                    <span>{KIND_LABEL[group.kind]}</span>
                  </div>
                  <ul className="chlog-items">
                    {group.items.map((item, i) => (
                      <li key={i} className="chlog-item">
                        <span className="chlog-text">{item.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
