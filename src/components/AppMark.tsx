/* The product mark, inline. Vector rendering of `design/icon.svg` — the
   backlit monolith: a rooted asterisk cut THROUGH a dark slab and lit from
   behind, with the escaping light spilling onto the slab face.

   Inline rather than an <img> to the packaged `src-tauri/icons/*.png`: those
   are rasters sized for docks and trays, and the mark is drawn here at
   48–64px where a 64px PNG is already soft on a 2x display. One ink, butt
   caps, no drop shadow — the same restraint the icon file carries.

   The viewBox is cropped to the tile (the icon file pads it to a 1024 square
   for the platform packagers), so the rendered box IS the mark: `size` is the
   slab's edge length, not a canvas the slab floats inside.

   The gradient/mask/filter ids are namespaced because SVG defs live in one
   document-wide namespace — two of these on a page with bare ids would have
   the second one silently steal the first one's paint. */

const IDS = {
  tile: "appmark-tile",
  under: "appmark-under",
  edge: "appmark-edge",
  cut: "appmark-cut",
  clip: "appmark-tileclip",
  bleed: "appmark-bleed",
} as const;

/** The rooted asterisk, drawn twice: once as the mask that cuts it out of the
    slab, once as the light bleeding back onto the face. */
const RUNE = (
  <>
    <line x1="512" y1="248" x2="512" y2="636" />
    <line x1="327" y1="323" x2="697" y2="541" />
    <line x1="697" y1="323" x2="327" y2="541" />
    <line x1="276" y1="636" x2="748" y2="636" />
    <line x1="512" y1="636" x2="512" y2="768" />
  </>
);

interface AppMarkProps {
  /** rendered edge length in px */
  size?: number;
  className?: string;
}

export default function AppMark({ size = 56, className }: AppMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="100 100 824 824"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Substrate"
      data-testid="app-mark"
    >
      <defs>
        <linearGradient id={IDS.tile} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1E2026" />
          <stop offset="0.45" stopColor="#14151A" />
          <stop offset="1" stopColor="#0B0C0F" />
        </linearGradient>
        <radialGradient id={IDS.under} cx="0.5" cy="0.45" r="0.62">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.5" stopColor="#D9DCE4" />
          <stop offset="1" stopColor="#7E848F" />
        </radialGradient>
        <linearGradient id={IDS.edge} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.20" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.03" />
        </linearGradient>
        <mask id={IDS.cut}>
          <rect width="1024" height="1024" fill="white" />
          <g stroke="black" strokeWidth="56" strokeLinecap="butt" fill="none">
            {RUNE}
          </g>
        </mask>
        <clipPath id={IDS.clip}>
          <rect x="100" y="100" width="824" height="824" rx="185" />
        </clipPath>
        <filter id={IDS.bleed} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="30" />
        </filter>
      </defs>

      <rect x="100" y="100" width="824" height="824" rx="185" fill={`url(#${IDS.under})`} />
      <rect
        x="100"
        y="100"
        width="824"
        height="824"
        rx="185"
        fill={`url(#${IDS.tile})`}
        mask={`url(#${IDS.cut})`}
      />

      <g clipPath={`url(#${IDS.clip})`}>
        <g
          stroke="#EAF0FF"
          strokeWidth="56"
          strokeLinecap="butt"
          fill="none"
          opacity="0.38"
          filter={`url(#${IDS.bleed})`}
        >
          {RUNE}
        </g>
      </g>

      <rect
        x="103"
        y="103"
        width="818"
        height="818"
        rx="182"
        fill="none"
        stroke={`url(#${IDS.edge})`}
        strokeWidth="5"
      />
    </svg>
  );
}
