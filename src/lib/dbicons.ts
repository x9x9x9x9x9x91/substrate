import type { DbIcon, PropSchema, SchemaConfig } from "./types.ts";
import { byFoldedKey } from "./schemalookup.ts";

/** Reserved key inside a type's `.vault/schema.json` entry holding the
    database's icon (SUB-27). Prop names are user data; this one is reserved. */
export const ICON_KEY = "icon";

/** Curated outline glyph set for database icons — no network fetch, no icon
    dependency. Geometry is hand-adapted from Lucide (ISC-licensed) to the
    app's own icon conventions (16×16 viewBox, strokeWidth 1.4, round
    caps/joins — see src/components/Icons.tsx). Values are SVG path `d`
    strings, rendered stroked-only. Keep the set modest. */
export const GLYPHS: Record<string, readonly string[]> = {
  music: ["M6 12V3.5l8-1.5v8.5", "M4 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M12 12.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"],
  mic: [
    "M8 1.3a2 2 0 0 0-2 2V8a2 2 0 0 0 4 0V3.3a2 2 0 0 0-2-2Z",
    "M12.7 6.7V8a4.7 4.7 0 0 1-9.4 0V6.7",
    "M8 12.7v2",
  ],
  disc: ["M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z", "M8 9.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z"],
  sliders: ["M3 2v12", "M1.2 9.5h3.6", "M8 2v12", "M6.2 5.5h3.6", "M13 2v12", "M11.2 11.5h3.6"],
  wrench: [
    "M9.8 4.2a.7.7 0 0 0 0 .9l1 1a.7.7 0 0 0 1 0l2.5-2.5a4 4 0 0 1-5.3 5.3l-4.6 4.6a1.4 1.4 0 0 1-2-2l4.6-4.6a4 4 0 0 1 5.3-5.3L9.8 4.2Z",
  ],
  "check-square": ["m5.5 8.5 2 2 4.5-4.5", "M13.5 2h-10A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V8"],
  calendar: [
    "M2.5 5A1.5 1.5 0 0 1 4 3.5h8A1.5 1.5 0 0 1 13.5 5v7.5A1.5 1.5 0 0 1 12 14H4a1.5 1.5 0 0 1-1.5-1.5V5Z",
    "M2.5 6.5h11",
    "M5.5 2v3",
    "M10.5 2v3",
  ],
  cart: [
    "M1.4 1.4h1.3l1.8 8.3a1.3 1.3 0 0 0 1.3 1h6.5a1.3 1.3 0 0 0 1.3-1l1.1-5H3.4",
    "M6 14.1a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6Z",
    "M13.3 14.1a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6Z",
  ],
  book: [
    "M1.3 2h4A2.7 2.7 0 0 1 8 4.7V14a2 2 0 0 0-2-2H1.3V2Z",
    "M14.7 2h-4A2.7 2.7 0 0 0 8 4.7V14a2 2 0 0 1 2-2h4.7V2Z",
  ],
  bookmark: ["M12.7 14 8 11.3 3.3 14V3.3A1.3 1.3 0 0 1 4.7 2h6.6a1.3 1.3 0 0 1 1.4 1.3V14Z"],
  heart: [
    "M12.7 9.3c1-.9 2-2.1 2-3.6A3.7 3.7 0 0 0 11 2c-1.2 0-2 .3-3 1.3C7 2.3 6.2 2 5 2a3.7 3.7 0 0 0-3.7 3.7c0 1.5 1 2.7 2 3.6l4.7 4.7Z",
  ],
  star: ["M8 1.5l2 4.1 4.6.7-3.3 3.2.8 4.6L8 12l-4.1 2.1.8-4.6-3.3-3.2 4.6-.7L8 1.5Z"],
  home: [
    "M2 6.3 8 1.7l6 4.6v6.4a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 12.7V6.3Z",
    "M6 14V8.7h4V14",
  ],
  folder: [
    "M2.5 4A1.5 1.5 0 0 1 4 2.5h2.4l1.5 1.8H12A1.5 1.5 0 0 1 13.5 5.8V12A1.5 1.5 0 0 1 12 13.5H4A1.5 1.5 0 0 1 2.5 12V4Z",
  ],
  archive: [
    "M2.8 2h10.4a.8.8 0 0 1 .8.8v1.9a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8V2.8a.8.8 0 0 1 .8-.8Z",
    "M2.7 5.5v7A1.3 1.3 0 0 0 4 13.8h8a1.3 1.3 0 0 0 1.3-1.3v-7",
    "M6.7 8.3h2.6",
  ],
  inbox: [
    "M2.5 9.5h3l1 1.8h3l1-1.8h3",
    "M13.5 9.7V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V9.7L4.4 3.6A1.5 1.5 0 0 1 5.8 2.5h4.4a1.5 1.5 0 0 1 1.4 1.1l1.9 6.1Z",
  ],
  pen: ["M11.3 2a1.9 1.9 0 1 1 2.7 2.7L5 13.7l-3.7 1 1-3.7L11.3 2Z"],
  tag: [
    "M8.4 2.5H3.9a1.4 1.4 0 0 0-1.4 1.4v4.5l6 6a1.4 1.4 0 0 0 2 0l3.1-3.1a1.4 1.4 0 0 0 0-2l-6-6.1Z",
    "M5.6 6.2a.6.6 0 1 0 0-1.2.6.6 0 0 0 0 1.2Z",
  ],
  image: [
    "M4 3h8a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 4 3Z",
    "M6 7.7a1.1 1.1 0 1 0 0-2.2A1.1 1.1 0 0 0 6 7.7Z",
    "m3.2 11.8 3-3 2 2 2.3-2.3 2.3 2.3",
  ],
  user: ["M13 14v-1.3a2.7 2.7 0 0 0-2.7-2.7H6a2.7 2.7 0 0 0-2.7 2.7V14", "M8 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"],
  users: [
    "M10.7 14v-1.3A2.7 2.7 0 0 0 8 10H4a2.7 2.7 0 0 0-2.7 2.7V14",
    "M6 7.3a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4Z",
    "M14.7 14v-1.3a2.7 2.7 0 0 0-2-2.6",
    "M10.7 2.1a2.7 2.7 0 0 1 0 5.2",
  ],
  globe: [
    "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z",
    "M8 1.5a9.8 9.8 0 0 0 0 13 9.8 9.8 0 0 0 0-13",
    "M1.5 8h13",
  ],
  pin: ["M13.3 6.7c0 4-5.3 8-5.3 8s-5.3-4-5.3-8a5.3 5.3 0 0 1 10.6 0Z", "M8 8.7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"],
  coffee: [
    "M2 5.3h9.3v6a2.7 2.7 0 0 1-2.7 2.7H4.7A2.7 2.7 0 0 1 2 11.3V5.3Z",
    "M11.3 5.3h.7a2.7 2.7 0 1 1 0 5.4h-.7",
    "M4 1.3v1.4",
    "M6.7 1.3v1.4",
    "M9.3 1.3v1.4",
  ],
  leaf: [
    "M7.3 13.3A4.7 4.7 0 0 1 6.5 4.1C10.3 3.3 11.3 3 12.7 1.3c.7 1.3 1.3 2.8 1.3 5.4 0 3.6-3.2 6.6-6.7 6.6Z",
    "M1.3 14c0-2 1.2-3.6 3.4-4 1.6-.3 3.3-1.3 3.9-2",
  ],
  bulb: ["M10 9.3c.1-.7.5-1.1 1-1.6.7-.6 1-1.5 1-2.4a4 4 0 0 0-8 0c0 .7.1 1.5 1 2.4.5.6.9 1 1 1.6", "M6 12h4", "M6.7 14.7h2.6"],
  zap: ["M8.7 1.3 2 9.3h6l-.7 5.4L14 6.7H8l.7-5.4Z"],
  clock: ["M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z", "M8 4.6V8l2.3 1.4"],
  briefcase: [
    "M2.7 4.7h10.6a1.3 1.3 0 0 1 1.4 1.3v6.7a1.3 1.3 0 0 1-1.4 1.3H2.7a1.3 1.3 0 0 1-1.4-1.3V6a1.3 1.3 0 0 1 1.4-1.3Z",
    "M10.7 14V3.3A1.3 1.3 0 0 0 9.3 2H6.7a1.3 1.3 0 0 0-1.4 1.3V14",
  ],
  gift: [
    "M2.7 5.3h10.6a.7.7 0 0 1 .7.7v1.3a.7.7 0 0 1-.7.7H2.7a.7.7 0 0 1-.7-.7V6a.7.7 0 0 1 .7-.7Z",
    "M8 8v6",
    "M12.7 8v4.7a1.3 1.3 0 0 1-1.4 1.3H4.7a1.3 1.3 0 0 1-1.4-1.3V8",
    "M5 5.3a1.7 1.7 0 0 1 0-3.3C7.3 2 8 5.3 8 5.3s.7-3.3 3-3.3a1.7 1.7 0 0 1 0 3.3",
  ],
  camera: [
    "M9.7 2.7H6.3L4.7 4.7H2.7a1.3 1.3 0 0 0-1.4 1.3v6a1.3 1.3 0 0 0 1.4 1.3h10.6a1.3 1.3 0 0 0 1.4-1.3V6a1.3 1.3 0 0 0-1.4-1.3h-2L9.7 2.7Z",
    "M8 10.7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  ],
  code: ["m10.7 12 4-4-4-4", "m5.3 4-4 4 4 4"],
  dumbbell: ["M1.5 6.5v3", "M4 4.5v7", "M4 8h8", "M12 4.5v7", "M14.5 6.5v3"],
  wallet: [
    "M2.7 3.3h10.6A1.3 1.3 0 0 1 14.7 4.7v8a1.3 1.3 0 0 1-1.4 1.3H2.7a1.3 1.3 0 0 1-1.4-1.3v-8a1.3 1.3 0 0 1 1.4-1.4Z",
    "M9.3 7.3H14a.7.7 0 0 1 .7.7v1.3a.7.7 0 0 1-.7.7H9.3a.7.7 0 0 1-.7-.7V8a.7.7 0 0 1 .7-.7Z",
  ],
  gamepad: [
    "M4.7 4.7h6.6a3.3 3.3 0 0 1 3.4 3.3v.7a3.3 3.3 0 0 1-3.4 3.3H4.7A3.3 3.3 0 0 1 1.3 8.7V8a3.3 3.3 0 0 1 3.4-3.3Z",
    "M4.7 8h2.6",
    "M6 6.7v2.6",
    "M10.5 8a.7.7 0 1 0 0-1.4.7.7 0 0 0 0 1.4Z",
    "M12.5 10a.7.7 0 1 0 0-1.4.7.7 0 0 0 0 1.4Z",
  ],
  plane: [
    "M11.9 12.8 10.7 7.3l2.3-2.3C14 4 14.3 2.7 14 2c-.7-.3-2 0-3 1L8.7 5.3 3.2 4.1c-.3-.1-.6.1-.7.3l-.2.3c-.1.3-.1.7.2.9L6 8l-1.3 2H2.7l-.7.7 2 1.3 1.3 2 .7-.7v-2l2-1.3 2.3 3.5c.2.3.5.3.9.2l.3-.1c.3-.2.4-.5.3-.8Z",
  ],
  database: ["M8 6c-2.8 0-5-.9-5-2s2.2-2 5-2 5 .9 5 2-2.2 2-5 2Z", "M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4", "M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"],
  chart: ["M3 13.5h10", "M4.5 13.5V8.8", "M8 13.5V4.5", "M11.5 13.5V6.8"],
  shirt: [
    "M10.7 2.5a2.7 2.7 0 0 1-5.4 0L3.6 3.3a1.3 1.3 0 0 0-.9 1.5l.5 2a.9.9 0 0 0 .9.7h.6V13a1.3 1.3 0 0 0 1.3 1.3h4A1.3 1.3 0 0 0 11.3 13V7.5h.6a.9.9 0 0 0 .9-.7l.5-2a1.3 1.3 0 0 0-.9-1.5L10.7 2.5Z",
  ],
  utensils: [
    "M2 1.3v4.7c0 .7.6 1.3 1.3 1.3h2.7A1.3 1.3 0 0 0 7.3 6V1.3",
    "M4.7 1.3v13.4",
    "M14 10V1.3a3.3 3.3 0 0 0-3.3 3.3v4c0 .7.6 1.3 1.3 1.3h2Z",
    "M14 10v4.7",
  ],
  flame: [
    "M5.7 9.7A1.7 1.7 0 0 0 7.3 8c0-.9-.3-1.3-.7-2-.7-1.4-.1-2.7 1.3-4 .3 1.7 1.3 3.3 2.7 4.3 1.3 1.1 2 2.3 2 3.7a4.7 4.7 0 1 1-9.3 0c0-.8.3-1.5.7-2a1.7 1.7 0 0 0 1.7 1.7Z",
  ],
  download: [
    "M8 10V2",
    "m4.7 6.7 3.3 3.3 3.3-3.3",
    "M14 10v2.7A1.3 1.3 0 0 1 12.7 14H3.3A1.3 1.3 0 0 1 2 12.7V10",
  ],
  // matches the bottom rail's SyncIcon geometry (src/components/Icons.tsx)
  refresh: [
    "M13.5 5.5A5.5 5.5 0 0 0 4 3.8L2.5 5.5",
    "M2.5 2.5v3h3",
    "M2.5 10.5A5.5 5.5 0 0 0 12 12.2l1.5-1.7",
    "M13.5 13.5v-3h-3",
  ],
};

/** Glyph ids in picker-grid order (insertion order of GLYPHS). */
export const GLYPH_IDS: string[] = Object.keys(GLYPHS);

/** Tint names for icons — the same muted `--opt-*` vocabulary as select-option
    dots (mirrors OPTION_COLORS in src/components/SelectMenu.tsx; duplicated
    here because lib files stay JSX-free for node --test). */
export const ICON_TINTS = [
  "gray",
  "blue",
  "indigo",
  "violet",
  "pink",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
] as const;

const asMark = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;

/** The icon on one type's schema entry, validated — the wire/disk type is the
    flat prop map typed as `Record<string, PropSchema>`, and the reserved
    `icon` key rides inside it. Anything malformed reads as no icon (the
    auto-glyph fallback), never as an error. */
export function typeIcon(entry: Record<string, PropSchema> | undefined): DbIcon | undefined {
  if (!entry) return undefined;
  const raw = (entry as Record<string, unknown>)[ICON_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const glyph = asMark(o.glyph);
  const emoji = asMark(o.emoji);
  const tint = asMark(o.tint);
  if (!glyph && !emoji) return undefined;
  return {
    ...(glyph ? { glyph } : {}),
    ...(emoji ? { emoji } : {}),
    ...(tint ? { tint } : {}),
  };
}

/** Every type's icon, keyed by type name. */
export function iconsByType(schema: SchemaConfig): Record<string, DbIcon> {
  return Object.fromEntries(
    Object.entries(schema).flatMap(([type, entry]) => {
      const icon = typeIcon(entry);
      return icon ? [[type, icon] as const] : [];
    })
  );
}

/** Resolve a type's configured icon by user-authored database identity.
    Exact spelling wins; a case-only schema/note mismatch folds on miss. */
export function iconForType(
  icons: Readonly<Record<string, DbIcon>>,
  type: string
): DbIcon | undefined {
  return byFoldedKey(icons, type);
}

/* Curated default icons by type name (SUB-183): the designed mark a database
   gets when its schema sets none. Exact, lowercased names only — plurals ride
   their singular's entry, near-misses ("finance-doc") get nothing. Tints stay
   inside the muted --opt-* vocabulary and spread across hues; glyph choice
   follows the obvious noun. */
const DEFAULT_ICONS: Record<string, DbIcon> = {
  release: { glyph: "disc", tint: "violet" },
  demo: { glyph: "mic", tint: "pink" },
  plugin: { glyph: "sliders", tint: "teal" },
  contact: { glyph: "users", tint: "blue" },
  contacts: { glyph: "users", tint: "blue" },
  people: { glyph: "users", tint: "blue" },
  person: { glyph: "user", tint: "indigo" },
  shopping: { glyph: "cart", tint: "green" },
  inventory: { glyph: "archive", tint: "orange" },
  contract: { glyph: "pen", tint: "yellow" },
  watchlist: { glyph: "bookmark", tint: "red" },
  fashion: { glyph: "shirt", tint: "violet" },
  recipe: { glyph: "utensils", tint: "red" },
  recipes: { glyph: "utensils", tint: "red" },
  event: { glyph: "calendar", tint: "teal" },
  task: { glyph: "check-square", tint: "green" },
  tasks: { glyph: "check-square", tint: "green" },
  todo: { glyph: "check-square", tint: "green" },
  book: { glyph: "book", tint: "indigo" },
  books: { glyph: "book", tint: "indigo" },
  game: { glyph: "gamepad", tint: "violet" },
  games: { glyph: "gamepad", tint: "violet" },
  travel: { glyph: "plane", tint: "indigo" },
  workout: { glyph: "dumbbell", tint: "orange" },
  fitness: { glyph: "dumbbell", tint: "orange" },
  finance: { glyph: "wallet", tint: "yellow" },
  money: { glyph: "wallet", tint: "yellow" },
  idea: { glyph: "bulb", tint: "yellow" },
  ideas: { glyph: "bulb", tint: "yellow" },
  photo: { glyph: "camera", tint: "pink" },
  photos: { glyph: "camera", tint: "pink" },
  music: { glyph: "music", tint: "pink" },
  project: { glyph: "briefcase", tint: "teal" },
  projects: { glyph: "briefcase", tint: "teal" },
};

/** Curated defaults by type name (SUB-183): a schema icon always wins;
    these fire only when a database has none. */
export function defaultIcon(type: string): DbIcon | undefined {
  return DEFAULT_ICONS[type.trim().toLowerCase()];
}

/* Curated default icons by folder name (SUB-391) — the SUB-183 idea applied
   to plain folders: a distinctive mark when `$folders` sets none, so the
   tree isn't a wall of identical folder glyphs. Keyed by the folder's own
   name (last path segment), lowercased. Names not listed fall through to
   the database-name map — a folder called "Recipes" reads as recipes — and
   only then to the plain folder glyph. An explicit SUB-84 icon always wins. */
const FOLDER_ICONS: Record<string, DbIcon> = {
  inbox: { glyph: "inbox", tint: "blue" },
  archive: { glyph: "archive", tint: "gray" },
  calendar: { glyph: "calendar", tint: "teal" },
  journal: { glyph: "book", tint: "indigo" },
  docs: { glyph: "book", tint: "indigo" },
  documents: { glyph: "book", tint: "indigo" },
  downloads: { glyph: "download", tint: "blue" },
  work: { glyph: "briefcase", tint: "teal" },
  life: { glyph: "leaf", tint: "green" },
  label: { glyph: "disc", tint: "violet" },
};

/** The default mark for a folder with no explicit `$folders` icon; callers
    keep the plain folder glyph when this returns undefined. */
export function folderDefaultIcon(name: string): DbIcon | undefined {
  const k = name.trim().toLowerCase();
  return FOLDER_ICONS[k] ?? DEFAULT_ICONS[k];
}

/* Curated dashboard icons by `dashboard:` kind (SUB-391): every dashboard
   row carries its own mark instead of the shared chart glyph. Untinted —
   the sidebar section reads as one quiet gray set (2026-07-24); a
   frontmatter `icon:` can still opt into any mark. Kinds not listed (plain
   charts/metrics-fallback notes) keep the generic chart. */
const DASHBOARD_ICONS: Record<string, DbIcon> = {
  food: { glyph: "flame" },
  metrics: { glyph: "wallet" },
  "yield-apr": { glyph: "zap" },
  hub: { glyph: "home" },
  feed: { glyph: "inbox" },
  "music-work": { glyph: "folder" },
};

/** A dashboard note's icon, from its frontmatter props: an `icon:` value
    wins (a curated glyph id, else treated as an emoji), then the curated
    per-kind mark; undefined keeps the generic chart glyph. */
export function dashboardIcon(props: Record<string, unknown>): DbIcon | undefined {
  const mark = asMark(props.icon);
  if (mark) return GLYPHS[mark] ? { glyph: mark } : { emoji: mark };
  const kind = asMark(props.dashboard);
  return kind ? DASHBOARD_ICONS[kind.toLowerCase()] : undefined;
}

/** The icon a database renders with (SUB-183): the explicit schema icon when
    set, else the curated default for the type name, else undefined — callers
    fall back to the auto-letter/hash tint exactly as before. */
export function resolveIcon(type: string, icon?: DbIcon): DbIcon | undefined {
  return icon ?? defaultIcon(type);
}

/** First grapheme of a string — ZWJ sequences and flags stay whole. */
export function firstGrapheme(s: string): string {
  const t = s.trim();
  if (!t) return "";
  // Intl.Segmenter is in every supported runtime (webview, node) but not in
  // this project's TS lib — type it structurally
  const Seg = (
    Intl as {
      Segmenter?: new () => { segment(s: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (Seg) {
    const first = new Seg().segment(t)[Symbol.iterator]().next();
    if (!first.done) return first.value.segment;
  }
  return [...t][0];
}

/** The quiet default mark: first letter/digit of the type name, uppercased. */
export function autoGlyphLetter(type: string): string {
  for (const ch of type) {
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase();
  }
  return "·";
}

/** CSS color for a tint name; unknown/absent names render untinted. */
export function tintVar(tint?: string): string | undefined {
  return tint && (ICON_TINTS as readonly string[]).includes(tint)
    ? `var(--opt-${tint})`
    : undefined;
}

/** CSS color for a select option's color name (SUB-619). Option colors come
    from note frontmatter, which is free-form, so the name is checked against
    the same closed `--opt-*` roster icon tints use before it reaches CSS —
    an unknown name renders exactly like no color at all, never as an
    interpolated `var(--opt-…)` fragment. */
export const optionColorVar = tintVar;

/** Every database gets a stable identity color (SUB-73): the icon's explicit
    tint when set, else the curated default's tint (SUB-183), else a hash of
    the type name into the non-gray `--opt-*` palette — same name, same color,
    across sessions and surfaces. */
export function typeTint(type: string, icon?: DbIcon): string {
  const explicit = tintVar(resolveIcon(type, icon)?.tint);
  if (explicit) return explicit;
  const hues = ICON_TINTS.filter((t) => t !== "gray");
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return `var(--opt-${hues[h % hues.length]})`;
}
