import { useCallback, useState } from "react";

/**
 * sidebar collapse: full-width content on demand, ⌘\ or the rail
 * button. Session preference — localStorage, not views.json: it's per-window
 * ergonomics like scroll position, not vault state.
 */
export function useSidebarHidden() {
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem("substrate.sidebarHidden") === "1"
  );
  const toggleSidebar = useCallback(() => {
    setSidebarHidden((h) => {
      localStorage.setItem("substrate.sidebarHidden", h ? "0" : "1");
      return !h;
    });
  }, []);
  return { sidebarHidden, toggleSidebar };
}
