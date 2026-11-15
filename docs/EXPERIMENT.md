# Catalyst two-device comparison protocol

**Status: protocol only. No comparison results have been collected.** This document specifies a small, controlled pilot for Tiam and Namit on two physical macOS devices on the same Wi-Fi, using the same Claude model. It compares Catalyst with ordinary Git plus shared repository notes, both with Catalyst peer sync active and during a three-minute peer-sync pause. Claude and Git stay online during the pause; it is not a whole-network outage. It is not evidence of general performance until run and replicated.

## Questions and provisional decisions

Primary questions:

1. Does Catalyst change elapsed time, human nudges, or correctness when two developers coordinate while connected?
2. What happens to coordination and recovery when cross-device coordination is interrupted during work?
3. Which bottlenecks dominate: waiting for decisions, waiting for Git integration, task contention, setup, model/API latency, or recovery?

Use **normal Git plus a shared coordination-notes file committed to the repository** as the baseline. No chat or other side channel is used for task coordination. This is an active coordination method, not “no coordination.” Keep Git, Claude Code, and model access available in every primary run. Both developers work toward the same goal from the last shared notes, pick up work when an agent stops, and avoid editing work that the disconnected agent may be doing.

## Design: 2 × 2 crossover

Each person participates in all four cells. The factors are the coordination method and whether cross-device coordination is available:

| Cell | Coordination | Peer-link condition |
|---|---|---|
| A | Catalyst | Peer sync active |
| B | Catalyst | Pause Catalyst peer sync for 180 seconds; local work and event queue continue |
| C | Git + shared repository notes | Git remote and shared notes are available |
| D | Git + shared repository notes | Same 180-second comparison window; Git remote and shared notes stay available |

In B, pause Catalyst peer sync for exactly **180 seconds** using `catalyst peer pause` (or Claude's `pause_sync`). Wi-Fi, Claude/model access, and hosted Git must stay available. Catalyst updates queue locally and replay after `catalyst peer resume` (or `resume_sync`). In D, use the same timed window while shared notes and Git continue normally; do not artificially pause the baseline. This intentional asymmetry compares Catalyst's paused direct sync with the baseline's available hosted Git path, and must be stated when interpreting results. It is a logical peer-sync pause, not a physical network partition.

For a minimal pilot, use two matched task variants across two blocks. In block 1, run variant 1 in a randomized order such as A-D-B-C; in block 2, run variant 2 in reverse order C-B-D-A. That is eight timed runs, two observations per cell and one observation per variant in each cell. Randomize which person owns each role in each run and ensure each person owns each role equally often. If eight runs are impractical, run one per cell and label conclusions exploratory; do not use significance language. A facilitator should draw the order before the first run and preserve it in the results.

### Connection terminology

- **Peer-sync pause (primary interruption):** Catalyst stops exchanging peer updates for 180 seconds through its pause control. Both devices stay on Wi-Fi, Claude/model APIs and hosted Git remain available, and local Catalyst writes continue to queue.
- **Physical peer-network partition (optional separate test):** a router/VPN rule blocks only direct device-to-device packets on the Catalyst peer port while Claude and hosted Git remain online. This is distinct from the app-level pause; label and analyze separately.
- **Baseline during the three-minute comparison window:** Git and the shared repository notes stay available. Continue the assigned workflow; do not pause the baseline channel.
- **Whole-internet loss (separate optional stress test):** disable internet access on one or both devices. Claude/model APIs and hosted Git may then fail; a direct Catalyst LAN link may still work if the LAN remains up. Do not mix these runs into the primary comparison. Record which device lost internet, whether LAN peer connectivity remained, model/API failures, and the exact outage interval.
- Never label a run simply “offline.” State which path was interrupted and which services remained reachable.

## Task and matched work

Use the existing **Pocket Tasks** demo in [`../sample/`](../sample/), reset to the same clean starter commit for every run. It already has complementary tasks (`api-create-task` and `client-add-command`) and test placeholders. Prepare a second mirrored fixture, **Pocket Notes**, with the same files, TODOs, tests, and task split; only rename the entity/route (`tasks`→`notes`) and labels. Verify the two fixtures have the same number of baseline tests, TODOs, and acceptance cases before timing. Assign Pocket Tasks to block 1 and Pocket Notes to block 2, then use each variant in all four cells once. Give both conditions the same fixed requirements and acceptance checklist. Do not let one condition inherit code, decisions, or notes from an earlier timed run.

The sample currently contains Catalyst-specific coordination hints in comments and its README. Replace those hints with “use the assigned coordination method” in the common starter for **both** conditions, then freeze its commit. Baseline agents must not be instructed to use unavailable Catalyst tools. Replace the task-related TODO tests with real assertions during the run; a passing suite containing those TODOs is not evidence of completion.

Before timing, the facilitator creates two fresh copies from the same starter commit, one per device. Confirm clean `git status`, record the starter commit hash, and verify that each copy has the same baseline tests. Use new branches and a new Catalyst project for each Catalyst run. For baseline runs, use a fresh shared Git remote and a tracked `COORDINATION.md` file for the goal, task status/ownership, decisions, blockers, questions, and evidence. Do not use chat, calls, or uncommitted shared documents. Keep `.catalyst/` out of Git.

Use the following initial API contract in every run, recorded in advance and made visible to both developers before the timer starts: `POST /tasks` (or `/notes`) uses `Authorization: Bearer <token>`, JSON `{ "title": "..." }`; a valid request returns `201 { "task": { "id": number, "title": string, "done": false } }` (use `note` instead of `task` in Pocket Notes); a missing/blank title initially returns `400 { "error": "title is required" }`. This shared initial state makes the later update propagation comparable; it is not a scored decision-making task.

At exactly **60 seconds after timed work starts**, the facilitator privately gives the API owner (Agent A for that run) this change card, and nobody else: “Change invalid-title handling to HTTP `422` with JSON `{ "error": "title must be a non-empty string" }`. Keep the auth rule and successful response unchanged. Publish the revised contract using the assigned coordination method.” The API owner publishes it; the CLI owner must learn it only through Catalyst or `COORDINATION.md`/Git, then adapt. Do not announce the change or send the card to the CLI owner. For B and D, timed work and the **180-second peer-pause window** start together, so the card arrives at pause+60 seconds. For A and C, deliver it at the same task+60 second point without a pause. This keeps the change requirement and timing constant across all four cells.

Both developers receive this same prompt:

> Implement the assigned Pocket Tasks/Pocket Notes API and CLI tasks using the initial contract already shared. Agent A owns the API; Agent B owns the CLI client. Add automated tests, commit your work on separate branches, integrate both branches, run the full sample test suite, and demonstrate adding then listing an item. If a detail is unclear, record the question using the assigned coordination method and wait for a usable answer before guessing. Record progress and evidence using the coordination method assigned to this run. Do not coordinate over chat or any other side channel.

The existing sample README describes the task files and TODO markers. Use the same test and integration requirements in every cell. The facilitator must not provide the later contract change to the client owner directly. Capture both the initial and final contract in the run record.

### Independent acceptance checks

Before collecting data, the facilitator prepares one acceptance harness per fixture, outside both participant worktrees. Keep the harness identical across all cells for a fixture and run it only after integration, so it does not reveal the private change card.

| Case | Pass condition |
|---|---|
| Existing behavior | `GET /health` and `GET /tasks` (or `/notes`) return 200 JSON; existing seed items remain visible. |
| Auth | Missing or incorrect bearer token on `POST` returns 401 JSON and creates no item. |
| Revised validation | After the change card has been published, a missing, blank, or whitespace-only title returns exactly `422 { "error": "title must be a non-empty string" }` and creates no item. |
| Create | A valid title with the configured token returns 201; response contains an item with numeric `id`, exact `title`, and `done: false`; the item appears in the subsequent list. |
| CLI integration | `client add "Study acceptance item"` sends the agreed auth/body, returns success for a valid title, handles the revised validation error without claiming success, and `client list` displays the new item. |
| Regression | All existing fixture tests and the final acceptance harness pass after both branches are integrated. |

Acceptance is pass only if every case passes. Record each assertion as pass/fail plus the command/output; save harness source and its hash in the study evidence. Use the same harness structure and assertion count in Pocket Notes, substituting the resource name.

### Workload parity

- Same Claude Code version, model name/version, reasoning/effort setting, permission policy, and tools for both participants throughout the study. Record any change; if a change is unavoidable, restart the affected matched pair of runs.
- Use one lead Claude session per person in every cell. For the primary comparison, use **zero subagents** in every cell to isolate coordination method. If the product question requires multiagent use, run a separate labeled follow-up with the same fixed number of subagents per person in every cell; do not compare subagent Catalyst against no-subagent manual work.
- Use the same initial task prompt, role split, repository state, test command, and acceptance rubric. Do not provide extra hints to one cell.
- Complete one untimed familiarization run before collecting data; do not reuse its code or transcript. The timed runs use clean copies.
- No code may be copied between devices except through the assigned Git workflow. No unlogged side channel is permitted.

## Run procedure

### Before each run

1. The facilitator records run ID, cell, randomized order, roles, machine names, OS, Node version, Git version, Claude Code version, model, settings, sample starter commit, and clean working-tree status.
2. Synchronize clocks to the same time source. Record each device’s UTC offset and clock difference. Aim for under one second; if larger, use the screen recording/event-relative timestamps for elapsed measures and record the offset.
3. Start screen recording on both devices if participants consent. Capture Claude transcripts, Git logs, test output, Catalyst status/dashboard/event evidence, `COORDINATION.md` history in baseline runs, and model usage/cost where available. Redact invite secrets, access tokens, personal paths, and private conversation unrelated to the task before sharing evidence.
4. Verify both model APIs and hosted Git are available. Record a baseline `catalyst` status for Catalyst runs and verify `COORDINATION.md` and the initial contract are committed/pushed for baseline runs. Confirm the initial contract is visible to both participants.
5. The facilitator reads the fixed prompt verbatim to both participants, then starts the timer. In B only, immediately run `catalyst peer pause` on the Catalyst node; in D, start the same 180-second observation window without disabling Git or notes. In A/C, use the normal assigned method with Catalyst sync active in A. At timer+60 seconds, deliver the change card to the API owner only.

### During the run

6. Participants work in parallel, using only the assigned coordination method. In baseline runs, coordinate only through `COORDINATION.md` and Git: write a question there, commit/push it, and check for a response; the reply is another note update committed/pushed. Let each team choose its natural note-check cadence and record each pull/check timestamp; do not impose polling only on baseline. Keep model/tool budgets the same. If a fixed polling cadence is desired, run it as a separate sensitivity comparison and use the same retrieval cadence in both methods. In Catalyst runs, use the corresponding shared decision/question/progress tools and the version's wait mechanism. Count human nudges: any facilitator prompt outside the fixed task instructions that is needed to resume, redirect, or unblock work.
7. Both participants continue their work during the peer pause. In Catalyst, local updates should queue; in baseline, Git and `COORDINATION.md` continue through the hosted remote. Do not tell the CLI owner about the contract change directly. Record the API owner's publication time, when the CLI owner can first see it, their adaptation, pending events/commits, and any duplicate work or rework.
8. At pause+180 seconds, run `catalyst peer resume` (or call `resume_sync`). Record time to Catalyst's first successful sync and consistent state, queued updates, conflicts/duplicate work, and recovery actions. Baseline has no peer-pause recovery step; record Git/note activity through the interval. Do not silently repair inconsistencies; log them first.
9. In connected runs, skip partition restoration and leave recovery fields blank. Integrate using Git, run `npm test` from the fixture, and perform the same live acceptance check: start the API, add one item through the CLI, and list it. Stop the timer only when both participants can observe the acceptance criteria passing and integration is complete.
10. Immediately after stopping, each participant independently records perceived workload (1–7), frustration (1–7), and the largest bottleneck before discussing results. The facilitator collects evidence and saves a copy of the final diff and test output.

### Fixed peer-pause details

Use exactly 180 seconds in B and D as the comparison window. In B, call `catalyst peer pause` on one Catalyst node at the timer start and `catalyst peer resume` at the end. Verify `catalyst status` shows paused/pending updates while paused and pending clears after replay; confirm Claude/model APIs and hosted Git remain online. In D, do not disable anything: continue normal `COORDINATION.md` and Git use during the same 180-second window. A run where Claude/model access or Git hosting fails is a deviation from the primary protocol; preserve its evidence and repeat if feasible.

If running the optional physical peer-network partition, use a router/VPN rule to block only direct device-to-device packets on the Catalyst peer port while keeping Claude/model APIs and hosted Git reachable. Label it `physical-peer-partition`; do not combine it with the logical peer-pause results.

## Timing and event definitions

Use UTC wall-clock event timestamps plus monotonic elapsed time from screen/video or a local stopwatch. Wall clocks are for cross-device ordering; monotonic time is preferred for durations. Record event timestamps to seconds where possible. Define events before the run:

| Event | Definition |
|---|---|
| `prompt_start` | Fixed task prompt begins |
| `change_card_delivered` | Facilitator privately gives the revision card to the API owner at task+60s |
| `revision_published` | API owner publishes the new contract through the assigned method |
| `revision_available_other` | CLI owner can first see/retrieve the revised contract through that method |
| `first_question` / `first_answer` | First task question and first usable answer across devices |
| `peer_pause_start` / `peer_pause_end` | Facilitator’s recorded 180-second Catalyst peer-sync pause boundaries; baseline uses the same timed observation window |
| `recovery_first_exchange` | First confirmed Catalyst update syncs after route restoration |
| `recovery_consistent` | Both participants confirm matching Catalyst state after replay; baseline recovery is recorded as Git/note events |
| `integrated` | Both branches integrated locally and acceptance checks pass |

Separate developer elapsed time from wall-clock time. Record periods when both developers are actively waiting, one is waiting, or neither is waiting if evidence permits. For each question, measure question-to-first-usable-answer; do not substitute message delivery time for answer time. Count messages, questions, answers, commits, merge conflicts, duplicated work, failed tests, and nudges from evidence. “Useful answer” means it resolves the question enough for the asker to continue without another clarification; have the asker mark this contemporaneously.

## Predefined outcomes

Report per-run values and paired differences; do not choose metrics after seeing the results.

**Primary outcomes**

- Elapsed seconds from `prompt_start` to `integrated`.
- Total developer waiting minutes attributable to coordination (sum across both people; self-reported intervals plus timestamp evidence).
- Task acceptance: all specified tests pass, live add/list succeeds, and the two branches integrate without losing work.

**Secondary outcomes**

- Human nudges after the fixed prompt; task-related questions; median and maximum question-to-usable-answer latency.
- Contract agreement time; number of contract revisions and clarification loops.
- Partition recovery time to `recovery_first_exchange` and `recovery_consistent`; Catalyst events queued at recovery; baseline notes/commits made during the partition; number of recovery actions.
- Duplicate implementation, overlapping work, merge conflicts, failed test runs, and rework minutes.
- Number of terminal commands beyond the common Git/test commands; model calls/tokens/cost when captured; workload and frustration ratings.

**Quality rubric (score 0–2 each, blind to condition where possible):** API contract implemented consistently (0 absent/wrong, 1 partial, 2 matches agreed contract); CLI behavior and error handling (0–2); automated tests cover acceptance cases (0–2); integrated application passes the live check (0–2); implementation preserves existing behavior and has no known regression (0–2). Save rubric evidence and scorer identity. Do not use lines of code as a quality proxy.

Success is not “Catalyst wins.” A cell is successful only if the acceptance task completes. A coordination method may be faster but less correct; report the trade-off. An interruption result is interpretable only if the intended path was interrupted and other specified services remained available.

## Results capture

Create one row per run in `results.csv` (or an equivalent append-only table); preserve raw timestamps and evidence separately. Use the schema expected by the plotting/validation utility:

```csv
run_id,block,condition,network,variant,completed,duration_s,decision_latency_s,manual_interventions,rework_minutes,integration_failures,recovery_s,replay_s,claude_tokens,claude_cost,notes
```

`condition` is `catalyst` or `baseline`; `network` is `connected` or `partition` (the latter labels the logical peer-pause comparison window, not a physical Wi-Fi partition); `completed` is `true` or `false`. Here `network=partition` is the plotting utility's fixed category for the three-minute peer-pause window; it is not a claim of a physical network partition, and the baseline remains available over Git. `decision_latency_s` is from the facilitator delivering the change card to the CLI owner being able to read/retrieve the revised contract through the assigned method. `manual_interventions` counts facilitator nudges only, not normal shared-note updates. `integration_failures` counts distinct failed integration attempts, not individual test assertions. `recovery_s` is from peer-pause end until both Catalyst participants confirm consistent state; `replay_s` is from peer-pause end until Catalyst confirms queued events were delivered. Leave recovery/replay blank for connected runs and baseline runs where not applicable; do not record zero for missing data. `block` pairs/counterbalances runs, while `variant` identifies the work/task version.

Keep a companion environment record per run with roles, devices/OS, Node/Git/Claude versions, model/settings, subagents per person, starter commit, clock offsets, exact partition type and start/end, question latency, queue size, failed tests, duplicate work, quality score, evidence paths, and deviations. Keep a separate event log with `run_id,event_type,utc_timestamp,device,actor,source,evidence_path,notes`. Store raw Claude transcripts, screen recordings, Git logs/diffs, `COORDINATION.md` history, test output, Catalyst status/event exports, and model usage/cost evidence in a run-specific evidence folder. Record hashes for final diffs and test logs where practical. Preserve failed and invalidated runs with reasons; do not delete inconvenient results.

## Graphs for the presentation

Make plots from the captured table only; do not draw mock data or interpolate missing runs.

1. **Primary time comparison:** paired dot/dumbbell plot of elapsed seconds by run and condition, grouped by connected vs peer-pause window. Show every run and cell median; with only two runs per cell, do not show misleading precision or claim statistical significance.
2. **Decision delay and bottlenecks:** plot contract decision latency, facilitator interventions, rework, and integration failures by run and condition. Preserve missing values; mark incomplete tasks instead of treating them as fast.
3. **Recovery and transport:** three-minute peer-pause timeline with Catalyst recovery/replay times, plus baseline Git/note activity during the same interval. Leave baseline recovery fields blank because its hosted route was never interrupted. This makes clear that the baseline may outperform Catalyst on update availability during a peer pause; do not assume Catalyst wins.
4. **Acceptance and quality:** show completion/pass rate and integration failures from the results CSV. Separately plot the blinded 0–10 acceptance rubric, failed tests, merge conflicts, duplicate work, and rework from the companion evaluator record. Do not combine these into an opaque “productivity score.”

Every chart must state the number of runs, definitions, and that the participants are two named developers on this setup. Show individual observations, not only averages. Include invalidated runs with a marker or explain exclusions and reasons. Keep results separate for peer-only interruption and whole-internet stress tests.

### Analysis commands

After measured runs exist, copy the header-only template to a runtime directory outside the repository, enter only observed values, then validate and render the plots. For example:

```sh
mkdir -p /tmp/catalyst-experiment-results
cp docs/experiment-results-template.csv /tmp/catalyst-experiment-results/results.csv
# Fill results.csv from the contemporaneous run logs; do not fabricate missing values.
python3 scripts/experiment-results.py /tmp/catalyst-experiment-results/results.csv \
  --out /tmp/catalyst-experiment-results/figures --validate-only
python3 scripts/experiment-results.py /tmp/catalyst-experiment-results/results.csv \
  --out /tmp/catalyst-experiment-results/figures
```

The plotting command requires Python 3 and Matplotlib. It produces descriptive PNG/SVG and a summary JSON outside the repository. Keep completed CSVs, event logs, and raw evidence in the agreed private runtime evidence directory; publish only reviewed, redacted figures and methodology.

## Evidence checklist and reporting limits

For each run retain: exact prompt; condition and order assignment; environment/version record; starter commit and final diff; timestamps and event log; both participants’ task-related conversation evidence; test and live-check output; status/queue/connection snapshots before, during, and after interruption; Git history; cost/usage if available; and deviations. Ask both participants to verify the event timeline before analysis. Redact sensitive data, but do not edit event timestamps or task outcomes.

The first study is an **N-of-2 participant pilot** with repeated runs, not a general benchmark. Repeated exposure, model variance, networking conditions, and facilitator effects remain limitations. Report raw observations and protocol deviations; do not claim causality beyond the controlled conditions, broader team productivity gains, or statistical significance. No result should be published until the runs and evidence exist.

## Separate agent-stop handoff drill

The primary 2 × 2 tests a Catalyst peer-sync pause while both developers' Claude sessions continue. It does not test what happens when an agent process stops. If the product question includes automatic pickup of stopped-agent work, run this as a separate matched follow-up and label it `agent_stop`; do not mix it into the primary plots.

Use one lead session and one subagent per developer in both Catalyst and baseline conditions. Add a third task to the same Pocket Tasks brief: write/complete integration tests after the API and CLI contract is agreed. Put that task behind the API and CLI dependencies. Before the run, assign the API task to Tiam's subagent and record the initial state. When that subagent has begun but not completed the API work, have it stop once at a pre-agreed checkpoint. It must leave its current branch/worktree untouched. The observer records the stop time and whether the system marks the task available.

- **Catalyst:** post the three tasks and dependencies; have agents use `take_next_task` and `complete_task`. At the stop, record whether the unfinished API task becomes ready and visible to Namit's agent. Namit's agent may take it only after Catalyst reports it available; it continues the CLI task until then and avoids the API files. Record time to visibility, takeover, duplicated edits, and completion.
- **Baseline:** keep the same task list/status in `COORDINATION.md`. At the stop, the stopped subagent's lead records that the API task is incomplete and available, commits/pushes that handoff, and Namit's agent checks/pulls the note before taking over. Until it sees the handoff, Namit's agent continues the CLI task and avoids API files. Record the same timings and duplication/rework measures.

Do not tell the active agent that its teammate stopped until the handoff is visible through the assigned method. The live acceptance check is still the same: all tests pass and add/list succeeds. Repeat equally in both methods, swapping which participant owns the interrupted task. This follow-up measures a deliberate, announced handoff; it does not prove safe takeover after an unannounced laptop failure. Test that separately only with a pre-registered scenario and explicit recovery rules.

## Remaining setup decisions

- Prepare the shared `COORDINATION.md` template and a clean Pocket Tasks starter commit before the first timed run.
- Confirm the counterbalanced run order, two observations per cell, and 180-second peer-sync pause.
- Lock the same Claude model/settings on both Macs. Confirm consent for recordings, evidence retention location, and who scores quality without seeing the condition.
- Keep one lead session and zero subagents per person in the primary study; run multiagent handoff separately.
- Confirm whether to run the optional whole-internet stress test. It is not part of the primary 2 × 2 comparison.
