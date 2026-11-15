import { describe, expect, it } from 'vitest';
import type { PeerStatus, QueueSummary, StatusResponse } from '../../src/core/api.js';
import type { AgentView } from '../../src/core/state.js';
import {
  agentDetailLines,
  homeLines,
  homeNotRunningLines,
  nextStep,
  outsideLines,
  queueDetailLines,
  statusSummaryLines,
} from '../../src/cli/summary.js';

const ME = 'p_aaaaaaaaaaaaaaaaaaaaaaaa';
const PEER = 'p_bbbbbbbbbbbbbbbbbbbbbbbb';

function agent(participant: string, participantName: string, agentKey: string, name: string, over: Partial<AgentView> = {}): AgentView {
  return {
    participant,
    participantName,
    agent: agentKey,
    address: `${participant}/${agentKey}`,
    name,
    displayName: agentKey === 'lead' ? participantName : `${participantName} / ${name}`,
    active: true,
    isMe: participant === ME,
    claims: [],
    ...over,
  };
}

const emptyQueue: QueueSummary = { total: 0, done: 0, inProgress: 0, ready: 0, blocked: 0, tasks: [] };
const queue: QueueSummary = {
  total: 3,
  done: 1,
  inProgress: 1,
  ready: 0,
  blocked: 1,
  tasks: [
    { taskId: 'notes-core', title: 'Notes core module', status: 'done', assignee: 'any', dependsOn: [], ready: true, ownerKeys: [`${ME}/a1`], ownerNames: ['Tiam / core'] },
    { taskId: 'notes-cli', title: 'CLI commands', status: 'in_progress', assignee: 'any', dependsOn: ['notes-core'], ready: true, ownerKeys: [`${PEER}/b1`], ownerNames: ['Namit / cli'] },
    { taskId: 'notes-tests', title: 'End-to-end tests', status: 'unclaimed', assignee: 'any', dependsOn: ['notes-cli'], ready: false, ownerKeys: [], ownerNames: [] },
  ],
};

function peer(over: Partial<PeerStatus> = {}): PeerStatus {
  return { participant: PEER, name: 'Namit', state: 'connected', addrs: ['10.0.0.2:4000'], pendingOutbound: 0, sessions: [], confirmCode: 'd97621d7', ...over };
}

function status(over: { peers?: PeerStatus[]; paused?: boolean; pending?: number; queue?: QueueSummary; conflicts?: number; agents?: AgentView[] } = {}): StatusResponse {
  const peers = over.peers ?? [peer()];
  return {
    health: { ok: true, projectId: 'prj_000000000000000000000000', participantId: ME, name: 'Tiam', nonce: 'n', pid: 1, version: '0.2.0', protocol: 2, apiPort: 1, peerPort: 2, startedAt: '2026-11-14T10:00:00.000Z' },
    dataDir: '/x/.catalyst',
    projectDir: '/x',
    sync: { paused: over.paused ?? false, peerPort: 2, peers, pendingOutbound: over.pending ?? 0, parkedEvents: 0, freshness: '' },
    counts: { events: 10, ownEvents: 5, peerEvents: 5, unacknowledged: 0, conflicts: over.conflicts ?? 0, forks: 0 },
    sessions: [],
    inbox: { pending: 0, rejected: 0, imported: 0 },
    snapshot: { path: '/x/.catalyst/snapshot.md' },
    handover: { path: '/x/IMPORTANT.md' },
    agents: over.agents ?? [
      agent(ME, 'Tiam', 'lead', 'lead'),
      agent(ME, 'Tiam', 'a1', 'core', { active: false }),
      agent(PEER, 'Namit', 'lead', 'lead', { isMe: false }),
      agent(PEER, 'Namit', 'b1', 'cli', { claims: ['notes-cli'] }),
    ],
    queue: over.queue ?? queue,
  };
}

describe('catalyst (no arguments)', () => {
  it('inside a project: at most 6 plain-English lines ending with one next step', () => {
    const lines = homeLines(status(), 'notes');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines).toEqual([
      'Catalyst · notes · you are Tiam.',
      'Connected to Namit (confirmation code d97621d7).',
      'Agents working: 1 (Namit / cli).',
      'Task queue: 1 of 3 done · 1 in progress · 0 ready · 1 blocked.',
      'Open conflicts: none.',
      'Next: nothing needed. The agents are working; run `catalyst status` for details.',
    ]);
    expect(lines.filter((l) => l.startsWith('Next:'))).toHaveLength(1);
  });

  it('mentions pending updates and an unreachable teammate', () => {
    const lines = homeLines(status({ peers: [peer({ state: 'unreachable', since: undefined })], pending: 3 }), 'notes');
    expect(lines[1]).toBe('Namit is unreachable. 3 updates waiting to be sent.');
    expect(lines.at(-1)).toMatch(/^Next: make sure your teammate's laptop is awake/);
  });

  it('suggests the right next step', () => {
    expect(nextStep(status({ peers: [] }))).toMatch(/invite my teammate/);
    expect(nextStep(status({ conflicts: 2 }))).toMatch(/resolve them/);
    expect(nextStep(status({ paused: true, peers: [peer({ state: 'paused' })] }))).toMatch(/resume Catalyst sync/);
    expect(nextStep(status({ queue: emptyQueue }))).toMatch(/tell Claude what to build/);
    expect(nextStep(status({ queue: { ...queue, done: 3, inProgress: 0, blocked: 0 } }))).toMatch(/every task is done/);
    expect(nextStep(status({ queue: { ...queue, ready: 1 }, agents: [agent(ME, 'Tiam', 'lead', 'lead')] }))).toMatch(/work through the Catalyst task queue/);
  });

  it('daemon not running', () => {
    const lines = homeNotRunningLines('notes', 'Tiam');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[1]).toMatch(/open Claude Code here/);
  });

  it('outside a project: 3 lines on how to start', () => {
    const lines = outsideLines();
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain('npm install -g github:08namit/catalyst && catalyst install');
    expect(lines.join('\n')).toContain('set up Catalyst and invite my teammate');
  });
});

describe('catalyst status', () => {
  it('starts with a 2-line summary', () => {
    expect(statusSummaryLines(status())).toEqual([
      'Connected to Namit (confirmation code d97621d7).',
      '1 agent working · tasks 1/3 done, 1 in progress, 0 ready, 1 blocked · no open conflicts.',
    ]);
    expect(statusSummaryLines(status({ peers: [], queue: emptyQueue, conflicts: 1, agents: [] }))).toEqual([
      'Not connected to a teammate yet.',
      'No agents working · no tasks queued · 1 open conflict.',
    ]);
  });

  it('lists agents with state and claims', () => {
    expect(agentDetailLines(status().agents)).toEqual([
      'Agents:',
      '  - Tiam: active',
      '  - Tiam / core: finished',
      '  - Namit: active',
      '  - Namit / cli: active · working on notes-cli',
    ]);
  });

  it('lists the queue in order with owners and dependencies', () => {
    expect(queueDetailLines(queue)).toEqual([
      'Queue:   1 done · 1 in progress · 0 ready · 1 blocked (of 3)',
      '  - [done] notes-core: Notes core module · Tiam / core',
      '  - [in progress] notes-cli: CLI commands · Namit / cli · after notes-core',
      '  - [blocked] notes-tests: End-to-end tests · after notes-cli',
    ]);
    expect(queueDetailLines(emptyQueue)[0]).toMatch(/^Queue:   empty/);
  });
});
