/* Terminal HUD (SUB-398): a quake-style panel that slides up from the bottom
   on ⌘⇧T and hosts the user's agent CLI (Settings.md `terminal-command`) in a
   real PTY. The session lives in the Rust backend and
   survives hiding — the component only attaches/detaches a renderer.

   Desktop-only: App never mounts this when !isTauri, so the web/e2e mock
   surface has no HUD (and no xterm bundle cost in play there either — the
   imports ride the same chunk but stay inert).

   Keyboard contract: while the HUD is visible and focused, the terminal owns
   every key except ⌘⇧T (toggle, handled app-level) — the app's global
   shortcuts (⌘K, ⌘1…) explicitly stay out via the xterm custom key handler
   returning false only for the toggle chord. Esc is the TUI's (vim, Claude
   Code menus), NOT a HUD-close key: closing is ⌘⇧T, same as opening.

   Trust gate (SUB-427, SUB-775): the command comes from Settings.md, which
   syncs and can be imported, so it is not automatically allowed to run. That
   holds for both ways vault text reaches the PTY — the spawn command and a
   palette quick action's `terminal-actions` line — so both run through the
   same gate, the same approval store and the same confirm card. An unapproved
   string spawns a plain shell / withholds the keystrokes and asks instead;
   approval is remembered per machine (see lib/termtrust.ts). */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke, listen } from "../lib/tauri";
import type { TerminalSettings } from "../lib/settings";
import { TERM_TRUST_KEY, decideInject, isCommandTrusted, withTrusted } from "../lib/termtrust";

/** A withheld command: `command` is what the user is asked about and what the
    approval is keyed by, `data` the exact bytes to type once they say yes
    (the spawn path appends its own newline, the palette path carries the CR
    that was already in the quick action). */
interface Pending {
  command: string;
  data: string;
  /** wording only: a quick action runs on the click, not on every open */
  source: "spawn" | "action";
}

interface TerminalHudProps {
  open: boolean;
  settings: TerminalSettings;
  /** bumped by palette quick actions: text typed into the PTY on arrival */
  inject: { seq: number; text: string } | null;
  onToast: (msg: string) => void;
}

/** xterm theme from the app's design tokens — the HUD is chrome, not a
    foreign surface; ANSI colors stay stock xterm (terminal content is the
    CLI's own visual language, only the frame is ours). */
function hudTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--bg-panel", "#101011"),
    foreground: v("--text-1", "#f5f6f6"),
    cursor: v("--text-1", "#f5f6f6"),
    selectionBackground: v("--accent-soft", "rgba(94,106,210,0.22)"),
  };
}

export default function TerminalHud({ open, settings, inject, onToast }: TerminalHudProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const genRef = useRef<number>(-1);
  /** exited sessions respawn on next open; -1 = nothing to respawn */
  const deadRef = useRef(false);
  const injectedSeq = useRef(0);
  // spawn settings are read at spawn time only — a settings change while the
  // shell runs applies on the next respawn, never yanks a live session
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** the command awaiting this machine's yes; null = nothing to confirm */
  const [pending, setPending] = useState<Pending | null>(null);

  // one Terminal instance for the component's lifetime
  useEffect(() => {
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: false,
      scrollback: 8000,
      theme: hudTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // the toggle chord must reach the app dispatcher even from inside the
    // terminal — everything else is the TUI's
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.metaKey && e.shiftKey && e.key.toLowerCase() === "t") {
        return false;
      }
      return true;
    });
    term.onData((data) => {
      invoke("term_write", { data }).catch(() => {
        /* dead session: the exit listener owns the messaging */
      });
    });
    term.onResize(({ cols, rows }) => {
      invoke("term_resize", { cols, rows }).catch(() => {});
    });
    termRef.current = term;
    fitRef.current = fit;

    let unData: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let cancelled = false;
    listen<{ gen: number; chunk: string }>("term:data", (e) => {
      if (e.payload.gen !== genRef.current) return; // stale session's tail
      const raw = atob(e.payload.chunk);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      term.write(bytes);
    }).then((un) => (cancelled ? un() : (unData = un)));
    listen<{ gen: number }>("term:exit", (e) => {
      if (e.payload.gen !== genRef.current) return;
      deadRef.current = true;
      invoke("term_kill").catch(() => {}); // reap; respawn happens on next open
      term.write("\r\n\x1b[2m[session ended — ⌘⇧T to restart]\x1b[0m\r\n");
    }).then((un) => (cancelled ? un() : (unExit = un)));

    return () => {
      cancelled = true;
      unData?.();
      unExit?.();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // open: mount into the host (first time), fit, spawn/attach, focus
  useEffect(() => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!open || !term || !host) return;
    if (!term.element) term.open(host);
    // Focus synchronously rather than inside the rAF below: the HUD is summoned
    // by an explicit chord and the very next keystroke is meant for the shell.
    // A deferred grab leaves a frame in which that keystroke lands in whatever
    // had focus — usually the note editor — which is the SUB-455 fault in
    // miniature. Remember the outgoing focus so closing can hand it back.
    const prev = document.activeElement as HTMLElement | null;
    term.focus();
    // fit after the slide-in has laid out the host
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit();
      const cols = term.cols;
      const rows = term.rows;
      const s = settingsRef.current;
      const respawn = deadRef.current;
      // Untrusted command → spawn a bare shell and ask. The shell still comes
      // up (the HUD is useful without the agent CLI); only the vault-provided
      // string is withheld until this machine has approved it.
      const trusted = isCommandTrusted(s.command, localStorage.getItem(TERM_TRUST_KEY));
      invoke<{ gen: number; fresh: boolean }>("term_spawn", {
        command: trusted ? s.command : "",
        cwd: s.cwd,
        cols,
        rows,
      })
        .then((info) => {
          genRef.current = info.gen;
          if (info.fresh && respawn) term.clear();
          deadRef.current = false;
          // ask only when this open actually withheld a command — a reused
          // session already carries whatever was approved when it started
          // A quick action that summoned this HUD raises its own card while
          // this spawn is still in flight; the resolve must not clear it —
          // it only owns the spawn command's question.
          setPending((p) =>
            p?.source === "action"
              ? p
              : !trusted && info.fresh
                ? { command: s.command, data: `${s.command}\n`, source: "spawn" }
                : null
          );
          // a reused session may have resized while hidden
          if (!info.fresh) invoke("term_resize", { cols, rows }).catch(() => {});
        })
        .catch((e) => onToast(`terminal failed to start (${e})`));
    });
    return () => {
      cancelAnimationFrame(raf);
      // The panel only slides off-screen — it stays in the DOM and stays
      // focusable, so without this the terminal still holds focus after
      // ⌘⇧T closes it: keystrokes go invisibly into the live PTY and the
      // app's own shortcuts are swallowed by xterm's key handler. `body` counts
      // as ours too: closing while the confirm card is up unmounts the focused
      // Run button before this cleanup runs, dropping focus to nowhere. Focus
      // that has since moved on by other means is left alone.
      const active = document.activeElement;
      const ours = term.element?.contains(active) || host.contains(active);
      if (ours || active === document.body || active === null) {
        if (ours) term.blur();
        if (prev?.isConnected) prev.focus();
      }
    };
  }, [open, onToast]);

  // palette quick actions type into the live PTY (keystrokes, not API — works
  // with any CLI that understands the command). The delay gives a spawn
  // triggered by this same summon (open effect's rAF) time to boot the shell
  // and lets a TUI's input loop come up; a dead-session race at worst types
  // into the fresh shell prompt, which is still the intended command.
  // The text is a `terminal-actions` line, so it is vault-carried and passes
  // the same trust gate as the spawn command (SUB-775) — untrusted asks
  // instead of typing, and the ask replaces any confirm card already up
  // (the click is the newer intent).
  useEffect(() => {
    if (!inject || inject.seq === injectedSeq.current) return;
    injectedSeq.current = inject.seq;
    if (!open) return;
    const decision = decideInject(inject.text, localStorage.getItem(TERM_TRUST_KEY));
    if (decision.action === "ask") {
      setPending({ command: decision.command, data: inject.text, source: "action" });
      return;
    }
    const t = window.setTimeout(() => {
      invoke("term_write", { data: decision.data }).catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [inject, open]);

  // keep the PTY sized to the panel across window resizes while visible
  useEffect(() => {
    if (!open) return;
    const onResize = () => fitRef.current?.fit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // Approve: remember the hash on this machine, then type the command into the
  // shell that is already up — no respawn, so nothing in the session is lost.
  const approve = () => {
    if (!pending) return;
    try {
      localStorage.setItem(
        TERM_TRUST_KEY,
        withTrusted(pending.command, localStorage.getItem(TERM_TRUST_KEY))
      );
    } catch {
      // a full or blocked localStorage costs the memory, not the run — the
      // command still needs a yes next time, which is the safe direction
    }
    invoke("term_write", { data: pending.data }).catch(() => {});
    setPending(null);
    termRef.current?.focus();
  };

  // Decline: the bare shell stays, the command is simply never typed. No
  // "never ask again" — a no here should not be a decision the vault can bank.
  const decline = () => {
    setPending(null);
    termRef.current?.focus();
  };

  const pct = Math.round(Math.min(0.9, Math.max(0.2, settings.height)) * 100);
  return (
    <>
      <div
        className={`termhud${open ? " open" : ""}`}
        style={{ height: `${pct}vh` }}
        aria-hidden={!open}
      >
        <div className="termhud-grip" />
        <div className="termhud-host" ref={hostRef} />
      </div>
      {open && pending !== null && (
        <div className="overlay">
          <div className="dbform" role="dialog" aria-label="Run terminal command">
            <div className="dbform-title">Run this command?</div>
            <div className="dbform-note">
              {pending.source === "action"
                ? "This quick action asks to run a command in the terminal. Vault notes can arrive by sync or import, so it runs only after you allow it on this machine."
                : "Your vault’s Settings.md asks to run a command in the terminal each time it opens. Vault notes can arrive by sync or import, so it runs only after you allow it on this machine."}
            </div>
            {/* borrows the frontmatter-source box: same monospace/verbatim
                treatment, no new class or colour; a command is one line, so
                the textarea's tall min-height is dropped */}
            <pre className="fm-raw" aria-label="Command" style={{ minHeight: 0, overflowX: "auto" }}>
              {pending.command}
            </pre>
            <div className="dbform-note">
              Allowing remembers this exact command here only — never in the
              vault. Change one character and you’ll be asked again.
            </div>
            <div className="dbform-foot">
              <button className="selmenu-btn" onClick={decline}>
                Not now
              </button>
              <button className="selmenu-btn selmenu-btn-primary" autoFocus onClick={approve}>
                Run
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
