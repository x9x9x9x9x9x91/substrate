import { createContext, useContext } from "react";

/* SUB-1165 — back navigation for the mouse. ⌫ has always popped the view
   history, but nothing on screen did: every pane header would otherwise have
   to thread canGoBack and goBack down from App to render one chevron. Same
   shape as UndoContext (SUB-477): App owns the history, this is only the
   read-and-go end of it. */

export type NavApi = {
  /** true while the history holds somewhere to return to — the same
      expression the ⌫ shortcut is gated on, so key and click agree */
  canGoBack: boolean;
  /** pop one step, exactly what ⌫ runs */
  goBack: () => void;
};

// no-op default: tests and isolated component renders shouldn't have to build
// a provider to render a pane
export const NavContext = createContext<NavApi>({ canGoBack: false, goBack: () => {} });

export function useNav(): NavApi {
  return useContext(NavContext);
}
