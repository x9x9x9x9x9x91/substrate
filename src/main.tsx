import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import Root from "./Root";
import { isTauri } from "./lib/tauri";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

/* Real-app smoke lane (SUB-426): drives the REAL ipc layer
   against a real scratch vault, since tauri-driver has no macOS support. The
   flag is a build-time literal, so a normal build evaluates `"undefined" ===
   "1"` and drops the branch — the driver never reaches the shipped bundle.
   `isTauri` keeps it off the mock backend, where it would prove nothing. */
if (import.meta.env.VITE_SUBSTRATE_SMOKE === "1" && isTauri) {
  import("./lib/smoke").then((m) => m.runSmoke());
}
