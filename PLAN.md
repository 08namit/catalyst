# Catalyst — implementation plan

> Living plan. Completion status is tracked in the **Status** table at the end; the handover for the next agent/developer is `IMPORTANT.md`.

## Context
Greenfield folder `/Users/tiampatel/Documents/Projects/catalyst` (only CLAUDE.md + empty IMPORTANT.md, no git).
Build Catalyst: an MIT-licensed companion that links two developers' Claude Code sessions on separate laptops
via a per-project local daemon (SQLite event log), a stdio MCP adapter, Claude Code hooks, and direct encrypted
LAN peer sync. It must work asynchronously (sessions hours apart), queue offline, replay on reconnect, flag
conflicts, and keep IMPORTANT.md as the generated handover so Tiam's and Namit's agents can continue each other's work.

User decisions: `git init` + milestone commits on main (no remote/push). Live verification with headless `claude -p`
sessions is approved.

### Verified facts (from docs/tooling research)
- Node v26.13.1; `node:sqlite` DatabaseSync + FTS5 work with no warning → **no native deps**. engines `>=22.13`.
- Node TLS 1.2 PSK with `ECDHE-PSK-CHACHA20-POLY1305` works (tested) → standard TLS with forward secrecy and no custom crypto.
- MCP SDK: `@modelcontextprotocol/sdk@^1.32` (`McpServer.registerTool`, `StdioServerTransport`, zod `^3.25||^4`). Use v1 (stable, widely documented; v2 split packages noted in README).
- Claude Code: `.mcp.json` stdio `{command,args,env}` with `${VAR}` expansion, approval prompt in interactive sessions
  (auto-loaded in `claude -p`); hooks in `.claude/settings.json`; SessionStart (`startup|resume|clear|compact`) and
  UserPromptSubmit inject stdout / `hookSpecificOutput.additionalContext` (10k-char cap); PostToolUse gets tool_input;
  SessionEnd can't block (1.5 s default timeout); MCP output warns >10k tokens. Stop hooks *can* force continuation —
  Catalyst deliberately does **not** use that (spec: don't rely on hooks triggering turns).
- Codex plugin works via `node ~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs task --write [--background] --cwd <dir> "<prompt>"`
  and `adversarial-review` (read-only, needs git). CLI authenticated. The configured `codex` MCP server is broken
  (`codex mcp-server` subcommand doesn't exist in 0.164) — report this; not needed.

## Architecture (single npm package, bin `catalyst` → `dist/cli/index.js`)
```
src/core/      protocol.ts (envelope, event types, zod payloads, canonical JSON, ed25519 sign/verify, hash ids),
               api.ts (local HTTP API + MCP tool request/response types), paths.ts, config.ts, log.ts (file logs only)
src/store/     db.ts (WAL, busy_timeout, migrations), events.ts (append/ingest/dedupe/pending gaps/vector),
               projections.ts (pure: goal, participants, tasks, claims, decisions, conflicts, questions, blockers),
               briefing.ts (deterministic ranking + FTS5), updates.ts (cursor, ack, retrieval)
src/handover/  important.ts (IMPORTANT.md generated block), snapshot.ts (atomic snapshot.md/json)
src/sync/      frames.ts, transport.ts (TLS-PSK, NDJSON, limits), peer.ts (dial/accept, dedupe, backoff, replay), pairing.ts
src/daemon/    main.ts, lifecycle.ts (lock + health nonce + detached spawn), http.ts (API + dashboard static), inbox.ts
src/client/    daemon client used by CLI/MCP/hooks (autostart only where allowed)
src/mcp/       stdio adapter (8 tools)       src/hooks/   lightweight hook entry (no zod/SDK import)
src/setup/     claude.ts (idempotent merge/uninstall of .mcp.json, .claude/settings.json, CLAUDE.md block, .gitignore)
src/cli/       commander: init start stop status doctor pair join peer(pause|resume|set-addr) dashboard
               handover snapshot setup uninstall daemon mcp hook
src/dashboard/static/   vanilla HTML/JS/CSS, polls /api/state
site/index.html  static setup page (real clone/build/link commands)
sample/        separate tiny Node app for the demo (own package.json)
examples/      config, .mcp.json, settings, inbox-update examples (no secrets)
test/          unit + two-node integration (child processes, separate dirs/ports/identities)
scripts/two-node-demo.sh
```
Per-project data: `<project>/.catalyst/` (gitignored by setup): `catalyst.db`, `identity.json` (participant id,
name, ed25519 keypair, 0600), `secrets.json` (pair keys, 0600), `daemon.json` (pid, ports, per-start token+nonce, 0600),
`snapshot.md/json`, `inbox/{imported,rejected}/`, `logs/`. Each checkout = one participant (documented).

### Event model (PROTOCOL.md)
Envelope: `{v, id, project, author, seq, lc, ts, type, payload, refs:{task?,topic?,paths?}, supersedes?, origin:
agent|hook|human|fallback, session?, sig}`. `id = sha256(canonical(envelope minus id,sig))`; `sig` = ed25519 by author
(public key in `participant.joined`). `seq` per author, contiguous, assigned **only by the daemon** in the insert
transaction. `lc` = Lamport clock; deterministic order = `(lc, author, seq)` by code point; `ts` is display only.
Types: `project.created, participant.joined, goal.set, task.created, task.claimed, task.released, decision.recorded
(proposed|accepted, topic), progress.reported (status, summary, blockers, evidence, next_steps), blocker.resolved,
message.posted (question|reply|notification, replyTo, to?), conflict.resolved, ack.recorded, activity.captured (hook)`.
Unknown types/versions: stored and relayed, skipped by projections. Same (author,seq) with different id → fork alarm.

### Semantics
- Durable first: event committed to SQLite before any delivery; dedupe by id.
- Conflicts via a "heads" model: for decisions per topic, and for claims/releases per task (release/re-claim
  supersede prior heads). More than one live head from different authors → flagged conflict until `conflict.resolved`
  supersedes all heads (history preserved). Path-scope overlap across tasks → warning only. No timestamp wins.
  Ownership advisory; no consensus claimed.
- Projections: pure functions of the event set, cached, invalidated on insert; `catalyst doctor --rebuild` checks reproducibility.
- Delivery vs consumption: `deliveries(event,peer)` from direct peer acks = **delivered**; peer status frames carry
  participant retrieval watermarks = **retrieved**; `ack.recorded` events = **acknowledged**; existence = **saved locally**.

### Sync & pairing
- TLS 1.2 PSK; PSK = HKDF(pairKey, salt=projectId, info=sorted participant ids); unknown identity → reject.
  Handshake timeout, max frame size, per-IP connection cap. NDJSON frames: `hello{protocol, project, participant,
  addrs, vector}` → each side streams missing events per author in seq order → `ack{ids}`; live `push`; `status`
  (retrieval watermarks, pending count); `ping`. Gaps parked in `pending` until filled. Wrong project/protocol → error frame with actionable message.
- Both sides dial known addrs (updated from every hello; `catalyst peer set-addr`); duplicate connection resolved
  deterministically; backoff 1 s→60 s with jitter. `catalyst peer pause|resume` disables only networking (demo step 4).
- `catalyst pair` (daemon running) → `cat1_<base64url{v, project, inviteId, secret(32B), addrs, exp}>`, single-use,
  15-min TTL, stored hashed, marked used in the same transaction that validates it. `catalyst join <token> --name X`
  dials with PSK = HKDF(secret, info=project|inviteId); exchange identities/pubkeys/addrs + new random pairKey; both
  print a short confirmation code derived from the handshake. Trust model documented (LAN, token = bearer secret).
- Peer state reported everywhere as `connected | unreachable(since) | paused | never_paired` with lastSyncAt and pendingOutbound, so "no updates" is never confused with "peer unreachable".

### Local API, daemon, MCP, hooks
- Loopback HTTP on 127.0.0.1 only; bearer token from `daemon.json` (rotated per start); Host/Origin checks (DNS
  rebinding); dashboard gets the token via URL fragment from `catalyst dashboard`. Peer listener is separate (`0.0.0.0:peerPort`, configurable).
- Lifecycle: O_EXCL lock + pid + `/health` nonce/projectId check; detached spawn with `stdio:'ignore'`; racing starters poll health instead of re-spawning.
- MCP adapter: one per Claude session, logs to file only, autostarts daemon (≤2 s wait). Tools: get_briefing,
  claim_task, publish_decision, publish_progress, send_message, get_updates, acknowledge_updates, resolve_conflict —
  zod-validated, bounded (truncate by priority, ≤8k chars), include authors, freshness, source ids, peer state.
  Peer text sanitized and framed as quoted project data.
- Hooks (committed `.claude/settings.json` calls `catalyst hook <event>` from PATH; exits 0 silently if missing):
  SessionStart → ranked briefing + pending-sync notice + retrieval record (only hook allowed to autostart; snapshot fallback);
  UserPromptSubmit → ≤300 ms, one-line unread notice only when new peer updates; PostToolUse(Bash `git commit`,
  Edit|Write) → local mechanical capture (origin `hook`); SessionEnd → flush activity summary + regenerate IMPORTANT.md.
  Session linking: hooks register `session_id`+Claude pid, adapter registers ppid; daemon joins them (best effort).
- Fallback: atomic `snapshot.md/json` with generation time; agents may write `.catalyst/inbox/*.json` drafts (client
  uuid); daemon imports idempotently on start/interval; invalid files moved to `rejected/` with `.error.txt`.

### IMPORTANT.md (product feature + this repo's handover)
- Generated block between markers, manual section preserved. Contains goal/context, tasks (owner/status), accepted
  decisions, **open conflicts with both versions**, known bugs/blockers, verification evidence, branch/HEAD + recent
  commits, next steps, "last material update" (= latest material event's ts+author, deterministic across replicas).
  Rewritten only when its content hash changes; activity noise excluded; credentials never included.
  `catalyst handover` regenerates (also resolves merge conflicts in the block).
- For this repo: I maintain IMPORTANT.md by hand during the build (Catalyst isn't running yet) and update it at each
  milestone. A new section in CLAUDE.md and a new AGENTS.md (read by Codex) tell every incoming agent to read IMPORTANT.md first and refresh it.

## Delegation (file ownership is exclusive; only the lead commits)
0. **Lead (me), sequential first:** `git init`, package.json/tsconfig/vitest/.gitignore/LICENSE, `src/core/protocol.ts`,
   `src/core/api.ts`, `src/sync/frames.ts`, store/sync interfaces, PLAN.md, PROTOCOL.md draft, IMPORTANT.md, CLAUDE.md
   and AGENTS.md pointers. Typecheck → commit "contracts".
1. **Claude agent — storage:** `src/store/**`, `src/handover/**`, `test/store/**`, `test/handover/**`.
2. **Codex (companion `task --write --background`) — networking:** `src/sync/{transport,peer,pairing}.ts`, `test/sync/**`.
3. **Claude agent — daemon/CLI:** `src/daemon/**`, `src/client/**`, `src/cli/**`, `test/daemon/**`.
4. **Claude agent — Claude integration:** `src/mcp/**`, `src/hooks/**`, `src/setup/**`, `examples/**`, `test/mcp/**`, `test/setup/**`.
5. **Claude agent — UI/sample:** `src/dashboard/static/**`, `site/**`, `sample/**`.
Then: lead integrates (build, typecheck, tests) → commit. **Claude agent — e2e:** `test/e2e/**`, `scripts/two-node-demo.sh`,
in parallel with a **Codex adversarial-review** (read-only); lead fixes findings → commit.
Each agent reports changed files, assumptions, checks run and open issues.

## Milestones (each ends with a verification step and a commit plus an IMPORTANT.md update)
1. Persistent local tools: store + daemon + MCP; restart keeps data → unit tests and MCP client smoke test.
2. Two isolated nodes exchange events (temp dirs, ports, identities) → e2e test.
3. Two real Claude sessions: A publishes an API decision, B retrieves it → headless `claude -p` runs, transcripts saved as evidence.
4. Reliable pairing, persistence, reconnect replay (pause/resume, kill -9 and restart) → e2e tests.
5. Dashboard → verified in Chrome against live two-node data; screenshot.
6. Filesystem fallback + docs (README, PLAN status, PROTOCOL, DEMO, examples, site) → import tests.

## Verification
- `npm run build && npm run typecheck && npm test` (vitest) covering: durable offline writes, duplicates,
  out-of-order and gap delivery, reconnect replay, restart recovery, bad token/PSK/wrong project/incompatible protocol,
  project isolation, signature/fork detection, conflicting revisions and claims plus resolution, briefing relevance
  ranking, fallback imports (valid/invalid/idempotent), setup preserving existing `.mcp.json`/settings/CLAUDE.md, uninstall.
- `scripts/two-node-demo.sh`: two dirs under `$TMPDIR`, init A → pair → join B → publish → pause → offline writes → resume → replay → conflict → status output.
- Live: two `claude -p` sessions in separate sample-project copies, using the real hooks/MCP (DEMO.md steps 1–3, 5–7);
  `sample/` integration through git (branch per dev, merge, run app) for step 8. Anything not observed live is labeled unverified, with exact manual steps.
- Two-laptop procedure documented in DEMO.md (LAN IP, firewall note, `--host`).
- Final report: launch commands, test/build output, evidence, remaining limitations (no NAT traversal/relay, advisory ownership, cloud model still required, hooks can't force turns).

## Status

| Step | State | Notes |
|---|---|---|
| 0. Scaffold + contracts (`src/core/*`, `src/sync/frames.ts`, `src/client`) | done | typecheck passes |
| 1. Storage + projections + handover | in progress | Claude subagent |
| 2. Networking (TLS-PSK, sync, pairing) | in progress | Codex via plugin companion |
| 3. Daemon + CLI | in progress | Claude subagent |
| 4. MCP + hooks + setup | in progress | Claude subagent |
| 5. Dashboard + setup page + sample | in progress | Claude subagent |
| Integration, e2e, review | pending | |
| Live Claude verification | pending | |
| Docs (README, PROTOCOL, DEMO) | pending | |
