/** Two real local daemons exercise signed checkpoint replay and a cross-participant queue handoff.
 * Agent tool calls are simulated; this is not a physical two-device or live-Claude benchmark. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TakeTaskResult } from '../../src/core/api.js';
import { assertBuilt, cleanupNodes, client, initNode, joinNode, state, status, waitFor } from './helpers.js';

describe('checkpoint recovery across two daemons', () => {
  beforeAll(() => assertBuilt());
  afterAll(cleanupNodes, 60_000);

  it('keeps remote claims during an outage, replays milestones, and hands stopped work to a new worker', async () => {
    const a = await initNode('recovery-a', 'Tiam');
    const b = (await joinNode(a, 'recovery-b', 'Namit')).dir;
    const ca = client(a, 'recovery:a');
    const cb = client(b, 'recovery:b');
    await waitFor('both peers connected', async () => (await status(a)).sync.peers[0]?.state === 'connected' && (await status(b)).sync.peers[0]?.state === 'connected');
    await ca.tool('post_tasks', { tasks: [
      { taskId: 'handoff', title: 'Recover API work', paths: ['api.js'], order: 0 },
      { taskId: 'local', title: 'Independent CLI work', paths: ['cli.js'], assignee: 'Namit', order: 1 },
      { taskId: 'unassigned', title: 'Do not race for this', paths: ['shared.js'], order: 2 },
    ] });
    const original = { agentId: 'original' };
    const replacement = { agentId: 'replacement' };
    await ca.tool('take_next_task', { taskId: 'handoff', _caller: original });
    await ca.tool('checkpoint_task', { taskId: 'handoff', status: 'in_progress', summary: 'PRIVATE_INITIAL_PLAN', nextSteps: ['Verify the API contract'], _caller: original });
    await waitFor('initial checkpoint synced', async () => (await state(b)).state.tasks.find((t) => t.taskId === 'handoff')?.latestProgress.some((p) => p.summary === 'PRIVATE_INITIAL_PLAN'));
    await cb.tool('pause_sync', {});
    await ca.tool('checkpoint_task', { taskId: 'handoff', status: 'in_progress', summary: 'PRIVATE_MILESTONE_VALIDATION_DONE', nextSteps: ['Add missing authorization tests'], evidence: ['Parser checks passed'], branch: 'feature/api', commit: 'abcd1234', _caller: original });
    await ca.post('/api/agents/stop', { agentId: 'original' });
    // A release on the unreachable peer is not permission to guess: B still knows A's old live claim.
    const blocked = await cb.tool<TakeTaskResult>('take_next_task', { taskId: 'handoff', _caller: replacement });
    expect(blocked.pick.task).toBeNull();
    const unassigned = await cb.tool<TakeTaskResult>('take_next_task', { taskId: 'unassigned', _caller: replacement });
    expect(unassigned.pick.task).toBeNull();
    const local = await cb.tool<TakeTaskResult>('take_next_task', { _caller: replacement });
    expect(local.pick.task?.taskId).toBe('local');
    await cb.tool('complete_task', { taskId: 'local', summary: 'Independent work verified', _caller: replacement });
    expect((await state(b)).state.tasks.find((t) => t.taskId === 'handoff')?.latestProgress.some((p) => p.summary === 'PRIVATE_MILESTONE_VALIDATION_DONE')).toBe(false);
    await cb.tool('resume_sync', {});
    await waitFor('checkpoint and graceful release replayed', async () => {
      const task = (await state(b)).state.tasks.find((t) => t.taskId === 'handoff');
      return task?.claims.length === 0 && task.latestProgress.some((p) => p.summary === 'PRIVATE_MILESTONE_VALIDATION_DONE');
    });
    const takeover = await cb.tool<TakeTaskResult>('take_next_task', { taskId: 'handoff', _caller: replacement });
    expect(takeover.text).toContain('PRIVATE_MILESTONE_VALIDATION_DONE');
    expect(takeover.text).toContain('Add missing authorization tests');
    expect(takeover.text).toContain('feature/api');
    expect(takeover.text).toContain('abcd1234');
    await cb.tool('complete_task', { taskId: 'handoff', summary: 'Recovered task verified', evidence: ['API checks passed'], _caller: replacement });
    await waitFor('completion synced', async () => (await state(a)).state.tasks.find((t) => t.taskId === 'handoff')?.status === 'done');
    for (const dir of [a, b]) {
      await client(dir).post('/api/handover');
      expect(readFileSync(join(dir, 'IMPORTANT.md'), 'utf8')).not.toMatch(/PRIVATE_INITIAL_PLAN|PRIVATE_MILESTONE_VALIDATION_DONE|Add missing authorization tests/);
      expect((await state(dir)).state.conflicts).toHaveLength(0);
    }
  }, 60_000);
});
