# Catalyst demo

This document has three parts:
- [A. Reproducible two-node run on one machine](#a-reproducible-two-node-run-on-one-machine) (v0.1 history)
- [B. Live run with two real Claude Code sessions (recorded 2026-11-14)](#b-live-run-with-two-real-claude-code-sessions-recorded-2026-11-14) (v0.1 history)
- [C. Two laptops, several agents each](#c-two-laptops-several-agents-each) (v0.2, the current procedure)

Parts A and B were recorded with v0.1. They used terminal commands (`catalyst init`, `pair`, `join`, `goal`,
`peer pause`) and one agent per person. Those commands still exist, but in v0.2 you do all of it by talking to
Claude, with several named agents per person. Use part C now.

Parts A and B use the sample app in [`sample/`](sample/), "Pocket Tasks". It has a tiny HTTP API and a CLI
client, and two roles:

| Role | Task | Files |
|---|---|---|
| **Agent A** | `api-create-task`: implement `POST /tasks` | `sample/server/` |
| **Agent B** | `client-add-command`: implement `client add "<title>"` | `sample/client/` |

The request contract is agreed through a Catalyst decision on topic `api/create-task`.

---

## A. Reproducible two-node run on one machine

> v0.1 history. Still useful to check the plumbing on one machine; the script's output may differ in v0.2.

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

> v0.1 history: one agent per person, set up with terminal commands. Kept as the record of that run.

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

Part C covers these on two laptops with v0.2.

## C. Two laptops, several agents each

Two people build a small notes app together. Each person runs **one** Claude Code session, and that session
spawns subagents. All agents on both laptops take work from **one shared task queue**.

The only terminal command is the install. Everything else is a sentence you say to Claude.

**Targets to record:**
- terminal commands typed (target: the install line only, plus normal git);
- manual nudges after the first build prompt (target: 0);
- time from a question to its answer (target: seconds, not minutes).

### The app

A notes CLI in Node.js, split into three tasks:

| Task | Files | Depends on |
|---|---|---|
| `notes-core` | `src/notes.js`: `addNote`, `listNotes`, `deleteNote`, data in `data/notes.json` | — |
| `notes-cli` | `src/cli.js`: `notes add <title> [body]`, `notes list`, `notes delete <id>` | `notes-core` |
| `notes-tests` | `test/`: `node --test` tests for the core and the CLI | `notes-core`, `notes-cli` |

### 1. Install (both laptops)

```bash
npm install -g github:08namit/catalyst && catalyst install
```

Check that the last line starts with `Done. Open Claude Code in your project and say …`.

### 2. Create the project (person A, then person B)

- **A:** in an empty folder, open Claude Code (`claude`) and say: *"Create a minimal Node.js project called
  notes (ESM, tests with `node --test`, no dependencies). Commit it and push it to <your git remote>."*
- **B:** clone that repo and open Claude Code in it.

### 3. Connect (both)

- **A** says: *"Set up Catalyst and invite my teammate."* Claude returns an invite line starting with `cat1_`.
  Send it to B privately.
- **B** says: *"Join Catalyst with cat1_…"*.
- Both Claudes show a confirmation code. **Check that the two codes match.**
- Both: quit Claude Code and start it again in the project, so the hooks load.
- Both: say *"Commit the files Catalyst added."* (They are identical on both sides, so merging is clean.)

**Expected:** running `catalyst` in the project on either laptop prints `Connected to <teammate> (confirmation
code …)`.

### 4. Plan the work (person A)

Say:

> Set the Catalyst goal: a notes CLI with add, list and delete. Post three tasks to the Catalyst queue:
> notes-core (src/notes.js: addNote, listNotes, deleteNote; data in data/notes.json), notes-cli (src/cli.js:
> `notes add <title> [body]`, `notes list`, `notes delete <id>`; depends on notes-core) and notes-tests (test/:
> node --test tests for core and CLI; depends on notes-core and notes-cli). Before anyone writes code, publish
> the note data model and the CLI output format as Catalyst decisions.

**Expected:**
- Claude calls `set_goal`, `post_tasks` and `publish_decision` twice.
- `catalyst` on **both** laptops shows `Task queue: 0 of 3 done · 0 in progress · 1 ready · 2 blocked.`
- The dashboard (`catalyst dashboard`) shows the queue in order, with `notes-cli` and `notes-tests` waiting
  on their dependencies.

### 5. Build with subagents (both, at the same time)

Each person says:

> Use 2 subagents to work through the Catalyst task queue. Each subagent: give yourself a short role name,
> take the next task, follow the published decisions, write tests, commit on a branch named after the task,
> complete the task with evidence, then take the next one. If nothing is ready, or you are waiting for an
> answer, call wait_for_updates instead of stopping. Stop when the queue is empty.

Then don't type anything else until the queue is empty.

**Expected:**
- Each subagent appears by name, for example `Tiam / core` and `Namit / cli`, in `catalyst status` and on the
  dashboard's Agents panel.
- Exactly one agent, on either laptop, takes `notes-core`. The other agents wait (`wait_for_updates`) instead
  of grabbing a task that isn't ready.
- When `notes-core` is done, `notes-cli` becomes ready and is taken within seconds, possibly on the other
  laptop. `notes-tests` follows.
- No task is worked on by two agents. If both laptops take the same task at the same moment, both sides show
  a claim conflict and one agent releases it and takes the next task.

### 6. A question across laptops

While step 5 runs, have one agent ask another directly. For example, B says to their lead session:
*"Ask Tiam/core whether deleteNote should throw or return false for an unknown id."* (Or let an agent ask on
its own when it is unsure.)

**Expected:** the question reaches only that agent. It answers with `send_message {kind: reply}` and the asking
agent receives the reply through `wait_for_updates` within seconds. Record the time between question and
reply.

### 7. Outage and conflict (optional)

- **A** says: *"Pause Catalyst sync."*
- Each person then says: *"Revise the CLI output format decision: <a different format on each side>."*
- **A** says: *"Resume Catalyst sync."*

**Expected:** while paused, `catalyst` shows the teammate as paused with updates waiting to be sent. After
resuming, both laptops show `Open conflicts: 1`. Either person says *"Show the Catalyst conflicts and help me
resolve them"*, agrees on one version, and the conflict clears on both laptops.

### 8. Integrate

A says: *"Merge all the task branches into main, run the tests, and push."* B says: *"Pull main and run the
tests."* Then try the app: *"Run `node src/cli.js add "First note" "hello"` and then `list`."*

**Expected evidence:**
- matching confirmation codes;
- named agents from both laptops on the dashboard, with each task done by exactly one agent;
- `Task queue: 3 of 3 done` on both laptops;
- tests passing on main on both laptops;
- byte-identical generated blocks in `IMPORTANT.md` on both laptops;
- the counts from the targets above (terminal commands, nudges, question-to-answer time).
