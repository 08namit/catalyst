#!/usr/bin/env bash
# Two-node Catalyst demo on one machine: two project checkouts ("Alice" and "Bob"), each with its own daemon,
# database and identity, linked over loopback TLS-PSK. Shows pairing, delivery, an outage with queued writes,
# replay on reconnect, a flagged decision conflict and the dashboard URL. Both daemons are stopped on exit.
#
#   bash scripts/two-node-demo.sh            # uses fresh temp dirs (deleted afterwards)
#   DEMO_DIR=/some/empty/dir bash scripts/two-node-demo.sh   # keeps the two checkouts in $DEMO_DIR/{alice,bob}
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli/index.js"
# Never let an outer Claude Code / Catalyst environment point the demo at a real project.
unset CLAUDE_PROJECT_DIR CATALYST_PROJECT_DIR

if [[ ! -f "$CLI" ]]; then
  echo "dist/ missing — building Catalyst first…"
  (cd "$ROOT" && npm run build >/dev/null)
fi

if [[ -n "${DEMO_DIR:-}" ]]; then
  BASE="$DEMO_DIR"
  mkdir -p "$BASE"
  CLEAN_BASE=0
else
  BASE="$(mktemp -d "${TMPDIR:-/tmp}/catalyst-demo.XXXXXX")"
  CLEAN_BASE=1
fi
A="$BASE/alice"
B="$BASE/bob"
for d in "$A" "$B"; do
  if [[ -e "$d/.catalyst" ]]; then
    echo "error: $d is already a Catalyst checkout; point DEMO_DIR at an empty directory." >&2
    exit 1
  fi
  mkdir -p "$d"
done

cat_() { node "$CLI" "$@"; }

cleanup() {
  local rc=$?
  set +e
  echo
  echo "== Stopping both daemons =="
  for d in "$A" "$B"; do
    [[ -f "$d/.catalyst/config.json" ]] && cat_ stop --dir "$d"
  done
  if [[ "$CLEAN_BASE" == 1 ]]; then rm -rf "$BASE"; else echo "Checkouts kept in $BASE"; fi
  exit "$rc"
}
trap cleanup EXIT

section() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# json <dir> <js-expression over `s` (status --json)>: prints the expression's value.
json() {
  cat_ status --json --dir "$1" | node -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{const s=JSON.parse(t);console.log(eval(process.argv[1]))})' "$2"
}

# wait_for <description> <dir> <js-boolean over s> [timeout seconds]
wait_for() {
  local what="$1" dir="$2" expr="$3" limit="${4:-20}" i=0
  until [[ "$(json "$dir" "$expr")" == "true" ]]; do
    i=$((i + 1))
    if (( i > limit * 4 )); then echo "timed out waiting for: $what" >&2; exit 1; fi
    sleep 0.25
  done
}

section "1. Alice initialises the project (loopback peer listener)"
cat_ init --dir "$A" --name Alice --project-name demo-shop --peer-bind 127.0.0.1 --no-setup

section "2. Alice creates an invitation; Bob joins with it"
TOKEN="$(cat_ pair --dir "$A" | grep -o 'cat1_[A-Za-z0-9_-]*' | head -n1)"
echo "Invitation: ${TOKEN:0:24}… (single use, 15 min)"
cat_ join "$TOKEN" --dir "$B" --name Bob --peer-bind 127.0.0.1 --no-setup
wait_for "peers connected" "$A" 's.sync.peers[0]?.state==="connected"'
wait_for "peers connected" "$B" 's.sync.peers[0]?.state==="connected"'
echo "Confirmation codes — Alice: $(json "$A" 's.sync.peers[0].confirmCode')  Bob: $(json "$B" 's.sync.peers[0].confirmCode')"

section "3. Alice sets the goal and publishes an API decision"
cat_ goal "Ship the task list app" --criteria "POST /tasks works end to end" --dir "$A"
cat_ tool publish_decision '{"topic":"api/create-task","title":"POST /tasks contract","decision":"POST /tasks takes {title} and returns 201 {id,title,done:false}","rationale":"Frontend and backend build against one shape"}' --dir "$A"

section "4. Bob's agent sees the update"
wait_for "decision delivered to Bob" "$A" 's.sync.pendingOutbound===0'
cat_ updates --dir "$B"
cat_ updates --dir "$A" >/dev/null # Alice's CLI session reads Bob's join event, so its feed is empty now

section "5. Bob goes offline (peer pause); both keep working"
cat_ peer pause --dir "$B"
cat_ tool publish_progress '{"status":"in_progress","summary":"Bob: login form wired to POST /tasks (written offline)"}' --dir "$B"
cat_ tool publish_progress '{"status":"in_progress","summary":"Alice: POST /tasks validation done (written offline)"}' --dir "$A"
wait_for "Alice sees Bob unreachable" "$A" 's.sync.peers[0]?.state==="unreachable"'

section "6. Status while disconnected (queued, unreachable/paused)"
echo "--- Alice"; cat_ status --dir "$A" | sed -n '/^Sync:/,/^Events:/p'
echo "--- Bob";   cat_ status --dir "$B" | sed -n '/^Sync:/,/^Events:/p'
echo "--- Alice's agent asks for updates:"
cat_ updates --dir "$A" | head -n 3

section "7. Bob reconnects (peer resume): missed updates replay both ways"
cat_ peer resume --dir "$B"
wait_for "replay to Alice" "$A" 's.sync.pendingOutbound===0 && s.sync.peers[0]?.state==="connected"'
wait_for "replay to Bob" "$B" 's.sync.pendingOutbound===0'
echo "--- Alice's updates after replay:"; cat_ updates --dir "$A"
echo "--- Bob's updates after replay:";   cat_ updates --dir "$B"

section "8. Conflicting decision revisions made while disconnected are flagged"
cat_ peer pause --dir "$B" >/dev/null
cat_ tool publish_decision '{"topic":"api/create-task","title":"POST /tasks v2 (Alice)","decision":"Return 201 with a Location header","rationale":"REST convention"}' --dir "$A"
cat_ tool publish_decision '{"topic":"api/create-task","title":"POST /tasks v2 (Bob)","decision":"Return 200 with the full task list","rationale":"Saves a round trip"}' --dir "$B"
cat_ peer resume --dir "$B" >/dev/null
wait_for "conflict on Alice" "$A" 's.counts.conflicts>0'
wait_for "conflict on Bob" "$B" 's.counts.conflicts>0'
echo "--- Alice:"; cat_ status --dir "$A" | sed -n '/^Conflicts:/,/^Inbox:/p' | sed '$d'
echo "--- Bob:";   cat_ status --dir "$B" | sed -n '/^Conflicts:/,/^Inbox:/p' | sed '$d'
echo "(resolve with: catalyst tool resolve_conflict '{\"scope\":\"decision\",\"key\":\"api/create-task\",\"resolution\":\"…\"}')"

section "9. Dashboard for Alice (open while the demo is running; daemons stop at the end)"
cat_ dashboard --no-open --dir "$A"

echo
echo "Demo complete."
