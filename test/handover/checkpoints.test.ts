import { describe, expect, it } from 'vitest';
import { renderHandoverBlock, updateHandoverFile } from '../../src/handover/important.js';
import { renderSnapshot } from '../../src/handover/snapshot.js';
import { makePair, sync, syncSummary, tempDir } from '../store/helpers.js';
import { join } from 'node:path';

describe('runtime checkpoint privacy', () => {
  it('syncs detailed recovery context but excludes it from the Git-visible handover', () => {
    const { a, b } = makePair();
    a.append({ type: 'task.created', payload: { taskId: 'api', title: 'API' }, origin: 'agent' });
    a.append({
      type: 'task.checkpoint',
      payload: {
        taskId: 'api', status: 'blocked', summary: 'PRIVATE_PLAN_SENTINEL',
        blockers: ['PRIVATE_BLOCKER_SENTINEL'], evidence: ['PRIVATE_EVIDENCE_SENTINEL'],
        nextSteps: ['PRIVATE_NEXT_SENTINEL'], branch: 'private-branch-sentinel', commit: 'aabbccdd',
      },
      refs: { task: 'api' }, origin: 'agent',
    });
    sync(a, b);
    const progress = b.getState().tasks.find((t) => t.taskId === 'api')!.latestProgress[0]!;
    expect(progress.runtimeOnly).toBe(true);
    expect(progress.summary).toBe('PRIVATE_PLAN_SENTINEL');
    const publicText = updateHandoverFile(join(tempDir(), 'IMPORTANT.md'), a.getState()).content;
    expect(publicText).not.toMatch(/PRIVATE_|private-branch-sentinel|aabbccdd/);
    expect(renderHandoverBlock(a.getState())).toBe(renderHandoverBlock(b.getState()));
    const snapshot = renderSnapshot(b.getState(), syncSummary('connected'), '2026-11-15T00:00:00.000Z');
    for (const text of ['PRIVATE_PLAN_SENTINEL', 'PRIVATE_BLOCKER_SENTINEL', 'PRIVATE_EVIDENCE_SENTINEL', 'PRIVATE_NEXT_SENTINEL', 'private-branch-sentinel', 'aabbccdd']) {
      expect(snapshot).toContain(text);
    }
  });

  it('keeps normal public progress and shared blockers in the project handover', () => {
    const { a } = makePair();
    a.append({ type: 'task.created', payload: { taskId: 'api', title: 'API' }, origin: 'agent' });
    a.append({ type: 'progress.reported', payload: { taskId: 'api', status: 'blocked', summary: 'Public status', blockers: ['shared blocker'], evidence: ['Public tests'], nextSteps: ['Public next step'] }, origin: 'agent' });
    a.append({ type: 'agent.registered', payload: { agent: 'worker', name: 'worker' }, origin: 'system', agent: 'worker' });
    a.append({ type: 'task.checkpoint', payload: { taskId: 'api', status: 'blocked', summary: 'PRIVATE_PLAN_SENTINEL', blockers: ['shared blocker', 'private blocker'] }, origin: 'agent', agent: 'worker' });
    const text = renderHandoverBlock(a.getState());
    expect(text).toContain('Public status');
    expect(text).toContain('Public tests');
    expect(text).toContain('Public next step');
    expect(text).toContain('shared blocker');
    expect(text).not.toContain('private blocker');
    expect(text).not.toContain('PRIVATE_PLAN_SENTINEL');
  });
});
