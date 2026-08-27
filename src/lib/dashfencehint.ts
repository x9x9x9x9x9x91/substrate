import { FENCE_REGISTRY } from "./fenceRegistry.ts";
import { isTailedBareFence } from "./fences.ts";

/* A ```chart or ```heatmap block only draws where a dashboard renders it. Pasted
   into an ordinary note it used to sit there as a code box saying nothing — the
   config was plainly written, the picture never arrived, and nothing on screen
   said which of the two had gone wrong. That is the silent-wrong-answer shape
   the boards' own empty/failed split exists to refuse, so the note says it too:
   one quiet line under the block, in the calm voice (a dot and a sentence), not
   the banner — nothing is broken here, the block is simply somewhere it does
   not draw.

   The nouns come from the fence registry, where each is the word
   docs/dashboards.md uses for its fence, so the hint and the documentation
   name the same thing. A registry entry with no noun gets no hint. */
const DASH_ONLY_FENCE_NOUNS: ReadonlyMap<string, string> = new Map(
  FENCE_REGISTRY.filter((f) => f.noun !== null).map((f) => [f.id, f.noun as string])
);

/** The line a fence gets when it is written somewhere it will not draw, or
    null when the block belongs where it is.

    `view` deliberately carries no noun: a ```view embed renders in an
    ordinary note already, so a hint under one would be a lie. Neither do
    ```csv and ```formulas,
    which are a sheet's own content rather than a dashboard's. Everything else
    is prose to every reader in the app and gets no hint at all — a ```sh block
    is a code box on purpose.

    A TAILED opener of a bare-form language (```calendar month) never draws
    anywhere, dashboard included: its parser reads the bare form only, so the
    block is someone's prose and telling them to move it would send them
    somewhere it still would not draw. `fences.ts` owns that rule; this asks it
    rather than restating it. */
export function dashFenceHint(lang: string, tail: string): string | null {
  const noun = DASH_ONLY_FENCE_NOUNS.get(lang.trim().toLowerCase());
  if (!noun) return null;
  if (isTailedBareFence(lang, tail)) return null;
  return `${noun} draws on a dashboard note — here it stays as text.`;
}
