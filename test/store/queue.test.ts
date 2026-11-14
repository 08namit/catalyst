import { describe, expect, it } from 'vitest';
import { newProjectId } from '../../src/core/protocol.js';
import { pickNextTask, summarizeQueue } from '../../src/store/index.js';
import type { SqliteEventStore } from '../../src/store/index.js';
import { makeNode, makePair, sync } from './helpers.js';

const X = 'a7a6a241124692d30';
const Y = 'b1c2d3e4f5a6b7c8d';

function post(s: SqliteEventStore, taskId: string, extra: { dependsOn?: string[]; assignee?: string; order?: number; paths?: string[] } = {}) {
  return s.append({ type: 'task.created', payload: { taskId, title: taskId.toUpperCase(), ...extra }, origin: 'agent' }).event;
}
function take(s: SqliteEventStore, taskId: string, agent: string, paths?: string[]) {
  return s.append({ type: 'task.claimed', payload: { taskId, scope: 'work', ...(paths ? { paths } : {}) }, origin: 'agent', agent }).event;
}
function done(s: SqliteEventStore, taskId: string, agent: string) {
  s.append({ type: 'progress.reported', payload: { taskId, status: 'done', summary: 'done' }, origin: 'agent', agent });
  s.append({ type: 'task.released', payload: { taskId }, origin: 'agent', agent });
}

describe('pickNextTask', () => {
  it('honours dependsOn, queue order, and resumes the agent’s own claim', () => {
    const s = makeNode(newProjectId(), 'Tiam', true);
    post(s, 'core');
    post(s, 'api', { dependsOn: ['core'] });
    post(s, 'ui', { dependsOn: ['core', 'api'] });
    let st = s.getState();
    expect(st.tasks.map((t) => [t.taskId, t.order, t.ready])).toEqual([
      ['core', 0, true],
      ['api', 1, false],
      ['ui', 2, false],
    ]);
    let p = pickNextTask(st, s.me, X);
    expect(p).toMatchObject({ reason: 'next', remaining: 3, task: { taskId: 'core' } });
    expect(p.blocked).toEqual([
      { taskId: 'api', waitingOn: ['core'] },
      { taskId: 'ui', waitingOn: ['core', 'api'] },
    ]);

    take(s, 'core', X);
    st = s.getState();
    expect(pickNextTask(st, s.me, X)).toMatchObject({ reason: 'resume', task: { taskId: 'core' } });
    expect(pickNextTask(st, s.me, Y)).toMatchObject({ reason: 'none_ready', task: null, remaining: 3 });

    done(s, 'core', X);
    st = s.getState();
    expect(pickNextTask(st, s.me, Y)).toMatchObject({ reason: 'next', task: { taskId: 'api', ready: true }, remaining: 2 });
    expect(pickNextTask(st, s.me, Y).blocked).toEqual([{ taskId: 'ui', waitingOn: ['api'] }]);

    done(s, 'api', Y);
    done(s, 'ui', X);
    expect(pickNextTask(s.getState(), s.me, Y)).toMatchObject({ reason: 'all_done', task: null, remaining: 0, blocked: [] });
  });

  it('prefers tasks assigned to me, skips tasks for other participants, and uses explicit order', () => {
    const { a, b } = makePair();
    post(a, 'shared-late', { order: 50 });
    post(a, 'shared-early', { order: 10 });
    post(a, 'for-namit', { assignee: b.me, order: 0 });
    post(a, 'for-tiam', { assignee: a.me, order: 99 });
    sync(a, b);
    expect(pickNextTask(a.getState(), a.me, X).task?.taskId).toBe('for-tiam');
    expect(pickNextTask(b.getState(), b.me, X).task?.taskId).toBe('for-namit');
    take(a, 'for-tiam', 'lead');
    expect(pickNextTask(a.getState(), a.me, X).task?.taskId).toBe('shared-early');
  });

  it('skips tasks whose paths overlap another agent’s live claim (including my own other agents)', () => {
    const s = makeNode(newProjectId(), 'Tiam', true);
    post(s, 'api-routes', { paths: ['src/api/routes.ts'] });
    post(s, 'api-auth', { paths: ['src/api/auth.ts'] });
    post(s, 'docs', { paths: ['docs/'] });
    post(s, 'api-all', { paths: ['src/api/**'] });
    take(s, 'api-all', X); // claim without paths covers its task's paths
    expect(pickNextTask(s.getState(), s.me, Y).task?.taskId).toBe('docs');
    expect(pickNextTask(s.getState(), s.me, X).reason).toBe('resume');
  });

  it('requested tasks: not ready, not found, already done', () => {
    const s = makeNode(newProjectId(), 'Tiam', true);
    expect(pickNextTask(s.getState(), s.me, X)).toMatchObject({ reason: 'empty', task: null, remaining: 0 });
    post(s, 'core');
    post(s, 'api', { dependsOn: ['core'] });
    expect(pickNextTask(s.getState(), s.me, X, { taskId: 'api' })).toMatchObject({ reason: 'requested', task: { taskId: 'api', ready: false } });
    expect(pickNextTask(s.getState(), s.me, X, { taskId: 'nope' })).toMatchObject({ reason: 'not_found', task: null });
    done(s, 'core', X);
    expect(pickNextTask(s.getState(), s.me, X, { taskId: 'core' })).toMatchObject({ reason: 'already_done', task: { taskId: 'core' } });
  });
});

describe('summarizeQueue', () => {
  it('counts done / in progress / ready / blocked in queue order with owner names', () => {
    const s = makeNode(newProjectId(), 'Tiam', true);
    s.append({ type: 'agent.registered', payload: { agent: X, name: 'api' }, origin: 'system', agent: X });
    post(s, 'core');
    post(s, 'api', { dependsOn: ['core'] });
    post(s, 'docs');
    post(s, 'ui', { dependsOn: ['missing'] });
    post(s, 'old');
    done(s, 'core', X);
    take(s, 'api', X);
    s.append({ type: 'progress.reported', payload: { taskId: 'old', status: 'abandoned', summary: 'dropped' }, origin: 'agent' });
    const q = summarizeQueue(s.getState());
    expect(q).toMatchObject({ total: 5, done: 1, inProgress: 1, ready: 1, blocked: 1 });
    expect(q.tasks.map((t) => t.taskId)).toEqual(['core', 'api', 'docs', 'ui', 'old']);
    expect(q.tasks[1]).toEqual({
      taskId: 'api',
      title: 'API',
      status: 'claimed',
      assignee: 'any',
      dependsOn: ['core'],
      ready: true,
      ownerKeys: [`${s.me}/${X}`],
      ownerNames: ['Tiam / api'],
    });
  });
});
