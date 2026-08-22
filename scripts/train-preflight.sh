#!/usr/bin/env bash
# train-preflight.sh — ask the tracker, at adoption time, whether a branch is
# actually free to join a merge train.
#
# The checklist already says this: re-read each candidate issue's CURRENT state
# immediately before it joins a train, and skip anything that is claimed, under
# review by someone else, or waiting on a human. That rule is written down and
# it still failed — a coordinator with the whole protocol in context adopted a
# branch whose issue had been claimed minutes earlier, because "re-read the
# state" is a step a human performs from memory in the middle of a long
# mechanical sequence, which is precisely the kind of step that gets skipped.
#
# So the same question gets asked by a script instead:
#
#   scripts/train-preflight.sh sub/1094-train-preflight sub/1071-foo
#   scripts/train-preflight.sh 1094 1071                # bare ids work too
#
# A `<namespace>/<num>-<topic>` name resolves when the namespace is a plain
# topic directory or THIS team's key; a namespace naming ANOTHER team's tracker
# is refused rather than renumbered into ours — pass the issue id for those.
#
# One line per candidate — ADOPT or SKIP with the reason — and a nonzero exit
# if anything was skipped. The exit code is advisory in the sense that the
# CALLER decides what to do with it (drop the skipped branch and continue, or
# abort the train); what is not negotiable is that the answer came from the
# tracker a moment ago rather than from a list assembled an hour ago.
#
# It fails CLOSED, everywhere:
#
#   * No API token in the environment is a hard error, not a pass. A preflight
#     that cannot reach the tracker cannot vouch for anything, and a green
#     "all clear" printed by a script that checked nothing is worse than no
#     script at all — it launders an unchecked adoption as a verified one.
#   * A branch name with no issue id in it is a SKIP, not a pass: there is
#     nothing to look up, so nothing was checked.
#   * A query that errors out is a SKIP for that candidate.
#   * An unrecognised state is a SKIP. New workflow states appear; the safe
#     default for a state this script has never heard of is "not mine".
#   * A state whose AGE cannot be established — no transition in the history
#     the tracker returned — is a SKIP too: the settle window exists to catch
#     a claim made moments ago, and "I could not tell" is not "it is old".
#
# The cost of a wrong SKIP is one round of delay. The cost of a wrong ADOPT is
# two lanes on one branch, which is what this exists to prevent.
#
# STANDALONE ON PURPOSE (for now): the merge lock's own rework is in flight, so
# this does not wire itself into with-merge-lock.sh or merge-queue.sh. It is
# invoked as its own step in the train protocol (AGENTS.md). Folding the call
# into the lock wrapper is the follow-up once that rework lands.
#
# Flags:
#   --grace <seconds>               settle window (default 300)
#   --actor <name-or-id>            whose review "In Review" counts as; matched
#                                   against the assignee's id or display name.
#                                   Defaults to the token's own viewer, which
#                                   is ambiguous when lanes share one token.
#                                   The id half is authoritative; the DISPLAY
#                                   NAME half is ADVISORY ONLY — a display name
#                                   is tracker-controlled and not unique, so
#                                   anyone who can set theirs to this string
#                                   makes their review look like the caller's.
#                                   Pass an id when the answer has to be sound.
#
# Environment:
#   SUBSTRATE_LINEAR_TEAM_PREFIX    issue-id prefix for this team (default SUB).
#                                   Both ends of the mapping read it: a prefixed
#                                   candidate is only recognised when its prefix
#                                   is THIS team's, so another team's id is
#                                   never silently rewritten into this one's.
#   LINEAR_API_KEY / LINEAR_TOKEN   API token (required) — a PERSONAL API KEY,
#                                   sent as a bare `Authorization:` header. An
#                                   OAuth access token is not accepted (it
#                                   would need a `Bearer ` prefix).
#   SUBSTRATE_LINEAR_API            endpoint override (default: Linear's)
#   SUBSTRATE_LINEAR_TIMEOUT        per-request timeout in seconds (default 20)
#   SUBSTRATE_LINEAR_CURL           HTTP client override — the seam the tests
#                                   use to serve canned responses, so the gate
#                                   suite never makes a live call (the rigs
#                                   have no token and must not need one)
#   SUBSTRATE_TRAIN_PREFLIGHT_GRACE fresh-claim window in seconds (default 300)
#   SUBSTRATE_HISTORY_PAGE          how many history events to ask for when
#                                   dating the current state (default 100, max
#                                   250). Raise it for an issue busy enough
#                                   that even a proven newest-first page cannot
#                                   reach a transition; lowering it only makes
#                                   skips more likely, never adoptions.
set -euo pipefail

die() { printf 'train-preflight: %s\n' "$*" >&2; exit 2; }
note() { printf 'train-preflight: %s\n' "$*" >&2; }

# shellcheck source=scripts/lib/checkout-guard.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/checkout-guard.sh"
guard_checkout_freshness train-preflight.sh

USAGE="usage: train-preflight.sh [--grace <seconds>] [--actor <name-or-id>] <branch-or-id> [...]"

TEAM_PREFIX="${SUBSTRATE_LINEAR_TEAM_PREFIX:-SUB}"
API_URL="${SUBSTRATE_LINEAR_API:-https://api.linear.app/graphql}"
CURL_BIN="${SUBSTRATE_LINEAR_CURL:-curl}"
GRACE="${SUBSTRATE_TRAIN_PREFLIGHT_GRACE:-300}"
HTTP_TIMEOUT="${SUBSTRATE_LINEAR_TIMEOUT:-20}"
ACTOR=""

CANDIDATES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --grace) [[ $# -ge 2 ]] || die "--grace needs a value — $USAGE"
             GRACE="$2"; shift 2 ;;
    --actor) [[ $# -ge 2 ]] || die "--actor needs a value — $USAGE"
             ACTOR="$2"; shift 2 ;;
    -h|--help) printf '%s\n' "$USAGE"; exit 0 ;;
    -*) die "unknown flag '$1' — $USAGE" ;;
    *) CANDIDATES+=("$1"); shift ;;
  esac
done

[[ ${#CANDIDATES[@]} -gt 0 ]] || die "nothing to check — $USAGE"
[[ "$GRACE" =~ ^[0-9]+$ ]] || die "--grace takes whole seconds, got '$GRACE'"

TOKEN="${LINEAR_API_KEY:-${LINEAR_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
  die "no token, preflight cannot vouch — set LINEAR_API_KEY (or LINEAR_TOKEN) so the tracker can actually be asked. Refusing to print a verdict this script did not earn."
fi

command -v node >/dev/null 2>&1 || die "node is required (JSON parsing)"

# ---------------------------------------------------------------------------
# Candidate → issue id
# ---------------------------------------------------------------------------
# Branch names carry the id by convention (`sub/1094-train-preflight`), so the
# mapping is offline — no extra round trip, and no dependence on a branch
# having been pushed anywhere yet. A branch that does NOT carry an id is not
# guessed at; it is reported unmapped, which is a skip.
#
# The accepted prefix is derived from $TEAM_PREFIX rather than hardcoded: with a
# non-default prefix configured, a hardcoded default-team pattern would accept a
# FOREIGN team's id and then query `<prefix>-<same number>` — a different, real
# issue, adopted on the strength of an answer about something else. Matching is
# case-insensitive (branch names lowercase the prefix by convention).
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Does this path segment look like a tracker team key rather than a plain
# directory? Team keys are short alphanumeric tokens (SUB, ALM, ENG). Used to
# tell `sub/40-x` (a team namespace) from `feature/40-x` (a topic namespace):
# the first names a team and must match ours, the second names nothing.
looks_like_team_key() { [[ "$1" =~ ^[A-Za-z][A-Za-z0-9]{1,5}$ ]]; }

# The namespace segment of an `a/b` name when it names a FOREIGN team's tracker
# rather than a plain topic directory — empty otherwise. One predicate, two
# callers: the id lookup refuses on it, and the skip line explains itself with
# it. Split them and the message drifts away from the rule it describes.
foreign_namespace_in() { # candidate -> the segment, or empty
  local raw="$1" ns
  case "$raw" in
    */*) ns="${raw%/*}"; ns="${ns##*/}"
         if looks_like_team_key "$ns" && [[ "$(lower "$ns")" != "$(lower "$TEAM_PREFIX")" ]]; then
           printf '%s' "$ns"
         fi ;;
  esac
}

issue_id_for() { # candidate -> id, or empty
  local raw="$1" num="" head=""
  case "$raw" in
    *-*) head="${raw%%-*}"
         if [[ "$(lower "$head")" == "$(lower "$TEAM_PREFIX")" ]]; then num="${raw#*-}"; fi ;;
  esac
  if [[ -z "$num" ]]; then
    case "$raw" in
      [0-9]*) num="$raw" ;;
      */*)
        # A branch name carries its team in the segment before the last one
        # (`sub/1094-topic`). Taking only the trailing number here would stamp
        # OUR prefix onto ANOTHER team's branch and then ask the tracker about
        # our issue of that number — vouching for the branch on an answer about
        # different work. A namespace that names a team must name THIS one; a
        # namespace that names no team (`feature/…`) constrains nothing and is
        # left alone. The refusal is silent here; the caller turns it into a
        # skip line that names the segment and the way past it.
        if [[ -n "$(foreign_namespace_in "$raw")" ]]; then
          printf ''; return 0
        fi
        num="${raw##*/}"; num="${num%%-*}" ;;
    esac
  fi
  [[ "$num" =~ ^[0-9]+$ ]] || { printf ''; return 0; }
  printf '%s-%s' "$TEAM_PREFIX" "$num"
}

# ---------------------------------------------------------------------------
# Foreign worktree check
# ---------------------------------------------------------------------------
# The one signal that needs no network: if some OTHER tree on this machine has
# the branch checked out, a lane is standing in it. Cheap, local, and it can
# only ever add a skip — a candidate is never adopted BECAUSE of this check.
#
# The candidate may be given as a branch name OR as a bare/prefixed issue id, and
# an id names no branch, so a literal branch comparison would silently check
# NOTHING for the id forms — a strictly weaker gate for a caller who has no way
# to tell. The check therefore matches on the ISSUE, not on the string: a
# worktree standing on any branch that carries this issue's number by the usual
# naming convention (`<prefix>/<num>-<topic>`) counts, and an exact branch-name
# match counts too. That keeps the check local (no network, so it can still run
# before the query) and keeps every widening in the fails-closed direction: it
# can add skips, never remove one. Two branches for one issue is itself a lane
# standing on that issue.
#
# A tree on disk is NOT a lane, though. On this fleet parked lanes leave their
# worktrees behind — 32 trees were standing when this check was first run for
# real, and it answered "skip" for 4 of 4 candidates before the tracker was
# asked at all. A required gate that always says no is a gate that gets routed
# around, which is worse than no gate. So the arm asks whether the tree holds
# WORK, not whether it exists:
#
#   * uncommitted changes  -> live, somebody is editing in there
#   * ahead of / different from its branch's pushed tip -> live, unpushed work
#   * clean AND exactly at `origin/<branch>` -> parked; the branch is safely on
#     the remote and the tree is a leftover. Reported, not skipped.
#   * no `origin/<branch>` at all -> live. Nothing is pushed, so nothing is
#     recoverable if the branch is adopted out from under it: fails closed.
#
# A tree can also stand on a branch WITHOUT holding the ref: when the branch is
# already checked out somewhere, the second lane gets its tree with `--detach`,
# which is the normal shape here and leaves no `branch` line to match on. Such a
# tree is read through its HEAD instead — see `detached_tree_live_for`.
SELF_TREE="$(git rev-parse --show-toplevel 2>/dev/null || printf '')"

worktree_is_live() { # path, branch -> 0 when a lane is plausibly working in it
  local path="$1" branch="$2" dirty="" local_sha="" remote_sha=""
  dirty="$(git -C "$path" status --porcelain 2>/dev/null || printf 'unreadable')"
  [[ -z "$dirty" ]] || return 0
  remote_sha="$(git -C "$path" rev-parse --verify --quiet "refs/remotes/origin/$branch" 2>/dev/null || printf '')"
  [[ -n "$remote_sha" ]] || return 0
  local_sha="$(git -C "$path" rev-parse --verify --quiet "refs/heads/$branch" 2>/dev/null || printf '')"
  [[ -n "$local_sha" ]] || return 0
  [[ "$local_sha" == "$remote_sha" ]] && return 1
  return 0
}

branch_matches_candidate() { # branch, candidate, issue number -> 0 if the same work
  local branch="$1" candidate="$2" num="$3" tail
  [[ "$branch" == "$candidate" ]] && return 0
  [[ -n "$num" ]] || return 1
  tail="${branch##*/}"
  [[ "${tail%%-*}" == "$num" ]] && return 0
  return 1
}

# A detached tree names no branch, so it is placed by its HEAD against the tips
# of the branches this candidate could mean. It counts as a lane when:
#
#   * the branch tip is reachable FROM its HEAD -> it is standing at that tip or
#     on commits made past it, which is a lane mid-flight either way — unless
#     that HEAD is itself on `origin/main`. A merged branch's tip is an ancestor
#     of main, so a tree parked at main's tip is trivially "at or ahead of"
#     EVERY merged branch at once, and this fleet's primary checkout sits in
#     exactly that shape by design. Standing precisely AT the tip still counts;
#     past it and on main does not, and falls through to the tracker so the
#     honest already-resolved reason gets printed instead of a phantom lane;
#   * its HEAD has DIVERGED from the tip and the two meet on commits that belong
#     to this branch alone -> unpushed lane work that an adoption would strand.
#     Clean or dirty: committing your work must not make your lane less visible
#     to the gate than leaving it uncommitted;
#   * it is dirty AND its HEAD sits on commits that belong to this branch alone
#     (behind the tip, not on the shared main line) -> a lane editing from an
#     older point. Dirtiness on its own is not enough: an unrelated dirty
#     detached tree anywhere on the machine would then block every candidate,
#     which is the always-says-no failure this whole arm exists to avoid.
#     Behind AND clean is the one shape that holds nothing unpushed, so it is
#     the one shape that does not block.
#
# Any probe that cannot answer (no HEAD line, unreadable object, no
# `origin/main` to place the commit against) counts as live.
DETACHED_BRANCH=""
detached_tree_live_for() { # path, HEAD sha, candidate, issue number -> 0 when live
  local path="$1" head="$2" candidate="$3" num="$4" tip branch dirty="" rc=0 meet=""
  DETACHED_BRANCH=""
  [[ -n "$head" ]] || { DETACHED_BRANCH="?"; return 0; }
  dirty="$(git -C "$path" status --porcelain 2>/dev/null || printf 'unreadable')"
  while IFS=' ' read -r tip branch; do
    [[ -n "$tip" && -n "$branch" ]] || continue
    branch_matches_candidate "$branch" "$candidate" "$num" || continue
    DETACHED_BRANCH="$branch"
    rc=0; git -C "$path" merge-base --is-ancestor "$tip" "$head" >/dev/null 2>&1 || rc=$?
    if [[ "$rc" == 0 ]]; then             # at, or ahead of, the branch tip
      [[ "$head" == "$tip" ]] && return 0
      git -C "$path" merge-base --is-ancestor "$head" refs/remotes/origin/main >/dev/null 2>&1 || return 0
      continue                            # past the tip but on main: main, not this lane
    fi
    [[ "$rc" == 1 ]] || return 0          # unreadable: fails closed
    # Behind the tip, or diverged from it. Behind AND clean is the only shape
    # holding nothing of its own, so it is the only one let through.
    if [[ -z "$dirty" ]] && git -C "$path" merge-base --is-ancestor "$head" "$tip" >/dev/null 2>&1; then
      continue
    fi
    # Where this HEAD and the tip meet decides the rest: off `origin/main` means
    # the tree stands on work that belongs to this branch alone.
    meet="$(git -C "$path" merge-base "$head" "$tip" 2>/dev/null || printf '')"
    [[ -n "$meet" ]] || return 0          # cannot place it: fails closed
    git -C "$path" merge-base --is-ancestor "$meet" refs/remotes/origin/main >/dev/null 2>&1 || return 0
  done < <(git for-each-ref --format='%(objectname) %(refname:short)' refs/heads 2>/dev/null || true)
  DETACHED_BRANCH=""
  return 1
}

foreign_worktree_for() { # candidate, issue id -> "live|detached|parked <branch> <path>", or empty
  local candidate="$1" id="$2" num="" path="" head="" line branch parked=""
  [[ -n "$SELF_TREE" ]] || { printf ''; return 0; }
  [[ -n "$id" ]] && num="${id##*-}"
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path="${line#worktree }"; head="" ;;
      "HEAD "*) head="${line#HEAD }" ;;
      "detached")
        if [[ "$path" != "$SELF_TREE" ]] && detached_tree_live_for "$path" "$head" "$candidate" "$num"; then
          printf 'detached %s %s' "$DETACHED_BRANCH" "$path"; return 0
        fi ;;
      "branch refs/heads/"*)
        branch="${line#branch refs/heads/}"
        if branch_matches_candidate "$branch" "$candidate" "$num"; then
          if [[ "$path" != "$SELF_TREE" ]]; then
            if worktree_is_live "$path" "$branch"; then
              printf 'live %s %s' "$branch" "$path"; return 0
            fi
            # Keep looking: a second tree on the same issue may be live. The
            # first parked one is remembered so the caller can still say so.
            [[ -n "$parked" ]] || parked="parked $branch $path"
          fi
        fi ;;
    esac
  done < <(git worktree list --porcelain 2>/dev/null || true)
  printf '%s' "$parked"
}

# ---------------------------------------------------------------------------
# The tracker query
# ---------------------------------------------------------------------------
# `viewer` rides along on every request so "is this MY review?" has a default
# answer that costs the caller nothing and cannot be mistyped: the identity of
# the token that did the asking. `--actor` overrides it for the case the viewer
# cannot cover — coordinator lanes sharing one token, where "the viewer" is
# several people and the question is really "is this MINE".
#
# History is fetched for the state-change TIMESTAMPS. `updatedAt` looks like
# the obvious cheaper signal and is the wrong one: a comment bumps it, and the
# closing comment a lane writes as it parks would then make every properly
# parked branch look freshly touched — skipping exactly the branches that are
# ready. Only a state transition counts as churn.
#
# `orderBy: createdAt` is pinned rather than left to the API's default, so the
# page is meant to be the NEWEST events — but that is an assumption about
# somebody else's API, and the whole churn guard rests on it. Taking the newest
# stamp PRESENT in an oldest-first page would hand back a real-but-stale age:
# large, past the settle window, ADOPT — silently wrong, not loudly skipped.
# So the page boundary is asked about directly: `pageInfo { hasNextPage }`, and
# a saturated page is only readable when the order can be PROVEN from the page
# itself (see `newestFirst` below) — never on the strength of the `orderBy`
# alone. Same for labels: an issue with more than a page of them could
# otherwise carry the human gate off the end, and a gate that pages away is not
# a gate.
#
# The page is deep by default because a shallow one fails closed FOREVER on the
# issues that matter most: a branch through dual review, a fix round and a
# re-review accumulates transitions plus label, attachment and comment events,
# and at twenty a page of those is saturated no matter how long the branch
# settles. That is not a wait, it is a branch the script can never adopt.
# Depth alone is only a bigger number to outgrow, so it is the junior half of
# the fix — the order proof is what closes the class.
HISTORY_PAGE="${SUBSTRATE_HISTORY_PAGE:-100}"
# Interpolated straight into the query text, so it is checked as a plain
# integer here rather than trusted: an unvalidated override is query injection
# wearing a page size. 250 is the tracker's own per-page ceiling.
[[ "$HISTORY_PAGE" =~ ^[1-9][0-9]{0,2}$ ]] && [[ "$HISTORY_PAGE" -le 250 ]] ||
  die "SUBSTRATE_HISTORY_PAGE must be a whole number of events from 1 to 250 (got: $HISTORY_PAGE)"
LABEL_PAGE=30
GQL="query(\$id: String!) {
  viewer { id name displayName }
  issue(id: \$id) {
    identifier
    state { name type }
    assignee { id displayName }
    labels(first: $LABEL_PAGE) { nodes { name } pageInfo { hasNextPage } }
    history(first: $HISTORY_PAGE, orderBy: createdAt) {
      nodes { createdAt toState { name } }
      pageInfo { hasNextPage }
    }
  }
}"

# Fields come back as key=value lines rather than raw JSON so the decision
# logic below stays readable bash. Ages are computed HERE, in node, because
# ISO-8601 arithmetic in portable shell is a pit — BSD and GNU `date` disagree
# on the parsing flag, and the rigs and this Mac are not the same one.
PARSE_JS='
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  // The reader downstream is line-oriented and last-write-wins, so a newline
  // inside ANY tracker-controlled value would let that value forge any other
  // key — a display name of "x\nstate=Needs Review" turning a claimed issue
  // into an ADOPT. Folding line breaks to spaces on the EMIT side closes the
  // whole class at the only point every value passes through.
  const out = (k, v) => process.stdout.write(k + "=" + String(v ?? "").replace(/[\r\n]+/g, " ") + "\n");
  let doc;
  try { doc = JSON.parse(raw); } catch { out("error", "response was not JSON: " + raw.slice(0, 200).replace(/\s+/g, " ")); return; }
  if (doc.errors && doc.errors.length) { out("error", doc.errors.map((e) => e.message).join("; ")); return; }
  const issue = doc.data && doc.data.issue;
  if (!issue) { out("error", "no such issue"); return; }
  const viewer = (doc.data && doc.data.viewer) || {};
  out("identifier", issue.identifier);
  out("state", issue.state && issue.state.name);
  out("statetype", issue.state && issue.state.type);
  out("assignee", issue.assignee && issue.assignee.displayName);
  out("assigneeid", issue.assignee && issue.assignee.id);
  out("viewerid", viewer.id);
  out("viewername", viewer.displayName || viewer.name);
  // A page boundary is not an answer. `hasNextPage` is the API saying so
  // directly; when the connection came back without pageInfo at all (an older
  // shape, a proxy that pruned it) a FULL page is treated as saturated on its
  // own, because a full page is exactly the case where more may be behind it.
  const saturated = (conn, limit) => {
    const nodes = (conn && conn.nodes) || [];
    const info = conn && conn.pageInfo;
    return info ? info.hasNextPage === true : nodes.length >= limit;
  };
  const labelNodes = ((issue.labels && issue.labels.nodes) || []).map((l) => l && l.name);
  out("labels", labelNodes.join(","));
  out("labelstruncated", saturated(issue.labels, Number(process.env.SUBSTRATE_LABEL_PAGE) || 30) ? "1" : "");
  const events = ((issue.history && issue.history.nodes) || [])
    .filter((n) => n && n.createdAt)
    .map((n) => ({ at: Date.parse(n.createdAt), toState: Boolean(n.toState) }))
    .filter((e) => Number.isFinite(e.at));
  const stamps = events.filter((e) => e.toState).map((e) => e.at);
  // Newest wins regardless of the order the API returned them in — but only
  // when the newest transition is known to BE in the page. On a saturated page
  // it may be off the end, and a stale-but-real age reads as "settled long ago"
  // and adopts. With no usable transition, or a page that cannot be shown to
  // reach the newest one, the age is UNKNOWN and says so — an absent key would
  // read downstream as "nothing to wait for" and adopt.
  //
  // Two ways the page can reach it. Either it holds EVERY event (not
  // saturated), or it is demonstrably newest-first: the timestamps never climb
  // and drop at least once, which no oldest-first page of distinct events can
  // fake. In that order everything past the boundary is older than everything
  // in the page, so the newest transition present is the newest there is, and
  // a busy issue stops being permanently unadoptable. This is read off the
  // RESPONSE, not off the `orderBy` we asked for: an API that quietly changes
  // its ordering makes the proof fail and the answer go back to unknown, which
  // is the direction this script is allowed to be wrong in.
  const historyComplete = !saturated(issue.history, Number(process.env.SUBSTRATE_HISTORY_PAGE) || 100);
  const times = events.map((e) => e.at);
  const newestFirst =
    times.length >= 2 &&
    times.every((t, i) => i === 0 || t <= times[i - 1]) &&
    times.some((t, i) => i > 0 && t < times[i - 1]);
  out(
    "laststateage",
    (historyComplete || newestFirst) && stamps.length
      ? Math.max(0, Math.round((Date.now() - Math.max(...stamps)) / 1000))
      : "unknown",
  );
});
'

fetch_issue() { # id -> key=value lines (including `error=` on failure)
  local id="$1" body response rc errfile detail=""
  body=$(SUBSTRATE_GQL="$GQL" SUBSTRATE_ID="$id" node -e \
    'process.stdout.write(JSON.stringify({ query: process.env.SUBSTRATE_GQL, variables: { id: process.env.SUBSTRATE_ID } }))')
  errfile="$(mktemp)"
  set +e
  # The bare `Authorization: <token>` form is a PERSONAL API KEY header. An
  # OAuth access token would need `Bearer ` in front of it; this script does
  # not accept one, and the key shape is what LINEAR_API_KEY/LINEAR_TOKEN are
  # documented to hold.
  response=$(printf '%s' "$body" | "$CURL_BIN" -sS --max-time "$HTTP_TIMEOUT" \
    -H "Authorization: $TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @- "$API_URL" 2>"$errfile")
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    # TLS, DNS and proxy failures are only ever explained by the client's own
    # stderr; an exit code alone leaves an operator nothing to act on. Folded
    # to one line because the reader below is line-oriented.
    detail="$(tr '\n\r' '  ' <"$errfile" | tr -s ' ' | sed 's/^ *//; s/ *$//' | cut -c1-300)"
    rm -f "$errfile"
    printf 'error=the request to %s failed (client exit %s)%s\n' \
      "$API_URL" "$rc" "${detail:+ — $detail}"
    return 0
  fi
  rm -f "$errfile"
  # The page sizes travel with the response: the parser has to know how big a
  # page was asked for to recognise a full one, and the query above is the only
  # place that decides.
  printf '%s' "$response" | SUBSTRATE_HISTORY_PAGE="$HISTORY_PAGE" \
    SUBSTRATE_LABEL_PAGE="$LABEL_PAGE" node -e "$PARSE_JS"
}

# ---------------------------------------------------------------------------
# State → verdict
# ---------------------------------------------------------------------------
# Only two states mean "free to adopt": a branch waiting for review, and one
# already cleared to land. In Review is a third, conditional case — mine to
# adopt if I am the reviewer, someone else's otherwise. Everything else is a
# skip, including the states that look harmless: a Done issue with a live
# branch is a bookkeeping mismatch, not an invitation.
verdict_for_state() { # state, labels, assigneeid, assignee, viewerid, actor, statetype, labelstruncated -> "ADOPT" | "SKIP <reason>"
  local state="$1" labels="$2" assigneeid="$3" assignee="$4" viewerid="$5" actor="$6" \
    statetype="$7" labelstruncated="${8:-}"
  # `labels` and `labelstruncated` drive an owner-gate arm that is private to
  # this tree. In the public mirror both parameters are intentionally unused —
  # that gate is not a missing feature to fix here.
  # State TYPE first, where the tracker has one. Type is the tracker's own
  # invariant — a workflow state can be renamed to anything ("Shipped",
  # "Abgeschlossen") and keep its completed/canceled type, while the names
  # below are only the ones this team happens to use today. Reading the type
  # first means a rename cannot turn a closed issue into an unexpected state
  # and, from there, into a candidate someone has to re-triage by hand.
  case "$statetype" in
    completed|canceled|cancelled)
      printf 'SKIP already resolved (%s) — a live branch here is a mismatch, not a candidate' \
        "${state:-$statetype}"
      return 0 ;;
  esac
  case "$state" in
    "Needs Review"|"Merge-Ready"|"Merge Ready")
      printf 'ADOPT' ;;
    "In Review")
      # Whose review this is: the caller's --actor when given (matched against
      # the assignee's id or display name), otherwise the token's own viewer.
      if [[ -z "$assigneeid" ]]; then
        printf 'SKIP under review with no assignee — cannot tell whose'
      elif [[ -n "$actor" ]]; then
        if [[ "$actor" == "$assigneeid" || "$actor" == "$assignee" ]]; then
          printf 'ADOPT'
        else
          printf 'SKIP foreign review — In Review, held by someone other than %s' "$actor"
        fi
      elif [[ "$assigneeid" == "$viewerid" ]]; then
        printf 'ADOPT'
      else
        printf 'SKIP foreign review — In Review, held by someone else'
      fi ;;
    "In Progress")
      printf 'SKIP claimed — In Progress' ;;
    "Changes Requested")
      printf 'SKIP changes requested — the branch is not what review asked for' ;;
    "Needs Call")
      printf 'SKIP waiting on a human (Needs Call)' ;;
    "Done"|"Canceled"|"Cancelled"|"Duplicate")
      printf 'SKIP already resolved (%s) — a live branch here is a mismatch, not a candidate' "$state" ;;
    *)
      printf 'SKIP unexpected state %s — nothing here says it is free' "${state:-<none>}" ;;
  esac
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
SKIPPED=0
for candidate in "${CANDIDATES[@]}"; do
  id="$(issue_id_for "$candidate")"
  if [[ -z "$id" ]]; then
    # `sub/1094-x` under a `DEV` tracker plainly carries a number, so "no issue
    # id in the name" reads as a bug unless the line says which segment refused
    # it and what to pass instead. A gate whose refusals look wrong is a gate
    # people route around.
    foreign_ns="$(foreign_namespace_in "$candidate")"
    if [[ -n "$foreign_ns" ]]; then
      printf "SKIP   %-28s no issue id in the name (namespace '%s' is not this team's prefix — pass the issue id explicitly)\n" \
        "$candidate" "$foreign_ns"
    else
      printf 'SKIP   %-28s no issue id in the name — nothing to check, so nothing is vouched for\n' "$candidate"
    fi
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  foreign="$(foreign_worktree_for "$candidate" "$id")"
  if [[ -n "$foreign" ]]; then
    tree_rest="${foreign#* }"
    tree_branch="${tree_rest%% *}"; tree_path="${tree_rest#* }"
    if [[ "${foreign%% *}" == live ]]; then
      printf 'SKIP   %-28s another tree holds this branch (%s): %s\n' \
        "$candidate" "$tree_branch" "$tree_path"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
    if [[ "${foreign%% *}" == detached ]]; then
      printf 'SKIP   %-28s a detached tree stands on this branch (%s): %s\n' \
        "$candidate" "$tree_branch" "$tree_path"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
    note "$candidate: a PARKED worktree stands on $tree_branch ($tree_path) — clean and at its pushed tip, so it is not read as a live lane"
  fi

  state="" statetype="" labels="" labelstruncated="" assignee="" assigneeid="" \
    viewerid="" laststateage="" identifier="" error=""
  while IFS= read -r line; do
    key="${line%%=*}"; value="${line#*=}"
    case "$key" in
      identifier) identifier="$value" ;;
      state) state="$value" ;;
      statetype) statetype="$value" ;;
      labels) labels="$value" ;;
      labelstruncated) labelstruncated="$value" ;;
      assignee) assignee="$value" ;;
      assigneeid) assigneeid="$value" ;;
      viewerid) viewerid="$value" ;;
      laststateage) laststateage="$value" ;;
      error) error="$value" ;;
    esac
  done < <(fetch_issue "$id")

  if [[ -n "$error" ]]; then
    printf 'SKIP   %-28s %s: could not read the issue — %s\n' "$candidate" "$id" "$error"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Free round-trip verification: the tracker is supposed to have answered about
  # the issue that was asked for. If it did not, every field below describes
  # something else and no verdict drawn from them means anything.
  if [[ "$(lower "$identifier")" != "$(lower "$id")" ]]; then
    printf 'SKIP   %-28s %s: the tracker answered about %s — refusing a verdict about a different issue\n' \
      "$candidate" "$id" "${identifier:-<nothing>}"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  verdict="$(verdict_for_state "$state" "$labels" "$assigneeid" "$assignee" "$viewerid" "$ACTOR" "$statetype" "$labelstruncated")"

  # Churn guard, applied only to candidates that otherwise pass: a state that
  # moved seconds ago is a state still being edited, and the read that just
  # came back may already be behind whoever is doing the editing. Waiting one
  # round costs a round; racing them costs the branch.
  #
  # An age that could not be established counts as INSIDE the window, not
  # outside it. An empty history page, a full page of comment events whose
  # order cannot be proven so the transition may be off the end, a schema
  # change — each of those means the question "was this claimed a moment ago?"
  # went unanswered, and an unanswered question is never an adopt here.
  if [[ "$verdict" == ADOPT ]]; then
    if [[ -z "$laststateage" || "$laststateage" == unknown ]]; then
      verdict="SKIP state age unknown — left to settle (no readable state transition in the issue's history; raise SUBSTRATE_HISTORY_PAGE if the issue is that busy)"
    elif [[ "$laststateage" -lt "$GRACE" ]]; then
      verdict="SKIP freshly claimed — state changed ${laststateage}s ago, inside the ${GRACE}s settle window"
    fi
  fi

  if [[ "$verdict" == ADOPT ]]; then
    printf 'ADOPT  %-28s %s: %s%s\n' "$candidate" "$id" "$state" \
      "$([[ -n "$assignee" ]] && printf ' (%s)' "$assignee")"
  else
    printf 'SKIP   %-28s %s: %s\n' "$candidate" "$id" "${verdict#SKIP }"
    SKIPPED=$((SKIPPED + 1))
  fi
done

if [[ $SKIPPED -gt 0 ]]; then
  note "$SKIPPED of ${#CANDIDATES[@]} candidates are not free to adopt"
  exit 1
fi
note "all ${#CANDIDATES[@]} candidates are free to adopt"
exit 0
