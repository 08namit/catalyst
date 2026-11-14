/** Plain-English renderers for the agent/queue/status tools (bounded, peer text sanitised). */
import type { CallerView, PeerStatus, QueueSummary, SyncSummary, UpdateItem } from '../core/api.js';
import { LEAD_AGENT, sanitizeForContext } from '../core/protocol.js';
import type { ConflictView, ProjectState } from '../core/state.js';

const TYPE_LABELS: Record<string, string> = {
  'decision.recorded': 'decision',
  'progress.reported': 'progress',
  'message.posted': 'message',
  'task.created': 'task',
  'task.claimed': 'claim',
  'task.released': 'release',
  'goal.set': 'goal',
  'issue.reported': 'issue',
  'issue.resolved': 'issue resolved',
  'conflict.resolved': 'conflict resolved',
  'agent.registered': 'agent',
  'activity.captured': 'activity',
  'ack.recorded': 'ack',
};

export function updateLine(u: UpdateItem): string {
  const who = u.agentName || u.authorName;
  return `- [${TYPE_LABELS[u.type] ?? u.type}] ${sanitizeForContext(who, 80)}: ${sanitizeForContext(u.summary, 300)} (\`${u.id}\`)`;
}

export function personName(state: ProjectState, participant: string): string {
  return state.participants.find((p) => p.id === participant)?.name ?? participant;
}

/** One line per queue task: id, title, status, owners, what it waits on, who it is for. */
export function queueLines(state: ProjectState, queue: QueueSummary, max = 30): string[] {
  const status = new Map(queue.tasks.map((t) => [t.taskId, t.status]));
  const lines = queue.tasks.slice(0, max).map((t) => {
    const parts = [t.status];
    if (t.ownerNames.length) parts.push(`by ${t.ownerNames.join(', ')}`);
    const waiting = t.dependsOn.filter((d) => status.get(d) !== 'done');
    if (t.status !== 'done' && !t.ready && waiting.length) parts.push(`waiting on ${waiting.join(', ')}`);
    else if (t.status !== 'done' && t.ready && t.ownerKeys.length === 0) parts.push('ready');
    if (t.assignee && t.assignee !== 'any') parts.push(`for ${personName(state, t.assignee)}`);
    return `- \`${t.taskId}\` ${sanitizeForContext(t.title, 120)} — ${parts.join('; ')}`;
  });
  if (queue.tasks.length > max) lines.push(`- … and ${queue.tasks.length - max} more`);
  return lines;
}

export function queueHeadline(queue: QueueSummary): string {
  if (queue.total === 0) return 'Queue: empty.';
  return `Queue: ${queue.total} task${queue.total === 1 ? '' : 's'} — ${queue.done} done, ${queue.inProgress} in progress, ${queue.ready} ready, ${queue.blocked} blocked.`;
}

export function conflictSentence(c: ConflictView): string {
  const heads = c.heads.map((h) => `${sanitizeForContext(h.agentName || h.authorName, 80)}: "${sanitizeForContext(h.summary, 160)}"`).join(' vs ');
  return `${c.scope} \`${c.key}\` — ${heads}. ${c.hint}`;
}

function peerSentence(p: PeerStatus): string {
  const state =
    p.state === 'connected'
      ? 'connected'
      : p.state === 'never_connected'
        ? 'has not connected yet'
        : p.state === 'connecting'
          ? 'connecting'
          : p.state === 'paused'
            ? 'paused'
            : 'unreachable';
  const pending = p.pendingOutbound > 0 ? `, ${p.pendingOutbound} update${p.pendingOutbound === 1 ? '' : 's'} waiting to be sent` : '';
  const code = p.confirmCode ? ` Confirmation code: ${p.confirmCode} (you and ${p.name} should both see this same code).` : '';
  return `- ${sanitizeForContext(p.name, 80)}: ${state}${pending}.${code}`;
}

export function statusText(state: ProjectState, sync: SyncSummary, me: CallerView, queue: QueueSummary, headline?: string): string {
  const lines: string[] = [];
  if (headline) lines.push(headline, '');
  lines.push(`Catalyst project "${sanitizeForContext(state.project?.name ?? 'unnamed', 120)}" — you are ${me.displayName}.`);
  lines.push('', sync.paused ? 'Sync: PAUSED — updates are saved locally and sent when you resume_sync.' : 'Sync: on.');
  if (sync.peers.length === 0) lines.push('Teammate: nobody has joined yet. Use invite_teammate to create an invite.');
  else lines.push('Teammates:', ...sync.peers.map(peerSentence));
  lines.push(sync.freshness);

  const agents = state.agents.filter((a) => a.agent === LEAD_AGENT || a.active || a.claims.length > 0);
  lines.push('', 'Agents:');
  for (const a of agents) {
    const claims = a.claims.length ? `working on ${a.claims.map((c) => `\`${c}\``).join(', ')}` : 'no claims';
    lines.push(`- ${sanitizeForContext(a.displayName, 100)}${a.isMe && a.agent === me.agent ? ' (you)' : ''}${a.active ? '' : ' (finished)'}: ${claims}`);
  }
  const finished = state.agents.length - agents.length;
  if (finished > 0) lines.push(`- (${finished} finished agent${finished === 1 ? '' : 's'} without claims not shown)`);

  lines.push('', queueHeadline(queue), ...queueLines(state, queue, 20));
  lines.push('', state.conflicts.length ? `Conflicts (${state.conflicts.length}):` : 'Conflicts: none.');
  for (const c of state.conflicts.slice(0, 10)) lines.push(`- ${conflictSentence(c)}`);

  lines.push('', `What to do next: ${nextSteps(state, sync, queue).join(' ')}`);
  return lines.join('\n');
}

function nextSteps(state: ProjectState, sync: SyncSummary, queue: QueueSummary): string[] {
  const steps: string[] = [];
  if (sync.peers.length === 0) steps.push('Invite your teammate with invite_teammate.');
  if (sync.paused) steps.push('Call resume_sync when you want to share updates again.');
  if (sync.peers.some((p) => p.state === 'unreachable')) steps.push('A teammate is unreachable: their updates may be waiting on their side; keep working and check again later.');
  if (state.conflicts.length) steps.push('Agree on each conflict with send_message, then call resolve_conflict.');
  if (queue.total === 0) steps.push('Post the work with post_tasks so agents can take it with take_next_task.');
  else if (queue.done === queue.total) steps.push('All tasks are done: publish_progress with the result, or post more tasks.');
  else if (queue.ready > 0) steps.push(`${queue.ready} task${queue.ready === 1 ? ' is' : 's are'} ready: agents take them with take_next_task.`);
  else steps.push('Tasks are in progress or waiting on dependencies: idle agents call wait_for_updates.');
  return steps;
}
