import { useState } from "react";
import type { NumberFormat, PropKind, RollupConfig, SelectOption } from "../lib/types";
import SelectMenu, { type AnchorRect } from "./SelectMenu";

/** "＋ Add property" (SUB-43): names a new column, then rides SelectMenu's
    schema editor (kind / options / target) wholesale. Saving writes schema
    only — notes without a value simply render the column empty. A rollup
    (SUB-678) wires through the same card: the pickers list this database's
    relation props and the picked relation's target props. */
export default function PropForm({
  anchor,
  existing,
  databases,
  rollupRelations,
  rollupPropsFor,
  onSave,
  onClose,
}: {
  anchor: AnchorRect;
  /** prop keys already on this database — the collision guard */
  existing: string[];
  /** database types the relation target picker offers */
  databases: string[];
  /** relation props of this database a rollup can follow (SUB-678) */
  rollupRelations?: string[];
  /** the props of a relation's target database (SUB-678) */
  rollupPropsFor?: (relation: string) => string[];
  onSave: (
    name: string,
    opts: SelectOption[],
    kind: PropKind | null,
    notify?: boolean,
    target?: string,
    format?: NumberFormat,
    description?: string,
    rollup?: RollupConfig | null
  ) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const clash =
    trimmed !== "" && existing.some((k) => k.toLowerCase() === trimmed.toLowerCase());

  return (
    <SelectMenu
      anchor={anchor}
      value=""
      options={[]}
      used={[]}
      canEditSchema
      databases={databases}
      startEditing
      editTitle="New property"
      heading={
        <div className="dbprop-head">
          <input
            className="selmenu-input dbprop-name"
            autoFocus
            placeholder="Property name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
              e.stopPropagation();
            }}
          />
          {clash && <div className="selmenu-hint dbprop-err">“{trimmed}” already exists</div>}
        </div>
      }
      saveDisabled={!trimmed || clash}
      onCommit={() => undefined}
      rollupRelations={rollupRelations}
      rollupPropsFor={rollupPropsFor}
      onSaveSchema={(o, k, n, t, f, d, r) => onSave(trimmed, o, k, n, t, f, d, r)}
      onClose={onClose}
    />
  );
}
