// Kind fences: a ```kind fence inside a hub or workbook page mounts a
// vault-resident custom kind (vault-format §5.8) as one block, the way a
// ```chart fence mounts a chart:
//
//   ```kind gear-log
//   room: studio        # optional config, handed to the kind as ctx.config
//   limit: 5
//   ```
//
// The first word of the info string is the kind id — the same id the folder
// under `.vault/kinds/` is named and a note's `dashboard:` prop spells. The
// body is optional `key: value` text, hand-editable and portable like every
// other fence's config, with one difference that is the whole point: the app
// does not interpret a single key. It hands the map to the kind, so the
// vocabulary belongs to the kind's author and this parser never has to grow a
// key table. That is what keeps the grammar future-proof — a kind adding a
// knob is a change to the kind, not to Substrate.
//
// Consent is NOT decided here. Whether the named kind may run is the same
// per-vault, per-device record that gates a full-note custom kind, resolved
// by `kindpane.ts` from the bundle list; this module only says which kind the
// fence asked for. Keeping the two apart is why a fence cannot become a
// second door into the same code.
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import { KIND_ID_RE } from "./kinds.ts";

/** One parsed ```kind fence: an id plus the kind's own config, or the
    sentence the block shows in place. Same either/or the calendar and chart
    fences use — a fence that cannot be read says why where it was written. */
export interface KindFenceBlock {
  /** the kind id the fence named, or null when the fence could not be read */
  id: string | null;
  /** the config lines, verbatim, for `ctx.config`. Empty when none were written. */
  config: Record<string, string>;
  error: string | null;
}

function fail(error: string): KindFenceBlock {
  return { id: null, config: {}, error };
}

/** Parse a ```kind fence.

    `tail` is the info string after the lang word (` gear-log`), `inner` the
    fence body without its opener and closer. Both arrive exactly as the hub's
    block scanner cut them. */
export function parseKindFence(tail: string, inner: string): KindFenceBlock {
  const words = tail.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0)
    return fail(
      "this kind fence names no kind — write ```kind <id>, the folder name under .vault/kinds/",
    );
  if (words.length > 1)
    return fail(
      `a kind fence names one kind, not ${words.length} — write \`\`\`kind ${words[0]}`,
    );
  const id = words[0];
  /* The same grammar the folder name, the `dashboard:` value and the
     `substrate-kind:` URL segment all answer to. Checked here rather than
     left to the bundle lookup so a typo reads as a typo instead of as "no
     such kind installed" — the two are different problems. */
  if (!KIND_ID_RE.test(id))
    return fail(
      `“${id}” is not a kind id — lowercase letters, digits and dashes, starting with a letter or digit, up to 40 characters`,
    );

  /* Null-prototype while filling, so a config key spelled `__proto__` is an
     ordinary key rather than a write to the object's prototype. The spread on
     the way out defines own properties, so the map the kind receives is a
     plain object that still carries the key it was given. */
  const config: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const raw of inner.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at <= 0)
      return fail(
        `kind fence config is key: value lines — could not read “${line}”`,
      );
    const key = line.slice(0, at).trim();
    if (key === "")
      return fail(
        `kind fence config is key: value lines — could not read “${line}”`,
      );
    /* Last-wins would make which value the kind sees depend on line order
       nobody thought about, and a repeated key is nearly always a mistake in
       a block short enough to read at a glance. */
    if (Object.prototype.hasOwnProperty.call(config, key))
      return fail(`kind fence config sets “${key}” twice — keep one`);
    config[key] = line.slice(at + 1).trim();
  }
  return { id, config: { ...config }, error: null };
}
