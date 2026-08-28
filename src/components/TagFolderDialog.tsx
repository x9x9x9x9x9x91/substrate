import { useEffect, useMemo, useRef, useState } from "react";
import type { TagCount, TagFolder, TagMatch } from "../lib/types";
import { tagFolderSummary, tagOptions } from "../lib/tags";
import { XIcon } from "./Icons";

/* The tag-folder builder. Clicked together, never typed: a name,
   tags as chips, an any/all toggle, and an exclusion row. There is no query
   language behind this — the chips ARE the query, so what the dialog shows is
   the whole rule.

   Rides the SendLinkDialog / DbAdmin overlay+dbform idiom. */

const uid = () => `tf-${Math.random().toString(36).slice(2, 10)}`;

/** Chips carry the author's spelling but never duplicate case-insensitively —
    the same rule the matcher uses, applied at authoring time so the folder
    can't hold `#Demo` and `#demo` as two separate requirements.

    A rejection says WHY: the field used to just clear itself, so
    `#2024` and `#a/b` looked accepted until the chip never appeared. */
type AddResult =
  | { list: string[]; reject?: undefined }
  | { list?: undefined; reject: string | null };

function addTag(list: string[], raw: string): AddResult {
  const tag = raw.trim().replace(/^#+/, "");
  // nothing typed — a stray space or Enter, not a rejection worth flagging
  if (!tag) return { reject: null };
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(tag))
    return { reject: "Tags start with a letter, then letters, numbers, - or _" };
  if (list.some((t) => t.toLowerCase() === tag.toLowerCase()))
    return { reject: `#${tag} is already here` };
  return { list: [...list, tag] };
}

function ChipRow({
  label,
  hint,
  tags,
  universe,
  onChange,
}: {
  label: string;
  hint: string;
  tags: string[];
  universe: TagCount[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [reject, setReject] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // the same completion source the editor's `#` uses, minus what this row
  // already holds — offering a chip you can't add twice is a dead option
  const options = useMemo(() => {
    if (!draft.trim()) return [];
    const taken = new Set(tags.map((t) => t.toLowerCase()));
    return tagOptions(draft.trim().replace(/^#+/, ""), universe)
      .filter((t) => !taken.has(t.toLowerCase()))
      .slice(0, 6);
  }, [draft, tags, universe]);

  const commit = (raw: string) => {
    const res = addTag(tags, raw);
    if (res.list) {
      onChange(res.list);
      setReject(null);
      setDraft("");
    } else if (res.reject) {
      // keep what was typed — the user can fix `#a/b` into `#a-b` rather than
      // retype it — and say why, with a nudge so it reads as a refusal
      setReject(res.reject);
      setShake((n) => n + 1);
    } else {
      setReject(null);
      setDraft("");
    }
    inputRef.current?.focus();
  };

  return (
    <div className="tagfolder-row">
      <div className="tagfolder-row-label">{label}</div>
      <div
        // two identical classes, alternated: swapping restarts the nudge so a
        // second bad tag moves again. Re-keying the element would remount the
        // input and drop focus mid-typing.
        className={`tagfolder-chips${
          reject ? (shake % 2 ? " tagfolder-chips-reject-a" : " tagfolder-chips-reject-b") : ""
        }`}
      >
        {tags.map((t) => (
          <span key={t} className="tagfolder-chip">
            #{t}
            <button
              type="button"
              className="tagfolder-chip-x"
              aria-label={`Remove #${t}`}
              onClick={() => onChange(tags.filter((x) => x !== t))}
            >
              <XIcon />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="tagfolder-input"
          value={draft}
          placeholder={hint}
          aria-label={label}
          aria-invalid={reject ? true : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            // typing is the user answering the hint — drop it as they go
            if (reject) setReject(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" || e.key === "," || e.key === " ") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && !draft && tags.length > 0) {
              // the chip-field convention: backspace on an empty field eats
              // the last chip rather than doing nothing
              onChange(tags.slice(0, -1));
            }
          }}
        />
      </div>
      {reject && (
        <div className="tagfolder-reject" role="status">
          {reject}
        </div>
      )}
      {options.length > 0 && (
        <div className="tagfolder-opts">
          {options.map((t) => (
            <button key={t} type="button" className="tagfolder-opt" onClick={() => commit(t)}>
              #{t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TagFolderDialog({
  folder,
  universe,
  matchCount,
  onSave,
  onDelete,
  onClose,
}: {
  /** null = build a new one */
  folder: TagFolder | null;
  universe: TagCount[];
  /** how many notes the draft rule matches right now — the live answer to
      "did I mean this?", which no chip list can give on its own */
  matchCount: (draft: TagFolder) => number;
  onSave: (folder: TagFolder) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const [tags, setTags] = useState<string[]>(folder?.tags ?? []);
  const [match, setMatch] = useState<TagMatch>(folder?.match ?? "any");
  const [exclude, setExclude] = useState<string[]>(folder?.exclude ?? []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const draft: TagFolder = useMemo(
    () => ({ id: folder?.id ?? uid(), name: name.trim(), tags, match, exclude, icon: folder?.icon }),
    [folder, name, tags, match, exclude]
  );

  // an unnamed folder or one with no positive tags would be a row that
  // matches nothing — refuse it here rather than let it sit in the sidebar
  const canSave = draft.name.length > 0 && tags.length > 0;
  const count = tags.length > 0 ? matchCount(draft) : 0;

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dbform" role="dialog" aria-label={folder ? "Edit tag folder" : "New tag folder"}>
        <div className="dbform-title">{folder ? "Edit tag folder" : "New tag folder"}</div>

        <input
          className="dbform-input"
          value={name}
          autoFocus
          placeholder="Folder name"
          aria-label="Folder name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />

        <ChipRow
          label="Tagged"
          hint="add a tag…"
          tags={tags}
          universe={universe}
          onChange={setTags}
        />

        <div className="tagfolder-row">
          <div className="tagfolder-row-label">Match</div>
          <div className="sendlink-expiry" role="radiogroup" aria-label="Match">
            {(["any", "all"] as TagMatch[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={match === m}
                className={`selmenu-btn${match === m ? " sendlink-expiry-on" : ""}`}
                onClick={() => setMatch(m)}
              >
                {m === "any" ? "Any of them" : "All of them"}
              </button>
            ))}
          </div>
        </div>

        <ChipRow
          label="But not"
          hint="add an exclusion…"
          tags={exclude}
          universe={universe}
          onChange={setExclude}
        />

        <div className="dbform-note">
          {tagFolderSummary(draft)} — {count} {count === 1 ? "note" : "notes"} right now. Notes made
          or dropped here get these tags; nothing moves on disk.
        </div>

        <div className="dbform-foot">
          {folder && (
            <button
              className="selmenu-btn selmenu-btn-danger"
              onClick={() => onDelete(folder.id)}
            >
              Delete
            </button>
          )}
          <button className="selmenu-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="selmenu-btn selmenu-btn-primary"
            disabled={!canSave}
            onClick={() => onSave(draft)}
          >
            {folder ? "Save" : "Create folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
