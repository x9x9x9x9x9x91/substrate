# Two visual tiers

Screenshots in this repo do two unrelated jobs, and conflating them costs
either a broken gate or a false sense of coverage. Keep them apart.

## Tier 1 — Linux baselines: regression detection

`e2e/visualbaselines.spec.ts`, part of the ordinary `npm run e2e` gate.

Ten core surfaces — note list + editor, All notes, the database manager, a
database table, three dashboards, the calendar month grid, search results, and
the print (light-ramp) surface — are compared pixel-for-pixel against PNGs
committed under `e2e/__screenshots__/linux/`.

What it is for: catching a rendering change nothing else in the suite can see.
The other ~265 e2e specs assert structure — text, counts, classes — so a
dropped stylesheet, a colour token repointed, a pane that quietly lost its
padding all pass them. This tier fails.

What it is **not** for: judging whether a surface looks good, or how it looks
in the shipped app. These are headless Chromium on Linux. The app ships in
WKWebView on macOS with retina geometry and different font stacks — the
baselines are the wrong pixels on purpose, and that is fine, because their job
is only to answer "did this change?", never "is this right?".

### Rules

- **Baselines are Linux-only and committed.** `playwright.config.ts` keys the
  snapshot path on `{platform}`; the spec skips itself on anything but Linux
  with a named reason, so a Mac gate run stays green and never writes a second
  baseline set.
- **Updating them is a deliberate act.** A UI change that moves these pixels is
  expected to re-record on Linux (`npm run e2e -- visualbaselines
  --update-snapshots` on the Linux gate host) and commit the new PNGs *in the
  same branch as the change*, so review sees the before/after in the diff.
  Re-recording to make red go away, on a branch that did not touch rendering,
  is the one misuse that empties the tier.
- **Determinism is load-bearing.** The mock seeds date their fixtures off
  `Date.now()` at module load, so the spec installs a fixed clock and pins the
  timezone to UTC before the first navigation. Anything genuinely unstable gets
  masked, never given a wider pixel tolerance — the tolerance in the spec
  absorbs anti-aliasing drift between Linux hosts and nothing more. Playwright's
  *default* per-pixel threshold is one of those wider tolerances: at 0.2, a
  one-line edit repainting every surface in the app passed all ten shots. The
  spec pins it to 0.01, which fails that edit; don't loosen it back.
- **Mock vault only.** Like every e2e spec, these run against the handwritten
  mock backend, so the baselines contain fixture content and no real data.
- **The Linux hosts must agree on fonts.** The baselines were recorded where
  fontconfig resolves the generic sans/serif/mono families to DejaVu, which is
  what it does whenever `fonts-dejavu-core` and `fonts-dejavu-mono` are
  installed. A rig missing them silently substitutes something else — Nimbus
  from urw-base35, Noto Mono — and text metrics shift far enough to break the
  comparison. `scripts/setup-substrate-rig.sh` now installs both and asserts
  the resolution, so a freshly provisioned rig cannot land in that state
  quietly.

  The signature is specific: the same tree is green on one px host and red on
  another, on a handful of text-dense baselines (the dashboards and the print
  surface) rather than on all ten. Diagnose it by comparing the hosts, not the
  diff — `ssh <rig> 'fc-match sans; fc-match serif; fc-match monospace'` on the
  red rig and a green one. Different families there is the whole answer, and
  re-recording the baselines would be the wrong fix: it would encode one host's
  fonts and move the red to every other rig.

- **The baselines are host-sensitive.** "Linux" is not one renderer. Font
  resolution, freetype versions and the GPU stack all move the pixels, so a rig
  can fail these specs at the same tree state where another Linux rig passes.
  That is host divergence, not a regression, and the red it produces is about
  the machine rather than the branch. The quarantine below exists for exactly
  that case.

### Quarantining a host from the `e2e` leg

`scripts/verify-gates-remote.sh` can remove named rigs from any gate set that
contains `e2e`, before they are probed, the same way it removes a Linux rig from
a set containing `ios`.

- **Default: empty.** `VISUAL_MISMATCH_RIGS_DEFAULT=""` — no host is presumed to
  diverge, and nothing is struck until someone says so.
- **Knob:** `SUBSTRATE_VISUAL_MISMATCH_RIGS="rig-a rig-b"`, a space-separated
  rig list, set fleet-wide (in the environment every gate caller inherits).
- **Scope:** only sets containing `e2e`. A struck rig stays a full host for
  `tsc`, `test`, `cargo`, `lint` (and `ios` where its class allows), so
  quarantining one costs the fleet only its visual-tier capacity.
- **Never silent:** the skip prints the rig and the reason on stderr; a
  deliberate `--rig` pin at a struck rig for an `e2e` set is refused with the
  reason and exit 2, rather than run into a red the branch did not earn.
- **`--split`:** the half that carries `e2e` respects the strike; the other half
  does not, so a struck rig still takes the static/unit work.

**Operator playbook.** The moment a host disagrees with the committed baselines
at a tree state where another host passes:

1. Set `SUBSTRATE_VISUAL_MISMATCH_RIGS="<rig>"` fleet-wide. Only that host's
   `e2e` leg is quarantined; it keeps serving every other gate, and branch gates
   stop producing false reds while you work.
2. Root-cause it on the host — fonts installed, renderer versions, container
   image — not in this repo. A host that diverges is a host problem.
3. Lift the quarantine when the failing specs pass there: check out pristine
   `main` on that rig, run `npm run e2e -- visualbaselines` against the
   committed `e2e/__screenshots__/linux/` PNGs, and when they are green remove
   the rig from the variable.

Do **not** re-record the baselines on a diverging host to make the red go away —
that just moves the divergence onto every other host in the fleet.

*Origin: built 2026-08-19 when a px-fleet host diverged through font resolution;
that host was fixed, so the default ships empty and the mechanism waits for the
next one.*

## Tier 2 — Mac captures: proof a human looks at

Ad-hoc, never committed as baselines. This is the `SHOTS=1` family of specs
(`e2e/*shots.spec.ts`) writing evidence images, plus screenshots taken from the
real app, plus live walkthroughs.

Two jobs:

1. **Owner-facing pixel proofs.** Anything shown to judge a design decision has
   to be the pixels the product actually renders — macOS, retina, WKWebView or
   at least a Mac browser. A Linux capture is proof of the wrong pixels.
2. **The visual self-check.** AGENTS.md requires a branch that changes rendered
   UI to be looked at, before and after, by whoever changed it. Headless
   captures satisfy the correctness half of that; the judgment half is a person
   looking.

Tier 2 never gates. It has no baselines, no comparison and no pass/fail — it
produces images someone reads.

## Which one do I need?

- *"Did I break the rendering somewhere I wasn't looking?"* → tier 1. It is
  already running in your gate.
- *"Does this new pane look right / is this the layout we want?"* → tier 2, on
  a Mac.
- *"I changed the UI on purpose."* → both: re-record tier 1 on Linux and commit
  the PNGs with the change, and take tier 2 shots for the review.
