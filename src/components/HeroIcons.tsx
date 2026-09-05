/* Purpose-drawn hero marks for the app's empty states. They are the only icons
   in the app drawn for hero scale rather than borrowed from chrome.

   Why they exist: the shared glyph set (Icons.tsx) fixes strokeWidth 1.4 in a
   16 viewBox, and the empty state's glyph slot is 44 — a 2.75× blowup that
   would render the stroke at 3.85px against ~1.31px everywhere else in chrome,
   so the heaviest ink in the app sat exactly where a designed hero belongs.
   These marks are drawn at their own size instead of scaled up to it: a 48
   viewBox rendered at 44px (scale 0.917), strokeWidth 1.5 → 1.375px apparent,
   inside the 1.3–1.5px band the 15px chrome glyphs occupy. Every `.empty`
   glyph is one of these now, so no borrowed glyph needs its stroke compensated
   down to reach that band.

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

/** The same lit face for a silhouette that is not a rectangle — the slab
    language applied to a cylinder, a folder, a pin. Same two opacities. */
function Face({ id, d }: { id: string; d: string }) {
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <path d={d} fill={`url(#${id})`} stroke="none" />
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

/** Agent ledger, nothing to show: the written page with the eye that reads it
    resting on its corner — the ledger's own chrome shape at hero scale. */
export const HeroLedger = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-ledger" x={9} y={5} w={24} h={32} r={4} />
    <path d="M15 15h12" />
    <path d="M15 22h8" opacity="0.6" />
    <path d="M25 33s3.5-5.4 8.8-5.4S42.5 33 42.5 33s-3.5 5.4-8.7 5.4S25 33 25 33Z" />
    <circle cx="33.8" cy="33" r="2.2" opacity="0.62" />
  </svg>
);

/** Assets, nothing orphaned: the picture plate — a lit frame with a horizon
    drawn across it and the disc above. */
export const HeroAssets = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-assets" x={6} y={9} w={36} h={30} r={5} />
    <circle cx="17" cy="19" r="3.2" opacity="0.62" />
    <path d="m9 34.5 9-9 5.5 5.5 7-7 8 8" />
  </svg>
);

/** No matches for a filter: the funnel cut through the slab, holding nothing
    at its stem. */
export const HeroFilter = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-filter" x={7} y={8} w={34} h={32} r={5} />
    <path d="M14 16h20l-7.5 9v9.4l-5 2.4V25L14 16Z" />
  </svg>
);

/** A database with no rows, and the manager with no databases: the cylinder,
    its bands trailing off the way the notes list's rules do. */
export const HeroDatabase = () => (
  <svg {...hero} aria-hidden="true">
    <Face id="hero-database" d="M11 12v24c0 2.8 5.8 5 13 5s13-2.2 13-5V12Z" />
    <ellipse cx="24" cy="12" rx="13" ry="5" />
    <path d="M11 12v24c0 2.8 5.8 5 13 5s13-2.2 13-5V12" />
    <path d="M11 22c0 2.8 5.8 5 13 5s13-2.2 13-5" opacity="0.6" />
    <path d="M11 29c0 2.8 5.8 5 13 5s13-2.2 13-5" opacity="0.3" />
  </svg>
);

/** Board view with nothing to group by: three lanes stood up and empty. */
export const HeroBoard = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-board-a" x={6} y={9} w={10.5} h={30} r={3} />
    <SlabFace id="hero-board-b" x={18.75} y={9} w={10.5} h={21} r={3} />
    <SlabFace id="hero-board-c" x={31.5} y={9} w={10.5} h={25.5} r={3} />
  </svg>
);

/** Doctor, scanning or clean: the trace running clean across the slab. */
export const HeroDoctor = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-doctor" x={5} y={11} w={38} h={26} r={5} />
    <path d="M10 24h6l4-9 6.5 18.5L31 24h7" />
  </svg>
);

/** Mounted folder not found: the folder standing on its mount, with nothing
    inside the seam. */
export const HeroMount = () => (
  <svg {...hero} aria-hidden="true">
    <Face
      id="hero-mount"
      d="M6 11a3.5 3.5 0 0 1 3.5-3.5h6.6l3.6 4.3H38.5A3.5 3.5 0 0 1 42 15.3V29a3.5 3.5 0 0 1-3.5 3.5h-29A3.5 3.5 0 0 1 6 29Z"
    />
    <path d="M6 11a3.5 3.5 0 0 1 3.5-3.5h6.6l3.6 4.3H38.5A3.5 3.5 0 0 1 42 15.3V29a3.5 3.5 0 0 1-3.5 3.5h-29A3.5 3.5 0 0 1 6 29Z" />
    <path d="M14 24h20" opacity="0.45" />
    <path d="M24 32.5V42" opacity="0.62" />
    <path d="M16 42h16" />
  </svg>
);

/** Saved view not found: the pin with nothing under it. */
export const HeroPin = () => (
  <svg {...hero} aria-hidden="true">
    <Face id="hero-pin" d="M24 5a12 12 0 0 1 12 12c0 8.6-12 24-12 24S12 25.6 12 17A12 12 0 0 1 24 5Z" />
    <path d="M24 5a12 12 0 0 1 12 12c0 8.6-12 24-12 24S12 25.6 12 17A12 12 0 0 1 24 5Z" />
    <circle cx="24" cy="17" r="4.2" opacity="0.62" />
  </svg>
);

/** The note's file is gone: the page slab drawn as a ghost of itself — same
    silhouette as the notes mark, held at the opacity the trailing rules use. */
export const HeroMissing = () => (
  <svg {...hero} aria-hidden="true">
    <Face id="hero-missing" d="M28 5H16.5a2 2 0 0 0-2 2v34a2 2 0 0 0 2 2H32a2 2 0 0 0 2-2V11Z" />
    <path d="M28 5H16.5a2 2 0 0 0-2 2v34a2 2 0 0 0 2 2H32a2 2 0 0 0 2-2V11Z" opacity="0.5" />
    <path d="M28 5v6h6" opacity="0.5" />
    <path d="M20 20h9" opacity="0.3" />
    <path d="M20 27h6" opacity="0.16" />
  </svg>
);

/** Sheet with no data block: the grid ruled out and waiting. */
export const HeroSheet = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-sheet" x={5} y={9} w={38} h={30} r={4} />
    <path d="M5 18h38" />
    <path d="M18 18v21" opacity="0.6" />
    <path d="M24 27h19" opacity="0.35" />
    <path d="M24 33h19" opacity="0.2" />
  </svg>
);

/** The heavy-binary folder, empty or absent: a document slab with two more
    stacked behind it — a pile of files rather than one file, and deliberately
    not the attachments mark, whose picture read would name a third of what
    goes in here. */
export const HeroFiles = () => (
  <svg {...hero} aria-hidden="true">
    <path d="M17 9h14" opacity="0.3" />
    <path d="M14 12h20" opacity="0.5" />
    <SlabFace id="hero-files" x={11} y={15} w={26} h={28} r={4} />
    <path d="M17 27h14" opacity="0.6" />
    <path d="M17 33h9" opacity="0.35" />
  </svg>
);

/** Shelf, nothing cataloged: the drive resting on its shelf line. */
export const HeroDrive = () => (
  <svg {...hero} aria-hidden="true">
    <SlabFace id="hero-drive" x={5} y={13} w={38} h={13} r={3.5} />
    <path d="M11.5 19.5h.01" />
    <path d="M9 34h30" opacity="0.55" />
  </svg>
);

/** Nothing on today: the day itself, open and unmarked. */
export const HeroToday = () => (
  <svg {...hero} aria-hidden="true">
    <Face id="hero-today" d="M24 15.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Z" />
    <circle cx="24" cy="24" r="8.5" />
    <path d="M24 4v5.5M24 38.5V44M4 24h5.5M38.5 24H44" />
    <path d="m10.2 10.2 3.9 3.9M33.9 33.9l3.9 3.9M37.8 10.2l-3.9 3.9M14.1 33.9l-3.9 3.9" opacity="0.62" />
  </svg>
);
