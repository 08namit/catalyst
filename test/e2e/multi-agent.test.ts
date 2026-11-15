/**
 * v0.2 multi-agent end-to-end test: two real daemons (Alice, Bob), each with several agents. Agents are
 * simulated exactly the way Claude Code's PreToolUse hook identifies them: every tool body carries
 * `_caller: { agentId, agentType }` (absent = the lead / main session).
 *
 * Scenarios: 1 pairing, 2 same-person decision conflict, 3 own-agent path overlap warning, 4 task queue with
 * dependsOn + assignee across laptops, 5 agent-addressed message + wait_for_updates, 6 cross-laptop double take
 * during an outage is flagged, 7 SubagentStop releases claims, 8 identical handover on both replicas.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentStopResponse, ClaimResult, PublishResult, TakeTaskResult, WaitResult } from '../../src/core/api.js';
import type { CatalystClient } from '../../src/client/index.js';
import { assertBuilt, cleanupNodes, cliOk, client, initNode, joinNode, state, status, waitFor } from './helpers.js';

let A = '';
let B = '';
let ca: CatalystClient;
let cb: CatalystClient;

type Caller = { agentId?: string; agentType?: string };
const LEAD: Caller = {};
const agent = (agentId: string, agentType = 'general-purpose'): Caller => ({ agentId, agentType });
const call = <T>(c: CatalystClient, who: Caller, tool: string, input: Record<string, unknown> = {}) => c.tool<T>(tool, { ...input, _caller: who });

async function waitConverged(): Promise<void> {
  await waitFor('both nodes converged', async () => {
    const [sa, sb] = await Promise.all([status(A), status(B)]);
    const peer = (s: typeof sa) => s.sync.peers[0];
    return sa.counts.events === sb.counts.events && sa.sync.pendingOutbound === 0 && sb.sync.pendingOutbound === 0 && peer(sa)?.state === 'connected' && peer(sb)?.state === 'connected';
  }, 20_000);
}

function handoverHash(dir: string): string {
  const text = readFileSync(join(dir, 'IMPORTANT.md'), 'utf8');
  const block = /<!-- catalyst:handover:begin -->[\s\S]*<!-- catalyst:handover:end -->/.exec(text)?.[0] ?? '';
  expect(block.length).toBeGreaterThan(0);
  return createHash('sha256').update(block).digest('hex');
}

describe('multi-agent e2e (real CLI, real daemons)', { concurrent: false }, () => {
  beforeAll(() => assertBuilt());
  afterAll(async () => {
    await cleanupNodes();
  }, 60_000);

  it('1. Alice and Bob pair and connect', async () => {
    A = await initNode('MA', 'Alice');
    B = (await joinNode(A, 'MB', 'Bob')).dir;
    ca = client(A, 'mcp:alice');
    cb = client(B, 'mcp:bob');
    await waitConverged();
  }, 60_000);

  it('2. two agents of ONE person publishing on one topic are flagged as a conflict on both laptops', async () => {
    const d1 = await call<PublishResult>(ca, agent('a1'), 'publish_decision', { topic: 'notes/format', title: 'JSON', decision: 'list prints JSON', rationale: 'scripts' });
    const d2 = await call<PublishResult>(ca, agent('a2'), 'publish_decision', { topic: 'notes/format', title: 'Table', decision: 'list prints a table', rationale: 'humans' });
    expect(d2.conflicts.some((c) => c.key === 'notes/format')).toBe(true);
    // the same agent revising its own decision is NOT a conflict
    await call<PublishResult>(ca, agent('a1'), 'publish_decision', { topic: 'notes/format', title: 'JSON v2', decision: 'list prints JSON lines', rationale: 'streaming' });
    await waitConverged();
    for (const dir of [A, B]) {
      const s = (await state(dir)).state;
      const topic = s.decisions.find((t) => t.topic === 'notes/format')!;
      expect(topic.conflict).toBe(true);
      expect(topic.heads).toHaveLength(2);
      expect(topic.heads.map((h) => h.agentName).sort()).toEqual(['Alice / general-purpose-1', 'Alice / general-purpose-2']);
      expect(s.agents.filter((g) => g.participantName === 'Alice').map((g) => g.name)).toEqual(expect.arrayContaining(['lead', 'general-purpose-1', 'general-purpose-2']));
    }
    expect(d1.event.id).toBeTruthy();
    // resolve through the lead
    await call<PublishResult>(ca, LEAD, 'resolve_conflict', { scope: 'decision', key: 'notes/format', resolution: 'list prints JSON lines' });
    await waitConverged();
    for (const dir of [A, B]) expect((await state(dir)).state.conflicts).toHaveLength(0);
  }, 60_000);

  it('3. path overlap between two agents of the same person produces a warning', async () => {
    await call<ClaimResult>(ca, agent('a1'), 'claim_task', { taskId: 'api-routes', title: 'API routes', scope: 'routes', paths: ['src/api/**'] });
    const second = await call<ClaimResult>(ca, agent('a2'), 'claim_task', { taskId: 'api-auth', title: 'API auth', scope: 'auth', paths: ['src/api/auth.ts'] });
    expect(second.overlaps.some((o) => o.reason === 'path_overlap' && o.taskId === 'api-routes')).toBe(true);
    expect(second.warnings.join(' ')).toMatch(/api-routes/);
    // claim_task created these tasks, so they are queue items too: finish them so the queue below starts clean.
    await call(ca, agent('a1'), 'complete_task', { taskId: 'api-routes', summary: 'done' });
    await call(ca, agent('a2'), 'complete_task', { taskId: 'api-auth', summary: 'done' });
  }, 30_000);

  it('4. shared queue: dependsOn and assignee are honoured across laptops; no task is handed out twice', async () => {
    await call<PublishResult>(ca, LEAD, 'post_tasks', {
      tasks: [
        { taskId: 'notes-core', title: 'Notes core module', paths: ['src/notes.js'] },
        { taskId: 'notes-cli', title: 'Notes CLI', paths: ['src/cli.js'], dependsOn: ['notes-core'] },
        { taskId: 'notes-web', title: 'Notes web page', paths: ['web/**'], assignee: 'Bob' },
      ],
    });
    await waitConverged();
    const t1 = await call<TakeTaskResult>(ca, agent('a1'), 'take_next_task');
    expect(t1.pick.task?.taskId).toBe('notes-core');
    const t2 = await call<TakeTaskResult>(ca, agent('a2'), 'take_next_task');
    expect(t2.pick.task).toBeNull(); // notes-cli blocked on notes-core, notes-web is Bob's
    expect(t2.pick.reason).toBe('none_ready');
    const tb = await call<TakeTaskResult>(cb, agent('b1'), 'take_next_task');
    expect(tb.pick.task?.taskId).toBe('notes-web');

    await call<PublishResult>(ca, agent('a1'), 'complete_task', { taskId: 'notes-core', summary: 'done', evidence: ['node --test: 8 passed'] });
    const t3 = await call<TakeTaskResult>(ca, agent('a2'), 'take_next_task');
    expect(t3.pick.task?.taskId).toBe('notes-cli');
    await waitConverged();
    const tasks = (await state(B)).state.tasks;
    const owners = Object.fromEntries(tasks.map((t) => [t.taskId, t.claims.map((c) => c.ownerName)]));
    expect(owners['notes-cli']).toEqual(['Alice / general-purpose-2']);
    expect(owners['notes-web']).toEqual(['Bob / general-purpose-1']);
    expect(tasks.find((t) => t.taskId === 'notes-core')!.status).toBe('done');
  }, 60_000);

  it('5. a message to one agent ("Bob/<name>") wakes that agent via wait_for_updates and is unread only for it', async () => {
    // b1 has a backlog of unread updates (wait_for_updates returns those immediately): read them first.
    await call(cb, agent('b1'), 'acknowledge_updates', { upToCursor: 1_000_000 });
    const waiting = call<WaitResult>(cb, agent('b1'), 'wait_for_updates', { timeoutSec: 30 });
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    await call<PublishResult>(ca, LEAD, 'send_message', { kind: 'question', body: 'Which port does the web page use?', to: 'Bob/general-purpose-1' });
    const woke = await waiting;
    expect(woke.outcome).toBe('updates');
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(woke.updates.some((u) => u.type === 'message.posted')).toBe(true);

    const other = await call<WaitResult>(cb, agent('b2'), 'wait_for_updates', { timeoutSec: 1, topic: 'nothing/here' });
    expect(other.outcome).toBe('timeout');
  }, 60_000);

  it('6. two laptops taking the same task while disconnected is flagged as a claim conflict after reconnect', async () => {
    await call<PublishResult>(ca, LEAD, 'post_tasks', { tasks: [{ taskId: 'notes-tests', title: 'End-to-end tests', paths: ['test/e2e.test.js'] }] });
    await waitConverged();
    await cliOk(['peer', 'pause', '--dir', B]);
    try {
      const ta = await call<TakeTaskResult>(ca, agent('a3'), 'take_next_task');
      const tb = await call<TakeTaskResult>(cb, agent('b2'), 'take_next_task');
      expect(ta.pick.reason).toBe('none_ready');
      expect(tb.pick.reason).toBe('none_ready');
      // Manual claims still exercise the existing advisory conflict path under a deliberate partition.
      await call<ClaimResult>(ca, agent('a3'), 'claim_task', { taskId: 'notes-tests', scope: 'End-to-end tests', paths: ['test/e2e.test.js'] });
      await call<ClaimResult>(cb, agent('b2'), 'claim_task', { taskId: 'notes-tests', scope: 'End-to-end tests', paths: ['test/e2e.test.js'] });
    } finally {
      await cliOk(['peer', 'resume', '--dir', B]);
    }
    await waitConverged();
    for (const dir of [A, B]) {
      const s = (await state(dir)).state;
      expect(s.conflicts.some((c) => c.scope === 'claim' && c.key === 'notes-tests')).toBe(true);
    }
  }, 60_000);

  it('7. SubagentStop releases the finished agent’s unfinished claims back to the queue', async () => {
    const stopped = await ca.request<AgentStopResponse>('POST', '/api/agents/stop', { agentId: 'a3' });
    expect(stopped.released).toContain('notes-tests');
    await waitConverged();
    const s = (await state(B)).state;
    expect(s.conflicts.some((c) => c.key === 'notes-tests')).toBe(false);
    expect(s.agents.find((g) => g.participantName === 'Alice' && g.agent === 'a3')?.active).toBe(false);
  }, 60_000);

  it('8. the generated IMPORTANT.md block is identical on both laptops', async () => {
    await waitConverged();
    await Promise.all([ca.request('POST', '/api/handover', {}), cb.request('POST', '/api/handover', {})]);
    expect(handoverHash(A)).toBe(handoverHash(B));
  }, 30_000);
});
