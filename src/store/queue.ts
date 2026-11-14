/**
 * Shared task queue (pure, deterministic): which task an agent should take next, and a queue summary.
 * Rules are documented on QueuePick in src/core/interfaces.ts.
 */
import { ownerKey } from '../core/protocol.js';
import type { QueueSummary } from '../core/api.js';
import type { QueuePick } from '../core/interfaces.js';
import type { ProjectState, TaskView } from '../core/state.js';
import { pathsOverlap } from './paths-match.js';

/** done and abandoned tasks are finished: never handed out, not "remaining". */
const finished = (t: TaskView) => t.status === 'done' || t.status === 'abandoned';

const byQueueOrder = (a: TaskView, b: TaskView) => a.order - b.order || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);

function waitingOn(state: ProjectState, t: TaskView): string[] {
  return t.dependsOn.filter((d) => state.tasks.find((x) => x.taskId === d)?.status !== 'done');
}

export function pickNextTask(state: ProjectState, me: string, agent: string, opts: { taskId?: string } = {}): QueuePick {
  const key = ownerKey(me, agent);
  const tasks = [...state.tasks].sort(byQueueOrder);
  const remaining = tasks.filter((t) => !finished(t)).length;
  const blocked = tasks
    .filter((t) => !finished(t) && !t.ready)
    .map((t) => ({ taskId: t.taskId, waitingOn: waitingOn(state, t) }))
    .filter((b) => b.waitingOn.length > 0);
  const pick = (task: TaskView | null, reason: QueuePick['reason']): QueuePick => ({ task, reason, remaining, blocked });

  if (opts.taskId !== undefined) {
    const t = tasks.find((x) => x.taskId === opts.taskId);
    if (!t) return pick(null, 'not_found');
    return t.status === 'done' ? pick(t, 'already_done') : pick(t, 'requested');
  }
  if (tasks.length === 0) return pick(null, 'empty');

  const resume = tasks.find((t) => !finished(t) && t.ownerKeys.includes(key));
  if (resume) return pick(resume, 'resume');

  // Paths held by other agents' live claims (a claim without paths covers its task's paths).
  const heldPaths = tasks.flatMap((t) => t.claims.filter((c) => c.ownerKey !== key).flatMap((c) => (c.paths.length ? c.paths : t.paths)));
  const next = tasks
    .filter(
      (t) =>
        t.ready &&
        !finished(t) &&
        t.claims.length === 0 &&
        (t.assignee === 'any' || t.assignee === me) &&
        pathsOverlap(t.paths, heldPaths).length === 0,
    )
    .sort((a, b) => Number(b.assignee === me) - Number(a.assignee === me) || byQueueOrder(a, b))[0];
  if (next) return pick(next, 'next');
  return pick(null, remaining === 0 ? 'all_done' : 'none_ready');
}

export function summarizeQueue(state: ProjectState): QueueSummary {
  const tasks = [...state.tasks].sort(byQueueOrder);
  const summary: QueueSummary = { total: tasks.length, done: 0, inProgress: 0, ready: 0, blocked: 0, tasks: [] };
  for (const t of tasks) {
    // Abandoned tasks count in total only.
    if (t.status === 'done') summary.done++;
    else if (!finished(t)) {
      if (t.claims.length > 0) summary.inProgress++;
      else if (t.ready) summary.ready++;
      else if (waitingOn(state, t).length > 0) summary.blocked++;
    }
    summary.tasks.push({
      taskId: t.taskId,
      title: t.title,
      status: t.status,
      assignee: t.assignee,
      dependsOn: t.dependsOn,
      ready: t.ready,
      ownerKeys: t.ownerKeys,
      ownerNames: [...new Set(t.claims.map((c) => c.ownerName))],
    });
  }
  return summary;
}
