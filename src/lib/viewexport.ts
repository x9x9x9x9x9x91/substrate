import { save } from "@tauri-apps/plugin-dialog";
import type { NoteMeta, PropSchema, SavedView, ViewExportReport } from "./types.ts";
import { foldedPropStr } from "./types.ts";
import { filterByQuery } from "./views.ts";
import { rollupColumns, rollupProps, withRollups } from "./rollup.ts";
import { isTauri } from "./tauri.ts";
import { viewExportRun, viewExportTarget } from "./ipc.ts";

/** The rows a saved view stands for, without opening it: its
    database's notes narrowed by its own stored query. The pane derives the
    same set — it just starts from `initialQuery` — so an export from the tab
    strip's menu matches what opening the pin would show. Layout, grouping and
    column choices are display-only and can't change membership.

    Rollup columns are derived first, for the same reason the pane
    filters over `dispNotes`: a pin whose query reads a rollup column would
    otherwise match nothing here and export a folder that doesn't match the
    view on screen. Derivation is skipped entirely when the type declares no
    rollup. */
export function savedViewRows(
  notes: NoteMeta[],
  view: SavedView,
  typeSchema?: Record<string, PropSchema>
): NoteMeta[] {
  const db = view.db.toLowerCase();
  const typed = notes.filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === db);
  const schema = typeSchema ?? {};
  const rolled = rollupColumns(typed, schema, notes);
  const rows = rolled ? withRollups(typed, rolled, Object.keys(rollupProps(schema))) : typed;
  return filterByQuery(rows, view.query ?? "", undefined, typeSchema);
}

/** The default folder name offered the first time a view is exported. Kept
    filesystem-safe: a pin may be named "Mixdowns / Q3" and a slash there
    would silently export into a subfolder nobody asked for. */
export function exportFolderName(viewName: string): string {
  const cleaned = viewName.replace(/[/\\:]/g, "-").replace(/\s+/g, " ").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "Substrate view" : cleaned;
}

/** One line of plain English for the toast after an export. */
export function exportSummary(report: ViewExportReport): string {
  const links = `${report.links} ${report.links === 1 ? "link" : "links"}`;
  const parts = [`${links} in ${report.dest.split("/").pop() ?? report.dest}`];
  if (report.missing > 0) parts.push(`${report.missing} row${report.missing === 1 ? "" : "s"} skipped`);
  if (report.kept > 0)
    parts.push(`${report.kept} file${report.kept === 1 ? "" : "s"} of your own left alone`);
  return parts.join(" · ");
}

/** Export or regenerate a saved view's link folder.
 *
 *  `reask` forces the location question even when a target is remembered —
 *  the "Export to a new location…" lane. Otherwise the first export asks
 *  where, and every later Regenerate silently reuses that answer, which is
 *  the whole point of remembering it.
 *
 *  Returns null when the user dismissed the dialog. Errors (a folder that
 *  isn't ours, a write that failed) come back as rejections for the caller's
 *  toast — refusing to clobber a real folder is a message worth showing.
 */
export async function exportSavedView(
  view: SavedView,
  rows: NoteMeta[],
  reask = false
): Promise<ViewExportReport | null> {
  let dest = reask ? null : await viewExportTarget(view.id);
  if (!dest) {
    if (!isTauri) throw new Error("Link folders need the desktop app");
    dest = await save({
      defaultPath: exportFolderName(view.name),
      title: `Export "${view.name}" as a link folder`,
    });
    if (!dest) return null;
  }
  return viewExportRun(
    view.id,
    view.name,
    dest,
    rows.map((n) => n.path)
  );
}
