# IMPORTANT — Catalyst handover

> Read this first. Update material goals, decisions, bugs, checks and branches before ending a session.
> Keep credentials out. Preserve conflicting evidence for review.

**Last update:** 2026-11-15 GMT — Codex main integration

## Current goal and integration
- User explicitly authorized checking, merging and pushing the completed features to main. This supersedes
  the earlier instruction to keep v0.2/recovery separate. Integrates `ac5d01f` (v0.2), `1f272b4` (recovery),
  and `8c493e8` (website updates) with Namit's existing website commit `c90ffbe` on origin/main.
- Integration is prepared in `/private/tmp/catalyst-main-integration`; validate before the normal main push.
  Do not force-push. Keep the historical feature branches and untracked `notes-demo/`.
- Website and demo install instructions now describe v0.2/recovery on main, while retaining the pending
  physical two-device validation. No website hosting configuration was found; Git push does not prove deployment.
- `project.md` was absent; project sources are README, PLAN, PROTOCOL, DEMO, this handover and docs/.

## Implemented
- One daemon per participant checkout; stdio MCP adapter and Claude hooks; durable signed SQLite event log;
  direct encrypted LAN/VPN peer sync, offline queueing, reconnect replay, conflict flags, dashboard and handover.
- Named subagents, per-agent decisions/claims/progress/unread/acks and addressed messages; shared task queue
  with dependencies/assignees; long-poll `wait_for_updates`; conversational setup, install and status tools.
- Runtime `checkpoint_task` / signed `task.checkpoint`: initial scope, agent-authored milestones, reminders
  after five edited-file events, bounded takeover context, graceful-stop checkpoint/release, session-scoped
  lead cleanup, and expected-claim guards on delayed releases. Lead approved the narrow shared-contract
  additions; sync frames/protocol version remain v2. Older v2 peers relay but do not project checkpoint events.
- Detailed checkpoints stay in ignored `.catalyst` SQLite/snapshots/inbox and sync through the existing link.
  They are excluded from generated root IMPORTANT.md. Public publish_progress remains Git-visible.
  Recovery events do not determine completion status; late checkpoints cannot reopen completed tasks.
- During known peer unavailability, queue selection (including explicit requests) preserves claims and limits
  new work to local assignments/eligible local handoffs. Claims remain advisory; manual claim_task can warn
  about overlap rather than lock files. Source changes still move through Git.

## Verification
- Recovery source milestone: typecheck, 197 unit/integration tests, build, 26 end-to-end tests, existing
  two-node demo and six Python results-validator tests passed. End-to-end tests use real local daemons with
  simulated agent calls; they are not physical two-device or live-model comparison results.
- Final integration checks: pending this session's run; replace this line with the actual result before push.
- Earlier v0.2 evidence: 186 tests, 25 e2e; two headless lead sessions each spawning two subagents completed
  3/3 queue tasks; resulting sample code passed 14 tests. Interactive setup was not established by that run.
- Historical evidence conflict retained: original PLAN said physical two-laptop verification was untested;
  the 2026-11-14 handover records v0.1 pairing, Q&A, replay, conflict flags and identical handover hashes on
  Tiam/Namit's laptops. Neither establishes the new v0.2/recovery two-laptop workflow.

## Decisions and boundaries
- Node >=22.13, built-in node:sqlite; MCP SDK v1, zod v4, commander, TypeScript, Vitest; static HTML/CSS/JS UI.
- TLS 1.2 PSK peer link; Ed25519 signatures, content-addressed ids, Lamport ordering, wall time display-only.
- Authenticate before dedupe/fork classification; conflicts preserve competing versions until explicit resolution.
- Retrieval/ack is recorded only for rendered records; MCP write retries and fallback drafts are idempotent.
- Protocol v2 cannot sync with v0.1 project data: create fresh projects and pair again on both devices.
- Invite lifetime depends on the entry point: CLI pair historically defaults to 15 minutes; MCP invite defaults
  to 30 minutes. Invites are single-use secrets; use each tool's actual result, not a blanket historical TTL claim.

## Known limits
- No NAT traversal/relay; same LAN or reachable VPN required. No distributed lock or guaranteed zero conflicts.
- Hard kill/power loss cannot send a final checkpoint/release. No crash detector or worker supervisor is built.
  Hooks cannot start idle Claude turns; running workers can wait/take tasks autonomously.
- Lead SessionEnd while daemon is down retains claims. Best-effort MCP/hook linking can retain unattributed
  lead claims. Offline stop drafts depend on snapshots; stop metadata may still say active without reconciliation.
- Cross-laptop takeover needs the source commit through Git; Catalyst does not transfer dirty worktrees.
- Interactive installation/setup/trust prompts and physical two-laptop v0.2/recovery validation remain pending.
- Lead rename via set_agent_name is not supported; daemon-down hook activity can be attributed to the lead.
- Full synchronous projection rebuilds are suitable for small logs; scaling needs measurement.
- npm's prepare build can make GitHub installation fail on a build error; cloning/building/linking is documented.
- Old configured Codex MCP server failed (`codex mcp-server` unavailable in that CLI); companion plugin was used.

## Branches and provenance
- main: integration target; includes Namit's website commit already present on origin/main.
- v0.2-agents (`ac5d01f`), feature/agent-recovery (`1f272b4`), website/project-update (`8c493e8`): retained
  historical branches, incorporated by this integration. They are local; origin exposed only main at the last fetch.
- Previous notes said these branches were unmerged/not pushed. That was accurate before this explicit merge request.

## Next steps
1. Finish final integration checks and normal push to main; verify origin/main matches the tested commit.
2. Tiam + Namit install the same main build on macOS/same Wi-Fi/same Claude model; re-pair fresh v2 projects.
3. Run docs/EXPERIMENT.md: Git+tracked-notes baseline only, no chat; 180-second peer-sync pause with Claude/Git
   online; retain raw measurements/failed trials outside Git. No comparison measurements are claimed yet.
4. Use docs/DEMO-PRESENTATION.md for the five-minute booth slot; measure beforehand and label shortened live
   illustrations. docs/ARCHITECTURE.md explains the stack; scripts/experiment-results.py plots measured CSVs.
