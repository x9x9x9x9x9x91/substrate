import DateMenu from "./DateMenu";
import FileMenu from "./FileMenu";
import RelationMenu from "./RelationMenu";
import SelectMenu, { type AnchorRect } from "./SelectMenu";
import type { CellModel } from "../lib/cellmodel";
import type { RelationCandidate } from "../lib/relation";
import { toggleValue } from "../lib/relation";

interface CellEditorProps {
  /** the cell's box on screen — every menu portals to the document and pins
      itself here, so a clipped container (the embed table's `overflow:hidden`
      cells) never truncates the picker */
  anchor: AnchorRect;
  /** the column being edited, as the table labels it */
  column: string;
  cell: CellModel;
  /** values already in use across the type — the picker's bootstrap list */
  used: string[];
  /** entries of a relation column's target database */
  candidates: RelationCandidate[];
  /** does the file value exist on disk? null while unknown/not a file cell */
  fileExists?: boolean | null;
  /** scalar commit: typed text, a picked option, or null to clear */
  onCommit: (value: string | null) => void;
  /** list commit (multi/relation): the menu stays open, the parent writes */
  onCommitList: (values: string[]) => void;
  /** create a new entry of a relation column's target type, then link it */
  onCreateRelation?: (title: string) => void;
  onClose: () => void;
}

/** The picker a cell edit opens, chosen by kind (SUB-796). The database table
    grew this cascade first; the inline ```view widget mounts the same one, so
    a select cell inside a note behaves exactly like the same cell in the pane.
    Schema editing is deliberately absent here — an inline table is a view of a
    database, not the place to redefine it, so `canEditSchema` is false and no
    "edit property" row is offered. */
export default function CellEditor({
  anchor,
  column,
  cell,
  used,
  candidates,
  fileExists = null,
  onCommit,
  onCommitList,
  onCreateRelation,
  onClose,
}: CellEditorProps) {
  const { val, schema, kind, list } = cell;
  if (kind === "relation" && schema?.type) {
    return (
      <RelationMenu
        anchor={anchor}
        values={list}
        candidates={candidates}
        targetType={schema.type}
        onCommit={onCommitList}
        onCreate={(t) => onCreateRelation?.(t)}
        onClear={() => onCommit(null)}
        onClose={onClose}
      />
    );
  }
  if (kind === "date") {
    return (
      <DateMenu
        anchor={anchor}
        value={val}
        onCommit={onCommit}
        onClear={() => onCommit(null)}
        onClose={onClose}
      />
    );
  }
  if (kind === "file") {
    return (
      <FileMenu
        anchor={anchor}
        value={val}
        exists={val ? fileExists : null}
        onCommit={onCommit}
        onClear={() => onCommit(null)}
        onClose={onClose}
      />
    );
  }
  return (
    <SelectMenu
      anchor={anchor}
      value={val}
      options={schema?.options ?? []}
      used={used}
      canEditSchema={false}
      kind={kind}
      target={schema?.type}
      format={schema?.format}
      description={schema?.description}
      label={`Pick ${column}`}
      cell
      values={kind === "multi" ? list : undefined}
      onToggle={kind === "multi" ? (nv) => onCommitList(toggleValue(list, nv)) : undefined}
      onCommit={onCommit}
      onClear={() => onCommit(null)}
      // canEditSchema is false, so no row can reach this — required by the
      // shared menu's contract, never called from an inline table
      onSaveSchema={() => {}}
      onClose={onClose}
    />
  );
}
