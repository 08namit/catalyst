/**
 * Tool handlers: one per entry in toolInputShapes (src/core/api.ts). Shared by POST /api/tools/:name
 * (MCP adapter, CLI, dashboard) and inbox imports. Validation failures → HttpError 400.
 */
import { toolInputSchemas, type ClaimResult, type PublishResult, type SessionInfo, type SyncSummary, type ToolInput, type ToolName } from '../core/api.js';
import type { AppendInput, EventStore } from '../core/interfaces.js';
import { formatZodError, sanitizeForContext, validatePayload, type CatalystEvent, type Origin } from '../core/protocol.js';
import type { ConflictView, ProjectState } from '../core/state.js';
import { acknowledge, buildBriefing, getUpdates, pathsOverlap } from '../store/index.js';
import { badRequest } from './context.js';

export interface ToolCall {
  store: EventStore;
  sync: () => SyncSummary;
  session: string;
  sessionKind: SessionInfo['kind'];
  origin: Origin;
  /** Idempotency key (inbox drafts). */
  clientId?: string;
}

export interface ToolOutcome {
  result: unknown;
  /** true when the clientId had already been imported (nothing new written). */
  duplicate: boolean;
}

type Appended = { event: CatalystEvent; cursor: number; duplicate: boolean };

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(toolInputSchemas, name);
}

export function runTool(name: string, rawInput: unknown, call: ToolCall): ToolOutcome {
  if (!isToolName(name)) throw badRequest(`Unknown tool "${name}". Known tools: ${Object.keys(toolInputSchemas).join(', ')}.`);
  const parsed = toolInputSchemas[name].safeParse(rawInput ?? {});
  if (!parsed.success) throw badRequest(`Invalid input for ${name}: ${formatZodError(parsed.error)}`);
  const input = parsed.data as never;
  switch (name) {
    case 'get_briefing':
      return { result: getBriefing(input, call), duplicate: false };
    case 'get_updates':
      return { result: getUpdates(call.store, input, { session: call.session, sync: call.sync() }), duplicate: false };
    case 'acknowledge_updates':
      return { result: acknowledge(call.store, input, { session: call.session, sync: call.sync(), origin: call.origin === 'fallback' ? 'fallback' : call.origin === 'human' ? 'human' : 'agent' }), duplicate: false };
    case 'claim_task':
      return claimTask(input, call);
    case 'release_task':
      return releaseTask(input, call);
    case 'publish_decision':
      return publishDecision(input, call);
    case 'publish_progress':
      return publishProgress(input, call);
    case 'send_message':
      return sendMessage(input, call);
    case 'resolve_conflict':
      return resolveConflict(input, call);
    case 'set_goal':
      return setGoal(input, call);
    case 'report_issue':
      return reportIssue(input, call);
    case 'resolve_issue':
      return resolveIssue(input, call);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function append(call: ToolCall, input: Omit<AppendInput, 'origin' | 'session' | 'clientId'>, clientIdSuffix = ''): Appended {
  const v = validatePayload(input.type, input.payload);
  if (!v.ok) throw badRequest(`Invalid ${input.type} payload: ${v.error}`);
  return call.store.append({
    ...input,
    origin: call.origin,
    session: call.session,
    ...(call.clientId ? { clientId: call.clientId + clientIdSuffix } : {}),
  });
}

/** Drop undefined values so payloads stay canonical and minimal. */
function compact<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export function deliveryLine(sync: SyncSummary): string {
  if (sync.paused) return `peer sync paused → queued, ${sync.pendingOutbound} pending (\`catalyst peer resume\`)`;
  if (sync.peers.length === 0) return 'no peer paired yet → will be sent once a peer joins (`catalyst pair`)';
  return sync.peers
    .map((p) => {
      if (p.state === 'connected') return `${p.name} connected → sending now`;
      const state = p.state === 'never_connected' ? 'has not connected yet' : p.state === 'connecting' ? 'connecting' : p.state === 'paused' ? 'paused' : 'unreachable';
      return `${p.name} ${state} → queued, ${p.pendingOutbound} pending`;
    })
    .join('; ');
}

function conflictsOn(state: ProjectState, scope: ConflictView['scope'], key: string): ConflictView[] {
  return state.conflicts.filter((c) => c.scope === scope && c.key === key);
}

function conflictLine(c: ConflictView): string {
  const heads = c.heads.map((h) => `${h.authorName}: "${sanitizeForContext(h.summary, 200)}" (\`${h.id}\`)`).join(' vs ');
  return `⚠ Conflict on ${c.scope} \`${c.key}\`: ${heads}. ${c.hint}`;
}

function publishResult(call: ToolCall, a: Appended, what: string, warnings: string[], conflicts: ConflictView[], extra: string[] = []): PublishResult {
  const sync = call.sync();
  const e = a.event;
  const lines = [`Recorded ${what} — event \`${e.id}\` (seq ${e.seq}).`];
  if (a.duplicate) lines.push('Duplicate request (same clientId): this is the original event; nothing new was written.');
  lines.push(`Saved locally; delivery: ${deliveryLine(sync)}.`);
  lines.push(...extra);
  for (const c of conflicts) lines.push(conflictLine(c));
  for (const w of warnings) lines.push(`⚠ ${w}`);
  return {
    text: lines.join('\n'),
    sync,
    event: { id: e.id, seq: e.seq, type: e.type, ts: e.ts, cursor: a.cursor },
    warnings,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------
function getBriefing(input: ToolInput<'get_briefing'>, call: ToolCall) {
  const briefing = buildBriefing(call.store, input, { sync: call.sync(), now: new Date() });
  const ids = new Set(briefing.sourceIds); // only what was rendered into the text
  if (ids.size > 0) call.store.recordRetrieval(call.session, [...ids]);
  call.store.upsertSession({ id: call.session, kind: call.sessionKind, retrieved: true });
  return briefing;
}

function claimTask(input: ToolInput<'claim_task'>, call: ToolCall): ToolOutcome {
  const state = call.store.getState();
  const me = call.store.me;
  const task = state.tasks.find((t) => t.taskId === input.taskId);
  const myPaths = input.paths ?? task?.paths ?? [];
  const overlaps: ClaimResult['overlaps'] = [];
  for (const t of state.tasks) {
    for (const c of t.claims) {
      if (c.owner === me) continue;
      if (t.taskId === input.taskId) {
        overlaps.push({ taskId: t.taskId, owner: c.owner, ownerName: c.ownerName, paths: c.paths, claimId: c.id, reason: 'same_task' });
      } else {
        const shared = pathsOverlap(myPaths, c.paths);
        if (shared.length > 0) overlaps.push({ taskId: t.taskId, owner: c.owner, ownerName: c.ownerName, paths: shared, claimId: c.id, reason: 'path_overlap' });
      }
    }
  }
  if (!task) {
    append(call, {
      type: 'task.created',
      payload: compact({ taskId: input.taskId, title: input.title ?? input.taskId, paths: input.paths }),
      refs: compact({ task: input.taskId, paths: input.paths }),
    }, '#task');
  }
  const mine = task?.claims.filter((c) => c.owner === me).map((c) => c.id) ?? [];
  const a = append(call, {
    type: 'task.claimed',
    payload: compact({ taskId: input.taskId, scope: input.scope, paths: input.paths, note: input.note }),
    refs: compact({ task: input.taskId, paths: input.paths }),
    supersedes: mine,
  });
  const warnings = overlaps.map((o) =>
    o.reason === 'same_task'
      ? `Task \`${o.taskId}\` is also claimed by ${o.ownerName} (claim \`${o.claimId}\`). Both claims are preserved and flagged as a conflict until someone calls resolve_conflict(scope "claim", key "${o.taskId}"). Coordinate with send_message.`
      : `Paths overlap with ${o.ownerName}'s claim on \`${o.taskId}\`: ${o.paths.join(', ')}. Coordinate before editing them.`,
  );
  const base = publishResult(
    call,
    a,
    `claim on task \`${input.taskId}\`${task ? '' : ' (new task created)'}`,
    warnings,
    conflictsOn(call.store.getState(), 'claim', input.taskId),
    ['Claims are advisory: they tell your peer what you intend to change; nothing is locked.'],
  );
  const result: ClaimResult = { ...base, overlaps };
  return { result, duplicate: a.duplicate };
}

function releaseTask(input: ToolInput<'release_task'>, call: ToolCall): ToolOutcome {
  const task = call.store.getState().tasks.find((t) => t.taskId === input.taskId);
  if (!task) throw badRequest(`Unknown task "${input.taskId}". Use get_briefing to list tasks.`);
  const mine = task.claims.filter((c) => c.owner === call.store.me).map((c) => c.id);
  if (mine.length === 0) throw badRequest(`You have no live claim on task "${input.taskId}" to release.`);
  const a = append(call, {
    type: 'task.released',
    payload: compact({ taskId: input.taskId, reason: input.reason }),
    refs: { task: input.taskId },
    supersedes: mine,
  });
  return { result: publishResult(call, a, `release of task \`${input.taskId}\``, [], conflictsOn(call.store.getState(), 'claim', input.taskId)), duplicate: a.duplicate };
}

function publishDecision(input: ToolInput<'publish_decision'>, call: ToolCall): ToolOutcome {
  const topic = call.store.getState().decisions.find((t) => t.topic === input.topic);
  const supersedes = input.supersedes ?? topic?.heads.map((h) => h.id) ?? [];
  const status = input.status ?? 'accepted';
  const a = append(call, {
    type: 'decision.recorded',
    payload: compact({
      topic: input.topic,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale,
      status,
      codeRefs: input.codeRefs,
      alternatives: input.alternatives,
    }),
    refs: compact({ topic: input.topic, task: input.taskId, paths: input.paths }),
    supersedes,
  });
  const revises = supersedes.length > 0 ? ` (revises ${supersedes.length} earlier version${supersedes.length > 1 ? 's' : ''})` : '';
  return {
    result: publishResult(call, a, `${status} decision "${input.title}" on topic \`${input.topic}\`${revises}`, [], conflictsOn(call.store.getState(), 'decision', input.topic)),
    duplicate: a.duplicate,
  };
}

function publishProgress(input: ToolInput<'publish_progress'>, call: ToolCall): ToolOutcome {
  const a = append(call, {
    type: 'progress.reported',
    payload: compact({
      taskId: input.taskId,
      status: input.status,
      summary: input.summary,
      blockers: input.blockers,
      evidence: input.evidence,
      nextSteps: input.nextSteps,
      branch: input.branch,
      commit: input.commit,
    }),
    refs: compact({ task: input.taskId, paths: input.paths }),
  });
  const where = input.taskId ? ` on task \`${input.taskId}\`` : '';
  return { result: publishResult(call, a, `progress (${input.status})${where}`, [], []), duplicate: a.duplicate };
}

function sendMessage(input: ToolInput<'send_message'>, call: ToolCall): ToolOutcome {
  if (input.kind === 'reply') {
    if (!input.replyTo) throw badRequest('kind "reply" requires replyTo: the event id of the question you are answering.');
    const q = call.store.getEvent(input.replyTo);
    if (!q) throw badRequest(`replyTo ${input.replyTo} is not a known event. Use get_updates or get_briefing to find the question id.`);
    if (q.event.type !== 'message.posted' || q.event.payload.kind !== 'question') throw badRequest(`replyTo ${input.replyTo} is a ${q.event.type}, not a question.`);
  }
  const a = append(call, {
    type: 'message.posted',
    payload: compact({ kind: input.kind, body: input.body, to: input.to, replyTo: input.replyTo }),
    refs: compact({ topic: input.topic, task: input.taskId }),
  });
  return { result: publishResult(call, a, `${input.kind}${input.to && input.to !== 'all' ? ` to ${input.to}` : ''}`, [], []), duplicate: a.duplicate };
}

function resolveConflict(input: ToolInput<'resolve_conflict'>, call: ToolCall): ToolOutcome {
  const state = call.store.getState();
  const conflict = state.conflicts.find((c) => c.scope === input.scope && c.key === input.key);
  if (!conflict) {
    const open = state.conflicts.map((c) => `${c.scope}:${c.key}`).join(', ') || 'none';
    throw badRequest(`No open ${input.scope} conflict for "${input.key}". Open conflicts: ${open}.`);
  }
  const headIds = conflict.heads.map((h) => h.id);
  if (input.chosen && !headIds.includes(input.chosen)) throw badRequest(`chosen ${input.chosen} is not one of the conflicting heads: ${headIds.join(', ')}.`);
  const refs = input.scope === 'decision' ? { topic: input.key } : input.scope === 'claim' ? { task: input.key } : {};
  const a = append(call, {
    type: 'conflict.resolved',
    payload: compact({ scope: input.scope, key: input.key, resolution: input.resolution, chosen: input.chosen, owner: input.owner }),
    refs,
    supersedes: headIds,
  });
  return {
    result: publishResult(call, a, `resolution of ${input.scope} conflict \`${input.key}\` (history preserved)`, [], conflictsOn(call.store.getState(), input.scope, input.key)),
    duplicate: a.duplicate,
  };
}

function setGoal(input: ToolInput<'set_goal'>, call: ToolCall): ToolOutcome {
  const supersedes = call.store.getState().goal.heads.map((g) => g.id);
  const a = append(call, {
    type: 'goal.set',
    payload: compact({ title: input.title, description: input.description, successCriteria: input.successCriteria }),
    supersedes,
  });
  return { result: publishResult(call, a, `goal "${input.title}"`, [], conflictsOn(call.store.getState(), 'goal', 'goal')), duplicate: a.duplicate };
}

function reportIssue(input: ToolInput<'report_issue'>, call: ToolCall): ToolOutcome {
  const a = append(call, {
    type: 'issue.reported',
    payload: compact({ kind: input.kind, title: input.title, detail: input.detail, taskId: input.taskId }),
    refs: compact({ task: input.taskId, paths: input.paths }),
  });
  return { result: publishResult(call, a, `${input.kind} "${input.title}"`, [], []), duplicate: a.duplicate };
}

function resolveIssue(input: ToolInput<'resolve_issue'>, call: ToolCall): ToolOutcome {
  const issue = call.store.getState().issues.find((i) => i.id === input.issueId);
  if (!issue) throw badRequest(`Unknown issue ${input.issueId}. Use get_briefing to list open issues.`);
  const warnings = issue.status === 'resolved' ? ['This issue was already resolved; recorded another resolution.'] : [];
  const a = append(call, {
    type: 'issue.resolved',
    payload: compact({ issueId: input.issueId, note: input.note }),
    refs: compact({ task: issue.taskId }),
  });
  return { result: publishResult(call, a, `resolution of ${issue.kind} "${issue.title}"`, warnings, []), duplicate: a.duplicate };
}
