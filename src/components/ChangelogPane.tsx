import {
  CHANGELOG,
  KIND_LABEL,
  groupRelease,
  splitLead,
  type ChangelogKind,
} from "../lib/changelog";
import { DashHead } from "./DashHead";

/* The in-app release history. Read-only by construction: it renders
   the CHANGELOG constant and touches no vault IPC, so nothing here is indexed
   by search, lists, or databases. Dressed in the instrument language — the
   shared DashHead, numbered section labels per release, round dots carrying
   the kind.

   Structured: a release leads with its headline items at sentence
   prominence, then the remaining items grouped New / Improved / Fixed. Only
   headline rows carry the kind dot; the group label is a section voice —
   uppercase micro-label with a trailing hairline, never a dotted row
   (a dotted label read as a bullet item and its items as orphan
   continuation lines).

   Visual pass: the kind color lives on the group label text as well
   as the headline dot — meaning-carrying per the option-dot palette, not
   chrome — and "Lead: detail" entries render the lead a step up so a release
   scans as phrases, not a wall of even sentences. */

const KIND_COLOR: Record<ChangelogKind, string> = {
  new: "var(--opt-green)",
  improved: "var(--opt-blue)",
  fixed: "var(--opt-orange)",
};

/** "Lead: detail" gets a scannable bold lead; plain sentences render as-is. */
function EntryText({ text }: { text: string }) {
  const split = splitLead(text);
  if (!split) return <>{text}</>;
  return (
    <>
      <span className="chlog-lead">{split.lead}:</span> {split.rest}
    </>
  );
}

function releaseDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

interface ChangelogPaneProps {
  /** Machine-local surfaces carry `private` changelog items; they
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
                <>
                  {/* the pane matches the generated CHANGELOG.md's
                      "### Highlights"; the mark is a four-pointed
                      star in the kind color — a highlight, not a state dot */}
                  <h3 className="chlog-highlights-label">Highlights</h3>
                  <ul className="chlog-headlines">
                  {headlines.map((item, i) => (
                    <li key={i} className="chlog-headline">
                      <span
                        className="chlog-mark"
                        style={{ color: KIND_COLOR[item.kind ?? "improved"] }}
                        title={KIND_LABEL[item.kind ?? "improved"]}
                        aria-hidden="true"
                      >
                        ✦
                      </span>
                      <span
                        className={
                          "chlog-headline-text" +
                          (splitLead(item.text) ? "" : " no-lead")
                        }
                      >
                        <EntryText text={item.text} />
                      </span>
                    </li>
                  ))}
                  </ul>
                </>
              )}

              {groups.map((group) => (
                <div key={group.kind} className="chlog-group">
                  <h3
                    className="chlog-group-label"
                    style={{ color: KIND_COLOR[group.kind] }}
                  >
                    {KIND_LABEL[group.kind]}
                  </h3>
                  <ul className="chlog-items">
                    {group.items.map((item, i) => (
                      <li key={i} className="chlog-item">
                        <span className="chlog-text">
                          <EntryText text={item.text} />
                        </span>
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
