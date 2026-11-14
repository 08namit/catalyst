# Catalyst protocol (v1)

This document describes Catalyst's event model, its synchronisation protocol and its conflict semantics. The
normative types are in `src/core/protocol.ts`, `src/core/interfaces.ts` and `src/sync/frames.ts`.

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
  "v": 1,                      // protocol version
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
  "session": "claude:…",       // informational
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

**Forward compatibility:** if an event has an unknown `type`, or `v` is greater than 1, it is validated
structurally, verified, stored and relayed. Projections ignore it.

**Ordering:** the deterministic total order is `(lc, author, seq)`, compared by code point. Timestamps are only shown to people.

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
   - `catalyst peer pause` closes every peer connection and stops dialling and accepting peer connections; local tools keep working.
   - `catalyst peer resume` restarts sync.

Because replay is driven by vectors, missed updates are exchanged on reconnect whatever the outage cause:
network loss, a sleeping laptop, daemon restart, or a pause. Events relayed through a third participant are
verified against the original author's signature.

## 6. Pairing

1. `catalyst pair` runs on a node with the daemon running and creates an invitation. The token is
   `cat1_` + base64url(JSON) and contains:
   - `{v: 1, project, projectName, inviteId, secret (32 random bytes), addrs: ["host:port", …], exp, inviter}`.
   - Addresses default to the node's non-internal IPv4 interfaces; override them with `--host`. A pairing code
     on its own could not locate a laptop.
   - Invitations expire after 15 minutes by default and can be used once. Only the derived invite PSK is stored, never the secret.
2. `catalyst join <token>`:
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
   the two sides.

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
| decision | topic | `decision.recorded`, `conflict.resolved{scope: decision}` | current heads of the topic |
| claim | task | `task.claimed`, `task.released`, `conflict.resolved{scope: claim}` | the author's *own* live claim heads |
| goal | `goal` | `goal.set`, `conflict.resolved{scope: goal}` | current goal heads |

**Decisions and goals:**
- They are in conflict when there is more than one head. This happens when two participants revise the same
  version while disconnected, or create the same topic concurrently.

**Claims:**
- Releases are never heads.
- A task is in conflict when its live claim heads have more than one distinct owner.
- Claims are advisory. Catalyst does not claim distributed consensus.

**Overlapping paths:**
- Claims on different tasks with overlapping `paths` produce **warnings** rather than conflicts.

**Resolving a conflict:**
- Nothing is resolved by "latest timestamp wins".
- A conflict stays open until someone records `conflict.resolved`, which supersedes all current heads.
- History is preserved. The resolution becomes the new head: for decisions its text is the resolution, and for
  claims `owner` names the agreed owner.

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
