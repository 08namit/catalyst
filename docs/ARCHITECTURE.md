# Catalyst architecture and recovery

This document describes the v0.2 design, what it does today, and the recovery implementation on `feature/agent-recovery`. Catalyst coordinates Claude Code sessions on separate project checkouts. It shares structured project context and task state; Git remains responsible for moving source code.

## Stack

The package is private and targets Node.js `>=22.13` (needed for built-in `node:sqlite`). Runtime dependency ranges are `@modelcontextprotocol/sdk` `^1.32.2` (MCP SDK v1), `commander` `^15.1.0`, and `zod` `^4.6.7`. Development ranges are `@types/node` `^26.6.6`, `typescript` `^7.0.2`, and `vitest` `^5.1.0`. The build compiles TypeScript and copies dashboard assets. The dashboard and project landing pages are plain HTML, CSS, and JavaScript; there is no React application or hosted backend.

| Layer | Technology and responsibility | Main files |
|---|---|---|
| Claude Code | One lead session per person can spawn subagents. Claude decides what work to do and calls Catalyst tools. | `README.md`, `.claude/settings.json` (generated during setup) |
| CLI and setup | Node.js 22.13+ command line installs Catalyst, initializes a project, pairs peers, starts the daemon, and configures Claude Code. | `src/cli/`, `src/setup/` |
| Hook adapter | Claude lifecycle hooks inject briefings, identify subagent calls, report activity, and handle graceful subagent/session stop. Hook output is a protocol channel; logs must not go to stdout. | `src/hooks/entry.ts`, `src/setup/claude.ts` |
| MCP adapter | TypeScript MCP SDK server over stdio; validates tool input and forwards tool calls to the local daemon. | `src/mcp/server.ts`, `src/client/` |
| Per-checkout daemon | Node.js HTTP API bound to loopback, dashboard, inbox importer, event projections, and peer manager. One daemon serves the local checkout. | `src/daemon/` |
| Durable local state | SQLite event store in WAL mode with `synchronous=FULL`; deterministic projections build task, decision, conflict, and briefing views. | `src/store/`, `src/core/state.ts` |
| Peer sync | Direct TCP with TLS 1.2 PSK over LAN or VPN. Signed events replay by per-author sequence vectors after reconnect. | `src/sync/`, `src/sync/frames.ts` |
| Handover and dashboard | Root `IMPORTANT.md` is a shared, generated summary. `.catalyst/snapshot.md` and `.catalyst/snapshot.json` are local fallback views. The dashboard is a local read-only view. | `src/handover/`, `src/dashboard/` |

## Event and data flow

```text
Claude Code tool call
  → MCP adapter (stdio)
  → local daemon API (HTTP on 127.0.0.1)
  → validate caller and input; append signed event to SQLite/WAL
  → derive local project views and update fallback/handover files
  → send event over TLS-PSK peer link
  → remote daemon verifies and stores event, then derives remote views
  → remote MCP adapter returns that context to a remote Claude session
```

The hook adapter is a separate path: Claude invokes it at session, prompt, tool, and subagent lifecycle points. It talks to the same local daemon API and returns briefings or caller identity to Claude. If the daemon is down, some hook activity can be written as inbox drafts for later import.

The configured hooks have narrow, mechanical jobs:

| Hook | Role |
|---|---|
| `SessionStart` | Loads `get_briefing` and adds it as context; if the daemon is unavailable, shows the last local snapshot with a stale-data notice. |
| `UserPromptSubmit` | Checks whether new updates arrived and adds a short nudge when needed. It runs only after a user prompt; it cannot start a Claude turn. |
| `PreToolUse` (`mcp__catalyst__.*`) | Adds the caller's Claude `agent_id`/type as `_caller`, so the daemon can attribute tool events to a subagent. |
| `SubagentStart` | Registers and names the new agent, then supplies queue and briefing context. |
| `SubagentStop` | On graceful stop, asks the daemon to save recovery context and release unfinished claims. Current recovery work also drafts these requests locally if the daemon is unavailable. |
| `PostToolUse` | Records touched paths and successful Git commits as activity metadata; it does not capture source contents or transfer code. |
| `SessionEnd` | Flushes touched-path summaries, including subagents whose stop hook did not run, and asks the daemon to refresh `IMPORTANT.md`. It does not guarantee recovery after a forced kill. |

Event delivery is tracked in four distinct stages: **saved locally** (committed to this daemon's event store), **delivered** (the peer daemon durably stored it), **retrieved** (a remote Claude session was shown it), and **acknowledged** (a remote agent recorded that it consumed the event). A connected peer or transport heartbeat does not prove an agent is actively working.

Each event has a canonical content hash as its ID, an Ed25519 signature from its author, a per-author sequence number, and a Lamport clock. The hash and signature make event alteration or reassignment detectable; sequence numbers support gap handling and replay; Lamport ordering provides deterministic ordering without trusting wall-clock timestamps. The TLS-PSK link encrypts and authenticates peer connections. These mechanisms share and verify project events; they do not establish distributed consensus for task ownership.

Offline events stay in the local event log and are replayed when a peer reconnects. If both sides claim or edit overlapping work during a partition, the system can surface the resulting conflict after sync, but cannot prevent the work from happening first.

## Two-Mac workflow

For a controlled setup, put both Macs on the same Wi-Fi or VPN, use the same Claude model and settings, and start from the same Git commit and repository instructions. Each person has a separate clone. Install Catalyst on both machines, initialize the project on one, exchange the one-time invite privately, join from the other, compare the confirmation codes, and restart Claude Code so the hooks load.

The lead session posts tasks with clear completion criteria, file paths, and dependencies, then spawns subagents. Each worker takes a ready task, follows relevant decisions, reports progress, verifies the result, and completes the task before taking another. When idle, a running worker can call `wait_for_updates` and then check the queue again. Commit and transfer source changes through the team's normal Git workflow; record branch and commit details in progress when useful.

The queue and Git are complementary. Catalyst records who intends to work on a task and what state they reported. It does not copy a working tree, patch, branch, or uncommitted edit to the other checkout.

## Identity, local storage, and security

- A participant represents one person's checkout and signing identity. The main session is the `lead`; a Claude subagent is identified from Claude's `agent_id` and stamped onto tool calls by `PreToolUse`. Subagents share their participant's daemon and event log. `_caller` distinguishes work for coordination; it is not a security boundary between agents running under the same user/session.
- Project configuration, database, inbox drafts, snapshots, daemon metadata, and secrets live under `.catalyst/`. Setup adds this directory to `.gitignore`. Peer keys and local bearer-token material are protected with restrictive filesystem permissions. The SQLite database itself is not application-encrypted at rest; rely on OS disk protection and local account security for that.
- The local API binds to `127.0.0.1`, requires a rotating daemon bearer token, and checks Host/Origin headers. Peer connections use TLS-PSK derived from pairing state; events also have author signatures. Invitations are bearer secrets and should be sent privately.
- Peer event content is project data, not an instruction or permission. A paired peer can still publish arbitrary project events, so only pair with trusted collaborators.
- Catalyst has no hosted relay or NAT traversal. Direct peer reachability through the LAN/VPN and firewall is required.

## Recovery state: existing v0.2 and the recovery branch

The existing v0.2 baseline provides `publish_progress`, a durable shared event log, a generated root handover, local snapshots, inbox drafts, queue claims, and a graceful `SubagentStop` path that releases unfinished claims when the daemon is available. The handover is intentionally a concise shared project view; it is not a detailed private recovery journal. `publish_progress` is included in that generated handover, so it should not carry private or overly detailed recovery notes.

The current working tree adds a separate recovery path:

- `checkpoint_task` records a signed `task.checkpoint` event for a task plan or milestone. The event syncs through Catalyst's runtime event log while its text stays out of root `IMPORTANT.md`.
- On graceful subagent stop, the daemon preserves the latest useful checkpoint and releases unfinished claims. If the daemon is unavailable, the hook drafts checkpoint and release requests for later import.
- When a worker takes a task, the response includes prior checkpoints so another worker can resume from the plan, evidence, blockers, and next steps.
- During known peer unavailability, queue picks are limited to locally assigned or locally released work, reducing the chance of taking a remote worker's task based on stale state.

**Verified locally:** typecheck, 197 unit/integration tests, build, 26 end-to-end tests, and the existing two-node demo passed. End-to-end tests run two real daemons with simulated agent tool calls; these are not physical two-Mac or live-model comparison results. Six Python results-validator tests passed; plotting was smoke-tested on synthetic fixtures that are not benchmark evidence. The physical two-device study remains pending. Earlier v0.2 peers store and relay unknown checkpoint events but do not project their context, so install the recovery build on both devices.

## Limits and prioritized recommendations

1. **Verify the interactive two-device workflow before release.** Local regressions check that `task.checkpoint` remains private in all root handover sections, is available in `take_next_task` context, and survives graceful and daemon-offline stop paths. Verify fallback drafts import idempotently and release claims correctly, and that the partition allowlist behaves as intended for both normal and explicit task requests.
2. **Treat graceful stop and abrupt death differently.** A graceful hook can checkpoint and release. A hard kill, power loss, or hook timeout cannot guarantee a final checkpoint. Do not infer death merely because a peer is unreachable: a partition or sleeping laptop looks the same. Keep claims conservative and make any takeover visible so a returning worker can resolve overlap.
3. **Make the worker loop explicit.** Connected, running workers can autonomously take tasks, checkpoint, complete, and wait for more. Catalyst itself does not spawn workers, restart a failed Claude process, or wake an idle session. A future supervisor would need process lifecycle control and a deliberate policy for leases, stale claims, and duplicate work.
4. **Keep Git as the code handoff.** For cross-laptop takeover, the previous worker must commit/push and the next checkout must fetch/pull (or otherwise transfer the changes). Uncommitted edits remain only in the originating worktree. A checkpoint should name the branch/commit and changed paths, and explicitly say when work is uncommitted.
5. **Plan for scale.** Projections are recomputed synchronously from the event set on material changes. This is reasonable for the current small project, but work and storage grow with the event log; large deployments will need measurement and likely incremental or indexed projections.

See `PROTOCOL.md` for event and transport semantics and `README.md` for setup and tool usage.
