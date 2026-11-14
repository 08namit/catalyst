# Catalyst

Catalyst connects two developers' **Claude Code** sessions running on separate laptops. Their agents share:
- the project goal;
- tasks and advisory ownership;
- decisions, with rationale;
- progress, blockers and verification evidence;
- questions and replies.

Each laptop runs a small local daemon. Agents use it through an MCP server, and Claude Code hooks deliver context
automatically at the start of a session. The two daemons sync directly with each other over an encrypted LAN link.

Each laptop keeps its own copy of the shared context. If the link drops, updates queue locally. When it comes
back, missed updates replay and contradictory decisions are flagged.

What it shares, and what it doesn't:
- **Shared:** project knowledge only.
- **Not shared:** conversations, hidden reasoning or source files. Git still integrates code.
- **No hosted service:** Catalyst has no backend you pay for. Claude usage is billed separately as usual.

![Dashboard showing live data from a two-node demo](docs/dashboard-live.png)

## Contents
- [How it works](#how-it-works)
- [Install (from source)](#install-from-source)
- [Quick start: two laptops](#quick-start-two-laptops)
- [Using it with Claude Code](#using-it-with-claude-code)
- [Working at different times and the IMPORTANT.md handover](#working-at-different-times-and-the-importantmd-handover)
- [Outages, conflicts and recovery](#outages-conflicts-and-recovery)
- [CLI reference](#cli-reference)
- [Troubleshooting](#troubleshooting)
- [Security and trust model](#security-and-trust-model)
- [Limitations](#limitations)
- [Uninstall](#uninstall)
- [Development](#development)

## How it works

```
 Laptop A                                                   Laptop B
 ┌───────────────────────────────┐                ┌───────────────────────────────┐
 │ Claude Code ─ hooks ──────┐   │                │   ┌────── hooks ─ Claude Code │
 │      │                    ▼   │  TLS 1.2 PSK   │   ▼                    │      │
 │  catalyst mcp ──► daemon ◄────┼──── (LAN) ─────┼──► daemon ◄── catalyst mcp    │
 │  (stdio)     127.0.0.1 API    │  signed events │   127.0.0.1 API     (stdio)   │
 │              SQLite log       │                │   SQLite log                  │
 │              dashboard        │                │   dashboard                   │
 └───────────────────────────────┘                └───────────────────────────────┘
```

**Daemon.** There is one daemon per project on each laptop, run by `catalyst daemon` (normally started for you). It owns:
- an append-only SQLite event log in `.catalyst/catalyst.db`, gitignored;
- the participant identity, an Ed25519 key;
- peer sync;
- a loopback HTTP API, which also serves the dashboard.

**MCP adapter.** `catalyst mcp` is a stdio MCP adapter. Claude Code starts one for each session, and it proxies
validated tool calls to the daemon. It logs to `.catalyst/logs/` and never to stdout.

**Hooks.** Claude Code hooks deliver a briefing at session start and a one-line notice when new peer updates
arrive. They also record commits and touched files mechanically.

**Peer sync.** Peers connect directly over TLS 1.2 with pre-shared keys (forward secrecy) and retry
automatically. Neither side is the coordinator: each stores the full history, replays what the other is missing
on reconnect, and verifies every event's signature.

Protocol details are in [PROTOCOL.md](PROTOCOL.md).

## Install (from source)

Catalyst is **not published to npm**. Install it from a clone:

```bash
# Prerequisites: Node.js ≥ 22.13 (24 LTS recommended), git, Claude Code
git clone <YOUR-CATALYST-REPO-URL> catalyst   # the URL of this repository or your fork
cd catalyst
npm install
npm run build
npm link            # puts `catalyst` on your PATH (remove with: npm unlink -g catalyst-coord)
catalyst --version
```

The hooks and `.mcp.json` call `catalyst` from your PATH. Both developers need it installed. A teammate without
it is unaffected, because the hooks are guarded and exit silently.

## Quick start: two laptops

Both laptops need a checkout of the same project, on the same network (LAN or VPN) and able to reach each other.

**Developer A** (creates the project):

```bash
cd ~/code/your-project
catalyst init --name "Tiam"   # creates .catalyst/ (gitignored), installs the Claude Code integration, starts the daemon
catalyst pair                 # prints a single-use invitation (valid 15 min) containing A's LAN address(es)
```

`catalyst init` writes `.mcp.json`, `.claude/settings.json` and a block in `CLAUDE.md`. Commit them so both
developers get the same integration:

```bash
git add .mcp.json .claude/settings.json CLAUDE.md .gitignore
git commit -m "Add Catalyst"
```

**Developer B** (joins). Send B the `cat1_…` token over a private channel, then on B's laptop:

```bash
cd ~/code/your-project        # B's clone
catalyst join cat1_…  --name "Namit"
```

Both sides print an 8-character **confirmation code**. Compare them by running `catalyst status` on A; they must match.

**Start Claude Code** in the project on both laptops (`claude`). In an interactive session, approve the
`catalyst` MCP server when prompted. The first SessionStart briefing appears automatically.

**Check the connection:**

```bash
catalyst status       # peer state, freshness, pending deliveries, sessions, conflicts
catalyst doctor       # installation, file permissions, daemon health, projection reproducibility, Claude setup
catalyst dashboard    # opens the local dashboard (optional; coordination does not depend on it)
```

If A has several network interfaces, or B cannot reach the advertised address, run `catalyst pair --host <A's LAN IP>`.

## Using it with Claude Code

### What the agents get

| MCP tool | Purpose |
|---|---|
| `get_briefing` | Goal, open conflicts, questions for you, your claims, records relevant to a task/topic/paths/query, unread updates and peer freshness. Bounded, with source IDs. |
| `claim_task` / `release_task` | Advisory ownership and intended scope. Warns about overlaps with other claims (same task or overlapping paths). |
| `publish_decision` | A decision or a revision of one, with a concise rationale and code references. Revisions supersede the current version. |
| `publish_progress` | Status, summary, blockers, verification evidence, next steps, branch and commit. |
| `send_message` | A question, reply or notification. |
| `get_updates` | Updates since this session's cursor, filterable by type, task, topic or paths. Says explicitly whether "no updates" means "peer is up" or "peer unreachable". |
| `acknowledge_updates` | Explicitly marks updates as consumed. By default this covers only what this session was shown. |
| `resolve_conflict` | Records the agreed resolution of a conflicting decision, claim or goal. History is preserved. |
| `set_goal`, `report_issue`, `resolve_issue` | Shared goal, and known bugs, blockers and risks. |

### Automatic capture vs agent-authored updates

**Hooks are mechanical.** They never decide anything:
- **SessionStart:** injects the briefing and records that this session retrieved context.
- **UserPromptSubmit:** prints one line only when new peer updates have arrived.
- **PostToolUse:** records `git commit`s and the files edited.
- **SessionEnd:** publishes the touched-file summary and regenerates `IMPORTANT.md`.

Captured items are labelled *auto-captured* everywhere.

**Agents write the meaningful records.** Decisions, progress summaries, questions and replies come only from
agent tool calls; the `CLAUDE.md` block tells agents when to make them.

**Fallback.** If hooks are unavailable, agents can still call `get_briefing` and `get_updates` explicitly.

**What hooks can't do.** Hooks cannot interrupt an agent's reasoning or start a new model turn. Peer updates
reach an agent at its next prompt, its next session, or when it calls a tool.

### Delivery states

Every update you author has four separate states. Each is visible on the dashboard and through `status`:

| State | Meaning |
|---|---|
| saved locally | committed to your SQLite log |
| delivered | the peer daemon durably stored it |
| retrieved | an agent session on the peer was shown it |
| acknowledged | the peer's agent explicitly marked it consumed |

A connected peer is not proof that an agent is working.

## Working at different times and the IMPORTANT.md handover

You don't need to work at the same time. Each laptop keeps the full shared history, and the daemons sync
whenever both happen to be running.

**At session start:**
- A new Claude session receives the latest briefing automatically.
- The briefing states whether updates are still awaiting synchronisation: "3 local updates awaiting delivery to
  Namit (unreachable since 14:02)".

**IMPORTANT.md** in the project root is the human- and agent-readable handover:
- **What it contains:** the goal, tasks with owner and status, decisions, open conflicts (all versions kept),
  known bugs and blockers, verification evidence, branches and commits, next steps, and the last update time
  and author.
- **How it's generated:** Catalyst regenerates the block between `<!-- catalyst:handover:begin -->` and
  `<!-- catalyst:handover:end -->` after material changes, at session end, and when you run `catalyst handover`.
- **Your own notes:** write them outside the markers; Catalyst preserves them.
- **Committing it:** the block is a deterministic function of the shared event log. Two synchronised laptops
  generate identical text, so committing it causes no merge churn.
- **Merge conflicts in the block:** run `catalyst handover` to regenerate it.

## Outages, conflicts and recovery

| Situation | What happens |
|---|---|
| Peer link down (Wi-Fi, sleep, `catalyst peer pause`) | Local tools keep working. Writes are saved and queued, and peer context is labelled stale or unreachable. Reconnection retries with backoff from 1 s up to 60 s. |
| Reconnect | Missed events are exchanged in both directions, whatever the gap or order, and duplicates are ignored. |
| Conflicting decisions or claims made while apart | Both versions are kept. The topic or task is flagged on both laptops and in the briefing, dashboard and IMPORTANT.md. It stays open until someone calls `resolve_conflict`. Neither side wins by timestamp. |
| Daemon crash or laptop restart | The log is durable (SQLite WAL, `synchronous=FULL`). The MCP adapter or the SessionStart hook restarts the daemon, which detects stale locks; sync then resumes. |
| Daemon or MCP unavailable | Agents read `.catalyst/snapshot.md`, which states its generation time, and write updates as JSON drafts in `.catalyst/inbox/`. The daemon imports them idempotently once it is back. Invalid drafts are kept in `inbox/rejected/` with an `.error.txt`. See [examples/](examples/). |
| Same history diverged (e.g. a restored `.catalyst/` backup) | Raises a fork alarm (`catalyst doctor`). Neither version is overwritten. |

## CLI reference

```
catalyst init [--name N] [--project-name P] [--peer-port N] [--peer-bind ADDR] [--host H...] [--no-setup] [--no-start]
catalyst pair [--ttl MIN] [--host H...]       create a single-use invitation
catalyst join <invite> [--name N] [--peer-port N] [--peer-bind ADDR] [--host H...] [--no-setup] [--no-start]
catalyst start | stop | status [--json] | doctor
catalyst peer pause | resume | list | set-addr <participant> <host:port...>
catalyst dashboard [--no-open]                 print/open http://127.0.0.1:<port>/#token=…
catalyst briefing [--task T] [--topic T] [--paths P...] [--query Q]
catalyst updates [--since N] [--limit N]
catalyst goal <title> [--description D] [--criteria C...]
catalyst tool <name> '<json>'                  call any tool as a human
catalyst handover | snapshot                   regenerate IMPORTANT.md block / fallback snapshot
catalyst setup claude | uninstall claude       idempotent Claude Code integration
catalyst daemon | mcp | hook <event>           internal entry points (used by start, .mcp.json, hooks)
```

`--dir <projectDir>` works with every command. The default is the nearest parent directory that contains `.catalyst/`.

## Troubleshooting

**`join` says it could not reach the inviter.**
- Both laptops must be on the same network.
- macOS may ask whether `node` may accept incoming connections. Allow it, or allow inbound TCP on the peer port
  shown by `catalyst status`.
- Retry with `catalyst pair --host <reachable-ip>`.

**"Invitation rejected … already been used / expired".** Create a new one with `catalyst pair`.

**Peer shows `unreachable`.**
- The other daemon isn't running: run `catalyst start` there.
- Its IP changed: run `catalyst peer set-addr <participant> <ip:port>`, or simply reconnect. Every connection
  refreshes the stored addresses.

**Claude doesn't see Catalyst tools.**
- Run `catalyst doctor`.
- Run `/mcp` in Claude Code to check that the `catalyst` server is approved and connected.
- Restart Claude Code after `catalyst init` or `join`.

**Permission rules are ignored.** Claude Code ignores the `"mcp__catalyst"` entry in `permissions.allow` from
`.claude/settings.json` until the workspace is trusted. Open the project once interactively and accept the
trust dialog. Headless `claude -p` runs can pass `--allowedTools "mcp__catalyst,…"` instead.

**Something looks wrong.** Look in `.catalyst/logs/` (`daemon.log`, `mcp.log`, `hooks.log`). Run `catalyst status --json` for machine-readable state.

## Security and trust model

**Invitations.**
- An invitation token is a **bearer secret** until it is used, or expires after 15 minutes. It is single-use.
- Only a derived key is stored on disk.
- After pairing, both sides show a confirmation code derived from the TLS session. Compare the codes to detect interception.

**Peer link.**
- TLS 1.2 PSK (`ECDHE-PSK-CHACHA20-POLY1305`) with a random 32-byte pair key, bound to the project ID. It is
  mutually authenticated and has forward secrecy.
- Every event is Ed25519-signed by its author.
- Forged, tampered, wrong-project and incompatible-protocol data is rejected with an actionable error.

**Local API and dashboard.**
- They listen on `127.0.0.1` only.
- Each request needs a bearer token that rotates with every daemon start and is stored in `.catalyst/daemon.json` (mode 0600).
- Host and Origin headers are checked to block DNS rebinding and CSRF.
- This listener is separate from the peer listener (`peerBind:peerPort`, default `0.0.0.0`).

**Secrets.** `identity.json`, `secrets.json` and `daemon.json` live in `.catalyst/` with mode 0600, and setup
adds `.catalyst/` to `.gitignore`. Nothing secret goes into `IMPORTANT.md`, the snapshot or the examples.

**Peer content is data.** It reaches agents sanitised, quoted and labelled as shared project data. It is never
treated as instructions or as permission to run commands.

## Limitations

**Networking.**
- No NAT traversal and no hosted relay. Peers must reach each other directly (LAN or VPN).
- An invitation carries the address; a code alone cannot find a laptop.

**Coordination.**
- Ownership is advisory and conflicts are flagged, not prevented. There is no distributed consensus.
- Catalyst can't keep a cloud model running or reach it without connectivity to the model provider.
- Hooks can't interrupt reasoning or start new turns. Agents see peer updates at their next prompt or tool call.

**Scope.**
- Built and tested for two developers. Relaying to a third participant is designed in but only lightly tested.
- Each checkout or worktree is a separate participant.

**Session tracking.** The MCP adapter and the hooks are linked to the same Claude session on a best-effort
basis, via the Claude process ID.

## Uninstall

```bash
catalyst uninstall claude     # removes only Catalyst's entries from .mcp.json, .claude/settings.json and CLAUDE.md
catalyst stop
rm -rf .catalyst              # deletes the local event log, identity and pair keys for this project
npm unlink -g catalyst-coord  # removes the `catalyst` command
```

## Development

```bash
npm install
npm run typecheck
npm test              # unit + integration (store, sync over real TLS, daemon, MCP, hooks, setup, dashboard)
npm run test:e2e      # builds, then drives the real CLI with two isolated nodes (separate dirs/dbs/identities/ports)
bash scripts/two-node-demo.sh   # narrated two-node demo on one machine
```

**Layout:**
- `src/core`: contracts.
- `src/store`: SQLite log, projections, briefing.
- `src/sync`: TLS-PSK peer protocol and pairing.
- `src/daemon`: lifecycle, API, inbox.
- `src/cli`.
- `src/mcp`.
- `src/hooks`.
- `src/setup`.
- `src/handover`: IMPORTANT.md and the snapshot.
- `src/dashboard/static`.
- `site/`: static setup page.
- `sample/`: demo app.
- `examples/`.

**Further reading:** [PLAN.md](PLAN.md) has the plan and its status, [PROTOCOL.md](PROTOCOL.md) the protocol,
and [DEMO.md](DEMO.md) the demo script and recorded evidence.

MIT licensed. See [LICENSE](LICENSE).
