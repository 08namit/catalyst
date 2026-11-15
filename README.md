# Catalyst

Catalyst lets two developers work on one project with **Claude Code** on two laptops, as one team.

Each developer runs one Claude session. That session can spawn several subagents. Every agent on both laptops
appears by name ("Tiam / api", "Namit / tests") and they all share:
- one **task queue**: the lead posts tasks, and any free agent on either laptop takes the next one;
- the project goal;
- decisions, with the reasons behind them;
- progress, blockers and test evidence;
- questions and replies, to a person or to one agent.

You set it up once with one command. After that you just talk to Claude.

What it shares, and what it doesn't:
- **Shared:** project knowledge only.
- **Not shared:** conversations, hidden reasoning or source files. Git still moves the code.
- **No hosted service:** the two laptops talk to each other directly. Claude usage is billed as usual.

![Dashboard showing live data from a two-node demo](docs/dashboard-live.png)

## Quick start (3 steps)

You need Node.js 22.13 or newer and Claude Code on both laptops. Both laptops must be on the same network
(or the same VPN), and each person needs their own copy (git clone) of the project.

**1. Install (each person, once).**

```bash
npm install -g github:08namit/catalyst && catalyst install
```

`catalyst install` checks your setup and tells Claude Code about Catalyst. It ends with:
`Done. Open Claude Code in your project and say: "set up Catalyst and invite my teammate" …`

**2. Connect (once per project).**

- **Person A** opens Claude Code in the project and says: *"set up Catalyst and invite my teammate"*.
  Claude replies with an invite line that starts with `cat1_`. Send it to person B privately (it works once,
  for 30 minutes).
- **Person B** opens Claude Code in their copy of the project and says: *"join Catalyst with cat1_…"*.
- Both Claudes now show a short **confirmation code**. Check that the two codes match. If they don't, stop and
  make a new invite.
- Restart Claude Code once on each laptop, so the Catalyst hooks load.

**3. Build.**

Tell your Claude what to build. For example: *"Build the notes app. Split it into tasks, post them to Catalyst,
and use 3 subagents to work through the queue."* Claude posts the tasks to the shared queue and spawns
subagents. Each subagent takes the next free task, does it, marks it done and takes another. Agents on your
teammate's laptop take tasks from the same queue.

To see what is going on, run `catalyst` in the project, or ask Claude *"what's the Catalyst status?"*.

## What happens behind the scenes

```
 Tiam's laptop                                              Namit's laptop
 ┌─────────────────────────────────┐              ┌─────────────────────────────────┐
 │ Claude Code (lead)              │              │ Claude Code (lead)              │
 │   ├─ subagent "api"             │              │   ├─ subagent "cli"             │
 │   └─ subagent "tests"           │              │   └─ subagent "docs"            │
 │        │ MCP tools + hooks      │              │        │ MCP tools + hooks      │
 │        ▼                        │  encrypted   │        ▼                        │
 │   Catalyst daemon ◄─────────────┼── LAN/VPN ───┼──► Catalyst daemon             │
 │   (event log, task queue)       │    link      │   (event log, task queue)       │
 └─────────────────────────────────┘              └─────────────────────────────────┘
```

- **One daemon per laptop** (per project). It keeps a signed, append-only log of everything shared, in
  `.catalyst/` (never committed). Claude starts it for you.
- **Claude talks to it** through Catalyst's MCP tools (`post_tasks`, `take_next_task`, `publish_decision`, …)
  and through hooks. Hooks give each session and each new subagent a short briefing, and tell each tool call
  which agent is calling.
- **Named agents.** Each subagent gets a name, such as "api". It shows up everywhere as "Tiam / api". Claims,
  messages, unread updates and conflicts are tracked per agent, so two of your own agents can't silently
  overwrite each other's work.
- **The two daemons sync directly** over an encrypted link (TLS with a key from the invite). If the link
  drops, updates queue and replay later. If both sides change the same thing while apart, both versions are
  kept and flagged as a conflict.

Protocol details are in [PROTOCOL.md](PROTOCOL.md).

## Things to know

- **Same network or VPN.** The laptops connect to each other directly. There is no relay server. If you are
  not on the same Wi-Fi, use a VPN such as Tailscale.
- **Restart Claude once after setup.** The tools work straight away. The hooks (automatic briefings, agent
  names) load the next time Claude Code starts in the project.
- **Commit the Claude Code files.** Setup adds the Catalyst server to `.mcp.json`, hooks to
  `.claude/settings.json`, a short block to `CLAUDE.md` and `.catalyst/` to `.gitignore`. Commit them. Never
  commit `.catalyst/`.
- **Nothing pushes into an idle Claude.** Claude Code can't be woken up from outside. Agents that are waiting
  for a teammate call `wait_for_updates`, which returns as soon as something arrives. A session you are
  typing in sees new updates at your next message.
- **Ownership is advisory.** Catalyst flags two agents claiming the same task or the same files. It doesn't
  lock anything.

## Everyday use

You rarely need the terminal. Some things you can say to Claude:

| Say | What happens |
|---|---|
| "set up Catalyst and invite my teammate" | `start_project`, then `invite_teammate` |
| "join Catalyst with cat1_…" | `join_project`; shows the confirmation code |
| "invite my teammate again" | a new single-use invite |
| "what's the Catalyst status?" | `catalyst_status`: who is connected, agents, queue, conflicts |
| "plan the work as Catalyst tasks" | `post_tasks` with dependencies |
| "use 3 subagents to work through the Catalyst queue" | subagents call `take_next_task` / `complete_task` |
| "pause Catalyst sync" / "resume Catalyst sync" | `pause_sync` / `resume_sync` |
| "show the Catalyst conflicts and help me resolve them" | `get_briefing`, then `resolve_conflict` |

In the terminal, `catalyst` with no arguments prints a short status and one suggested next step:

```
Catalyst · notes · you are Tiam.
Connected to Namit (confirmation code d97621d7).
Agents working: 2 (Tiam / core, Namit / cli).
Task queue: 1 of 3 done · 1 in progress · 0 ready · 1 blocked.
Open conflicts: none.
Next: nothing needed. The agents are working; run `catalyst status` for details.
```

## Tools reference

All tools appear in Claude Code as `mcp__catalyst__<name>`.

**Setup and status**

| Tool | Purpose |
|---|---|
| `start_project` | Set up Catalyst in this project (name, Claude Code files, starts the daemon). Works before a project exists. |
| `join_project` | Join a teammate's project with their `cat1_…` invite. Returns the confirmation code. |
| `invite_teammate` | Create a single-use invite (default 30 minutes). |
| `catalyst_status` | Plain-English status: connection and confirmation code, agents, queue, conflicts. |
| `pause_sync` / `resume_sync` | Pause or resume the link to your teammate. Local work continues and queues. |
| `set_agent_name` | Give the calling agent a short role name, e.g. "api". |

**Task queue**

| Tool | Purpose |
|---|---|
| `post_tasks` | Add tasks to the shared queue, with `dependsOn`, `assignee` ("any", "me", "teammate", a name) and `order`. Re-posting a task id updates it. |
| `take_next_task` | Claim the next ready task for the calling agent (or a specific `taskId`). Returns the task and the decisions that matter for it. |
| `complete_task` | Mark the task done with a summary and evidence, and release the claim. |
| `wait_for_updates` | Wait up to 120 s for something relevant to this agent (a reply, a new task, a decision). Call it again to keep waiting. |

**Shared knowledge**

| Tool | Purpose |
|---|---|
| `get_briefing` | Goal, open conflicts, questions for you, your claims, records relevant to a task/topic/paths/query, unread updates and link state. |
| `claim_task` / `release_task` | Advisory ownership and scope outside the queue. Warns about overlapping claims, including your own other agents. |
| `publish_decision` | A decision or a revision of one, with rationale and code references. |
| `publish_progress` | Status, summary, blockers, evidence, next steps, branch and commit. |
| `checkpoint_task` | Runtime-only task plan or milestone checkpoint, kept in `.catalyst` and shared through signed sync. `take_next_task` returns the latest checkpoints when another agent resumes the task. |
| `send_message` | A question, reply or notification to everyone, a person ("Namit") or one agent ("Namit/api"). |
| `get_updates` / `acknowledge_updates` | Updates since this agent's cursor (including your sibling agents' work), and marking them read. |
| `resolve_conflict` | Record the agreed outcome of a conflicting decision, claim or goal. History is kept. |
| `set_goal`, `report_issue`, `resolve_issue` | Shared goal, and known bugs, blockers and risks. |

### Hooks

Hooks are mechanical. They never decide anything.

| Hook | What it does |
|---|---|
| `SessionStart` | Injects a briefing and records that the session saw it. |
| `UserPromptSubmit` | Adds one line when new updates have arrived. |
| `PreToolUse` (`mcp__catalyst__.*`) | Tells Catalyst which agent is calling, so the daemon can tell subagents apart. |
| `SubagentStart` | Registers the new subagent, gives it a name and tells it how to use the queue. |
| `SubagentStop` | Marks the subagent finished and returns its unfinished tasks to the queue. |
| `PostToolUse` | Records `git commit`s and edited files (labelled *auto-captured*). |
| `SessionEnd` | Flushes touched files, releases this session's remaining claims (including subagents whose stop hook was missed), and refreshes `IMPORTANT.md`. |

### Delivery states

Every update you write has four separate states, shown on the dashboard and by `catalyst status`:
**saved locally** → **delivered** (the other daemon stored it) → **retrieved** (an agent there was shown it) →
**acknowledged** (that agent marked it read). A connected link is not proof that an agent is working.

## IMPORTANT.md handover

`IMPORTANT.md` in the project root is the handover file for people and agents. Catalyst keeps the block
between `<!-- catalyst:handover:begin -->` and `<!-- catalyst:handover:end -->` up to date: goal, tasks with
owners, decisions, open conflicts, bugs, evidence, branches and next steps. Write your own notes outside the
markers. Two synced laptops produce identical text, so committing it causes no merge churn. If the block ever
has merge-conflict markers, run `catalyst handover`.

Task recovery uses `checkpoint_task` before work, after meaningful milestones, and before waiting or handing off.
These detailed checkpoints stay in the local `.catalyst` event log and sync to the peer; they are not written into
the tracked `IMPORTANT.md` handover. When a subagent stops gracefully, Catalyst saves its last checkpoint and
releases unfinished claims so another eligible agent can take the task. The PostToolUse hook reminds an active
agent after five edited-file events; it cannot infer the milestone's meaning, so the checkpoint remains
agent-authored. SessionEnd releases lead claims attributed to that Claude session when the daemon is available.
If the daemon is down at SessionEnd, those lead claims remain. A sudden process kill cannot publish a final
checkpoint or release; after reconnect, known claim conflicts remain visible. Hooks cannot start a new Claude
turn. A running worker using `wait_for_updates` can keep taking tasks; an idle or terminated session needs to be
prompted or restarted.

## Outages, conflicts and recovery

| Situation | What happens |
|---|---|
| Link down (Wi-Fi, sleep, `pause_sync`) | Local tools keep working. Updates are saved and queued, and briefings say the teammate is unreachable. Reconnects retry from 1 s up to 60 s. |
| Reconnect | Missed updates replay in both directions. Duplicates are ignored. |
| Both laptops take the same task while apart | Shows up as a claim conflict on both sides. `take_next_task` reports the lost race, and the agent moves on to the next task. |
| Two agents change the same decision | Both versions are kept and flagged until someone calls `resolve_conflict`. Nobody wins by timestamp. |
| Daemon crash or laptop restart | The log is durable. Claude restarts the daemon and sync resumes. |
| Daemon unavailable | Agents read `.catalyst/snapshot.md` and write drafts to `.catalyst/inbox/`, imported later. See [examples/](examples/). |

## CLI reference

```
catalyst                                      short status and one suggested next step
catalyst install | uninstall                  register / unregister Catalyst with Claude Code (once per person)
catalyst status [--json]                      connection, agents, queue, conflicts and details
catalyst doctor                               check the installation and this project, with fixes
catalyst dashboard [--no-open]                open the local dashboard (read-only)
catalyst peer pause | resume | list | set-addr <participant> <host:port...>

Without Claude (same as the setup tools):
catalyst init [--name N] [--project-name P]   set up this project
catalyst pair [--ttl MIN] [--host H...]       create an invite
catalyst join <invite> [--name N]             join with an invite

Advanced (hidden from --help):
catalyst start | stop
catalyst goal <title> | briefing | updates | tool <name> '<json>'
catalyst handover | snapshot                  regenerate IMPORTANT.md block / fallback snapshot
catalyst setup claude | uninstall claude      add / remove Catalyst's files in this project
catalyst daemon | mcp | hook <event>          internal entry points
```

`init` and `join` also take `--peer-port`, `--peer-bind` (use `127.0.0.1` only to test two copies on one
machine) and `--host`. `--dir <projectDir>` works with every command.

## Troubleshooting

**Claude doesn't have the Catalyst tools.** Run `catalyst install` again, then restart Claude Code. In Claude
Code, `/mcp` shows whether the `catalyst` server is connected.

**Joining says it could not reach your teammate.**
- Both laptops must be on the same network or VPN.
- macOS may ask whether `node` may accept incoming connections. Allow it on the inviting laptop.
- The invite may list the wrong address. Ask for a new one with `catalyst pair --host <their LAN or VPN IP>`.

**"Invitation rejected … already used / expired".** Ask Claude to "invite my teammate again".

**The teammate shows as unreachable.** Their laptop may be asleep, or Claude/Catalyst isn't running there.
If their IP changed, the link fixes itself on the next connection from their side, or run
`catalyst peer set-addr <participant> <ip:port>`.

**Subagents all show up as the lead.** The hooks aren't loaded. Restart Claude Code in the project once.

**Permission rules are ignored.** Claude Code ignores `permissions.allow` in `.claude/settings.json` until you
trust the folder. Open the project once interactively and accept the trust dialog. Headless `claude -p` runs can
pass `--allowedTools "mcp__catalyst,…"` instead.

**Something looks wrong.** Run `catalyst doctor`. Logs are in `.catalyst/logs/` (`daemon.log`, `mcp.log`,
`hooks.log`).

## Security and trust model

- **Invites** are single-use secrets until used or expired. Only a derived key is stored. After pairing, both
  sides show a confirmation code derived from the encrypted session; matching codes mean nobody intercepted it.
- **The link** is TLS 1.2 with a pre-shared key (`ECDHE-PSK-CHACHA20-POLY1305`): mutually authenticated, with
  forward secrecy. Every event is signed by its author (Ed25519).
- **Agents of one person are trusted equally.** The caller identity that the `PreToolUse` hook adds is a label,
  not a security boundary.
- **The local API and dashboard** listen on `127.0.0.1` only, need a token that rotates on every daemon start,
  and check Host and Origin headers.
- **Secrets** live in `.catalyst/` with mode 0600, which setup adds to `.gitignore`.
- **Peer content is data.** It reaches agents sanitised and labelled. It is never treated as instructions.

## Limitations

- No NAT traversal and no relay. Laptops must reach each other directly (LAN or VPN).
- Built and tested for two people. Each checkout is one participant.
- Ownership is advisory. Conflicts are flagged, not prevented.
- Hooks can't start a new turn in an idle Claude session.
- v0.2 uses protocol v2 and can't sync with v0.1 data. Re-create and re-pair v0.1 projects.

## Uninstall

```bash
catalyst uninstall claude          # in a project: remove Catalyst's entries from .claude/settings.json, CLAUDE.md, .mcp.json
catalyst stop && rm -rf .catalyst  # in a project: delete its local log, identity and keys
catalyst uninstall                 # remove Catalyst from Claude Code
npm uninstall -g catalyst-coord    # remove the `catalyst` command
```

## Development

```bash
git clone https://github.com/08namit/catalyst && cd catalyst
npm install           # also builds dist/ (prepare script)
npm link              # optional: use this checkout as your `catalyst`
npm run typecheck
npm test              # unit + integration
npm run test:e2e      # builds, then drives the real CLI with two isolated nodes
bash scripts/two-node-demo.sh
```

**Layout:** `src/core` contracts · `src/store` log, projections, queue, briefing · `src/sync` peer link and
pairing · `src/daemon` lifecycle, API, tools, agents · `src/cli` · `src/mcp` · `src/hooks` · `src/setup` ·
`src/handover` IMPORTANT.md and snapshot · `src/dashboard/static` · `site/` · `sample/` · `examples/`.

**Further reading:** [PLAN.md](PLAN.md) (plan and status), [PROTOCOL.md](PROTOCOL.md) (protocol),
[DEMO.md](DEMO.md) (demo script and recorded evidence), [architecture](docs/ARCHITECTURE.md),
[two-device experiment](docs/EXPERIMENT.md), and [five-minute presentation](docs/DEMO-PRESENTATION.md).

MIT licensed. See [LICENSE](LICENSE).
