import { useEffect, useMemo, useRef, useState } from "react";
import { NON_COLUMN_KEYS } from "../lib/dbcolumns";

/* The prompt a row dropped ONTO another row raises: name the group the two
   rows should share. Nothing is written until it is confirmed — a drop is
   easy to make by accident while dragging rows around, so Escape, a click
   outside, and Cancel all leave the table exactly as it was.

   When the table is already grouped, the prompt is one field: the group
   name, with the values already in use offered underneath. When it is not
   grouped, the same prompt establishes the grouping first — pick the
   property the sections will stand for, or name a new one, and the confirm
   turns that column into the table's grouping in the same gesture.

   Rides the TagFolderDialog / DbAdmin overlay+dbform idiom: centered card,
   tokens only, Cancel beside a primary confirm. */

/** the property dropdown's "make me a new one" entry — no real column can
    take this value, since a column name is a YAML key and never empty */
const NEW_PROP = "";

export default function RowGroupPrompt({
  count,
  groupProp,
  propChoices,
  preferredProp,
  existingCols,
  optionsFor,
  onCancel,
  onConfirm,
}: {
  /** how many rows the confirmed drop would put in the group */
  count: number;
  /** the property the table already groups by, or null while ungrouped */
  groupProp: string | null;
  /** columns this table could group by, offered while it is ungrouped */
  propChoices: string[];
  /** the choice to open on: a column the schema already calls a select is
      an unambiguous grouping column, so it beats inventing a new one */
  preferredProp: string | null;
  /** every column name, for refusing a new-property name that collides */
  existingCols: string[];
  /** the group values already in use on a property, offered as one click */
  optionsFor: (prop: string) => string[];
  onCancel: () => void;
  /** `createProp` = the property is being invented here and does not exist
      in the schema yet */
  onConfirm: (prop: string, value: string, createProp: boolean) => void;
}) {
  const [choice, setChoice] = useState<string>(groupProp ?? preferredProp ?? NEW_PROP);
  const [propName, setPropName] = useState("Group");
  const [value, setValue] = useState("");
  const valueRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const creating = groupProp === null && choice === NEW_PROP;
  const prop = groupProp ?? (creating ? propName.trim() : choice);

  // a new property may not land on a column that is already there — the
  // dropdown above is where an existing one gets picked
  const collision =
    creating &&
    prop.length > 0 &&
    existingCols.some((c) => c.toLowerCase() === prop.toLowerCase());

  /* Nor on one of the keys the app writes for itself. These never appear in
     `existingCols` — a table shows none of them as a column — so the
     collision check above cannot see them, and a property named `type`
     would bulk-write `type: <group name>` onto both rows and move them out
     of this database entirely. Refused the same way a collision is. */
  const reserved = creating && NON_COLUMN_KEYS.includes(prop.toLowerCase());

  /** why the confirm is refusing, or null while it isn't */
  const refusal = collision
    ? `“${prop}” is already a column — pick it above.`
    : reserved
      ? `“${prop}” is a name the app keeps for itself — pick another.`
      : null;

  // the values this property already carries, minus what has been typed —
  // offering a suggestion identical to the field's contents is a dead row
  const suggestions = useMemo(() => {
    if (creating || !prop) return [];
    const typed = value.trim().toLowerCase();
    return optionsFor(prop)
      .filter((v) => v.toLowerCase() !== typed)
      .slice(0, 8);
  }, [creating, prop, value, optionsFor]);

  const canConfirm = prop.length > 0 && value.trim().length > 0 && !refusal;

  const confirm = () => {
    if (!canConfirm) return;
    onConfirm(prop, value.trim(), creating);
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dbform" role="dialog" aria-label="Group these rows">
        {/* always two rows or more: a drop pairs the dragged row with the
            row it landed on, and a row cannot be dropped on itself */}
        <div className="dbform-title">Group these {count} rows</div>

        {groupProp === null && (
          <>
            <div className="dbform-note">
              This table isn’t grouped yet — pick the property its sections will
              stand for, or name a new one.
            </div>
            <label className="rowgroup-field">
              <span className="rowgroup-lbl">Group by</span>
              <select
                className="dbform-select"
                aria-label="Group by property"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                {propChoices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value={NEW_PROP}>New property…</option>
              </select>
            </label>
            {creating && (
              /* captioned, because two bare text fields stacked here read as
                 one repeated field: a filled input shows no placeholder, and
                 the property name arrives already filled in */
              <label className="rowgroup-field">
                <span className="rowgroup-lbl">Property name</span>
                <input
                  className="dbform-input"
                  value={propName}
                  aria-label="New property name"
                  placeholder="Property name"
                  onChange={(e) => setPropName(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </label>
            )}
          </>
        )}

        <label className="rowgroup-field">
          <span className="rowgroup-lbl">{prop ? `${prop} value` : "Group name"}</span>
          <input
            ref={valueRef}
            className="dbform-input"
            value={value}
            autoFocus
            aria-label="Group name"
            placeholder={prop ? `${prop} value…` : "Group name…"}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                confirm();
              }
            }}
          />
        </label>

        {suggestions.length > 0 && (
          <div className="rowgroup-opts">
            {suggestions.map((v) => (
              <button
                key={v}
                type="button"
                className="rowgroup-opt"
                onClick={() => {
                  setValue(v);
                  valueRef.current?.focus();
                }}
              >
                {v}
              </button>
            ))}
          </div>
        )}

        {refusal && <div className="dbform-err">{refusal}</div>}

        <div className="dbform-foot">
          <button className="selmenu-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="selmenu-btn selmenu-btn-primary" disabled={!canConfirm} onClick={confirm}>
            Group
          </button>
        </div>
      </div>
    </div>
  );
}
