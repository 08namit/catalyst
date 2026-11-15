# Catalyst protocol (v2)

This document describes Catalyst's event model, its synchronisation protocol and its conflict semantics. The
normative types are in `src/core/protocol.ts`, `src/core/state.ts`, `src/core/api.ts`,
`src/core/interfaces.ts` and `src/sync/frames.ts`.

**What changed in v2:**
- Events carry an optional, signed `agent` field: which agent inside the participant wrote it (section 2a).
- New event type `agent.registered` names an agent and marks it active or finished.
- Ownership is per agent: decision heads, claims, progress, acknowledgements and unread state (section 7).
- Messages can be addressed to one agent: `to: "p_…/<agent>"`.
- `task.created` has queue fields (`dependsOn`, `assignee`, `order`), and tasks have a derived `ready` flag
  (section 2b).
- `conflict.resolved` can name the owning agent (`ownerAgent`).
- v1 and v2 nodes refuse each other (`incompatible_protocol`). v0.1 data is not migrated.

Catalyst shares **project knowledge**: goals, tasks, ownership claims, decisions, progress, issues, questions and
acknowledgements. It never shares conversations, hidden reasoning or source files. Git still integrates code.

## 1. Participants and identity

- Each checkout of a project that runs `catalyst init` or `catalyst join` is one **participant**.
- On creation the participant generates an Ed25519 key pair, stored in `.catalyst/identity.json` with mode 0600.
- Participant IDs are self-certifying: `p_` followed by the first 24 hex characters of `sha256(publicKey DER)`.
- A participant's first event (seq 1) is `participant.joined`, which carries its public key. Pairing also
  exchanges keys, so events can be verified before that event arrives.
- Project IDs are random: `prj_` followed by 24 hex characters. Every event, frame, invite, pre-shared key (PSK)
  and database is bound to one project ID. If a database belongs to a different project, opening it fails.

## 2. Events

```jsonc
{
  "v": 2,                      // protocol version
  "id": "<sha256 hex>",        // sha256(canonicalJson(body)); body = all fields except id and sig
  "project": "prj_…",
  "author": "p_…",
  "seq": 7,                    // per-author sequence, contiguous from 1, assigned only by the author's daemon
  "lc": 42,                    // Lamport clock: 1 + max(lc of all events the author had stored)
  "ts": "2026-11-14T17:02:11.123Z",   // display only; never used for ordering or conflict resolution
  "type": "decision.recorded",
  "payload": { … },            // validated per type (zod)
  "refs": { "task": "api-create-task", "topic": "api/create-task", "paths": ["sample/server/"] },
  "supersedes": ["<event id>", …],   // versions this event revises
  "origin": "agent",           // agent | hook | human | fallback | system
"  "session": "claude:…",       // informational
  "agent": "a7a6a241124692d30", // v2: agent key inside `author`; absent = the lead (main session)
  "sig": "<base64 Ed25519 signature over canonicalJson(body)>"
}
```

**Canonical JSON** sorts keys recursively by code point and omits `undefined` values.

**Types:**
- `project.created`
- `participant.joined`
- `goal.set`
- `task.created`
- `task.claimed`
- `task.released`
- `decision.recorded` (`proposed` | `accepted`)
- `progress.reported` (status, summary, blockers, evidence, next steps, branch, commit)
- `issue.reported` / `issue.resolved` (bug | blocker | risk)
- `message.posted` (question | reply | notification; `replyTo`, `to`)
- `conflict.resolved`
- `ack.recorded` (explicit consumption)
- `activity.captured` (hook-captured commits and touched files, always `origin: "hook"`)
- `agent.registered` (v2: names an agent of the author; `active: false` when it finished)

**Forward compatibility:** if an event has an unknown `type`, or `v` is greater than 2, it is validated
structurally, verified, stored and relayed. Projections ignore it.

**Ordering:** the deterministic total order is `(lc, author, seq)`, compared by code point. Timestamps are only shown to people.

## 2a. Agents (v2)

One participant (one person's checkout) can run several agents: the main Claude session and the subagents it
spawns. They share the participant's key, daemon and log, but Catalyst tells them apart.

**Agent key.** `agent` is a short key matching `^[a-z0-9][a-z0-9._-]{0,63}$`.
- `lead` is the main session, and every event without an `agent` field.
- A subagent's key comes from Claude Code's `agent_id` (lowercased, invalid characters replaced, at most 64
  characters; `agentKeyFromId` in `src/core/protocol.ts`).
- The field is part of the signed body, so a peer can't reassign an event to another agent.

**Agent address.** `"<participantId>/<agent key>"`, for example `p_4c2d…/a7a6a241124692d30`. It is used for
claim owners (`ownerKey`) and for messages to one agent.

**`agent.registered`** `{agent, name, agentType?, active?}`. The event's own `agent` field must equal
`payload.agent`. The latest version per (author, agent) in deterministic order wins.
- `name` is a short role name (1-40 characters, letters, digits, space, `.`, `_`, `-`). The default is
  `<agentType>-<n>`, for example `general-purpose-2`. An agent renames itself with `set_agent_name`.
- Agents are shown as `<person> / <name>` ("Tiam / api"). The lead is shown as just `<person>`.
- `active: false` means the agent finished.

**Who is calling (`_caller`).** All of a person's agents share one MCP connection, so the daemon learns the
caller from a hook:
- A `PreToolUse` hook with matcher `mcp__catalyst__.*` returns `updatedInput` with
  `_caller: {agentId, agentType}`, taken from Claude Code's hook input. The main thread has no `agent_id` and
  is treated as `lead`.
- Every tool accepts `_caller`. Models must not pass it; the hook overwrites it.
- **This is not a security boundary.** All agents of one person run in the same Claude session with the same
  permissions and are trusted equally. `_caller` keeps their work apart; it doesn't protect them from each
  other. Without the hook, every call counts as `lead`.

**Subagent lifecycle hooks.**
- `SubagentStart` registers the agent (`POST /api/agents`): the daemon picks a default name unless the agent
  already has one, appends `agent.registered {active: true}`, and returns text for the hook's
  `additionalContext`: who the agent is, how to use the queue (`take_next_task`, `complete_task`,
  `wait_for_updates`), and a short briefing.
- `SubagentStop` (`POST /api/agents/stop`) appends `agent.registered {active: false}` and releases the agent's
  live claims on tasks that are not done (reason "agent finished"), which returns them to the queue.

## 2b. Task queue (v2)

`task.created` has optional queue fields:

| Field | Meaning |
|---|---|
| `dependsOn` | Task ids that must be `done` before this task is handed out. |
| `assignee` | A participant id, or `"any"` (default). Tools also accept "me", "teammate" or a name and resolve it. |
| `order` | Lower first, ties by task id. Default: the position of the task's first `task.created`. |

Re-posting a task id (a later `task.created`) updates it; the latest version in deterministic order wins. A
task is **ready** when it has a `task.created` and every task in `dependsOn` is `done`.

**Picking the next task** (`pickNextTask` in `src/store/queue.ts`, used by `take_next_task`). For agent `a`
of participant `me`, in this order:
1. If a `taskId` is given, that task (if it exists and is not done), even if it is not ready. The result says so.
2. A task this agent already holds a live claim on that is not done (resume).
3. Otherwise the first task, ordered by assignee (assigned to `me` first, then `"any"`), then `order`, then task
   id, that:
   - is ready;
   - has no live claim by anyone;
   - is not done or abandoned;
   - is not assigned to another participant;
   - has paths that don't overlap any live claim of another agent.

The result also reports `remaining` (tasks not done) and `blocked` (tasks waiting on dependencies, with what
they wait for). The daemon serialises writes, so on one laptop `take_next_task` never hands the same task to
two agents.

**Across laptops** two agents can take the same task while the link is down or before it syncs. That shows up
as a normal claim conflict on both sides (section 7). `take_next_task` reports the lost race, and the agent
releases the task and takes the next one.

`complete_task` publishes `progress.reported {status: "done"}` with the summary and evidence, then releases the
agent's claim.

## 2c. Waiting instead of stopping (v2)

Nothing can start a turn in an idle Claude session. Instead, an agent that is waiting calls
`wait_for_updates {timeoutSec ≤ 120, task?, topic?}`. The daemon holds the request open and returns as soon as
something relevant to this agent arrives, for example a message to it (or to its person, or to everyone), a
reply to its question, or a change on the given task or topic. Otherwise it returns `timeout` and the agent
calls it again. Like `get_updates`, it skips the calling agent's own events.

## 3. Storage semantics

- **Durable first.** An event is committed to SQLite (WAL, `synchronous=FULL`) before any attempt to deliver it.
- **Deduplication.** Events are deduplicated by `id`. Appending again with the same `clientId` (an inbox draft
  UUID, or `commit:<hash>`) returns the original event.
- **Gaps.** Suppose an author's highest contiguous stored seq is n. An event with seq > n + 1 is *parked*. It is
  still durably stored and still acknowledged, but it is not applied until the gap is filled. Parked events are
  then drained in seq order.
- **Forks.** If the same `(author, seq)` arrives with a different `id`, the store raises a **fork alarm** and
  never overwrites either event. This can happen when a `.catalyst/` directory is restored or copied.
- **Projections.** Goals, tasks, claims, decisions, conflicts, questions and issues are pure functions of the
  stored event set, sorted deterministically, so they can be reproduced from history. `catalyst doctor` recomputes
  them from scratch and compares the result with the cache.

## 4. Delivery and consumption

These four states are deliberately kept separate:

| State | Meaning | Evidence |
|---|---|---|
| saved locally | committed to this node's SQLite | row in `events` |
| delivered | the peer durably stored it | direct `ack` frame from that peer, or covered by the peer's `hello` vector |
| retrieved | an agent session on the peer was shown it (`get_briefing` / `get_updates`) | the peer's `status` frame (`retrieved` ids) |
| acknowledged | an agent on the peer explicitly marked it consumed | an `ack.recorded` event authored by the peer |

A heartbeat or a connected socket does not prove that an agent is working.

**Per agent (v2).** `ack.recorded` carries the acknowledging agent in its `agent` field, and unread state is
computed per agent. An event counts as acknowledged by a person when any of their agents acknowledged it.
`get_updates` hides only the calling agent's own events, so sibling agents on the same laptop see each other's
work. A message addressed to `p_…/<agent>` counts as unread, and as a question, only for that agent.

## 5. Peer transport

- TCP with TLS 1.2 PSK. Cipher suites are `ECDHE-PSK-CHACHA20-POLY1305` (preferred) and
  `ECDHE-PSK-AES256-CBC-SHA384`, so sessions have forward secrecy. No certificates are needed.
- PSK identities, which are not secret:
  - `catalyst/1/<projectId>/<participantId of the connecting side>` for paired peers;
  - `catalyst-invite/1/<projectId>/<inviteId>` for invitations.
- PSK derivation (HKDF-SHA256, 32 bytes):
  - paired: `HKDF(pairKey, salt = projectId, info = "catalyst-psk-v1|" + sortedIds.join("|"))`;
  - invite: `HKDF(secret, salt = projectId, info = "catalyst-invite-v1|" + inviteId)`.
- If the server doesn't recognise the identity, the TLS handshake fails.
- Limits:
  - 10 s handshake timeout;
  - 4 MB maximum frame size;
  - 200 events per frame;
  - 8 connections per IP;
  - 45 s idle timeout, with a ping every 15 s.
- Frames are newline-delimited JSON (see `src/sync/frames.ts`).

### Session

1. Both sides send `hello {protocol, software, project, participant, name, addrs, vector}`. The `vector` maps
   each author to the highest contiguous seq this side holds.
2. The receiver checks the hello:
   - If the project doesn't match, it sends `error wrong_project` (fatal).
   - If the protocol version doesn't match, it sends `error incompatible_protocol` (fatal). The error names both versions.
   - On an inbound connection, `participant` must equal the PSK identity.
3. The receiver then:
   - saves the peer's advertised addresses;
   - marks everything covered by the peer's vector as delivered;
   - replays, for every author it knows, the events with seq > `vector[author]`, in ascending seq order and in
     batches (`events {replay: true}`).
4. **Live operation:**
   - Newly appended or ingested events are pushed straight away (`events {replay: false}`). They are never echoed
     back to the peer they came from.
   - The receiver ingests them and replies `ack {ids}`, covering accepted, duplicate and parked ids.
   - `status` frames carry the receiver's retrievals of the peer's events and its session list.
5. **Duplicate connections:** the connection dialled by the lexicographically smaller participant ID survives.
   Replay starts again from that connection's `hello`, so no event is lost.
6. **Reconnect:**
   - Each side dials every known address. Failures back off exponentially with full jitter, from 1 s up to 60 s.
   - `pause_sync` (or `catalyst peer pause`) closes every peer connection and stops dialling and accepting peer connections; local tools keep working.
   - `resume_sync` (or `catalyst peer resume`) restarts sync.

Because replay is driven by vectors, missed updates are exchanged on reconnect whatever the outage cause:
network loss, a sleeping laptop, daemon restart, or a pause. Events relayed through a third participant are
verified against the original author's signature.

## 6. Pairing

1. `invite_teammate` (or `catalyst pair`) runs on a node with the daemon running and creates an invitation. The token is
   `cat1_` + base64url(JSON) and contains:
   - `{v: 1, project, projectName, inviteId, secret (32 random bytes), addrs: ["host:port", …], exp, inviter}`.
   - Addresses default to the node's non-internal IPv4 interfaces; override them with `--host`. A pairing code
     on its own could not locate a laptop.
   - Invitations expire after 30 minutes by default (`invite_teammate`, `catalyst pair`) and can be used once. Only the derived invite PSK is stored, never the secret.
2. `join_project` (or `catalyst join <token>`):
   - dials each address using the invite PSK;
   - sends `join_request {project, inviteId, participant, name, publicKey, addrs}`.
3. The inviter:
   - checks that the participant ID matches the public key;
   - consumes the invite atomically, so a second use fails;
   - generates a random 32-byte `pairKey`;
   - replies `join_accept {project, inviter, pairKey, confirmCode}` and closes the connection.
4. Both sides store the peer (name, public key, pair key, addresses) in `.catalyst/secrets.json` (mode 0600,
   gitignored, bound to the project ID). Normal sync starts on a new connection using the paired PSK.
5. Both sides display a confirmation code: 8 hex characters from the TLS exporter
   `catalyst-confirm-v1`. A party that stole the token and intercepted the join would produce different codes on
   the two sides. In v2 the inviter's `catalyst_status` shows the code too, so both Claudes can show it.

### Trust model

- The invitation token is a **bearer secret** until it is used or expires. Share it over a private channel.
- After pairing:
  - every peer connection is mutually authenticated by the pair key;
  - the link is encrypted with forward secrecy;
  - every event is signed by its author.
- A peer can publish any project data it wants. Catalyst treats peer content as **data**: it is quoted,
  sanitised and labelled as such for agents. It is never a command or a permission.
- The local API listens only on `127.0.0.1`:
  - Requests need a bearer token from `.catalyst/daemon.json` (mode 0600). The token rotates every time the daemon starts.
  - Host and Origin headers are checked to block DNS rebinding and cross-site requests.
- The dashboard is served on that same loopback listener. It is separate from the peer listener (`peerBind:peerPort`).
- Catalyst has no NAT traversal and no relay. Peers must be able to reach each other directly, for example on
  the same LAN or VPN, with the peer port allowed through the firewall.

## 7. Conflicts ("heads")

For each conflict family, an event is a **head** if no event of that family lists it in `supersedes`.

| Family | Key | Events | Default `supersedes` on write |
|---|---|---|---|
| decision | topic | `decision.recorded`, `conflict.resolved{scope: decision}` | current heads of the topic written by the same (author, agent) |
| claim | task | `task.claimed`, `task.released`, `conflict.resolved{scope: claim}` | the same (author, agent)'s own live claim heads |
| goal | `goal` | `goal.set`, `conflict.resolved{scope: goal}` | current goal heads |

**Ownership is per (author, agent) in v2.** Two agents of the same person are two owners.

**Decisions and goals:**
- They are in conflict when there is more than one head. This happens when two participants revise the same
  version while disconnected, or create the same topic concurrently.
- A decision's default `supersedes` covers only heads by the same (author, agent). If two of your own agents
  publish on one topic, that makes two heads, which is a conflict, not a silent overwrite. An explicit
  `supersedes` can still revise any head.

**Claims:**
- Releases are never heads. `release_task` releases only the calling agent's claims.
- A task is in conflict when its live claim heads have more than one distinct owner key (`participant/agent`).
- Claims are advisory. Catalyst does not claim distributed consensus.

**Progress** is kept per (author, agent); a task's status comes from the latest report in deterministic order.

**Overlapping paths:**
- Claims on different tasks with overlapping `paths` produce **warnings** rather than conflicts. In v2 this
  includes overlaps with your own other agents.

**Resolving a conflict:**
- Nothing is resolved by "latest timestamp wins".
- A conflict stays open until someone records `conflict.resolved`, which supersedes all current heads.
- History is preserved. The resolution becomes the new head: for decisions its text is the resolution, and for
  claims `owner` and `ownerAgent` (default `lead`) name the agreed owning agent.

## 8. Fallback

**Snapshot.** The daemon atomically writes `.catalyst/snapshot.md` and `.catalyst/snapshot.json`. They include the
generation time, the sync state and the projected state.

**Inbox drafts.** If the daemon or the MCP adapter is unavailable, an agent may write
`.catalyst/inbox/<uuid>.json`:

```json
{ "catalystDraft": 1, "clientId": "6f1c…", "tool": "publish_decision",
  "input": { "topic": "api/create-task", "title": "…", "decision": "…", "rationale": "…" } }
```

- Raw-event drafts use `"event": {type, payload, refs}` in place of `tool`/`input`. Hooks use this form.
- The daemon imports drafts when it starts and every 10 s afterwards. Imports are idempotent by `clientId`.
- Imported events have `origin: "fallback"`.
- Files that fail validation are moved to `inbox/rejected/`, with an `.error.txt` file next to each.

## 9. Handover (IMPORTANT.md)

- The daemon regenerates the block between `<!-- catalyst:handover:begin -->` and `<!-- catalyst:handover:end -->`
  in `IMPORTANT.md` after material changes. The `SessionEnd` hook and `catalyst handover` also regenerate it.
- The block is a deterministic function of the event set: no wall-clock time, no local sync state and no git
  calls. Two synchronised replicas therefore render identical text.
- The file is only rewritten when its content changes.
- Merge-conflict markers inside the block are cleared by regenerating it.
- Text outside the block is preserved.
- Updates still awaiting synchronisation are reported live by `get_briefing` and the `SessionStart` hook, not in
  the committed file.


## Runtime task checkpoints (recovery extension)

`checkpoint_task` appends a signed `task.checkpoint` event with a required task id, `in_progress` or `blocked`
status, summary, and optional blockers, evidence, next steps, branch and commit. It uses the ordinary append-only
log, signature verification, replay and delivery/consumption tracking; there is no second document transfer channel.
All paired participants can receive these records. Runtime-only means excluded from Git-visible generated handover
content, not confidential from a paired teammate.

The projection treats these as per-task, per-agent recovery progress. The generated root `IMPORTANT.md` omits
checkpoint summaries, blockers, evidence, next steps and code references; the ignored `.catalyst/snapshot.md` and
`.catalyst/snapshot.json` retain them. Public `publish_progress` remains exported as before. Agents must not copy
runtime recovery details into public progress, task descriptions or repository notes if they want them excluded
from Git. Gitignore is a default exclusion, not protection against an explicit force-add.

This additive event uses the existing protocol-v2 envelope. Earlier v2 implementations store and relay unknown
event types without projecting them, so they cannot offer checkpoint recovery. Both devices must use the recovery
build for this workflow. It does not make protocol v1 compatible with v2.

On a confirmed graceful subagent stop, preserve its last checkpoint and release unfinished claims; other running
queue workers can take the released work. A lost peer connection does not release that peer's claims. During known
peer unavailability, queue selection is restricted to existing ownership, local assignments and eligible local
handoffs; explicit requests obey the same partition restriction. Claims remain advisory: partitions and stale
information cannot guarantee global exclusive ownership. Publish source commits through Git before a cross-device
handoff; Catalyst never transfers dirty worktrees or automatically executes code from checkpoint text.
