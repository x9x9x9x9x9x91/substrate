import { useCallback, useEffect, useRef, useState } from "react";

const MOBILE_LAYOUT_QUERY = "(max-width: 700px)";

function mobileLayoutMatches(): boolean {
  return window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

/**
 * The phone is a navigation stack, never the desktop three-pane
 * shell squeezed narrow. The CSS query owns geometry; this matching runtime
 * capability keeps selection/navigation semantics in lockstep with it.
 */
export function useMobileLayout() {
  const [mobile, setMobile] = useState(mobileLayoutMatches);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const mobileSwipeStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const update = () => {
      const next = query.matches;
      setMobile(next);
      setMobileSidebarOpen(false);
      if (!next) setMobilePane("list");
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // Harmless on desktop (the desktop render ignores mobilePane), and keeps
  // every non-row entry point — capture, journal, search, restore — on the
  // same phone navigation stack as tapping a list row.
  const showMobileDetail = useCallback(() => setMobilePane("detail"), []);

  return {
    mobile,
    mobilePane,
    setMobilePane,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    mobileSwipeStart,
    showMobileDetail,
  };
}
