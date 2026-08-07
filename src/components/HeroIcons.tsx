/* Purpose-drawn hero marks for the four big empty states — the notes list, the
   note pane, search, and trash. They are the only icons in the app drawn for
   hero scale rather than borrowed from chrome.

   Why they exist: the shared glyph set (Icons.tsx) fixes strokeWidth 1.4 in a
   16 viewBox, and `.empty > svg` scales those to 30px — a 1.875× blowup that
   renders the stroke at 2.63px against ~1.31px everywhere else in chrome, so
   the heaviest ink in the app sat exactly where a designed hero belongs. These
   marks are drawn at their own size instead of scaled up to it: a 48 viewBox
   rendered at 44px (scale 0.917), strokeWidth 1.5 → 1.375px apparent, inside
   the 1.3–1.5px band the 15px chrome glyphs occupy.

   Greyscale only: every mark inks in `currentColor`, which `.empty > svg`
   binds to --text-3. Faces and lit edges are the SAME ink at reduced opacity,
   never a second grey — the token table stays the only place a grey is
   chosen. */

const hero = {
  width: 44,
  height: 44,
  viewBox: "0 0 48 48",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: "hero-mark",
};

/** the app icon's language at glyph scale: a lit slab face with the state's
    own shape cut through it. The face gradient is currentColor at two
    opacities — the "lit, dimensional" read without a second grey. Gradient
    ids are per-mark because several marks can share a document. */
function SlabFace({ id, x, y, w, h, r }: { id: string; x: number; y: number; w: number; h: number; r: number }) {
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <rect x={x} y={y} width={w} height={h} rx={r} fill={`url(#${id})`} stroke="none" />
      <rect x={x} y={y} width={w} height={h} rx={r} />
    </>
  );
}

/** Notes list, empty: the page slab with its ruled cuts trailing off — written
    lines that stop rather than an absence of a page. */
export const HeroNotes = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-notes" x={12} y={5} w={24} h={38} r={4} />
    <path d="M18 17h12" />
    <path d="M18 24h9" opacity="0.6" />
    <path d="M18 31h5" opacity="0.3" />
  </svg>
);

/** Search, no results: an aperture cut clean through the slab — you can see
    past it, and there is nothing behind. */
export const HeroSearch = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-search" x={6} y={8} w={36} h={32} r={5} />
    <circle cx="21" cy="22" r="8" />
    <path d="m27 28 6.5 6.5" />
    <path d="M16.6 17.6a6 6 0 0 1 4-2.2" opacity="0.45" />
  </svg>
);

/** Trash, empty: the well with its lid seam and nothing resting in it. */
export const HeroTrash = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-trash" x={10} y={14} w={28} h={28} r={4} />
    <path d="M7 13h34" />
    <path d="M19 9h10" />
    <path d="M18 22v12" opacity="0.5" />
    <path d="M24 22v12" opacity="0.5" />
    <path d="M30 22v12" opacity="0.5" />
  </svg>
);

/** No note selected: the monolith itself — the app's own rooted-asterisk cut
    through a closed slab, nothing open on top of it. */
export const HeroNote = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-note" x={13} y={4} w={22} h={40} r={6} />
    <path d="M24 13v10" />
    <path d="m18.4 15.2 11.2 6.6" opacity="0.62" />
    <path d="m29.6 15.2-11.2 6.6" opacity="0.62" />
    <path d="M16 26h16" />
    <path d="M24 26v8" opacity="0.62" />
  </svg>
);
