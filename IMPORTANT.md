# IMPORTANT — Catalyst handover

> Read this before starting work. Update it when goals, decisions, ongoing tasks or known bugs materially change,
> and before ending a session. No credentials here. Keep conflicting entries side by side for review.

**Last update:** 2026-11-15 GMT — Codex recovery handover; website work preserved (previous handover: 2026-11-14 23:59 GMT, Claude Opus 5.5)

## Recovery implementation and demo preparation — 2026-11-15
- Completed on separate branch `feature/agent-recovery`, commit `1f272b4`, based on `v0.2-agents`.
  Worktree: `/private/tmp/catalyst-agent-recovery`. This original checkout remains on `website/project-update`;
  website edits and untracked `notes-demo/` are preserved. No main merge or remote push performed.
- Added signed runtime-only task checkpoints (MCP `checkpoint_task`), milestone reminders, bounded takeover
  context, graceful-stop/session cleanup, stale-release guards, and conservative queue selection during peer
  unavailability. Detailed recovery stays in ignored `.catalyst`, not generated root handovers.
- Verified: typecheck, 197 unit/integration tests, build, 26 two-daemon end-to-end tests, existing two-node demo,
  six Python results-tool tests, and diff checks. Real physical two-Mac comparison is still pending.
- Study preferences: both macOS/same Wi-Fi/same Claude model; baseline Git+repository notes only; 180-second
  peer-sync pause with Claude/Git online; five-minute booth presentation. The recovery worktree has
  `docs/ARCHITECTURE.md`, `docs/EXPERIMENT.md`, `docs/DEMO-PRESENTATION.md`, CSV template and plot utility.
  No benchmark results fabricated; collect evidence first, then generate graphs outside Git.
- Limits: no hard-kill failure detector/supervisor, no waking idle Claude turns, no source-code transfer;
  lead SessionEnd with daemon down can retain claims. A network outage is not proof that an agent stopped.
- Next: make the same feature build available on Namit's Mac, set up fresh v2 demo projects, run the
  controlled study and graceful-handoff drill, then create measured presentation figures.

## Website update — 2026-11-15
- User requested current project information on the website, with multiple lightweight subagents and no
  merging of separate upgrades into main. Two GPT-6 Luna agents reviewed content/branches; one updated the install guide.
- Fetched origin. Namit's `c90ffbe` adds the static `website/` and is already on `origin/main`; no separate
  remote feature branch was visible. Local `main` stays at `54b4df1`; local `v0.2-agents` stays at `ac5d01f`.
- Working branch: `website/project-update`, based on `origin/main` (`c90ffbe`). Only website content and this
  handover change; no application/contracts merge. Original `site/` guide and untracked `notes-demo/` untouched.
- Updated `website/index.html` and `website/install.html`, preserving Namit's animated design. Added named agents,
  shared queue, conversational setup, per-agent updates, delivery states, conflict semantics and handover details.
  v0.1 main instructions and unmerged v0.2 preview are explicitly separated; preview installation uses a local worktree.
- `project.md` was not present. Used README, IMPORTANT, PLAN, DEMO and the v0.2 branch documentation instead.
- Verification: typecheck, 118 tests and build passed on this website branch with local-socket access;
  `git diff --check`, JS syntax and static HTML checks passed (local assets/anchors and duplicate IDs).
  Initial sandbox test run could not bind sockets. Browser visual QA unavailable: computer-use browser host unavailable.
- Not deployed or pushed: no existing hosting identity, deployment workflow or live website URL found in the repo.
  Review this website branch before publishing; the preview branch must be available locally to try its setup.
- This branch retains v0.1 application code. The v0.2 status below describes the separate `v0.2-agents` branch.

## Current goal
Catalyst v0.1: connect two developers' Claude Code sessions (Tiam, Namit) via a per-project daemon, MCP adapter,
hooks and direct TLS-PSK peer sync, with offline queueing, reconnect replay, conflict flagging and this kind of
generated handover. Spec + status: `PLAN.md`. Semantics: `PROTOCOL.md`. Demo + evidence: `DEMO.md`.

## v0.2 (branch `v0.2-agents`, not merged): named subagents, task queue, talk-to-Claude setup
- Why: the real two-laptop test of v0.1 passed but (1) each developer will run one Claude session that spawns
  subagents, which v0.1 could not tell apart (silent decision overwrites, shared claims/acks), and (2) the setup
  needed too many terminal commands and human nudges (18 min question→reply gap).
- What changed: protocol v2 (NOT compatible with v0.1 data — re-create projects and re-pair). Signed `agent` field;
  PreToolUse hook stamps `_caller` (Claude agent_id) on every Catalyst tool call; SubagentStart/Stop hooks register
  and retire agents. Per-agent decisions/claims/progress/acks/unread; messages to "Namit/api". Queue tools
  `post_tasks`, `take_next_task`, `complete_task`; `wait_for_updates` long-poll; `catalyst_status`, `pause_sync`,
  `resume_sync`, `invite_teammate`; MCP `start_project`/`join_project` work before a project exists.
  `catalyst install` registers the MCP server at user scope; `catalyst` (no args) prints a 6-line summary.
- Behaviour change: a decision on a topic no longer silently replaces another agent's/person's decision — it is a
  conflict unless the writer passes `supersedes` (the tool result says so).
- Verified: typecheck; `npm test` 186; `npm run test:e2e` 25; two-node demo; live run of two headless lead sessions
  each spawning 2 subagents → 3/3 queue tasks done across both nodes with no prompts after the first; merged code
  passed 14 tests and the CLI worked.
- Known gaps: lead cannot rename itself (`set_agent_name` from the main session returns 400); hook activity drafted
  while the daemon is down is imported as the lead's; `catalyst install` and talk-to-Claude setup not yet tried in
  an interactive session; `prepare` script means a failing build breaks `npm install -g github:…`.

## State: v0.1 feature-complete and verified on one machine (main)
| Area | Owner | Status |
|---|---|---|
| Contracts `src/core`, `src/sync/frames.ts`, `src/client` | Tiam (lead agent) | done |
| Store/projections/briefing/handover `src/store`, `src/handover` | Claude subagent → lead | done |
| Sync/pairing `src/sync` | Codex → lead | done |
| Daemon/CLI `src/daemon`, `src/cli` | Claude subagent → lead | done |
| MCP/hooks/setup `src/mcp`, `src/hooks`, `src/setup` | Claude subagent → lead | done |
| Dashboard/site/sample | Claude subagent | done |
| Two-laptop verification (v0.1) | Tiam + Namit | done 2026-11-14: pairing, Q&A, outage replay, conflict flagged both sides, identical handover hash |
| v0.2 agents/queue/simple setup | Tiam (lead agent) + 3 Claude subagents | done on branch `v0.2-agents`; needs interactive + two-laptop test (DEMO.md part C) |

## Key decisions (see PROTOCOL.md for detail)
- Node ≥ 22.13 with built-in `node:sqlite` (no native deps); MCP SDK v1; zod v4; commander; vitest; TS 7.
- TLS 1.2 PSK `ECDHE-PSK-CHACHA20-POLY1305` peer link; invitations carry addresses + single-use secret (15 min).
- Events: Ed25519-signed, id = sha256(canonical body), Lamport ordering; timestamps display-only (ISO enforced).
- Conflicts = multiple live heads (decision per topic, claims per task, goal); only `conflict.resolved` clears them.
- Authenticate before dedupe/fork classification; hello carries per-author head ids to detect divergent history.
- Retrieval/ack only for records actually rendered to the model; default ack = what the session was shown.
- Writes from MCP carry an idempotency key (header `x-catalyst-client-id`) reused by retries and fallback drafts.
- IMPORTANT.md generated block is deterministic from the event set (byte-identical on synced replicas).

## Verification (2026-11-14)
- `npm run typecheck` clean; `npm test` 118 passed; `npm run test:e2e` 17 passed; `npm run build` ok;
  `bash scripts/two-node-demo.sh` exit 0; `catalyst doctor` all checks pass on a live node.
- Live: 5 headless `claude -p` sessions (sonnet, $1.33 total) completed demo steps 1–8 — DEMO.md part B.
- Codex adversarial review: 8 findings, all fixed with regression tests (`test/store/security`, `consumption`,
  `test/sync/divergence`, `test/daemon/lock`, `test/handover/in-force`).

## Known bugs / limitations
- No NAT traversal/relay; LAN/VPN only. Ownership advisory. Hooks cannot start turns.
- Interactive-session behaviour (MCP approval prompt, trust dialog for `permissions.allow`) not verified live.
- Session linking MCP adapter ↔ hook session is best effort (Claude pid).
- Projection is recomputed fully on each change (fine for thousands of events, not incremental).
- The user-level `codex` MCP server config (`codex mcp-server`) fails: Codex CLI 0.164 has no such subcommand.
  The Codex plugin companion works and was used instead.
- Codex task sandbox denies loopback sockets: run `test/sync` outside Codex.

## Branches / commits
- `v0.2-agents`: v0.2 (see above), branched from main `54b4df1`.
- `main` (remote `origin` = github.com/08namit/catalyst): scaffold `a0e7f35` → implementation `fa50a5b` → review fixes + e2e `4a64094` → docs/handover fixes (latest).

## Next steps
1. v0.2: Tiam + Namit run DEMO.md part C (install, talk-to-Claude setup, several subagents each) on two laptops;
   count terminal commands and nudges; then merge `v0.2-agents` into main.
2. Try an interactive Claude Code session in a Catalyst project (approve MCP server, accept trust dialog).
3. Optional: dogfood Catalyst on this repo (`catalyst init` here + `catalyst join` on Namit's clone) so this file's
   generated block comes from shared records; keep this manual section outside the markers.
4. Consider: incremental projections; relay/NAT options; publishing to npm (not done — install is clone/build/link).
