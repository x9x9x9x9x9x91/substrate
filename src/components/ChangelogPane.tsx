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
   prominence, then the remaining items grouped New / Improved / Fixed. Only
   headline rows carry the kind dot; the group label is a section voice —
   uppercase micro-label with a trailing hairline, never a dotted row
   (SUB-866: a dotted label read as a bullet item and its items as orphan
   continuation lines). */

const KIND_COLOR: Record<ChangelogKind, string> = {
  new: "var(--ok)",
  improved: "var(--opt-blue)",
  fixed: "var(--opt-gray)",
};

function releaseDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

interface ChangelogPaneProps {
  /** Machine-local surfaces carry `private` changelog items (SUB-830); they
      render only where such a surface exists, so a stock install's history
      describes the app it actually has. Never passed = never shown. */
  showPrivate?: boolean;
}

export default function ChangelogPane({ showPrivate = false }: ChangelogPaneProps) {
  const current = CHANGELOG[0];

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title="What's new"
          state={{ label: `version ${current?.version ?? "—"}` }}
        />

        {CHANGELOG.map((release) => {
          const { headlines, groups } = groupRelease({
            ...release,
            items: release.items.filter((item) => showPrivate || !item.private),
          });
          return (
            <section key={release.version} className="chlog-release">
              <h2 className="dash-section-label">
                <span>{release.version}</span>
                <span className="chlog-release-title">{release.title}</span>
                <span className="chlog-release-date">{releaseDate(release.date)}</span>
              </h2>

              {headlines.length > 0 && (
                <ul className="chlog-headlines">
                  {headlines.map((item, i) => (
                    <li key={i} className="chlog-headline">
                      <span
                        className="dash-dot chlog-mark"
                        style={{ background: KIND_COLOR[item.kind ?? "improved"] }}
                        title={KIND_LABEL[item.kind ?? "improved"]}
                        aria-hidden="true"
                      />
                      <span className="chlog-headline-text">{item.text}</span>
                    </li>
                  ))}
                </ul>
              )}

              {groups.map((group) => (
                <div key={group.kind} className="chlog-group">
                  <h3 className="chlog-group-label">{KIND_LABEL[group.kind]}</h3>
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
