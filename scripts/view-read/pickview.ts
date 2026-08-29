/** Picking the pin a name stands for, and the error a caller asked wrong.
 *
 *  Its own file because two callers share it and only one of them is a shell.
 *  The verb next door has a main block; so does the engine the MCP door runs.
 *  Bundling the engine pulls in whatever it imports, and a second main block
 *  in that bundle would fire on the same argv and answer over the top of it —
 *  so what both need lives where neither runs.
 */
import type { SavedView } from "../../src/lib/types.ts";

/** A caller asked wrong, as opposed to a vault that could not be read. */
export class UsageError extends Error {}

/** The pin a name stands for. Names are matched case-insensitively, the way
    the app matches them when saving over an existing pin; a name carried by
    two databases is an error rather than a guess, and `--db` settles it. */
export function pickView(
  views: SavedView[],
  name: string,
  db: string | null,
  // A shell caller who mistypes a pin name is holding the vault already, so
  // the fastest fix is the list of pins it does have. A caller at the MCP
  // door is not: its grants reach folders, and every pin name in this vault —
  // including the ones over databases it was never given — would be a set of
  // names it cannot otherwise see. So naming them is the caller's to ask for.
  opts: { nameKnown?: boolean } = {}
): SavedView {
  const wanted = name.trim().toLowerCase();
  const byId = views.filter((v) => v.id === name);
  const hits = byId.length > 0 ? byId : views.filter((v) => v.name.trim().toLowerCase() === wanted);
  const scoped = db === null ? hits : hits.filter((v) => v.db.toLowerCase() === db.toLowerCase());
  if (scoped.length === 0) {
    if (opts.nameKnown === false) throw new UsageError(`no saved view named ${name}`);
    const known = views.map((v) => `  ${v.name}  (${v.db})`).join("\n");
    throw new UsageError(
      known === "" ? `no saved view named ${name} — this vault has none` : `no saved view named ${name}. This vault has:\n${known}`
    );
  }
  if (scoped.length > 1) {
    const dbs = scoped.map((v) => v.db).join(", ");
    throw new UsageError(`${name} names a view in more than one database (${dbs}) — pass --db`);
  }
  return scoped[0];
}
