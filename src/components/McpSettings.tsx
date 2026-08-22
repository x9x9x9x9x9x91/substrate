import { useCallback, useEffect, useState } from "react";
import {
  mcpGrantPick,
  mcpGrantRevoke,
  mcpGrantsList,
  mcpGrantsRevokeAll,
  mcpLastSeen,
  mcpSetup,
  type McpAccess,
  type McpGrant,
  type McpLastSeen,
  type McpSetup,
} from "../lib/ipc";
import { dateLocale } from "../lib/dateLocale.ts";
import { errText } from "../lib/errtext";

/** The stamp is context, not the point: shown when it parses, dropped when it
    doesn't, so a hand-edited breadcrumb can't put "Invalid Date" in the pane. */
function formatSeenAt(at: string): string {
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? "" : ` (${when.toLocaleString(dateLocale())})`;
}

/** How a row names the folder it opens, without showing an empty path as if
    it were the whole vault. */
function grantLabel(grant: McpGrant): string {
  return grant.prefix || "Whole vault";
}

/** The same thing in the sentence the revoke button reads out. */
function grantTarget(grant: McpGrant): string {
  return grant.prefix || "the whole vault";
}

/** One row's identity: the client plus the folder it opens. */
function grantKey(grant: McpGrant): string {
  return `${grant.client}\u0000${grant.prefix}`;
}

/** Revokes address the row by its prefix. */
function revokeGrant(grant: McpGrant): Promise<McpGrant[]> {
  return mcpGrantRevoke(grant.client, grant.prefix);
}

interface McpSettingsProps {
  onToast: (message: string) => void;
}

export default function McpSettings({ onToast }: McpSettingsProps) {
  const [grants, setGrants] = useState<McpGrant[] | null>(null);
  const [grantApiAvailable, setGrantApiAvailable] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<McpSetup | null>(null);
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [client, setClient] = useState("Claude Desktop");
  const [access, setAccess] = useState<McpAccess>("read");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [lastSeen, setLastSeen] = useState<McpLastSeen | null>(null);

  useEffect(() => {
    mcpGrantsList()
      .then((next) => {
        setGrants(next);
        setGrantApiAvailable(true);
        if (next.length > 0) setClient(next[0].client);
      })
      .catch((e) => {
        setGrants([]);
        setGrantApiAvailable(false);
        setError(errText(e));
      });
    mcpSetup()
      .then(setSetup)
      .catch((e) => {
        setSetup(null);
        setSetupError(errText(e));
      })
      .finally(() => setSetupLoaded(true));
    // Purely diagnostic: an older backend without the command, or a door no
    // client has spoken to yet, both mean "no line", never a broken pane.
    mcpLastSeen()
      .then(setLastSeen)
      .catch(() => setLastSeen(null));
  }, []);

  const grantFolder = useCallback(async () => {
    const exactClient = client.trim();
    if (!exactClient) {
      onToast("name the MCP client before granting a folder");
      return;
    }
    setBusy("pick");
    setError("");
    try {
      setGrants(await mcpGrantPick(exactClient, access));
    } catch (e) {
      const message = errText(e);
      setError(message);
      onToast(`couldn't grant the folder (${message})`);
    } finally {
      setBusy("");
    }
  }, [access, client, onToast]);

  const revoke = useCallback(
    async (grant: McpGrant) => {
      const key = grantKey(grant);
      setBusy(key);
      setError("");
      try {
        setGrants(await revokeGrant(grant));
      } catch (e) {
        const message = errText(e);
        setError(message);
        onToast(`couldn't revoke the grant (${message})`);
      } finally {
        setBusy("");
      }
    },
    [onToast]
  );

  const revokeAll = useCallback(async () => {
    setBusy("all");
    setError("");
    try {
      setGrants(await mcpGrantsRevokeAll());
    } catch (e) {
      const message = errText(e);
      setError(message);
      onToast(`couldn't revoke MCP access (${message})`);
    } finally {
      setBusy("");
    }
  }, [onToast]);

  const copySetup = useCallback(() => {
    if (!setup) return;
    navigator.clipboard
      .writeText(setup.claude_desktop_snippet)
      .then(() => onToast("Claude Desktop MCP config copied"))
      .catch((e) => onToast(`couldn't copy MCP config (${errText(e)})`));
  }, [onToast, setup]);

  // Mobile (and an older backend during a rolling dev rebuild) has neither
  // MCP command surface. Hide only when BOTH calls fail. Setup-path discovery
  // is optional information; it must never hide healthy grant/revoke controls.
  if (grantApiAvailable === null || !setupLoaded) return null;
  if (!grantApiAvailable && !setup) return null;

  return (
    <section className="settings-section mcp-settings" aria-labelledby="mcp-settings-title">
      <div className="settings-section-head">
        <div>
          <div className="settings-section-title" id="mcp-settings-title">
            MCP
          </div>
          <div className="settings-hint">
            Give one desktop MCP client read or write access to an explicit vault folder.
          </div>
        </div>
        <button
          className="settings-raw"
          disabled={!grants?.length || busy !== ""}
          onClick={revokeAll}
        >
          {busy === "all" ? "revoking…" : "revoke all"}
        </button>
      </div>

      <div className="mcp-grant-builder">
        <label className="settings-label" htmlFor="mcp-client-name">
          Client
        </label>
        <input
          id="mcp-client-name"
          className="settings-input mcp-client-input"
          value={client}
          spellCheck={false}
          onChange={(event) => setClient(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <div className="settings-seg" role="radiogroup" aria-label="MCP folder access">
          {(["read", "write"] as const).map((choice) => (
            <button
              key={choice}
              role="radio"
              aria-checked={access === choice}
              className={`settings-seg-btn${access === choice ? " on" : ""}`}
              onClick={() => setAccess(choice)}
            >
              {choice === "read" ? "Read" : "Read + write"}
            </button>
          ))}
        </div>
        <button
          className="mcp-grant-button"
          disabled={busy !== "" || client.trim() === ""}
          onClick={grantFolder}
        >
          {busy === "pick" ? "choosing…" : "Grant folder…"}
        </button>
      </div>
      <div className="settings-hint mcp-client-hint">
        Client names match the name sent by MCP <code>initialize</code>. Read + write never grants
        delete. Two limits sit above every grant, including a whole-vault one:{" "}
        the root <code>Settings.md</code> and anything in a dot-folder — app config, version history,
        and the markers that hold a sealed folder's key — are never readable or writable through the
        door, and <code>AGENTS.md</code>/<code>CLAUDE.md</code> at the vault root can be read but
        never rewritten.
      </div>
      {lastSeen && (
        <div className="settings-hint mcp-last-seen">
          Last seen: <code className="mcp-last-seen-name">{lastSeen.name}</code>
          {formatSeenAt(lastSeen.at)}
          {grants && grants.length > 0 && !grants.some((g) => g.client === lastSeen.name)
            ? " — no grant uses this exact name, so every call is denied."
            : ""}
        </div>
      )}

      <div className="mcp-grant-list" aria-label="MCP folder grants">
        {grants === null ? (
          <div className="mcp-empty">Loading grants…</div>
        ) : grants.length === 0 ? (
          <div className="mcp-empty">No folders granted — the MCP door is closed.</div>
        ) : (
          grants.map((grant) => {
            const key = grantKey(grant);
            return (
              <div className="mcp-grant" key={key}>
                <div className="mcp-grant-copy">
                  <span className="mcp-grant-client">{grant.client}</span>
                  <span className="mcp-grant-path">{grantLabel(grant)}</span>
                  <span className="mcp-grant-access">
                    {grant.access === "write" ? "read + write" : "read"}
                  </span>
                </div>
                <button
                  className="settings-raw"
                  disabled={busy !== ""}
                  aria-label={`Revoke ${grant.client} access to ${grantTarget(grant)}`}
                  onClick={() => revoke(grant)}
                >
                  {busy === key ? "revoking…" : "revoke"}
                </button>
              </div>
            );
          })
        )}
      </div>

      {error && <div className="mcp-error">{error}</div>}

      {setup ? (
        <div className="mcp-setup">
          <div className="mcp-setup-head">
            <div>
              <div className="settings-label">Claude Desktop setup</div>
              <div className="settings-hint mcp-path">Config: {setup.client_config_path}</div>
            </div>
            <button className="settings-raw" onClick={copySetup}>
              copy config
            </button>
          </div>
          <pre className="mcp-snippet">{setup.claude_desktop_snippet}</pre>
          <div className="settings-hint mcp-path">
            Sidecar: {setup.binary_path}
            {!setup.binary_available && " (not built in this development build)"}
          </div>
          <div className="settings-hint mcp-setup-note">
            Merge this entry into the config, then fully quit and reopen Claude Desktop.
          </div>
        </div>
      ) : (
        <div className="mcp-error">
          MCP client setup details are unavailable{setupError ? ` (${setupError})` : ""}.
        </div>
      )}
    </section>
  );
}
