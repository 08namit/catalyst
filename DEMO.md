# Catalyst demo

The demo uses the separate sample app in [`sample/`](sample/), "Pocket Tasks". It has a tiny HTTP API and a CLI
client, and two roles:

| Role | Task | Files |
|---|---|---|
| **Agent A** | `api-create-task`: implement `POST /tasks` | `sample/server/` |
| **Agent B** | `client-add-command`: implement `client add "<title>"` | `sample/client/` |

The request contract is agreed through a Catalyst decision on topic `api/create-task`.

This document has three parts:
- [A. Reproducible two-node run on one machine](#a-reproducible-two-node-run-on-one-machine)
- [B. Live run with two real Claude Code sessions (recorded 2026-11-14)](#b-live-run-with-two-real-claude-code-sessions-recorded-2026-11-14)
- [C. Two-laptop procedure](#c-two-laptop-procedure)

---

## A. Reproducible two-node run on one machine

```bash
npm install && npm run build && npm link
bash scripts/two-node-demo.sh                 # narrated: init → pair → join → decision → outage → replay → conflict
DEMO_DIR=/tmp/catalyst-demo bash scripts/two-node-demo.sh   # keep the two project dirs afterwards
npm run test:e2e                              # the same flows as assertions (17 tests)
```

Each node has its own directory, database, identity, ports and loopback peer bind (`--peer-bind 127.0.0.1`).
These runs are **simulations**: commands drive the tools directly, with no agent involved. They prove the
plumbing, but not that a model consumed the context. Part B covers that.

## B. Live run with two real Claude Code sessions (recorded 2026-11-14)

### Setup

The run used two real headless Claude Code sessions (`claude -p`, Claude Code 2.1.325, model `sonnet`), one in
each of two git checkouts of the sample. Each checkout had its own Catalyst daemon on loopback. The sessions used
the committed hooks and `.mcp.json` exactly as `catalyst init` wrote them. The only extra flag was
`--allowedTools "mcp__catalyst,Read,Edit,Write,Glob,Grep,Bash(npm test:*),Bash(node:*),Bash(git:*)"`, because
headless runs ignore `permissions.allow` in an untrusted workspace.

The model API stayed available throughout. Only the Catalyst peer link was disabled during the outage step.

```bash
# A: sample copied into a fresh git repo
catalyst init --name "Dev A" --project-name "Pocket Tasks" --peer-bind 127.0.0.1
git commit -am "Add Catalyst Claude integration"; git clone <A> <B>
catalyst pair                                   # in A
catalyst join cat1_… --name "Dev B" --peer-bind 127.0.0.1   # in B → "Confirmation code: d97621d7"
catalyst goal "Pocket Tasks v0.2: create tasks over the API and from the CLI" \
  --description "Dev A owns the HTTP API (task api-create-task); Dev B owns the CLI client (task client-add-command)…"
```

### Results

**1. Shared goal and separate responsibilities.** Verified live.
- A's SessionStart hook injected `## Catalyst shared context (auto-delivered at session start)` with the goal,
  the success criteria and `Peer Dev B: connected`.
- Both agents read `IMPORTANT.md` first, as `CLAUDE.md` instructs.

**2. Agent A publishes an API decision; Agent B retrieves and uses it.** Verified live.
- **A:**
  - called `claim_task` and `publish_decision` (topic `api/create-task`: Bearer auth, `{title}` body,
    `201 {task}`, `400`/`401 {error}`) **before** writing any code;
  - implemented the endpoint and ran `npm test` (8 passed);
  - committed on `a/api-create-task`;
  - called `publish_progress` (done, with evidence).
- **B:** was told not to read A's branch. It:
  - called `claim_task`, then `get_updates {topic: "api/create-task"}`, which returned the decision;
  - implemented `client add` against a stub server, following the contract exactly;
  - ran `npm test` (11 passed) and committed on `b/client-add-command`;
  - called `acknowledge_updates` and `publish_progress`.

**3. Question and reply.** Verified live.
- B asked: "on a 400 (or 401), what does the error body look like?".
- In a new session, A found the question with `get_updates`, read `server/index.js`, and answered with
  `send_message {kind: reply, replyTo}`. It then acknowledged.

**4. Only the Catalyst peer connection disabled.** Verified.
- Ran `catalyst peer pause` on B.
- A's `status` showed `Peer Dev B unreachable since 17:54`.

**5. Both agents record local progress.** Verified live; the two sessions ran in parallel.
- Each agent published `publish_progress` and a proposed decision revision.
- Each reported the link state it saw:
  - B: "Dev A shows as PAUSED locally … 3 updates queued";
  - A: "Dev B was UNREACHABLE … 2 pending".

**6. Reconnect; missed updates arrive.** Verified.
- After `catalyst peer resume`, both nodes held 24 events and 0 pending.
- The queues had been 2 and 3 before resuming.

**7. A conflicting proposal surfaces.** Verified.
- While apart, A proposed adding `priority` and B proposed adding `due`, both revising the same head.
- Both nodes flagged `decision api/create-task has 2 competing versions` and kept both versions.
- The conflict appears in the briefing, the dashboard and IMPORTANT.md.

**8. Integrate through Git and run the app.** Verified.
- In A: `git fetch <B> b/client-add-command`, then merged both branches into `main`.
- `npm test` → **14 passed, 0 failed**.
- The server was started with `PORT=4391 node server/index.js`.
- `node client/index.js add "Write the Catalyst demo notes"` → `Created #3 …`, and `list` shows it.
- B's client, built only from the Catalyst decision, worked against A's real server on the first run.

**Cost:** five live sessions came to $1.33 in total (A1 $0.30, B1 $0.36, A2 $0.20, B2 $0.25, A3 $0.23).

**Evidence:**
- Transcripts are kept in the build session's scratchpad. They are not committed because they contain local paths.
- `docs/dashboard-live.png` is A's dashboard for this run, rendered by headless Chrome from the live API. It
  shows the conflict, the answered question and the four delivery states.

**Not verified live:**
- Interactive (non-`-p`) Claude Code sessions, including the MCP approval prompt and the trust dialog.
- The UserPromptSubmit notice inside a live session. It is covered by e2e tests that run the real hook binary.
- Two physical laptops. The live run used two checkouts on one machine over 127.0.0.1.

To verify these, use part C.

## C. Two-laptop procedure

1. **Install on both laptops** (see [README](README.md#install-from-source)):
   `git clone … && cd catalyst && npm install && npm run build && npm link`.
2. **Prepare the project.** Copy `sample/` into a new git repo on laptop A, then on A:
   ```bash
   catalyst init --name "<A>"
   git add -A && git commit -m "Add Catalyst"
   ```
   Clone that repo to laptop B over any git remote or a shared folder.
3. **Find A's LAN IP** (e.g. `ipconfig getifaddr en0` on macOS), then on A:
   ```bash
   catalyst pair --host <A-ip>
   ```
   If macOS asks whether `node` may accept incoming connections, allow it.
4. **Join from B:**
   ```bash
   catalyst join cat1_… --name "<B>"
   ```
   Check that the confirmation code matches `catalyst status` on A.
5. **Start Claude Code on each laptop** with `claude` in the project. Approve the `catalyst` MCP server, and
   accept the trust dialog on first use.
6. **Prompt the agents** with the instructions from part B. On A: "claim api-create-task, publish the POST /tasks
   contract as a decision on api/create-task before coding, implement, test, commit on a branch, publish
   progress". On B: "claim client-add-command, retrieve the api/create-task decision via Catalyst, ask Dev A one
   question, implement, test, commit, acknowledge, publish progress".
7. **Run the outage.** Turn off Wi-Fi on B, or run `catalyst peer pause`. The model provider must stay
   reachable: with Wi-Fi off, use another uplink such as a phone hotspot, or simply use `peer pause`. Have both
   agents publish progress and conflicting proposals.
8. **Reconnect.** Re-enable Wi-Fi or run `catalyst peer resume`. Check the replay with `catalyst status`,
   `catalyst dashboard` and `get_updates`, and check the conflict with `get_briefing`.
9. **Integrate through Git.** Merge both branches, then run `npm test`, `npm start` and `node client/index.js add "…"`.

**Expected evidence:**
- matching confirmation codes;
- `status` showing `unreachable`/`paused` with pending counts during the outage, then `connected · 0 pending`;
- the conflict listed on both laptops;
- byte-identical IMPORTANT.md generated blocks after `catalyst handover` on both laptops.
