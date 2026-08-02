import { Fragment, useEffect, useMemo, useState } from "react";
import type { FolderScanStats, NewTypeProp, PropKind } from "../lib/types";
import { filePick } from "../lib/ipc";
import { scanStatLine } from "../lib/folders";
import {
  CSV_IMPORT_LARGE,
  csvColumns,
  csvEntries,
  csvSafeColumns,
  dbNameFromFile,
  type CsvEntry,
} from "../lib/csvimport";
import { PlusIcon, XIcon } from "./Icons";
import SelectMenu, { anchorFrom, type AnchorRect } from "./SelectMenu";

/* Database-management dialogs (SUB-43): small centered cards riding the
   palette's overlay idiom — Esc or a backdrop click closes, the first input
   is autofocused, Enter submits. Destructive sweeps are always explicit
   choices with the affected note count in the label. */

function Card({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // an open menu portal (SelectMenu/DateMenu) owns Esc — it closes the
        // menu itself; swallowing the key here would close the whole dialog
        if (e.target instanceof HTMLElement && e.target.closest(".selmenu")) return;
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dbform" role="dialog" aria-label={title}>
        <div className="dbform-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

const PROP_KIND_OPTIONS: { value: PropKind; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "multi", label: "Multi-select" },
  { value: "date", label: "Date" },
  { value: "file", label: "File" },
  { value: "relation", label: "Relation" },
  { value: "url", label: "URL" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "checkbox", label: "Checkbox" },
  { value: "number", label: "Number" },
];

/** "＋ New database": a name (becomes the `type`) plus optional initial
    properties with kinds. Select-kind props are shaped afterwards from any
    cell picker — options need a note to hang values on anyway. */
export function NewDatabaseDialog({
  dbTypes,
  onCreate,
  onClose,
}: {
  /** existing database types — the relation target picker */
  dbTypes: string[];
  onCreate: (name: string, props: NewTypeProp[]) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [props, setProps] = useState<NewTypeProp[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** the one open picker (kind or relation target) — a SelectMenu anchored at
      its row button (SUB-647: replaces the two stock selects) */
  const [menu, setMenu] = useState<{
    row: number;
    which: "kind" | "target";
    anchor: AnchorRect;
  } | null>(null);

  const update = (i: number, patch: Partial<NewTypeProp>) =>
    setProps((cur) => cur.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const ready =
    name.trim().length > 0 &&
    props.every((p) => p.name.trim() && (p.kind !== "relation" || (p.target ?? "").trim()));

  const submit = () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    onCreate(
      name.trim(),
      props.map((p) => ({ ...p, name: p.name.trim() }))
    ).catch((e) => {
      setErr(String(e));
      setBusy(false);
    });
  };

  return (
    <Card title="New database" onClose={onClose}>
      <input
        className="dbform-input"
        autoFocus
        placeholder="Database name…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          e.stopPropagation();
        }}
      />
      {props.length > 0 && (
        <div className="dbform-props">
          {props.map((p, i) => (
            <div className="dbform-proprow" key={i}>
              <input
                className="dbform-input"
                placeholder="Property name…"
                value={p.name}
                onChange={(e) => update(i, { name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                  e.stopPropagation();
                }}
              />
              <button
                type="button"
                className="dbform-select"
                onClick={(e) =>
                  setMenu({ row: i, which: "kind", anchor: anchorFrom(e.currentTarget) })
                }
              >
                {PROP_KIND_OPTIONS.find((k) => k.value === (p.kind ?? "text"))?.label ?? "Text"}
              </button>
              {p.kind === "relation" && (
                <button
                  type="button"
                  className="dbform-select"
                  onClick={(e) =>
                    setMenu({ row: i, which: "target", anchor: anchorFrom(e.currentTarget) })
                  }
                >
                  {p.target?.trim() || "no databases yet"}
                </button>
              )}
              <button
                className="dbform-x"
                title="Remove property"
                onClick={() => setProps((cur) => cur.filter((_, j) => j !== i))}
              >
                <XIcon />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        className="dbform-addprop"
        onClick={() =>
          setProps((cur) => [...cur, { name: "", kind: "text", target: null }])
        }
      >
        <PlusIcon /> Add property
      </button>
      {err && <div className="dbform-err">{err}</div>}
      <div className="dbform-foot">
        <button className="selmenu-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="selmenu-btn selmenu-btn-primary" disabled={!ready || busy} onClick={submit}>
          Create database
        </button>
      </div>
      {menu && (
        <SelectMenu
          anchor={menu.anchor}
          value={
            menu.which === "kind"
              ? (PROP_KIND_OPTIONS.find((k) => k.value === (props[menu.row]?.kind ?? "text"))
                  ?.label ?? "Text")
              : (props[menu.row]?.target ?? "")
          }
          label={menu.which === "kind" ? "Property type" : "Target database"}
          options={
            menu.which === "kind"
              ? PROP_KIND_OPTIONS.map((k) => ({ value: k.label }))
              : dbTypes.map((t) => ({ value: t }))
          }
          used={[]}
          canEditSchema={false}
          aboveOverlay
          onCommit={(v) => {
            setMenu(null);
            if (menu.which === "target") {
              update(menu.row, { target: v });
              return;
            }
            // the menu lists kind LABELS; an unmatched free-text commit is
            // no kind at all — close without changing
            const kind = PROP_KIND_OPTIONS.find((k) => k.label === v)?.value;
            if (!kind) return;
            update(menu.row, {
              kind,
              target: kind === "relation" ? (dbTypes[0] ?? null) : null,
            });
          }}
          onSaveSchema={() => {}}
          onClose={() => setMenu(null)}
        />
      )}
    </Card>
  );
}

/** "Import CSV as database…" (SUB-274): a picked CSV becomes a new database.
    Name it, say whether the first row is headers, and choose the columns to
    bring — the first included column becomes each entry's title, the rest
    become text props; blank rows are skipped. The type is created through
    the same path as "New database" (vault_create_type), entries through the
    same vault_create as any note. */
export function CsvImportDialog({
  fileName,
  rows,
  onImport,
  onClose,
}: {
  fileName: string;
  /** parseCsv output — raw cells; the headers toggle says what row 0 is */
  rows: string[][];
  onImport: (name: string, props: NewTypeProp[], entries: CsvEntry[]) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => dbNameFromFile(fileName));
  const [headers, setHeaders] = useState(true);
  /** excluded column indices — everything starts included */
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const columns = useMemo(() => csvColumns(rows, headers), [rows, headers]);
  // the names the database will really store: reserved and duplicate headers
  // get suffixed rather than silently emptying a column or aborting the import
  // on submit (SUB-559, SUB-562). The rows below show these, not the raw ones.
  const picked = useMemo(
    () => csvSafeColumns(columns.map((c, i) => ({ ...c, include: !excluded.has(i) }))),
    [columns, excluded],
  );
  const entries = useMemo(() => csvEntries(rows, headers, picked), [rows, headers, picked]);
  const titleIdx = columns.findIndex((_, i) => !excluded.has(i));
  const renamed = picked.filter((c, i) => c.name !== columns[i].name).length;
  const includedCount = columns.length - excluded.size;
  const large = entries.length > CSV_IMPORT_LARGE;

  const toggle = (i: number) =>
    setExcluded((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const ready = name.trim().length > 0 && includedCount > 0 && entries.length > 0;

  const submit = () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    const props: NewTypeProp[] = picked
      .filter((_, i) => i !== titleIdx && !excluded.has(i))
      .map((c) => ({ name: c.name, kind: "text", target: null }));
    onImport(name.trim(), props, entries).catch((e) => {
      setErr(String(e));
      setBusy(false);
    });
  };

  return (
    <Card title={`Import ${fileName}`} onClose={onClose}>
      <input
        className="dbform-input"
        autoFocus
        placeholder="Database name…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          e.stopPropagation();
        }}
      />
      <div className="dbform-columns">
        <button className="dbform-colrow" onClick={() => setHeaders((h) => !h)}>
          <span
            className={`prop-check${headers ? " on" : ""}`}
            aria-label={headers ? "Checked" : "Unchecked"}
          />
          First row is headers
        </button>
        {columns.map((_, i) => (
          <button key={i} className="dbform-colrow" onClick={() => toggle(i)}>
            <span
              className={`prop-check${excluded.has(i) ? "" : " on"}`}
              aria-label={excluded.has(i) ? "Unchecked" : "Checked"}
            />
            <span className="dbform-colname">{picked[i].name}</span>
            {i === titleIdx && <span className="dbform-coltitle">title</span>}
          </button>
        ))}
      </div>
      <div className="dbform-note">
        {large
          ? `Large import — ${entries.length} rows. This can take a moment.`
          : `${entries.length} ${entries.length === 1 ? "row" : "rows"} — the first included column becomes the title.`}
        {renamed > 0 &&
          ` ${renamed === 1 ? "One column was" : `${renamed} columns were`} renamed — that name is already taken.`}
      </div>
      {err && <div className="dbform-err">{err}</div>}
      <div className="dbform-foot">
        <button className="selmenu-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="selmenu-btn selmenu-btn-primary"
          disabled={!ready || busy}
          onClick={submit}
        >
          Import {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </button>
      </div>
    </Card>
  );
}

/** One-name edit card — shared by "Rename database…" and "Rename property…". */
export function RenameDialog({
  title,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = name.trim().length > 0 && name.trim() !== initial;

  const submit = () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    onSubmit(name.trim()).catch((e) => {
      setErr(String(e));
      setBusy(false);
    });
  };

  return (
    <Card title={title} onClose={onClose}>
      <input
        className="dbform-input"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          e.stopPropagation();
        }}
      />
      {err && <div className="dbform-err">{err}</div>}
      <div className="dbform-foot">
        <button className="selmenu-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="selmenu-btn selmenu-btn-primary" disabled={!ready || busy} onClick={submit}>
          {submitLabel}
        </button>
      </div>
    </Card>
  );
}

/** "Delete database…" — two explicit choices, both showing the note count:
    strip `type:` and keep the notes, or move every note to the trash. Never
    a silent file deletion; the pre-sweep snapshot covers either way. */
export function DeleteDatabaseDialog({
  dbType,
  noteCount,
  onChoice,
  onClose,
}: {
  dbType: string;
  noteCount: number;
  onChoice: (trashNotes: boolean) => Promise<void>;
  onClose: () => void;
}) {
  // a mid-sweep failure must outlive a 4s toast (SUB-501): the dialog stays
  // open and carries the partial-count message, like its sibling dialogs
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = (trash: boolean) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    onChoice(trash).catch((e) => {
      setErr(String(e));
      setBusy(false);
    });
  };
  return (
    <Card title={`Delete database “${dbType}”?`} onClose={onClose}>
      <div className="dbform-note">
        {noteCount === 0
          ? "No entries yet — only the schema entry goes."
          : `${noteCount} ${noteCount === 1 ? "entry" : "entries"} — choose what happens to them.`}
      </div>
      {err && <div className="dbform-err">{err}</div>}
      <div className="dbform-foot dbform-foot-stack">
        {noteCount > 0 && (
          <>
            <button className="selmenu-btn" disabled={busy} onClick={() => choose(false)}>
              Remove database, keep {noteCount} {noteCount === 1 ? "note" : "notes"}
            </button>
            <button
              className="selmenu-btn selmenu-btn-danger"
              disabled={busy}
              onClick={() => choose(true)}
            >
              Move {noteCount} {noteCount === 1 ? "note" : "notes"} to Trash
            </button>
          </>
        )}
        {noteCount === 0 && (
          <button
            className="selmenu-btn selmenu-btn-danger"
            disabled={busy}
            onClick={() => choose(false)}
          >
            Remove database
          </button>
        )}
        <button className="selmenu-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Card>
  );
}

/** Second, separately-confirmed step of removing a property: the schema
    entry is already gone — this offers the bulk value strip. */
export function StripPropDialog({
  dbType,
  prop,
  count,
  onStrip,
  onClose,
}: {
  dbType: string;
  prop: string;
  count: number;
  onStrip: () => Promise<void>;
  onClose: () => void;
}) {
  // same partial-failure surface as the delete dialog (SUB-501)
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strip = () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    onStrip().catch((e) => {
      setErr(String(e));
      setBusy(false);
    });
  };
  return (
    <Card title={`Also delete “${prop}” values?`} onClose={onClose}>
      <div className="dbform-note">
        “{prop}” was removed from the {dbType} schema. Its values are still stored on {count}{" "}
        {count === 1 ? "note" : "notes"} — delete them too?
      </div>
      {err && <div className="dbform-err">{err}</div>}
      <div className="dbform-foot dbform-foot-stack">
        <button className="selmenu-btn selmenu-btn-danger" disabled={busy} onClick={strip}>
          Delete values from {count} {count === 1 ? "note" : "notes"}
        </button>
        <button className="selmenu-btn" onClick={onClose}>
          Keep values
        </button>
      </div>
    </Card>
  );
}

/** "Map a folder…" (SUB-672): point a database at a real folder on disk —
    the folder's files sync in as stub notes (vault-format.md §8), strictly
    read-only on the folder itself. The folder comes from the native picker
    or typed (`~/…` allowed); globs are a comma list of file-name patterns
    with `*` the only wildcard. Submit writes the mapping to
    `.vault/folders.json` and runs the first scan, whose stats replace the
    form inline — the card closes from its result, no toast-only summary. */
export function MapFolderDialog({
  dbTypes,
  initialType,
  onMap,
  onClose,
}: {
  /** existing database types — the type field's suggestions */
  dbTypes: string[];
  /** set when opened from a database's own menu — its type is the prefill */
  initialType?: string;
  /** write the mapping + run the first scan; resolves to the new mapping's
      stats, rejects with the add/scan error */
  onMap: (path: string, type: string, globs: string[], watch: boolean) => Promise<FolderScanStats[]>;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [type, setType] = useState(initialType ?? "");
  const [globs, setGlobs] = useState("");
  const [watch, setWatch] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<FolderScanStats[] | null>(null);

  const ready = path.trim().length > 0 && type.trim().length > 0;

  const pick = () => {
    filePick(true)
      .then((p) => {
        if (p) setPath(p);
      })
      .catch(console.error);
  };

  const submit = () => {
    if (!ready || busy || stats) return;
    setBusy(true);
    setErr(null);
    const globList = globs
      .split(",")
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
    onMap(path.trim(), type.trim(), globList, watch).then(
      (s) => {
        setStats(s);
        setBusy(false);
      },
      (e) => {
        setErr(String(e));
        setBusy(false);
      }
    );
  };

  if (stats) {
    return (
      <Card title="Folder mapped" onClose={onClose}>
        <div className="dbform-note">
          {path.trim()} → {type.trim()}
        </div>
        {stats.map((s, i) => (
          <Fragment key={i}>
            <div className="dbform-note">{scanStatLine(s)}</div>
            {s.error && <div className="dbform-err">{s.error}</div>}
          </Fragment>
        ))}
        <div className="dbform-foot">
          <button className="selmenu-btn selmenu-btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Map a folder" onClose={onClose}>
      <div className="dbform-proprow">
        <input
          className="dbform-input"
          autoFocus
          placeholder="Folder path…"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            e.stopPropagation();
          }}
        />
        <button className="selmenu-btn" onClick={pick}>
          Choose…
        </button>
      </div>
      <input
        className="dbform-input"
        placeholder="Database type…"
        list="mapfolder-dbtypes"
        value={type}
        onChange={(e) => setType(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          e.stopPropagation();
        }}
      />
      <datalist id="mapfolder-dbtypes">
        {dbTypes.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <input
        className="dbform-input"
        placeholder="Globs, optional — *.pdf, *.csv"
        value={globs}
        onChange={(e) => setGlobs(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          e.stopPropagation();
        }}
      />
      <button className="dbform-colrow" onClick={() => setWatch((w) => !w)}>
        <span
          className={`prop-check${watch ? " on" : ""}`}
          aria-label={watch ? "Checked" : "Unchecked"}
        />
        Watch this folder — sync automatically on changes
      </button>
      <div className="dbform-note">
        The scan creates one stub note per matching file — the folder itself is never
        written.
      </div>
      {err && <div className="dbform-err">{err}</div>}
      <div className="dbform-foot">
        <button className="selmenu-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="selmenu-btn selmenu-btn-primary"
          disabled={!ready || busy}
          onClick={submit}
        >
          Map folder
        </button>
      </div>
    </Card>
  );
}
