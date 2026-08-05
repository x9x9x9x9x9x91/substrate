import { ChevronLeftIcon } from "./Icons";
import { useNav } from "../lib/navContext";

/* SUB-1165: the mouse path back. ⌫ pops the view history; until now nothing
   on screen did, so a mouse-driven detour into a note or a database was a
   one-way trip. The chevron leads the pane header — the header's own button
   grammar (.list-new's shape), not a new chrome idiom — and is absent, rather
   than disabled, when there is nowhere to go back to. */
export function BackButton() {
  const { canGoBack, goBack } = useNav();
  if (!canGoBack) return null;
  return (
    <button className="list-back" onClick={goBack} title="Back (⌫)" aria-label="Back">
      <ChevronLeftIcon />
    </button>
  );
}
