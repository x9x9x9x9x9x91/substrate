/** The bundled dashboard cookbook — the shape of `cookbook/index.json`
    and a defensive parse of it.

    The index ships inside the app, so it is not hostile input; it is still
    parsed rather than cast, because a build that staged a stale or truncated
    index should render the recipes it can and drop the rest, not blank the
    pane on one bad field. `scripts/cookbook.test.ts` is what actually holds
    the file to this shape in CI. */

export interface CookbookRecipe {
  id: string;
  title: string;
  /** the dashboard kind the recipe demonstrates — rendered as a chip */
  kind: string;
  blurb: string;
  /** how to point the sample data at your own */
  adapt: string;
  expects: { sheets: string[]; databases: string[] };
  /** vault-relative paths the install writes, in order */
  files: string[];
  /** cookbook-relative screenshot path, e.g. `shots/food-log.png` */
  shot: string;
}

export interface Cookbook {
  about: string;
  recipes: CookbookRecipe[];
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function parseRecipe(raw: unknown): CookbookRecipe | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  const files = strArray(r.files);
  // an entry with no id or nothing to install is not installable — drop it
  // rather than render a button that would error on click
  if (!str("id") || !str("title") || files.length === 0) return null;
  const expects = (r.expects ?? {}) as Record<string, unknown>;
  return {
    id: str("id"),
    title: str("title"),
    kind: str("kind"),
    blurb: str("blurb"),
    adapt: str("adapt"),
    expects: { sheets: strArray(expects.sheets), databases: strArray(expects.databases) },
    files,
    shot: str("shot"),
  };
}

export function parseCookbook(json: string): Cookbook {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const recipes = Array.isArray(raw.recipes) ? raw.recipes : [];
  return {
    about: typeof raw.about === "string" ? raw.about : "",
    recipes: recipes.map(parseRecipe).filter((r): r is CookbookRecipe => r !== null),
  };
}

/** What a recipe binds to, as one line — "expects: 2 sheets · release" reads
    as noise, so the names themselves are listed. Empty on a recipe that binds
    to nothing, which is most of the self-contained ones. */
export function expectsLine(r: CookbookRecipe): string {
  const parts: string[] = [];
  if (r.expects.sheets.length > 0) parts.push(`sheets ${r.expects.sheets.join(", ")}`);
  if (r.expects.databases.length > 0) parts.push(`type ${r.expects.databases.join(", ")}`);
  return parts.join(" · ");
}
