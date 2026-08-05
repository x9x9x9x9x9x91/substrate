import { useCallback, useEffect, useState } from "react";
import type { DoctorFinding, DoctorKind, DoctorReport } from "../lib/types";
import { vaultDoctor } from "../lib/ipc";
import { NoteIcon, PulseIcon } from "./Icons";
import { BackButton } from "./BackButton";

/** Group order and headings — the same order the engine sorts findings in,
    so the pane never reshuffles what the JSON already ordered. */
const KIND_LABELS: [DoctorKind, string][] = [
  ["broken-link", "Broken links"],
  ["broken-relation", "Broken relations"],
  ["broken-embed", "Missing embeds"],
  ["broken-view-ref", "Dangling view references"],
  ["ambiguous-target", "Ambiguous link targets"],
  ["corrupt-config", "Unreadable vault config"],
  ["stale-config", "Stale vault config"],
  ["invalid-prop", "Invalid property values"],
  ["broken-reflex", "Reflexes that won't run"],
  ["unscannable-sealed-note", "Sealed notes not checked"],
];

interface DoctorPaneProps {
  /** bumps on every vault change — refetches so fixed findings disappear */
  vaultEpoch: number;
  /** click-through for note findings; config findings have no note to open */
  onOpenNote: (path: string) => void;
}

/** Read-only vault integrity report (SUB-432). This pane REPORTS ONLY —
    there are deliberately no fix buttons; repair is a separate slice, and
    the backend command never writes. The raw report is one click away as
    JSON so an agent can consume the same data the pane renders. */
export default function DoctorPane({ vaultEpoch, onOpenNote }: DoctorPaneProps) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    vaultDoctor()
      .then((r) => {
        setReport(r);
        // a successful scan retires the last error — no stale strip under new results
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(load, [load, vaultEpoch]);

  const copyJson = () => {
    if (!report) return;
    navigator.clipboard
      .writeText(JSON.stringify(report, null, 2))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch((e) => setError(String(e)));
  };

  const groups: [DoctorKind, string, DoctorFinding[]][] = report
    ? KIND_LABELS.map(([kind, label]): [DoctorKind, string, DoctorFinding[]] => [
        kind,
        label,
        report.findings.filter((f) => f.kind === kind),
      ]).filter(([, , items]) => items.length > 0)
    : [];

  return (
    /* shares the trash pane's chrome; `doctor` keeps the two apart for the
       info view, whose copy differs (nothing here changes the vault) */
    <div className="trash doctor">
      <div className="list-head" data-tauri-drag-region>
        <BackButton />
        <span className="list-title">Vault doctor</span>
        {report && report.findings.length > 0 && (
          <span className="list-count">{report.findings.length}</span>
        )}
        {report && (
          <button className="trash-restore doctor-copy" onClick={copyJson}>
            {copied ? "Copied" : "Copy as JSON"}
          </button>
        )}
      </div>
      <div className="trash-body">
        {report === null ? (
          /* an errored scan renders the strip below — never a loading state
             that sticks forever; same DOM as the resolved state, so the scan
             landing only swaps text (SUB-650) */
          error === null ? (
            <div className="empty">
              <PulseIcon />
              <span>Scanning the vault</span>
              <span className="empty-hint">
                checking every link, relation, embed and property
              </span>
            </div>
          ) : null
        ) : report.findings.length === 0 ? (
          <div className="empty">
            <PulseIcon />
            <span>No problems found</span>
            <span className="empty-hint">
              every link, relation, embed and property in {report.notes} notes resolves
            </span>
          </div>
        ) : (
          groups.map(([kind, label, items]) => (
            <div key={kind} className="doctor-group">
              <div className="doctor-group-head">
                <span className="doctor-group-title">{label}</span>
                <span className="doctor-group-count">{items.length}</span>
              </div>
              {items.map((f, i) => (
                <div key={`${f.subject}-${f.paths.join()}-${i}`} className="trash-row">
                  <span className={`doctor-dot sev-${f.severity}`} title={f.severity} />
                  <div className="trash-row-main">
                    <span className="trash-row-title">{f.subject}</span>
                    <span className="trash-row-sub">{f.detail}</span>
                  </div>
                  <div className="doctor-paths">
                    {f.paths.map((p) =>
                      p.startsWith(".vault/") ? (
                        <span key={p} className="doctor-path-static">
                          {p}
                        </span>
                      ) : (
                        <button
                          key={p}
                          className="trash-restore doctor-path"
                          onClick={() => onOpenNote(p)}
                        >
                          <NoteIcon size={12} />
                          {p}
                        </button>
                      )
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      {report && report.findings.length > 0 && (
        <div className="doctor-foot">
          Report only — nothing here changes the vault.
        </div>
      )}
      {error && <div className="trash-error">{error}</div>}
    </div>
  );
}
