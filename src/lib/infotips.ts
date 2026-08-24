import type { View } from "./types";

export interface InfoTip {
  title: string;
  body: string;
}

type TipEntry = {
  selector: string;
  tip: InfoTip | ((element: Element) => InfoTip);
};

const STATIC_VIEW_TIPS: Record<View["kind"], InfoTip> = {
  notes: {
    title: "Notes",
    body: "Your loose scratch notes. Select a row to open it, or press ⌘N to capture a new one.",
  },
  all: {
    title: "All notes",
    body: "Every note in the vault, including entries that belong to databases and folders.",
  },
  folder: {
    title: "Folder",
    body: "Notes stored in this vault folder. Notes can be dragged here from another list.",
  },
  tagfolder: {
    title: "Tag folder",
    body: "Every note carrying these tags, gathered live. Notes created or dragged here are tagged rather than moved — nothing changes place on disk.",
  },
  tag: {
    title: "Tag",
    body: "Every note carrying this tag, whether it was written inline in the text or set as a property.",
  },
  today: {
    title: "Today",
    body: "A working view of scheduled, due, overdue, and intentionally picked items for today.",
  },
  calendar: {
    title: "Calendar",
    body: "Notes with date properties appear here. Click a day to create an entry on that date.",
  },
  search: {
    title: "Search",
    body: "Search note titles, body text, and property filters across the vault.",
  },
  db: {
    title: "Database",
    body: "A structured collection of notes. Change the layout, filter the rows, or save the current view.",
  },
  mount: {
    title: "Mounted folder",
    body: "A real folder on disk, shown as a database. Every file is a row — nothing is imported or copied, and a note is only created for a file once you say something about it.",
  },
  shelf: {
    title: "Drive Shelf",
    body: "Every external disk this vault has cataloged. A drive stays here once it has been seen — browsable and searchable with the disk unplugged, from the catalog rather than the disk.",
  },
  drive: {
    title: "Drive",
    body: "One disk's catalog. With the drive unplugged this is what the last scan saw, and it says when that was — nothing here is read from the disk itself.",
  },
  saved: {
    title: "Saved view",
    body: "A named database view with its own query, sorting, layout, and visible columns.",
  },
  dashboard: {
    title: "Dashboard",
    body: "A purpose-built view assembled from live vault data.",
  },
  dbmanager: {
    title: "All databases",
    body: "Create databases and manage the structured collections in this vault.",
  },
  vaultsync: {
    title: "Vault sync",
    body: "Inspect and control the jobs that keep this vault synchronized.",
  },
  changelog: {
    title: "What's new",
    body: "The release history of this app — what changed in each version. Nothing here is stored in your vault.",
  },
  cookbook: {
    title: "Cookbook",
    body: "Dashboard recipes that ship inside the app — browse them and install one into this vault. Installing copies plain markdown files; an existing note is never overwritten.",
  },
  trash: {
    title: "Trash",
    body: "Restore removed notes, folders, and assets, or permanently delete them when they are no longer needed.",
  },
  assets: {
    title: "Assets",
    body: "Review files in the vault that are not currently referenced by a note.",
  },
  doctor: {
    title: "Vault doctor",
    body: "A read-only integrity scan: broken links, relations, embeds and view references, ambiguous link targets, stale config and property values that do not parse. It reports only — nothing here changes the vault.",
  },
};

/** Every view kind, read off the record above rather than written out again.
    The record is typed `Record<View["kind"], InfoTip>`, so the compiler already
    refuses a kind that has no tip; a second hand-kept list adds no guarantee
    and only has a way to go stale — the one this replaces was six kinds
    behind. Exported so the copy tests sweep every kind's prose, including the
    ones added after they were written. */
export const VIEW_KINDS = Object.keys(STATIC_VIEW_TIPS) as View["kind"][];

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function elementLabel(element: Element, fallback: string): string {
  return (
    cleanText(element.getAttribute("aria-label")) ||
    cleanText(element.getAttribute("title")).replace(/\s*\([^)]*\)\s*$/, "") ||
    cleanText(element.textContent).slice(0, 64) ||
    fallback
  );
}

/** exported for the coverage test — entry order is load-bearing (first match wins) */
export const TIPS: TipEntry[] = [
  {
    selector: ".info-view-toggle",
    tip: {
      title: "Info view",
      body: "Keep this open for an explanation of the control or surface under the pointer.",
    },
  },
  /* app chrome */
  {
    selector: ".mobile-sidebar-scrim",
    tip: {
      title: "Close navigation",
      body: "Dismiss the navigation drawer and go back to what you were reading.",
    },
  },
  {
    selector: ".mobile-nav-button",
    tip: (element) => ({
      title: elementLabel(element, "Navigation"),
      body: "Move between the list and the open note on a narrow screen.",
    }),
  },
  {
    selector: ".sidebar-mobile-close",
    tip: {
      title: "Close navigation",
      body: "Hide the navigation drawer without changing the current view.",
    },
  },
  {
    // `sidebar-new` is shared with the hide/show sidebar buttons, whose own
    // titles carry their shortcut — leave those to the labelled fallback.
    selector: ".sidebar-capture",
    tip: {
      title: "New note",
      body: "Capture a scratch note straight away. It is discarded again if you leave it empty.",
    },
  },
  {
    selector: ".toast",
    tip: {
      title: "Recent action",
      body: "A short confirmation of what just happened. Some carry an undo you can still take.",
    },
  },
  {
    selector: ".keyhints-chip",
    tip: {
      title: "Keyboard shortcuts",
      body: "Show the shortcuts that apply to the view you are currently using. The panel's footer opens the complete sheet — ⌘/ or ? gets there directly.",
    },
  },
  {
    selector: '.note-tool[aria-label="History"]',
    tip: {
      title: "Version history",
      body: "Browse earlier snapshots of this note, compare changes, and restore a previous version.",
    },
  },
  {
    selector: ".note-tool[aria-label='Note actions']",
    tip: {
      title: "Note actions",
      body: "Open actions for the current note, including rename, move, export, duplicate, and Trash.",
    },
  },
  {
    selector: ".dbmgr-menu",
    tip: {
      title: "Database actions",
      body: "Rename this database, change its icon, set its home folder, or delete it.",
    },
  },
  {
    // DatabasePane's menu carries "View actions"; keep the label honest rather
    // than describing every dots button as note actions.
    selector: ".dots-btn",
    tip: (element) => ({
      title: elementLabel(element, "More actions"),
      body: "Open the menu of actions for this item. Destructive entries are marked in red.",
    }),
  },
  {
    selector: ".dots-item",
    tip: (element) => ({
      title: elementLabel(element, "Action"),
      body: "Run this action. Anything shown in red changes or removes data.",
    }),
  },
  {
    selector: ".ctx-item",
    tip: (element) => ({
      title: elementLabel(element, "Action"),
      body: "Run this action on the item you right-clicked.",
    }),
  },
  {
    selector: ".ctx-menu",
    tip: {
      title: "Context menu",
      body: "Actions for the item you right-clicked. Press Esc or click elsewhere to dismiss it.",
    },
  },
  {
    selector: ".note-tool.daily-nav",
    tip: (element) => ({
      title: elementLabel(element, "Daily note"),
      body: "Step to the neighbouring day's journal note, creating it if it does not exist yet.",
    }),
  },
  {
    selector: ".side-section-toggle",
    tip: (element) => ({
      title: elementLabel(element, "Sidebar section"),
      body: "Fold this sidebar section in or out without changing the current view.",
    }),
  },
  {
    selector: ".side-add",
    tip: {
      title: "Add to Folders",
      body: "Create a folder or a database directly in the sidebar tree.",
    },
  },
  {
    selector: ".side-item, .side-destination",
    tip: (element) => ({
      title: elementLabel(element, "Sidebar destination"),
      body: "Open this destination. The highlighted sidebar row shows the view you are in.",
    }),
  },
  {
    selector: ".side-shortcut",
    tip: (element) => ({
      title: elementLabel(element, "Sidebar shortcut"),
      body: "The keyboard shortcut that opens this destination from anywhere in the app.",
    }),
  },
  {
    selector: ".side-count",
    tip: {
      title: "Item count",
      body: "How many notes this destination holds right now.",
    },
  },
  {
    selector: ".head-kind",
    tip: {
      title: "Folder",
      body: "This list is a vault folder, not a database — its notes share a location, not a schema.",
    },
  },
  {
    selector: ".list-journal-hint",
    tip: {
      title: "Journal",
      body: "Daily notes live in their own dated section, newest first.",
    },
  },
  {
    selector: ".empty-action",
    tip: (element) => ({
      title: elementLabel(element, "Get started"),
      body: "Create the first item for this empty view.",
    }),
  },
  {
    selector: ".row-dbblock",
    tip: (element) => ({
      title: elementLabel(element, "Database block"),
      body: "Open this database. The count underneath is the number of entries it contains.",
    }),
  },
  {
    selector: ".list-body .row",
    tip: (element) => ({
      title: elementLabel(element, "Note"),
      body: "Select this note to show it in the editor. Drag it to a folder, or right-click for actions.",
    }),
  },
  {
    selector: ".search-input",
    tip: {
      title: "Search query",
      body: "Search titles and note bodies. Property filters such as status:live can narrow the results.",
    },
  },
  {
    selector: ".search-note-row",
    tip: (element) => ({
      title: elementLabel(element, "Search result"),
      body: "Open the matching note. Arrow keys move through results and Enter opens the selection.",
    }),
  },
  {
    selector: ".search-match-row",
    tip: {
      title: "Matching line",
      body: "Open the note at this exact body-text match.",
    },
  },
  {
    selector: ".search-prop-row",
    tip: {
      title: "Matching property",
      body: "The query matched a property value on this note rather than its body text.",
    },
  },
  {
    selector: ".search-sort button",
    tip: (element) => ({
      title: elementLabel(element, "Result order"),
      body: "Order results by how well they match, or by when the note was last edited.",
    }),
  },
  {
    selector: ".search-stats",
    tip: {
      title: "Result count",
      body: "How many notes and body-text matches the current query found.",
    },
  },
  {
    selector: ".today-act",
    tip: (element) => ({
      title: elementLabel(element, "Today action"),
      body: "Change how this item participates in Today without leaving the overview.",
    }),
  },
  {
    selector: ".today-open",
    tip: (element) => ({
      title: elementLabel(element, "Today item"),
      body: "Open this item in its note or database view.",
    }),
  },
  {
    selector: ".today-journal",
    tip: {
      title: "Today's journal",
      body: "Open today's daily note, creating it on the spot if there is not one yet.",
    },
  },
  {
    selector: ".today-leftovers",
    tip: {
      title: "Leftovers",
      body: "Items that were due before today and are still open. Reschedule or finish them here.",
    },
  },
  {
    selector: ".cal-entry, .cal-ag-item",
    tip: (element) => ({
      title: elementLabel(element, "Calendar entry"),
      body: "Open this dated note. Drag it to another day to reschedule it.",
    }),
  },
  {
    selector: ".cal-day",
    tip: {
      title: "Calendar day",
      body: "Click empty space to add a dated entry here, or drop an existing calendar item to move it.",
    },
  },
  {
    selector: ".cal-pager button",
    tip: (element) => ({
      title: elementLabel(element, "Change period"),
      body: "Step the calendar one month or week, depending on the layout in use.",
    }),
  },
  {
    selector: ".cal-peek-open",
    tip: {
      title: "Open note",
      body: "Leave the calendar and open this entry's note in the editor.",
    },
  },
  {
    selector: ".cal-peek-del",
    tip: {
      title: "Delete entry",
      body: "Move this note to the Trash. Repeating entries drop every occurrence at once.",
    },
  },
  {
    selector: ".cal-peek-act",
    tip: (element) => ({
      title: elementLabel(element, "Repeat action"),
      body: "Change this repeating series — skip a single day, or stop it from this date onwards.",
    }),
  },
  {
    selector: ".cal-peek",
    tip: {
      title: "Entry preview",
      body: "The dates and properties of this calendar entry, editable without opening the note.",
    },
  },
  {
    selector: ".db-filter-input",
    tip: {
      title: "Database filter",
      body: "Filter the current database with words, property:value expressions, and supported operators. The ? beside the field lists every one of them.",
    },
  },
  {
    selector: ".db-syntax-btn",
    tip: {
      title: "Filter syntax",
      body: "Every operator the filter understands, one example each — matching a property, any-of lists, quoted values, negation, date and number comparisons, and folders.",
    },
  },
  {
    selector: ".db-filter-save",
    tip: {
      title: "Save view",
      body: "Pin the current query, sorting, and layout to the sidebar under a name you choose.",
    },
  },
  {
    selector: ".db-filter-clear",
    tip: {
      title: "Clear filter",
      body: "Drop the query and show every entry in this database again.",
    },
  },
  {
    selector: ".db-tab-add",
    tip: {
      title: "Save view",
      body: "Turn what you are looking at now into a named view alongside the other tabs.",
    },
  },
  {
    selector: ".wb-tab-add",
    tip: {
      title: "Add page",
      body: "Add a page to this workbook. Type the name of a database or a note — it becomes the next tab.",
    },
  },
  {
    selector: ".db-tab",
    tip: (element) => ({
      title: elementLabel(element, "Database view"),
      body: "Switch to this database view. Saved views remember their own query, sorting, and layout.",
    }),
  },
  {
    selector: ".db-layouts button",
    tip: (element) => ({
      title: elementLabel(element, "Database layout"),
      body: "Show the same database entries in this layout.",
    }),
  },
  {
    selector: ".cal-layouts button",
    tip: (element) => ({
      title: elementLabel(element, "Calendar layout"),
      body: "Show a whole month at a glance, or one week with more room per day.",
    }),
  },
  {
    selector: ".db-cols-btn",
    tip: {
      title: "Visible columns",
      body: "Choose which properties appear in this saved view or database table.",
    },
  },
  {
    selector: ".db-group-btn",
    tip: {
      title: "Group entries",
      body: "Collect database entries into sections based on one property.",
    },
  },
  {
    selector: ".db-filter-toggle",
    tip: {
      title: "Filter",
      body: "Show or hide the database query bar.",
    },
  },
  {
    selector: ".db-icon-btn",
    tip: {
      title: "Database icon",
      body: "Pick the glyph and colour this database wears in the sidebar and in note properties.",
    },
  },
  // Specific first: `db-new` is shared by the calendar and database-manager
  // header buttons, which do something other than create a database entry.
  {
    selector: ".cal-today",
    tip: {
      title: "Jump to today",
      body: "Scroll the calendar back to the current day without changing the layout.",
    },
  },
  {
    selector: ".dbmgr-new",
    tip: {
      title: "New database",
      body: "Define a new typed collection — its properties become the schema every entry shares.",
    },
  },
  {
    selector: ".db-new, .db-col-new",
    tip: {
      title: "New database entry",
      body: "Create an entry in this database. The new note starts with this database type.",
    },
  },
  {
    selector: ".db-draft-input",
    tip: {
      title: "Entry title",
      body: "Name the new entry and press Enter to create it. Esc discards the draft row.",
    },
  },
  {
    selector: ".db-add-btn",
    tip: {
      title: "Add property",
      body: "Add a property to this database's schema. Every entry gains the new field.",
    },
  },
  {
    selector: ".db-th-caret",
    tip: (element) => ({
      title: elementLabel(element, "Property actions"),
      body: "Rename, retype, hide, or remove this property across the whole database.",
    }),
  },
  {
    selector: ".db-th-title",
    tip: {
      title: "Name column",
      body: "Sort by note title. Repeated clicks cycle ascending, descending, and unsorted.",
    },
  },
  {
    selector: ".db-th-resize",
    tip: {
      title: "Column width",
      body: "Drag to resize this table column. Double-click to fit it to its contents.",
    },
  },
  {
    selector: ".db-th-label",
    tip: (element) => ({
      title: elementLabel(element, "Table column"),
      body: "Sort by this property. Repeated clicks cycle through ascending, descending, and unsorted.",
    }),
  },
  {
    selector: ".db-agg-btn",
    tip: {
      title: "Column calculation",
      body: "Choose a summary for this column, such as count, sum, average, minimum, or maximum.",
    },
  },
  {
    selector: ".db-card, .db-gcard, .db-table tbody tr, .db-list .row",
    tip: (element) => {
      const title = element.querySelector(
        ".db-title-txt, .db-card-title, .db-gcard-title, .row-title"
      );
      return {
        title: elementLabel(title ?? element, "Database entry"),
        body: "Open this database entry. Its properties can also be edited directly where controls appear.",
      };
    },
  },
  {
    selector: ".bulkbar-x",
    tip: {
      title: "Clear selection",
      body: "Deselect every row without changing them. Esc does the same.",
    },
  },
  {
    selector: ".bulkbar",
    tip: {
      title: "Selected entries",
      body: "Set one property across every selected entry, or move them all to the Trash together.",
    },
  },
  {
    selector: ".empty-hint-fix",
    tip: {
      title: "Fix the filter",
      body: "Apply the corrected query. The current one matches nothing in this database.",
    },
  },
  {
    selector: ".db-note-x",
    tip: {
      title: "Close entry",
      body: "Close this entry and go back to the database. Nothing is discarded — edits already saved.",
    },
  },
  {
    selector: ".chip-x",
    tip: {
      title: "Remove property",
      body: "Remove this property value from the note. The database schema itself is not deleted.",
    },
  },
  {
    selector: ".chip-add",
    tip: {
      title: "Add property",
      body: "Add a property to this note. Type a property name and value — the keys this note can use are suggested as you type — or choose the Database property.",
    },
  },
  {
    selector: ".prop-row.chip",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".prop-key") ?? element, "Note property"),
      body: "Edit this note property. Its control follows the field type defined by the database schema.",
    }),
  },
  {
    selector: ".chip-rel",
    tip: (element) => ({
      title: elementLabel(element, "Related note"),
      body: "Open the note this relation points at.",
    }),
  },
  {
    selector: ".chip-input",
    tip: {
      title: "Property value",
      body: "Type the value and press Enter to save it. Esc leaves the property unchanged.",
    },
  },
  {
    selector: ".fm-banner",
    tip: {
      title: "Broken frontmatter",
      body: "This note's property block cannot be parsed, so property edits are blocked until it is repaired.",
    },
  },
  {
    selector: ".note-banner",
    tip: {
      title: "File warning",
      body: "The note's file changed or vanished outside Substrate. Act here before you lose unsaved text.",
    },
  },
  {
    selector: ".save-error",
    tip: {
      title: "Save failed",
      body: "The last write did not reach disk. Click to try saving again.",
    },
  },
  {
    selector: ".backlink",
    tip: (element) => ({
      title: elementLabel(element, "Backlink"),
      body: "Open a note that links to this one.",
    }),
  },
  {
    selector: ".note-title",
    tip: {
      title: "Note title",
      body: "Rename this note. Daily notes and templates use fixed titles and are not editable here.",
    },
  },
  {
    selector: ".editor-toolbar-turn",
    tip: {
      title: "Change block type",
      body: "Convert the block under the cursor into a heading, list, quote, or code block.",
    },
  },
  {
    selector: ".editor-turn-item",
    tip: (element) => ({
      title: elementLabel(element, "Block type"),
      body: "Rewrite the current block as this kind of Markdown.",
    }),
  },
  {
    selector: ".editor-toolbar-button",
    tip: (element) => ({
      title: elementLabel(element, "Formatting"),
      body: "Apply this formatting to the current editor selection.",
    }),
  },
  {
    selector: ".editor-outline-toggle",
    tip: {
      title: "Outline",
      body: "Show or hide the list of headings in this note.",
    },
  },
  {
    selector: ".editor-outline-item",
    tip: (element) => ({
      title: elementLabel(element, "Heading"),
      body: "Scroll the editor to this heading.",
    }),
  },
  {
    selector: ".cm-editor",
    tip: {
      title: "Note editor",
      body: "Write the note body in Markdown. Changes save automatically, [[ opens note-link completion, and / at the start of a line lists the insertions.",
    },
  },
  /* spreadsheet notes */
  {
    selector: ".sheet-tool",
    tip: (element) => ({
      title: elementLabel(element, "Sheet action"),
      body: "Add a row or column, or switch between the grid and the note's raw Markdown source.",
    }),
  },
  {
    selector: ".sheet-addcol-btn, .sheet-addcol-input",
    tip: {
      title: "Add column",
      body: "Name a new column. It is appended to the CSV table stored in this note.",
    },
  },
  {
    selector: ".sheet-addrow",
    tip: {
      title: "Add row",
      body: "Append an empty row to the bottom of the table.",
    },
  },
  {
    selector: ".sheet-computed",
    tip: {
      title: "Computed cell",
      body: "The result of a formula from this note's formulas block. Edit the formula, not the cell.",
    },
  },
  {
    selector: ".sheet-cell",
    tip: {
      title: "Table cell",
      body: "Type to edit. Tab and the arrow keys move on; changes are written back into the note.",
    },
  },
  {
    selector: ".sheet-parse-err",
    tip: {
      title: "Formula errors",
      body: "One or more formulas could not be evaluated. Hover the count to read the messages.",
    },
  },
  {
    selector: ".sheet-summary",
    tip: {
      title: "Summary row",
      body: "Named aggregates from the formulas block, recalculated whenever the table changes. A blank line in that block splits it: the first group with summaries shows here, the rest wait behind “show all”.",
    },
  },
  /* version history */
  {
    selector: ".hist-item",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".hist-item-when") ?? element, "Snapshot"),
      body: "Show what this version changed. Lines added and removed are counted beside it.",
    }),
  },
  {
    selector: ".hist-restore",
    tip: {
      title: "Restore version",
      body: "Write this snapshot back over the note. The current text is snapshotted first.",
    },
  },
  {
    selector: ".hist-purge-go, .hist-danger-link",
    tip: {
      title: "Purge history",
      body: "Delete stored snapshots for good. The note itself stays; the versions cannot be recovered.",
    },
  },
  {
    selector: ".hist-purge-cancel",
    tip: {
      title: "Cancel",
      body: "Leave the stored history untouched.",
    },
  },
  {
    selector: ".hist-close",
    tip: {
      title: "Close history",
      body: "Return to the note. Nothing is restored unless you asked for it.",
    },
  },
  {
    selector: ".hist",
    tip: {
      title: "Version history",
      body: "Choose a snapshot on the left to inspect its changes, restore it, or manage stored history.",
    },
  },
  {
    selector: ".shortcut-sheet",
    tip: {
      title: "Keyboard shortcuts",
      body: "The canonical list of keyboard controls. It is generated from the same registry the app uses.",
    },
  },
  {
    selector: ".keyhints-panel",
    tip: {
      title: "Contextual shortcuts",
      body: "Only shortcuts that apply to the current surface appear here.",
    },
  },
  /* value pickers and dialogs */
  {
    selector: ".selmenu-x",
    tip: {
      title: "Remove value",
      body: "Take this value off the note. The option stays available for other entries.",
    },
  },
  {
    selector: ".selmenu-notify",
    tip: {
      title: "Reminder",
      body: "Get a Today entry when this date arrives, and — if you set a lead time — an earlier heads-up that many days before. Either can stand alone. Nothing is sent outside the app.",
    },
  },
  {
    selector: ".selmenu-add-input, .selmenu-addrow",
    tip: {
      title: "New option",
      body: "Add an option to this property's schema, so every entry in the database can use it.",
    },
  },
  {
    selector: ".selmenu-btn",
    tip: (element) => ({
      title: elementLabel(element, "Menu action"),
      body: "Confirm or dismiss the change you have set up in this menu.",
    }),
  },
  {
    selector: ".selmenu-item",
    tip: (element) => ({
      title: elementLabel(element, "Option"),
      body: "Set this value on the note. Multi-value properties keep the ones already chosen.",
    }),
  },
  {
    selector: ".selmenu-input",
    tip: {
      title: "Find a value",
      body: "Type to narrow the options, or to name one that does not exist yet.",
    },
  },
  {
    selector: ".datemenu-nav",
    tip: (element) => ({
      title: elementLabel(element, "Change month"),
      body: "Step the picker one month without changing the selected date.",
    }),
  },
  {
    selector: ".datemenu-type",
    tip: {
      title: "Change property type",
      body: "Switch this property away from a date, or adjust whether it carries a time.",
    },
  },
  {
    selector: ".datemenu-parse",
    tip: {
      title: "What you typed",
      body: "How your text was read, for example “next fri 9am”. Press Enter to accept it.",
    },
  },
  {
    selector: ".datemenu",
    tip: {
      title: "Date picker",
      body: "Pick a day, or type a date in words. The value is written into the note's properties.",
    },
  },
  {
    selector: ".iconpick-remove",
    tip: {
      title: "Remove icon",
      body: "Fall back to the default glyph for this database.",
    },
  },
  {
    selector: ".iconpick-emoji-input",
    tip: {
      title: "Custom emoji",
      body: "Use any emoji as the icon instead of one of the built-in glyphs.",
    },
  },
  {
    selector: ".iconpick-swatch",
    tip: {
      title: "Icon colour",
      body: "Tint the icon wherever this database appears.",
    },
  },
  {
    selector: ".iconpick",
    tip: {
      title: "Icon picker",
      body: "Choose the glyph and colour shown beside this database in the sidebar.",
    },
  },
  {
    selector: ".inline-edit",
    tip: {
      title: "Rename",
      body: "Type the new name and press Enter. Esc keeps the old one.",
    },
  },
  {
    selector: ".fm-raw",
    tip: {
      title: "Raw frontmatter",
      body: "The note's property block as stored. Fix the YAML here to unblock property editing.",
    },
  },
  {
    selector: ".dbform-x",
    tip: {
      title: "Remove property",
      body: "Drop this property from the database schema. Values already on notes are left in place.",
    },
  },
  {
    selector: ".dbform-addprop",
    tip: {
      title: "Add property",
      body: "Add a field to this database's schema. Choose its type to get the right editing control.",
    },
  },
  {
    selector: ".dbform-select",
    tip: (element) => ({
      title: elementLabel(element, "Property type"),
      body: "The type decides how the value is edited and sorted — text, date, number, select, or relation.",
    }),
  },
  {
    selector: ".prop-check",
    tip: {
      title: "Checkbox",
      body: "Toggle this yes or no value on the note.",
    },
  },
  {
    selector: ".dbform",
    tip: {
      title: "Database settings",
      body: "Name the database and define the properties every one of its entries shares.",
    },
  },
  /* trash and assets */
  {
    selector: ".assets .trash-danger",
    tip: {
      title: "Delete asset",
      body: "Click once to arm, once more to move the file to the Trash. Restore it from there until you empty it.",
    },
  },
  {
    selector: ".assets .trash-restore",
    tip: {
      title: "Reveal in Finder",
      body: "Show the file inside the vault's .assets folder without deleting anything.",
    },
  },
  {
    selector: ".assets .trash-row",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".trash-row-title") ?? element, "Orphaned asset"),
      body: "A file in .assets that no note embeds any more. Deleting it moves it to the Trash.",
    }),
  },
  {
    selector: ".doctor .doctor-copy",
    tip: {
      title: "Copy as JSON",
      body: "Put the whole integrity report on the clipboard exactly as the scan returned it, ready to paste elsewhere. Nothing in the vault changes.",
    },
  },
  {
    selector: ".doctor .doctor-path",
    tip: (element) => ({
      title: "Open this note",
      body: `Open ${elementLabel(element, "the note")} in the editor so you can fix the problem yourself. The scan never edits anything.`,
    }),
  },
  {
    selector: ".doctor .trash-row",
    tip: (element) => {
      const severity = cleanText(element.querySelector(".doctor-dot")?.getAttribute("title"));
      const kind =
        severity === "error" ? "An error" : severity === "warn" ? "A warning" : "A finding";
      return {
        title: elementLabel(element.querySelector(".trash-row-title") ?? element, "Finding"),
        body: `${kind} from the read-only integrity scan. Nothing on disk has changed — open one of the paths on the right to fix it in the note itself.`,
      };
    },
  },
  {
    selector: ".trash-also",
    tip: {
      title: "Also purge history",
      body: "Destroy every stored snapshot of the trashed notes too. That part cannot be undone.",
    },
  },
  {
    selector: ".trash-danger",
    tip: {
      title: "Permanent delete",
      body: "Click once to arm, once more to confirm. Deleting here is not recoverable.",
    },
  },
  {
    selector: ".trash-restore",
    tip: {
      title: "Restore",
      body: "Put this note, folder, or asset back where it came from, out of the Trash.",
    },
  },
  {
    selector: ".trash-row",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".trash-row-title") ?? element, "Trashed item"),
      body: "Still on disk under .trash. Restore it, or delete it for good from here.",
    }),
  },
  /* database manager */
  {
    selector: ".dbmgr-row",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".dbmgr-row-title") ?? element, "Database"),
      body: "Open this database. Drag it onto a sidebar folder to set where its new notes are stored.",
    }),
  },
  /* dashboards */
  {
    selector: ".dash-source",
    tip: {
      title: "Open source note",
      body: "Show the note this dashboard is built from, where its configuration lives.",
    },
  },
  {
    selector: ".dash-state",
    tip: {
      title: "Freshness",
      body: "When this dashboard's data was last gathered, and whether the last run succeeded.",
    },
  },
  {
    selector: ".dash-link",
    tip: (element) => ({
      title: elementLabel(element, "Link"),
      body: "Follow this link. External addresses open in your browser.",
    }),
  },
  {
    selector: ".hub-task",
    tip: {
      title: "Task",
      body: "Tick it to write the change straight back into the source note's checklist.",
    },
  },
  {
    selector: ".hub-view",
    tip: {
      title: "Embedded view",
      body: "A live database query rendered inside this note. It follows the database, so rows appear and leave as the entries change.",
    },
  },
  {
    selector: ".proxy-quota-bar",
    tip: {
      title: "Quota used",
      body: "How much of the current window's allowance is spent, and when it resets.",
    },
  },
  {
    selector: ".sync-action-err",
    tip: {
      title: "Last error",
      body: "The tail of the failing run's output, kept so you can see why it stopped.",
    },
  },
  {
    selector: ".tax-strip",
    tip: {
      title: "Readiness figures",
      body: "What the last export counted, and how much of it is still incomplete. These are computed here, not typed anywhere.",
    },
  },
  {
    selector: ".tax-row",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".tax-name") ?? element, "Incomplete entry"),
      body: "A booked line the export could not complete. The words at the end name the fields still missing.",
    }),
  },
  {
    // the hero is shared chrome (`dash-hero`), so the day's own figure needs
    // its own entry ahead of it
    selector: ".food-hero",
    tip: {
      title: "Today's balance",
      body: "What the day's entries add up to against the goal and the ceiling, with anything burned already taken off.",
    },
  },
  {
    selector: ".food-daynav-btn",
    tip: (element) => ({
      title: elementLabel(element, "Change day"),
      body: "Show another day's entries. Totals and the plot follow the day you pick.",
    }),
  },
  {
    selector: ".food-del",
    tip: {
      title: "Remove entry",
      body: "Delete this line from the day's log and recalculate the totals.",
    },
  },
  {
    selector: ".food-suggest-item",
    tip: (element) => ({
      title: elementLabel(element, "Saved food"),
      body: "Fill the form from this saved food, so you only have to enter the amount.",
    }),
  },
  {
    selector: ".food-db-toggle",
    tip: {
      title: "Food database",
      body: "Show the saved foods and their per-100g values, which the log's suggestions draw on.",
    },
  },
  {
    selector: ".food-db-per button",
    tip: (element) => ({
      title: elementLabel(element, "Entry mode"),
      body: "Choose whether you enter totals directly or per 100g of the food.",
    }),
  },
  {
    selector: ".food-col, .food-bar, .dash-bar-col",
    tip: {
      title: "Daily bar",
      body: "One day in the trend. Its height is the day's total against your target band.",
    },
  },
  /* tasks board */
  {
    selector: ".tasks-check",
    tip: {
      title: "Mark done",
      body: "Tick the task off in its own note. The row leaves the board once that write lands.",
    },
  },
  {
    selector: ".tasks-act",
    tip: (element) => ({
      title: elementLabel(element, "Task action"),
      body: "Pull the task into Now, push it back to later, park it until a day you choose, or wake a parked one.",
    }),
  },
  {
    // `dash-form` is worn by the quick-add as well, and its wording is about a
    // day this board does not have — the specific class has to come first.
    selector: ".tasks-compose",
    tip: {
      title: "Add a task",
      body: "Type a title and press Enter to create the task. The chip beside it dates the new task as it is written.",
    },
  },
  {
    selector: ".tasks-row, .tasks-card",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".tasks-title") ?? element, "Task"),
      body: "One open task. Due date and priority are edited here directly; the title opens its note.",
    }),
  },
  {
    selector: ".tasks-col",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".tasks-col-name") ?? element, "Board column"),
      body: "Tasks filed under one area. Drop a card here to move it into that area.",
    }),
  },
  {
    selector: ".tasks-group-head",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".tasks-group-name") ?? element, "Task group"),
      body: "Tasks gathered by how pressing they are, with the number in this band.",
    }),
  },
  /* curated feed */
  {
    selector: ".feed-vote",
    tip: {
      title: "Rate this item",
      body: "Write an up or a down into the items sheet, where the next curation reads it back.",
    },
  },
  {
    selector: ".feed-chip",
    tip: (element) => ({
      title: elementLabel(element, "Topic filter"),
      body: "Show only items on this topic. The first chip clears the filter again.",
    }),
  },
  {
    selector: ".feed-item",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".feed-title") ?? element, "Feed item"),
      body: "One curated entry. A title carrying a link opens it in your browser.",
    }),
  },
  /* music work index */
  {
    selector: ".mw-filter",
    tip: {
      title: "Filter jobs",
      body: "Narrow the board to jobs whose artist or name matches what you type.",
    },
  },
  {
    selector: ".mw-grouphead",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".mw-grouplabel") ?? element, "Group"),
      body: "Jobs collected under one value of the axis in use, with their count and size on disk.",
    }),
  },
  {
    selector: ".mw-job",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".mw-name") ?? element, "Indexed job"),
      body: "One project folder as the scan last found it. This board only reads — nothing here writes to the folder.",
    }),
  },
  {
    // worn by the food log, the accrual board and any vault kind that asks for
    // it, so this stays true of a headline figure in general — the boards that
    // can say something sharper have their own entry above.
    selector: ".dash-hero",
    tip: {
      title: "Headline figure",
      body: "The one number this board leads with, worked out from the data below it. The line underneath says how it stands.",
    },
  },
  {
    selector: ".dash-form",
    tip: {
      title: "Add entry",
      body: "Record a new line on this board. Enter saves it and readies the form for the next one.",
    },
  },
  {
    selector: ".dash-card, .dash-metric",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".dash-label") ?? element, "Metric"),
      body: "A single figure read from the dashboard's source data.",
    }),
  },
  {
    selector: ".metrics-strip",
    tip: {
      title: "Metric cards",
      body: "The figures this surface leads with. Each card shows what its binding reads out of a sheet, so the cards follow the sheet.",
    },
  },
  {
    selector: ".chart-line-slot",
    tip: {
      title: "Data point",
      body: "Point at a slot to read the exact values behind it, and how many rows they were drawn from.",
    },
  },
  {
    selector: ".chart-legend",
    tip: {
      title: "Series",
      body: "Which colour stands for which series in the plot beside it.",
    },
  },
  {
    selector: ".dash-chart, .chart-line",
    tip: {
      title: "Chart",
      body: "A series plotted from the source note's data block.",
    },
  },
  {
    selector: ".dash-foot",
    tip: {
      title: "Data source",
      body: "Where this dashboard's numbers came from, and when they were collected.",
    },
  },
  /* vault sync pane */
  {
    selector: ".vault-sync-save",
    tip: {
      title: "Save connection",
      body: "Store these sync settings for this device. They are written to the vault's config, not to a server.",
    },
  },
  {
    selector: ".vault-sync-cert",
    tip: {
      title: "Certificate fingerprint",
      body: "Pin the host you trust. A changed fingerprint means the connection is not the same machine.",
    },
  },
  {
    selector: ".vault-sync-passphrase",
    tip: {
      title: "Vault passphrase",
      body: "Unlocks the vault's end-to-end encryption key. The server never sees it — and losing it loses the vault.",
    },
  },
  {
    selector: ".vault-sync-conflicts",
    tip: {
      title: "Conflicts",
      body: "Notes edited on two devices at once. Both versions are kept until you resolve them.",
    },
  },
  {
    selector: ".vault-sync-button",
    tip: (element) => ({
      title: elementLabel(element, "Sync action"),
      body: "Run or stop the sync for this vault now.",
    }),
  },
  {
    selector: ".vault-sync-card",
    tip: {
      title: "Sync status",
      body: "Whether this device is connected, what it last exchanged, and any error it hit.",
    },
  },
  /* settings */
  {
    selector: ".settings-knob",
    tip: {
      title: "Toggle setting",
      body: "Switch this option on or off. The change is saved immediately.",
    },
  },
  {
    selector: ".settings-raw",
    tip: {
      title: "Raw settings",
      body: "The settings file behind this pane, for options with no control of their own.",
    },
  },
  {
    selector: ".settings-missing",
    tip: {
      title: "Not configured",
      body: "This feature needs a value before it can run. Fill it in to switch it on.",
    },
  },
  {
    selector: ".settings-row",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".settings-label") ?? element, "Setting"),
      body: "Change how this part of the app behaves. Settings apply to this device only.",
    }),
  },
  {
    selector: ".palette-item",
    tip: (element) => ({
      title: elementLabel(element.querySelector(".palette-item-label") ?? element, "Palette result"),
      body: "Open this note or run this action. Enter picks whatever is highlighted.",
    }),
  },
  {
    selector: ".palette-input",
    tip: {
      title: "Palette search",
      body: "Type part of a note title or a command name. Results narrow as you type.",
    },
  },
  {
    selector: ".palette",
    tip: {
      title: "Command palette",
      body: "Search for notes and app actions. Arrow keys move the selection; Enter runs it.",
    },
  },
  {
    // last resort for the segmented control: every named variant above wins first
    selector: ".db-switch button",
    tip: (element) => ({
      title: elementLabel(element, "Switch mode"),
      body: "Pick one of these mutually exclusive modes for the current surface.",
    }),
  },
  {
    selector: ".termhud",
    tip: {
      title: "Terminal",
      body: "A live shell attached to the configured command and working directory.",
    },
  },
];

export function infoTipForView(view: View): InfoTip {
  return STATIC_VIEW_TIPS[view.kind];
}

/** Resolve a pointer target from the most specific known control out to its
    surrounding surface. Titled/labelled controls are the fallback, so new
    buttons teach the info view before a dedicated prose entry is added. */
export function infoTipForElement(target: Element): InfoTip | null {
  const custom = target.closest<HTMLElement>("[data-info-title], [data-info-body]");
  if (custom) {
    return {
      title: cleanText(custom.dataset.infoTitle) || elementLabel(custom, "Control"),
      body: cleanText(custom.dataset.infoBody) || "Use this control on the current surface.",
    };
  }

  for (const entry of TIPS) {
    const match = target.closest(entry.selector);
    if (match) return typeof entry.tip === "function" ? entry.tip(match) : entry.tip;
  }

  const labelled = target.closest<HTMLElement>("[aria-label], [title]");
  if (labelled) {
    const rawTitle = cleanText(labelled.getAttribute("title"));
    const label = elementLabel(labelled, "Control");
    const shortcut = rawTitle.match(/\(([^)]+)\)\s*$/)?.[1];
    return {
      title: label,
      body: shortcut
        ? `Use this control here. Keyboard shortcut: ${shortcut}.`
        : "Use this control on the current surface.",
    };
  }

  const input = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (input) {
    return {
      title: "Text field",
      body: cleanText(input.placeholder) || "Enter a value here.",
    };
  }

  if (target.closest(".sidebar")) {
    return {
      title: "Sidebar",
      body: "Navigate the vault, open dashboards and databases, or drag items into folders.",
    };
  }
  if (target.closest(".list")) {
    return {
      title: "Note list",
      body: "Select a note to open it in the pane to the right.",
    };
  }
  if (target.closest(".db")) return STATIC_VIEW_TIPS.db;
  if (target.closest(".cal")) return STATIC_VIEW_TIPS.calendar;
  if (target.closest(".today-pane")) return STATIC_VIEW_TIPS.today;
  if (target.closest(".search-pane")) return STATIC_VIEW_TIPS.search;
  if (target.closest(".note")) {
    return {
      title: "Note",
      body: "The title, properties, Markdown body, and backlinks all belong to the open note.",
    };
  }
  return null;
}
