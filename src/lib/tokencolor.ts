/** Read a colour token as a literal that a foreign colour parser accepts.

    A custom property computes to its authored token stream, not to a colour.
    The tone family is arithmetic, so reading `--accent-soft` off the document
    element hands back `hsl(calc((200.6 + 0) * 1deg) 77.1% 67.5% / 0.22)`. The
    app's own CSS substitutes that happily. Anything that parses colour for
    itself does not: xterm's theme matches hex/rgb(a) and otherwise falls back
    to a canvas probe whose behaviour is engine-dependent, and on failure it
    silently keeps its own default — the HUD's selection wash quietly stops
    matching the app. A stylesheet baked into an exported document has the same
    problem from the other side: the recipient's browser never sees the tone
    table, so a token reference there resolves to nothing at all.

    So resolve it the way the print specs do (`e2e/dashprint.spec.ts` explains
    the same trick from the test side): hang the token on a real colour
    declaration on a throwaway element and read back what the engine computed,
    which is always an `rgb()` / `rgba()` literal.

    `fallback` covers the case where there is nothing to read — no document, an
    undeclared token, or a stylesheet that never loaded. It is a plain neutral
    on purpose: a fallback that names one tone's colour would be a second
    accent family hiding in the code, wrong for the other three tones and
    invisible until someone read it. */
export function resolveTokenColor(name: string, fallback: string, doc?: Document): string {
  const d = doc ?? (typeof document === "undefined" ? null : document);
  const view = d?.defaultView;
  if (!d?.body || !view) return fallback;
  const probe = d.createElement("span");
  probe.style.cssText =
    "position:fixed;top:-9999px;left:-9999px;width:0;height:0;pointer-events:none";
  probe.style.backgroundColor = `var(${name})`;
  d.body.appendChild(probe);
  const painted = view.getComputedStyle(probe).backgroundColor;
  probe.remove();
  // Only an rgb()/rgba() literal counts as an answer, which is what every
  // engine computes a background colour to. Anything else means the token had
  // nothing behind it: the property sat at its initial fully-transparent
  // value, or the reference was handed back verbatim, and passing either on
  // would be the silent failure this helper exists to end.
  return /^rgba?\(/.test(painted) && painted !== "rgba(0, 0, 0, 0)" ? painted : fallback;
}
