/**
 * Plain-English summaries for `catalyst` (no arguments) and the top of `catalyst status`. Pure functions of the
 * daemon's StatusResponse so they can be tested without a daemon.
 */
import type { PeerStatus, QueueSummary, StatusResponse, SyncSummary } from '../core/api.js';
import type { AgentView } from '../core/state.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function clock(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : ` since ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function peerPhrase(p: PeerStatus): string {
  switch (p.state) {
    case 'connected':
      return `connected to ${p.name}${p.confirmCode ? ` (confirmation code ${p.confirmCode})` : ''}`;
    case 'connecting':
      return `connecting to ${p.name}`;
    case 'paused':
      return `sync with ${p.name} is paused`;
    case 'unreachable':
      return `${p.name} is unreachable${clock(p.since)}`;
    case 'never_connected':
      return `${p.name} has not connected yet`;
  }
}

/** One sentence: who you are connected to, their state, and what is waiting to be sent. */
export function connectionLine(sync: SyncSummary): string {
  if (!sync.peers.length) return 'Not connected to a teammate yet.';
  const who = sync.peers.map(peerPhrase).join('; ');
  const pending = sync.pendingOutbound ? ` ${plural(sync.pendingOutbound, 'update')} waiting to be sent.` : '';
  return `${who.charAt(0).toUpperCase()}${who.slice(1)}.${pending}`;
}

/** Subagents currently working (leads are the people's main sessions and are not counted). */
export function workingAgents(agents: AgentView[]): AgentView[] {
  return agents.filter((a) => a.active && a.name !== 'lead' && a.agent !== 'lead');
}

export function agentsLine(agents: AgentView[], max = 4): string {
  const working = workingAgents(agents);
  if (!working.length) return 'Agents working: none right now.';
  const names = working.slice(0, max).map((a) => a.displayName);
  const more = working.length > max ? `, +${working.length - max} more` : '';
  return `Agents working: ${working.length} (${names.join(', ')}${more}).`;
}

export function queueLine(q: QueueSummary): string {
  if (!q.total) return 'Task queue: empty.';
  return `Task queue: ${q.done} of ${q.total} done · ${q.inProgress} in progress · ${q.ready} ready · ${q.blocked} blocked.`;
}

export function conflictsLine(n: number): string {
  return n ? `Open conflicts: ${n} — two versions of the same decision or task need a choice.` : 'Open conflicts: none.';
}

/** The single most useful next step. */
export function nextStep(s: Pick<StatusResponse, 'sync' | 'queue' | 'counts' | 'agents'>): string {
  const { sync, queue } = s;
  if (!sync.peers.length) return 'Next: tell Claude "invite my teammate to Catalyst" and send them the invite it gives you.';
  if (s.counts.conflicts > 0) return 'Next: ask Claude "show the Catalyst conflicts and help me resolve them".';
  if (sync.paused) return 'Next: tell Claude "resume Catalyst sync" (or run `catalyst peer resume`).';
  if (sync.peers.every((p) => p.state === 'unreachable' || p.state === 'never_connected')) {
    return 'Next: make sure your teammate\'s laptop is awake, Claude or Catalyst is running there, and you share a network or VPN.';
  }
  if (!queue.total) return 'Next: tell Claude what to build. It will post tasks to the shared queue for both laptops.';
  if (queue.done === queue.total) return 'Next: every task is done. Review and merge the work, or tell Claude what to build next.';
  if (queue.ready > 0 && workingAgents(s.agents).length === 0) return 'Next: tell Claude "work through the Catalyst task queue with subagents".';
  return 'Next: nothing needed. The agents are working; run `catalyst status` for details.';
}

/** `catalyst` with no arguments, inside a project with a running daemon (≤6 lines). */
export function homeLines(s: StatusResponse, projectName: string): string[] {
  return [
    `Catalyst · ${projectName} · you are ${s.health.name}.`,
    connectionLine(s.sync),
    agentsLine(s.agents),
    queueLine(s.queue),
    conflictsLine(s.counts.conflicts),
    nextStep(s),
  ];
}

/** `catalyst` with no arguments, inside a project whose daemon is not running. */
export function homeNotRunningLines(projectName: string, name: string): string[] {
  return [
    `Catalyst · ${projectName} · you are ${name}. Catalyst is not running in this folder.`,
    'Next: open Claude Code here (it starts Catalyst for you), or run `catalyst start`.',
  ];
}

/** `catalyst` with no arguments, outside any project (3 lines). */
export function outsideLines(): string[] {
  return [
    'Catalyst is not set up in this folder.',
    '1. Once per person: npm install -g github:08namit/catalyst && catalyst install',
    '2. Open Claude Code in your project and say "set up Catalyst and invite my teammate" (or "join Catalyst with <invite>").',
  ];
}

/** Two-line plain-English summary at the top of `catalyst status`. */
export function statusSummaryLines(s: StatusResponse): string[] {
  const working = workingAgents(s.agents).length;
  const q = s.queue;
  const queue = q.total ? `tasks ${q.done}/${q.total} done, ${q.inProgress} in progress, ${q.ready} ready, ${q.blocked} blocked` : 'no tasks queued';
  const conflicts = s.counts.conflicts ? plural(s.counts.conflicts, 'open conflict') : 'no open conflicts';
  return [connectionLine(s.sync), `${working ? plural(working, 'agent') + ' working' : 'No agents working'} · ${queue} · ${conflicts}.`];
}

/** "Agents" section of `catalyst status`. */
export function agentDetailLines(agents: AgentView[]): string[] {
  if (!agents.length) return ['Agents:  none yet'];
  return [
    'Agents:',
    ...agents.map((a) => `  - ${a.displayName}: ${a.active ? 'active' : 'finished'}${a.claims.length ? ` · working on ${a.claims.join(', ')}` : ''}`),
  ];
}

/** "Queue" section of `catalyst status`. */
export function queueDetailLines(q: QueueSummary): string[] {
  if (!q.total) return ['Queue:   empty (tell Claude what to build; it posts tasks with post_tasks)'];
  const lines = [`Queue:   ${q.done} done · ${q.inProgress} in progress · ${q.ready} ready · ${q.blocked} blocked (of ${q.total})`];
  for (const t of q.tasks) {
    const who = t.ownerNames.length ? ` · ${t.ownerNames.join(', ')}` : '';
    const deps = t.dependsOn.length ? ` · after ${t.dependsOn.join(', ')}` : '';
    const label = t.status === 'unclaimed' ? (t.ready ? 'ready' : 'blocked') : t.status.replace('_', ' ');
    lines.push(`  - [${label}] ${t.taskId}: ${t.title}${who}${deps}`);
  }
  return lines;
}
