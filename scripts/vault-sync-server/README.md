# Mac vault sync server

This folder is the Mac half of Substrate's private Git sync path. `mirror.ts`
copies the working vault repository into a separate bare mirror, and `serve.ts`
exposes exactly that mirror through Git smart HTTP over HTTPS. The server
accepts either `Authorization: Bearer <token>` or HTTP Basic with the token as
the password.

This is the free LAN self-host option: the right design when the server is
your own Mac on your own network, and the cheapest way to sync a phone
against a desktop vault. When the always-on server is NOT a machine you'd
trust with plaintext — a rented VPS, say — the app also speaks an
end-to-end-encrypted blob-store remote (`blob+https://…` in the Sync pane;
protocol in `docs/hosted-sync-protocol.md`, server in `hosted-sync-server/`):
that server only ever stores ciphertext, at the cost of running a second
small service. The two paths coexist; nothing here is deprecated.

The live vault's `.git` directory is never served. The intended flow is:

1. Mac working vault -> bare mirror: run `mirror.ts`.
2. Phone pull/push <-> bare mirror: use the app's vault sync commands.
3. Bare mirror -> Mac working vault: explicitly pull with Git on the Mac.

There is deliberately no `--push-back` mode. A phone push changes the mirror,
not the Mac working tree. Pull phone commits into the working vault before
refreshing the mirror again; a mirror refresh fetches from the working vault
and is not a substitute for that pull. `mirror.ts` refuses to refresh while
unpulled phone commits are still only in the mirror — see
[the refresh guard](#the-refresh-guard). `status.ts` reports whether the mirror
is fresh, stale, or diverged.

## One-time setup

Run these commands only after this folder has landed on `main`. Replace
`/Users/USERNAME/path/to/substrate` with your checkout's path; adjust the
Wi-Fi interface if the LAN is not `en0`.

```sh
SYNC_STATE="$HOME/Library/Application Support/Substrate/vault-sync"
SYNC_LAN_HOST="$(scutil --get LocalHostName).local"
SYNC_LAN_IP="$(ipconfig getifaddr en0)"

mkdir -p "$SYNC_STATE"
chmod 700 "$SYNC_STATE"

node /Users/USERNAME/path/to/substrate/scripts/vault-sync-server/mirror.ts \
  --source "$HOME/Vault" \
  --mirror "$SYNC_STATE/vault.git"

openssl rand -hex 32 > "$SYNC_STATE/token"
chmod 600 "$SYNC_STATE/token"

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -keyout "$SYNC_STATE/server-key.pem" \
  -out "$SYNC_STATE/server-cert.pem" \
  -subj "/CN=$SYNC_LAN_HOST" \
  -addext "subjectAltName=DNS:$SYNC_LAN_HOST,IP:$SYNC_LAN_IP" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"
chmod 600 "$SYNC_STATE/server-key.pem" "$SYNC_STATE/server-cert.pem"
```

The certificate is self-signed. The SAN contains both the Mac's `.local`
hostname and its current LAN IP; regenerate it if either changes. This is a
single self-signed server certificate for v1, not a private-CA setup.

To prove the endpoint manually before using launchd:

```sh
node /Users/USERNAME/path/to/substrate/scripts/vault-sync-server/serve.ts \
  --repo "$SYNC_STATE/vault.git" \
  --token-file "$SYNC_STATE/token" \
  --cert "$SYNC_STATE/server-cert.pem" \
  --key "$SYNC_STATE/server-key.pem" \
  --bind "$SYNC_LAN_IP" \
  --port 7420
```

Binding defaults to `127.0.0.1`. Supplying the exact LAN IP exposes the server
on that interface; `0.0.0.0` is also supported but listens on every IPv4
interface. Keep this on a trusted LAN and do not forward port 7420 from the
router. macOS may ask whether Node can accept incoming connections.

The repository URL is derived from the mirror's basename. With the paths
above it is:

```text
https://<Mac-LAN-hostname-or-IP>:7420/vault.git
```

`vault_sync_set_remote` takes that URL and the same token. Bearer is the
recommended explicit form:

```ts
await vaultSyncSetRemote(
  "https://your-mac.local:7420/vault.git",
  "Bearer <contents of the Mac token file>",
);
```

Passing the raw token instead makes the app use it as the HTTP Basic password
with username `substrate`. A username embedded in the URL wins, and the server
ignores the username. After configuration, `vault_sync_pull` and
`vault_sync_push` exchange the current branch with the mirror.

### Trusting the self-signed certificate: pin it in the app

The app's sync stack (git2 with vendored openssl) does **not** read the OS
trust store — on macOS, iOS, or the simulator. Installing a configuration
profile on the phone therefore does nothing for vault sync. Instead, paste the
contents of `server-cert.pem` into the Vault sync pane's "Server certificate"
field when saving the remote (or pass it as `vaultSyncSetRemote`'s third
argument). The app then accepts exactly that certificate for this remote and
nothing else. Re-save the remote with the new PEM whenever the certificate is
regenerated. Transfer only `server-cert.pem`; never copy the private key or
token except into the app's credential input. The test suite's
`http.sslVerify=false` is test-only and the app does not disable TLS
verification.

## Ongoing mirror workflow

Mac commits are published to the mirror by rerunning:

```sh
node /Users/USERNAME/path/to/substrate/scripts/vault-sync-server/mirror.ts \
  --source "$HOME/Vault" \
  --mirror "$SYNC_STATE/vault.git"
```

Phone pushes already land in the mirror. Bring them into the working vault
explicitly. Add a local-only remote once, then pull from it:

```sh
git -C "$HOME/Vault" remote add vault-sync "$SYNC_STATE/vault.git"
git -C "$HOME/Vault" pull --ff-only vault-sync main
```

If `vault-sync` already exists, update it with `git remote set-url` instead of
adding it again. Resolve any divergence in the working repository. Only rerun
`mirror.ts` after the working vault contains the phone commits, because its
documented refresh direction is working vault -> mirror.

### The refresh guard

That last rule is now enforced, not just documented. A refresh fetches into a
`--mirror` clone, which uses a forced refspec, so refreshing while the mirror
still holds unpulled phone commits would silently discard them. Before
fetching, `mirror.ts` compares every mirror branch against the working vault
and refuses if any mirror branch holds commits that neither the vault nor the
Mac's own last refresh can account for:

```text
refusing to refresh: the mirror holds commits the working vault cannot reach: main (1 commit).
A mirror refresh fetches with a forced refspec and would discard them.
If the phone pushed them, pull them into the working vault first, for example:
  git -C "$HOME/Vault" remote add vault-sync <mirror path>   # once
  git -C "$HOME/Vault" pull --ff-only vault-sync main
Then rerun this command.
If instead these mirror-only commits are disposable, refresh with --force.
  Warning: --force discards them permanently; they exist nowhere else.
```

Refusal exits non-zero and changes nothing. The two remedies are what the
message says: pull the commits and rerun, or — only when you know the
mirror-only commits are unwanted — refresh with `--force`, which discards them
for good. A branch that exists only in the mirror counts too, because `--prune`
would delete it; a branch the Mac itself published and then deleted does not.

### After a history purge or amend

Emptying the trash, purging a note from the history pane, or amending a commit
rewrites vault history: the commits the mirror already holds stop being
reachable from the working vault. That is not a phone push and needs no
intervention — the next refresh publishes the rewritten branch by itself, and
the interval job recovers on its own within one interval. `mirror.ts` tells the
two cases apart by recording each branch tip it publishes under
`refs/substrate/last-refresh/<branch>` inside the mirror; commits reachable from
those markers are the Mac's own published history, and only commits beyond them
count as unpulled phone work. Never use `--force` to get past a purge; if a
refresh still refuses after one, the message says what is actually unaccounted
for.

A mirror created before this change has no markers yet. Until it gets them the
guard stays strict — it will refuse after a rewrite and say so — and one
`--force` refresh writes the markers and restores automatic recovery.

Tags are outside the guard on purpose. The phone never pushes tags, so a tag
that exists only in the mirror is pruned on the next refresh without a refusal.
Keep vault tags in the working vault if they matter.

The mirror advertises `refs/substrate/*` to Git clients. This is harmless: the
app fetches and pushes only `refs/heads/<branch>`, so the marker namespace never
reaches the phone.

### After a client-side history rewrite

Everything above covers a rewrite on the Mac that hosts the mirror — its next
refresh publishes the rewritten branch. A purge or trim on a sync CLIENT (the
phone, or a second desktop using the app) is different: that device's pushes
are rejected non-fast-forward for as long as the mirror still holds the old
history, and the app never force-pushes. The push error says so and points
here. Recovery is manual, on the Mac hosting the mirror:

1. Rescue anything that exists only in the old history — notes committed on
   another device that the rewritten device never pulled, and unsnapshotted
   edits in the Mac's working vault. The steps below discard the old history
   everywhere.
2. Retire the mirror's stale branch and the refresh guard's record of it:

   ```sh
   git -C "$SYNC_STATE/vault.git" update-ref -d refs/heads/main
   git -C "$SYNC_STATE/vault.git" update-ref -d refs/substrate/last-refresh/main
   ```

3. Push again from the rewritten device (Vault sync pane → Push). With no
   remote branch to be behind, the push re-creates it from the rewritten
   history. Do this before the next scheduled mirror refresh — a refresh
   landing in between re-publishes the Mac's old history and you start over.
4. Every other device still holds the old history and must be moved onto the
   rewritten one before its next sync. A Mac:

   ```sh
   git -C "$HOME/Vault" fetch vault-sync
   git -C "$HOME/Vault" reset --hard vault-sync/main
   ```

   The phone has no shell: delete the app (its vault lives in the app
   container), reinstall, and set sync up again so it pulls the rewritten
   history fresh.

### Checking freshness

`status.ts` compares the two repositories without changing either and prints
one line. Its exit code is the answer, so it suits a dashboard or a shell check:
**0** fresh, **1** stale (mirror behind; the line says by how many commits),
**2** diverged (unpulled phone commits; refresh is blocked), **3** error.

```sh
node /Users/USERNAME/path/to/substrate/scripts/vault-sync-server/status.ts \
  --source "$HOME/Vault" \
  --mirror "$SYNC_STATE/vault.git"
```

### Refreshing on an interval

Manual refreshes drift — a mirror days behind the working vault serves the phone
stale notes. [`com.substrate.vault-mirror.plist.example`](./com.substrate.vault-mirror.plist.example)
is an inert `StartInterval` job (900s) that runs the refresh with
`--quiet-if-fresh`, which prints nothing and exits 0 when the mirror is already
up to date, so the log only records real refreshes. Install it the same way as
the server plist below: replace the `USERNAME` paths, copy it without the
`.example` suffix, and load it only after the manual command succeeds. Nothing
here installs it for you.

Both plists point at a `node` binary directly, and these scripts are TypeScript
run without a build step, so that binary must be **Node 22.18 or newer** (24+ or
26 also fine) — earlier releases need `--experimental-strip-types` and will fail
outright on 22.5 and below. Check with `node --version` before loading a job;
launchd failures here are silent apart from the error log.

A guard refusal inside the interval job is safe: the job exits non-zero,
touches nothing, and simply stops publishing new Mac commits until the phone
commits are pulled. The message lands in
`~/Library/Application Support/Substrate/vault-sync/mirror-error.log`, and
`status.ts` will report exit 2 in the meantime.

## launchd example (not installed automatically)

[`com.substrate.vault-sync.plist.example`](./com.substrate.vault-sync.plist.example)
contains this inert example. Replace `REPLACE_WITH_LAN_IP`, copy it without the
`.example` suffix to `~/Library/LaunchAgents/`, and load it only after the
manual server command succeeds. The Node and repository paths are absolute
because launchd does not inherit an interactive shell environment.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.substrate.vault-sync</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/USERNAME/path/to/substrate/scripts/vault-sync-server/serve.ts</string>
    <string>--repo</string>
    <string>/Users/USERNAME/Library/Application Support/Substrate/vault-sync/vault.git</string>
    <string>--token-file</string>
    <string>/Users/USERNAME/Library/Application Support/Substrate/vault-sync/token</string>
    <string>--cert</string>
    <string>/Users/USERNAME/Library/Application Support/Substrate/vault-sync/server-cert.pem</string>
    <string>--key</string>
    <string>/Users/USERNAME/Library/Application Support/Substrate/vault-sync/server-key.pem</string>
    <string>--bind</string>
    <string>REPLACE_WITH_LAN_IP</string>
    <string>--port</string>
    <string>7420</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/USERNAME/path/to/substrate</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>/Users/USERNAME/Library/Application Support/Substrate/vault-sync/server.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/USERNAME/Library/Application Support/Substrate/vault-sync/server-error.log</string>
</dict>
</plist>
```

Nothing here copies or loads the plist. When it is intentionally installed,
validate it with `plutil -lint`, then use `launchctl bootstrap` for the user's
GUI domain. `launchctl bootout` stops and unloads it.

## Development checks

From the Substrate repository root:

```sh
npx tsc --noEmit
node --test scripts/vault-sync-server/*.test.ts
npm test
npm run lint
```

The tests use only temporary repositories and a throwaway self-signed
certificate. `serve.test.ts` covers mirror create/refresh, Bearer and Basic
authentication, 401 rejection, HTTPS clone, and a forced chunked binary push.
`mirror.test.ts` covers the refresh guard (trip, `--force` override,
fast-forward pass, branch deleted upstream), `--quiet-if-fresh` silence, and
every `status.ts` exit code, including an end-to-end phone-push-then-pull
transcript.
