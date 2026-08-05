/* Terminal command trust.

   `terminal-command` comes from Settings.md — a plain note that syncs between
   devices and can arrive by import or by someone else's pull request into a
   shared vault. The HUD types it straight into a login shell, so a vault that
   travels is a vault that can carry code execution.

   The gate: a given command string runs only after the human at THIS machine
   has said yes to it once. Approvals are keyed by a hash of the exact command
   and live in localStorage — per-machine, never written back into the vault,
   so syncing an approval is impossible by construction. Change one character
   of the command and it is a new string that needs its own yes.

   Hash, not plaintext: the approval store is a security record, and a command
   line often carries a token or a path the user would rather not leave lying
   in a second place. The store only ever needs to answer "have I seen this
   exact string" — a digest does that. */

export const TERM_TRUST_KEY = "substrate.terminalTrust.v1";

/** FNV-1a over the UTF-8 bytes, twice with different offsets, hex-joined.
    Not a cryptographic hash and does not need to be — the store is local and
    the only attack it must resist is accidental collision between two of the
    user's own commands. Chosen over SubtleCrypto because that API is async
    and would turn the spawn gate into a promise chain for no real gain. */
export function commandHash(command: string): string {
  const bytes = new TextEncoder().encode(command.normalize("NFC"));
  const round = (offset: number) => {
    let h = offset;
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  return round(2166136261) + round(0x811c9dc5 ^ 0x5bf03635);
}

/** A command that needs no confirmation: nothing to run. An empty/whitespace
    `terminal-command` means "just give me a shell", and the login shell itself
    is the user's own machine config, not vault-provided content. */
export function isTrivialCommand(command: string): boolean {
  return command.trim() === "";
}

/** Parse the stored approval list, tolerating anything (a hand-edited or
    truncated entry must fail closed to "nothing approved", never throw). */
export function parseTrust(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function serializeTrust(hashes: string[]): string {
  // de-duped and capped: this is a small set of real commands, not a log
  return JSON.stringify([...new Set(hashes)].slice(-64));
}

/** The whole decision: may this command be typed into a shell right now? */
export function isCommandTrusted(command: string, raw: string | null): boolean {
  if (isTrivialCommand(command)) return true;
  return parseTrust(raw).includes(commandHash(command));
}

/** The store after the user approves `command`. */
export function withTrusted(command: string, raw: string | null): string {
  return serializeTrust([...parseTrust(raw), commandHash(command)]);
}

/** The command inside injected keystrokes. A palette quick action
    sends the command plus the return that submits it; that return is typing,
    not part of what the user approved. Stripping it keeps ONE approval list
    across both paths — a yes given at spawn covers the same string clicked in
    the palette, and vice versa. */
export function injectedCommand(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}

export type InjectDecision =
  | { action: "write"; data: string }
  | { action: "ask"; command: string };

/** The gate for vault-carried text on its way into the live PTY: identical
    policy to the spawn gate (same store, same hash, same trivial exemption),
    only the carrier differs. */
export function decideInject(text: string, raw: string | null): InjectDecision {
  const command = injectedCommand(text);
  if (isCommandTrusted(command, raw)) return { action: "write", data: text };
  return { action: "ask", command };
}
