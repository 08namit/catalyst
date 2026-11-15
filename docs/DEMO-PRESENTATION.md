# Catalyst five-minute booth demo

**Audience:** judges visiting the booth. **Slot:** five minutes including questions. **Status:** run the full measured experiment before the event; do not invent results or turn the short booth demonstration into benchmark data.

## Before the judges arrive

### Share and build the feature branch on both Macs

The current `feature/agent-recovery` branch is local to this checkout; the listed remote branches do not include it. Tiam must first make the branch available to Namit through an agreed shared Git remote (or transfer the checkout). Do not try the GitHub/npm install command for this local-only branch.

On Tiam’s machine, after the branch is available on the agreed remote:

```sh
cd /private/tmp/catalyst-agent-recovery
git branch --show-current
git push <shared-remote> feature/agent-recovery
```

On Namit’s machine, fetch that exact branch, then both developers build and link the same source checkout:

```sh
git fetch <shared-remote>
git switch --track -c feature/agent-recovery <shared-remote>/feature/agent-recovery
npm install
npm run build
npm link
command -v catalyst
node dist/cli/index.js --version
catalyst --version
catalyst install
```

Tiam runs the build/link/install commands too. `npm link` puts this checkout’s package bin on `PATH`; in `package.json`, the `catalyst` bin points to `dist/cli/index.js`. `catalyst install` registers the `catalyst` PATH command with Claude Code. Keep that command on PATH because `.mcp.json` and hooks invoke `catalyst`. `node dist/cli/index.js --version` checks the built entry point directly; it does not replace `npm link` or the PATH command used by Claude. Rebuild and relink after switching to a different branch or changing compiled code.

### Prepare a fresh shared Pocket Tasks project

Use a new demo Git remote and a clean copy of `sample/` for this run. Do not copy a `.catalyst/` directory or reuse a prior participant identity. Tiam seeds the shared application repository:

```sh
mkdir -p ~/catalyst-demo/pocket-tasks
cp -R /path/to/catalyst/sample/. ~/catalyst-demo/pocket-tasks/
cd ~/catalyst-demo/pocket-tasks
git init -b main
git add .
git commit -m "Pocket Tasks starter"
git remote add origin <demo-project-remote>
git push -u origin main
```

Namit clones the same starter:

```sh
git clone <demo-project-remote> ~/catalyst-demo/pocket-tasks
cd ~/catalyst-demo/pocket-tasks
```

On Tiam’s copy, open Claude Code and say “Set up Catalyst and invite my teammate.” Send the `cat1_…` invitation privately. On Namit’s copy, open Claude Code and say “Join Catalyst with `<invitation>`.” Check that the confirmation codes match. Commit/push the project integration files from Tiam’s copy (`.mcp.json`, `.claude/settings.json`, `CLAUDE.md`, `.gitignore`); Namit pulls that commit. Never commit `.catalyst/`. Restart Claude Code in both project folders so the hooks load. Verify `catalyst status` reports the peer connected and the same code on both Macs. Accept any first-run Claude MCP/workspace trust prompts before rehearsal.

Use this same fresh-fixture setup for the measured comparison. The baseline run uses a tracked `COORDINATION.md` plus Git only; no chat. Keep the task, Claude model, settings, Macs, and test harness fixed as specified in [EXPERIMENT.md](EXPERIMENT.md).

### Collect the full three-minute evidence in advance

For the primary Catalyst peer-sync pause, use the product control `catalyst peer pause` (or `pause_sync`) for exactly **180 seconds** while Claude/model access and hosted Git remain online. Generate at least one genuine local Catalyst update while paused. Record the pause start/end, local pending count, peer status, update delivery after `catalyst peer resume`, and final pending count. Capture the other participant retrieving the replayed update. Save terminal/dashboard captures and event timestamps.

Complete and review the measured four-cell comparison ahead of the booth. Generate graphs only from recorded rows:

```sh
mkdir -p /tmp/catalyst-experiment-results
cp docs/experiment-results-template.csv /tmp/catalyst-experiment-results/results.csv
# Fill this file only with observed runs and preserve the separate event/evidence log.
python3 scripts/experiment-results.py /tmp/catalyst-experiment-results/results.csv \
  --out /tmp/catalyst-experiment-results/figures --validate-only
python3 scripts/experiment-results.py /tmp/catalyst-experiment-results/results.csv \
  --out /tmp/catalyst-experiment-results/figures
```

Keep the CSV, evidence, and graph output outside the Git repository. Copy only reviewed, redacted figures into the presentation materials. If the experiment has not been run or the results are incomplete, say so and show the protocol; do not display sample numbers, estimated wins, or fabricated graphs.

## Five-minute running order

| Clock | Show and say |
|---|---|
| **0:00–0:20** | “Catalyst shares project decisions, progress, and task state between two Claude Code setups. Git still moves the source code.” |
| **0:20–0:50** | Point to the two-laptop architecture visual below. Explain that each laptop keeps its own local log and a direct encrypted link sends shared updates. There is no central project server. |
| **0:50–1:35** | Show the **actual** `checkpoint_task` handoff trace: an agent saved its task status and next steps, stopped gracefully, and a second agent took the released task and used that checkpoint to continue. Name the run/evidence source. Do not present a mock timeline. |
| **1:35–2:10** | Show the measured comparison graph made from the completed experiment. State the number of runs and explain that baseline Git/shared notes remain online during the Catalyst peer pause. Call out observed differences only; say “not measured yet” for any missing cell. |
| **2:10–2:45** | Run the clearly labelled **15-second illustrative pause** below. Show one local update queued and then delivered after resume. Say: “This short pause demonstrates the status display only; the measured test used a full 180-second pause.” |
| **2:45–4:20** | Show the captured full 180-second run: pause state, queued update, resume, replay, and measured outcome graph. Clarify that Claude and Git stayed online. Mention that baseline Git notes may be faster during a peer pause; the graph reports what happened. |
| **4:20–4:40** | State limitations: two participants, this setup and model, small sample; graceful checkpoint handoff is not a hard-crash guarantee. A killed process/laptop may leave work ambiguous, and hooks cannot wake an idle Claude session. |
| **4:40–5:00** | Give the one-sentence takeaway, then take a brief judge question. Offer the protocol and evidence summary for follow-up. |

If the judge interrupts with a question, skip a repeated explanation; keep the full slot under five minutes. Do not wait three minutes during the visit.

## Actual checkpoint handoff evidence

Rehearse this before the visit using the feature branch and a real task in the clean demo project:

1. The lead posts a small task such as `handoff-demo` with a clear done condition and allowed paths.
2. The first subagent takes the task, starts work, and calls `checkpoint_task` with `taskId`, `status: "in_progress"`, a concise `summary`, and concrete `nextSteps` (plus evidence/paths where useful).
3. Stop that subagent gracefully before completion. The `SubagentStop` hook records its final checkpoint and releases unfinished work.
4. A second subagent calls `take_next_task`, receives the released task and saved checkpoint, continues the work, then calls `complete_task` with evidence.
5. Capture the actual tool/event record and resulting task status. If any of these steps did not happen in rehearsal, do not claim a completed handoff; show the recorded failure or describe the intended test.

Example instruction to Claude for a live/rehearsed walkthrough:

> Create one small `handoff-demo` task. Have an `api` subagent take it, call `checkpoint_task` before editing and after its first milestone with precise next steps, then stop gracefully while it is still incomplete. Have a second subagent take the released task, read the checkpoint, finish the work, and report test evidence. Show me the actual checkpoint and task state.

This demonstrates a **graceful subagent stop**. It does not promise recovery after a force-quit, machine crash, or unreported disconnection.

## Clearly labelled 15-second live pause

Pre-check both project folders are connected and an actual `catalyst` command resolves to the linked branch build. Use only in the booth if the prepared state is ready; otherwise show the captured evidence.

On Tiam’s demo project:

```sh
catalyst peer pause
catalyst tool publish_progress '{"status":"in_progress","summary":"Illustrative booth update queued during a 15-second peer pause."}'
catalyst status
```

Show `paused` and a pending update. Wait approximately 15 seconds, then run:

```sh
catalyst peer resume
catalyst status
```

On Namit’s side, have Claude retrieve the new update with `get_updates` (or show the saved event evidence). The status should show replay/pending cleared. Label the whole action: **“15-second illustrative UI demo; not a 180-second measurement.”** If it fails, stop the live attempt and show the already captured full run. Do not describe a failed demo as a product behavior.

## Plain-language architecture and visual spec

**One-sentence explanation:** Catalyst is a small local coordinator beside each Claude Code session. It keeps a signed record of shared work notes, decisions, checkpoints, and queue state; it syncs those records directly to the teammate over an encrypted link. Git remains responsible for source code.

**Visual:** use two equal laptop panels. Inside each, draw “Claude Code + subagents” above “Catalyst local log/daemon.” Connect the daemons with a labeled encrypted peer link. Draw a separate Git remote below both laptops with arrows to each working copy, labeled “source code.” During the pause, gray the peer-link arrow, show a “queued locally” badge on the Catalyst side, keep the Git arrows green, then show queued events replaying after resume. Avoid implying a hosted Catalyst service or that Catalyst synchronizes code.

**Three concise slide/card layouts:**

1. **“Two Claudes, shared project context”** — architecture visual; three chips: decisions, task/checkpoint state, questions/progress. Footer: “Git moves code; Catalyst moves project context.”
2. **“Graceful handoff”** — actual event sequence: `checkpoint_task` → agent stops → task released → next agent retrieves checkpoint → task completed with evidence. Add a small footer: “Graceful stop demonstrated; hard-crash recovery is not guaranteed.”
3. **“What happened in the measured runs”** — use the generated comparison chart with all observed points and n per cell; put “2 developers, same Macs/model; 180-second Catalyst peer pause; Claude + Git online” next to it. Show the baseline’s shared-notes/Git line and the Catalyst line without visually implying one wins. If there are no measured rows yet, replace the plot with the four-cell protocol and a prominent “No results collected yet.”

Use only measured values from the saved CSV and evidence. Do not turn a 15-second booth illustration into a data point or claim a percentage improvement without the completed paired runs to support it.
