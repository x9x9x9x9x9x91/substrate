import type { NoteActionIcon } from "../lib/noteactions";

const base = {
  width: 15,
  height: 15,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const InboxIcon = () => (
  <svg {...base}>
    <path d="M2.5 9.5h3l1 1.8h3l1-1.8h3" />
    <path d="M13.5 9.7V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V9.7L4.4 3.6A1.5 1.5 0 0 1 5.8 2.5h4.4a1.5 1.5 0 0 1 1.4 1.1l1.9 6.1Z" />
  </svg>
);

export const SearchIcon = () => (
  <svg {...base}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m13.5 13.5-3.2-3.2" />
  </svg>
);

export const TerminalIcon = () => (
  <svg {...base}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="m4.5 6.5 2 1.8-2 1.8" />
    <path d="M8.5 10.3h3" />
  </svg>
);

export const GearIcon = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 2.8v1.4M8 11.8v1.4M2.8 8h1.4M11.8 8h1.4M4.3 4.3l1 1M10.7 10.7l1 1M11.7 4.3l-1 1M5.3 10.7l-1 1" />
  </svg>
);

export const NoteIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...base} width={size} height={size}>
    <path d="M9.5 2.5H4.8A1.3 1.3 0 0 0 3.5 3.8v8.4a1.3 1.3 0 0 0 1.3 1.3h6.4a1.3 1.3 0 0 0 1.3-1.3V5.5l-3-3Z" />
    <path d="M9.5 2.5v3h3" />
  </svg>
);

export const NotesIcon = () => (
  <svg {...base}>
    <path d="M9.5 2.5H4.8A1.3 1.3 0 0 0 3.5 3.8v8.4a1.3 1.3 0 0 0 1.3 1.3h6.4a1.3 1.3 0 0 0 1.3-1.3V5.5l-3-3Z" />
    <path d="M9.5 2.5v3h3" />
    <path d="M5.7 8.2h4.6" />
    <path d="M5.7 10.7h4.6" />
  </svg>
);

export const PenIcon = () => (
  <svg {...base}>
    <path d="M11.3 2a1.9 1.9 0 1 1 2.7 2.7L5 13.7l-3.7 1 1-3.7L11.3 2Z" />
  </svg>
);

export const ClockIcon = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5.2V8l2 1.4" />
  </svg>
);

/* SUB-452: the "what's new" mark — a four-point sparkle with a small
   companion. No existing glyph read as "release history" (ClockIcon is
   version history, BookIcon is the journal). */
export const SparkleIcon = () => (
  <svg {...base}>
    <path d="M6.4 2.5 7.5 5.4 10.4 6.5 7.5 7.6 6.4 10.5 5.3 7.6 2.4 6.5 5.3 5.4Z" />
    <path d="M11.4 9.4 12 11l1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6Z" />
  </svg>
);

export const KeyboardIcon = () => (
  <svg {...base}>
    <rect x="1.8" y="3.3" width="12.4" height="9.4" rx="1.7" />
    <path d="M4 6h.1M6.6 6h.1M9.3 6h.1M12 6h.1M4 8.5h.1M6.6 8.5h.1M9.3 8.5h.1M12 8.5h.1M4.5 10.7h7" />
  </svg>
);

export const DbIcon = () => (
  <svg {...base}>
    <ellipse cx="8" cy="4" rx="5" ry="2" />
    <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
    <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
  </svg>
);

export const PlusIcon = () => (
  <svg {...base}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

export const XIcon = () => (
  <svg {...base} width={11} height={11}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);

export const ChartIcon = () => (
  <svg {...base}>
    <path d="M3 13.5h10" />
    <path d="M4.5 13.5V8.8M8 13.5V4.5M11.5 13.5V6.8" />
  </svg>
);


export const SyncIcon = () => (
  <svg {...base}>
    <path d="M13.5 5.5A5.5 5.5 0 0 0 4 3.8L2.5 5.5" />
    <path d="M2.5 2.5v3h3" />
    <path d="M2.5 10.5A5.5 5.5 0 0 0 12 12.2l1.5-1.7" />
    <path d="M13.5 13.5v-3h-3" />
  </svg>
);

export const FilterIcon = () => (
  <svg {...base}>
    <path d="M2.5 3.5h11L9.5 8.4v4l-3 1.1v-5L2.5 3.5Z" />
  </svg>
);

/** Struck-through eye — "Hide property" (SUB-326). */
export const EyeOffIcon = () => (
  <svg {...base}>
    <path d="M2 8s2.2-3.5 6-3.5S14 8 14 8s-2.2 3.5-6 3.5S2 8 2 8Z" />
    <circle cx="8" cy="8" r="1.7" />
    <path d="m3 13 10-10" />
  </svg>
);

export const PinIcon = () => (
  <svg {...base}>
    <path d="M8 2.5A3.8 3.8 0 0 1 11.8 6.3c0 2.6-3.8 7.2-3.8 7.2S4.2 8.9 4.2 6.3A3.8 3.8 0 0 1 8 2.5Z" />
    <circle cx="8" cy="6.3" r="1.2" />
  </svg>
);

export const ColumnsIcon = () => (
  <svg {...base}>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.3" />
    <path d="M6.2 3.5v9M9.8 3.5v9" />
  </svg>
);

/* layout glyphs for the database layout switch (list/table/board/gallery) */
export const ListIcon = () => (
  <svg {...base}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </svg>
);

export const TableIcon = () => (
  <svg {...base}>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.3" />
    <path d="M2.5 6.8h11M6.3 6.8v5.7" />
  </svg>
);

export const BoardIcon = () => (
  <svg {...base}>
    <rect x="2.5" y="3.5" width="3.2" height="9" rx="1" />
    <rect x="6.4" y="3.5" width="3.2" height="6" rx="1" />
    <rect x="10.3" y="3.5" width="3.2" height="7.5" rx="1" />
  </svg>
);

export const GalleryIcon = () => (
  <svg {...base}>
    <rect x="2.5" y="3.5" width="5" height="4.2" rx="1" />
    <rect x="8.5" y="3.5" width="5" height="4.2" rx="1" />
    <rect x="2.5" y="8.7" width="5" height="4.2" rx="1" />
    <rect x="8.5" y="8.7" width="5" height="4.2" rx="1" />
  </svg>
);

export const TagIcon = () => (
  <svg {...base}>
    <path d="M8.4 2.5H3.9a1.4 1.4 0 0 0-1.4 1.4v4.5l6 6a1.4 1.4 0 0 0 2 0l3.1-3.1a1.4 1.4 0 0 0 0-2l-6-6.1Z" />
    <circle cx="5.6" cy="5.6" r=".4" fill="currentColor" stroke="none" />
  </svg>
);

export const CopyIcon = () => (
  <svg {...base}>
    <rect x="5.8" y="5.8" width="7.7" height="7.7" rx="1.3" />
    <path d="M10.2 3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.1a1.3 1.3 0 0 0 1.3 1.3" />
  </svg>
);

/* CopyIcon's twin with a plus in the front rect — "make a copy in place"
   (Duplicate, SUB-271) */
export const DuplicateIcon = () => (
  <svg {...base}>
    <rect x="5.8" y="5.8" width="7.7" height="7.7" rx="1.3" />
    <path d="M10.2 3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.1a1.3 1.3 0 0 0 1.3 1.3" />
    <path d="M9.65 8.15v3" />
    <path d="M8.15 9.65h3" />
  </svg>
);

export const FolderIcon = () => (
  <svg {...base}>
    <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h2.4l1.5 1.8H12A1.5 1.5 0 0 1 13.5 5.8V12A1.5 1.5 0 0 1 12 13.5H4A1.5 1.5 0 0 1 2.5 12V4Z" />
  </svg>
);

/* open state of the plain sidebar folder (SUB-183): same back rim and tab as
   FolderIcon, the front flap tilted open — gray like its sibling, no tint */
export const FolderOpenIcon = () => (
  <svg {...base}>
    <path d="M2.5 7V4A1.5 1.5 0 0 1 4 2.5h2.4l1.5 1.8H12A1.5 1.5 0 0 1 13.5 5.8V7" />
    <path d="M5.3 7h7.7a1.3 1.3 0 0 1 1.3 1.7l-1.6 4.6a1.3 1.3 0 0 1-1.2 1H3.5a1.2 1.2 0 0 1-1.2-1.6L4.1 8.3A1.3 1.3 0 0 1 5.3 7Z" />
  </svg>
);

export const LinkIcon = () => (
  <svg {...base}>
    <path d="M6.8 9.2 9.2 6.8" />
    <path d="M7.4 4.9 8.7 3.6a2.3 2.3 0 0 1 3.2 0l.5.5a2.3 2.3 0 0 1 0 3.2l-1.3 1.3" />
    <path d="M8.6 11.1 7.3 12.4a2.3 2.3 0 0 1-3.2 0l-.5-.5a2.3 2.3 0 0 1 0-3.2l1.3-1.3" />
  </svg>
);

export const TrashIcon = () => (
  <svg {...base}>
    <path d="M3 4.5h10" />
    <path d="M6.3 4.3V3.2a.7.7 0 0 1 .7-.7h2a.7.7 0 0 1 .7.7v1.1" />
    <path d="m4.4 4.7.5 7.5a1.3 1.3 0 0 0 1.3 1.3h3.6a1.3 1.3 0 0 0 1.3-1.3l.5-7.5" />
  </svg>
);

export const DotsIcon = () => (
  <svg {...base}>
    <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const ExportIcon = () => (
  <svg {...base}>
    <path d="M8 10V2.8" />
    <path d="m5.2 7.2 2.8 2.9 2.8-2.9" />
    <path d="M2.5 10.5V12A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
  </svg>
);

export const ImageIcon = () => (
  <svg {...base}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <circle cx="6" cy="6.6" r="1.1" />
    <path d="m3.2 11.8 3-3 2 2 2.3-2.3 2.3 2.3" />
  </svg>
);

export const BacklinkIcon = () => (
  <svg {...base} width={13} height={13}>
    <path d="M3 3v5a2.5 2.5 0 0 0 2.5 2.5H13" />
    <path d="m10 7.5 3 3-3 3" />
  </svg>
);

export const CalendarIcon = () => (
  <svg {...base}>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    <path d="M5.5 9.5h2M8.5 9.5h2M5.5 11.5h2" />
  </svg>
);

export const SunIcon = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" />
  </svg>
);

export const BookIcon = () => (
  <svg {...base}>
    <path d="M4.3 1.5h8.2a.5.5 0 0 1 .5.5v10.3H5.3a1.8 1.8 0 0 0-1.8 1.7V3.3a1.8 1.8 0 0 1 1.8-1.8Z" />
    <path d="M3.5 14a1.8 1.8 0 0 0 1.8-1.7H13" />
  </svg>
);

export const ChevronLeftIcon = () => (
  <svg {...base} width={13} height={13}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </svg>
);

export const ChevronRightIcon = () => (
  <svg {...base} width={13} height={13}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </svg>
);

export const MenuIcon = () => (
  <svg {...base} width={16} height={16}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </svg>
);

export const SidebarIcon = () => (
  <svg {...base} width={16} height={16}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M6.5 3v10" />
  </svg>
);

export const ChevronIcon = () => (
  <svg {...base} width={11} height={11}>
    <path d="m6 4 3 4-3 4" />
  </svg>
);

export const ChevronUpIcon = () => (
  <svg {...base} width={13} height={13}>
    <path d="m3.5 10 4.5-4.5 4.5 4.5" />
  </svg>
);

export const ChevronDownIcon = () => (
  <svg {...base} width={13} height={13}>
    <path d="m3.5 6 4.5 4.5 4.5-4.5" />
  </svg>
);

/* the recurrence mark on calendar chips (SUB-174) — a quiet clockwise arrow */
/** Vault doctor (SUB-432) — a pulse line, the read-only health check. */
export const PulseIcon = () => (
  <svg {...base}>
    <path d="M2 8h2.6l1.7-4.2 3 8.8 1.8-4.6H14" />
  </svg>
);

export const RepeatIcon = () => (
  <svg {...base} width={10} height={10} className="cal-entry-repeat">
    <path d="M13.66 10a6 6 0 1 1-1.41-6.24L15.33 6.67" />
    <path d="M15.33 2.67v4h-4" />
  </svg>
);

/* glyph for a canonical note action (SUB-257) — every surface that renders
   buildNoteActions descriptors resolves the same icon for the same action */
export function NoteActionGlyph({ name }: { name: NoteActionIcon }) {
  switch (name) {
    case "open":
      return <NoteIcon />;
    case "move":
      return <FolderIcon />;
    case "rename":
      return <PenIcon />;
    case "duplicate":
      return <DuplicateIcon />;
    case "prop":
      return <TagIcon />;
    case "copy":
      return <CopyIcon />;
    case "reveal":
      return <FolderIcon />;
    case "export":
      return <ExportIcon />;
    case "share":
      return <LinkIcon />;
    case "calendar":
      return <CalendarIcon />;
    case "pin":
      return <PinIcon />;
    case "trash":
      return <TrashIcon />;
  }
}
