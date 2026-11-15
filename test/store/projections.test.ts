import { describe, expect, it } from 'vitest';
import { canonicalJson, type CatalystEvent } from '../../src/core/protocol.js';
import { pathsOverlap, project } from '../../src/store/index.js';
import { decision, makeIdentity, makePair, openStore, sync } from './helpers.js';

function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('decision conflicts', () => {
  it('flags concurrent revisions, preserves both heads, and resolves with history intact', () => {
    const { a, b } = makePair();
    const v1 = a.append(decision('api/format', 'Format', 'JSON')).event;
    sync(a, b);
    // concurrent revisions: by default a writer revises only its own head (Namit's does not supersede Tiam's v1)
    const va = a.append(decision('api/format', 'Format', 'JSON:API')).event;
    const vb = b.append(decision('api/format', 'Format', 'protobuf')).event;
    expect(va.supersedes).toEqual([v1.id]);
    expect(vb.supersedes).toEqual([]);
    sync(a, b);
    sync(b, a);
    for (const s of [a, b]) {
      const topic = s.getState().decisions.find((d) => d.topic === 'api/format')!;
      expect(topic.conflict).toBe(true);
      expect(topic.heads.map((h) => h.id).sort()).toEqual([va.id, vb.id].sort());
      const c = s.getState().conflicts.find((x) => x.scope === 'decision')!;
      expect(c.key).toBe('api/format');
      expect(c.heads).toHaveLength(2);
      expect(c.hint).toMatch(/resolve_conflict/);
    }
    const res = a.append({ type: 'conflict.resolved', payload: { scope: 'decision', key: 'api/format', resolution: 'JSON:API', chosen: va.id }, origin: 'agent' }).event;
    expect([...res.supersedes].sort()).toEqual([va.id, vb.id].sort());
    sync(a, b);
    const topic = b.getState().decisions.find((d) => d.topic === 'api/format')!;
    expect(topic.conflict).toBe(false);
    expect(topic.heads).toHaveLength(1);
    expect(topic.heads[0]).toMatchObject({ status: 'resolved', decision: 'JSON:API', title: 'Format' });
    expect(topic.history).toHaveLength(4);
    expect(b.getState().conflicts).toEqual([]);
    expect(canonicalJson(a.getState().decisions)).toBe(canonicalJson(b.getState().decisions));
  });
});

describe('claims', () => {
  it('flags concurrent claims by different people; release clears; re-claim supersedes only my own claim', () => {
    const { a, b } = makePair();
    const ca = a.append({ type: 'task.claimed', payload: { taskId: 'login', scope: 'UI' }, origin: 'agent' }).event;
    const cb = b.append({ type: 'task.claimed', payload: { taskId: 'login', scope: 'API' }, origin: 'agent' }).event;
    sync(a, b);
    sync(b, a);
    let t = a.getState().tasks.find((x) => x.taskId === 'login')!;
    expect(t.claimConflict).toBe(true);
    expect(t.owners.sort()).toEqual([a.me, b.me].sort());
    expect(a.getState().conflicts.map((c) => [c.scope, c.key])).toEqual([['claim', 'login']]);

    // a re-claims: supersedes only a's own claim, so the conflict remains
    const ca2 = a.append({ type: 'task.claimed', payload: { taskId: 'login', scope: 'UI + forms' }, origin: 'agent' }).event;
    expect(ca2.supersedes).toEqual([ca.id]);
    expect(a.getState().tasks.find((x) => x.taskId === 'login')!.claimConflict).toBe(true);

    const rel = a.append({ type: 'task.released', payload: { taskId: 'login' }, origin: 'agent' }).event;
    expect(rel.supersedes).toEqual([ca2.id]);
    t = a.getState().tasks.find((x) => x.taskId === 'login')!;
    expect(t.claimConflict).toBe(false);
    expect(t.claims.map((c) => c.id)).toEqual([cb.id]);
    expect(t.status).toBe('claimed');
    expect(a.getState().conflicts).toEqual([]);
  });

  it('conflict.resolved with owner becomes the live claim', () => {
    const { a, b } = makePair();
    a.append({ type: 'task.claimed', payload: { taskId: 'db', scope: 'schema' }, origin: 'agent' });
    b.append({ type: 'task.claimed', payload: { taskId: 'db', scope: 'migrations' }, origin: 'agent' });
    sync(b, a);
    a.append({ type: 'conflict.resolved', payload: { scope: 'claim', key: 'db', resolution: 'Namit owns db', owner: b.me }, origin: 'agent' });
    const t = a.getState().tasks.find((x) => x.taskId === 'db')!;
    expect(t.claimConflict).toBe(false);
    expect(t.claims).toHaveLength(1);
    expect(t.claims[0]).toMatchObject({ owner: b.me, viaResolution: true, ownerName: 'Namit' });
  });
});

describe('projection', () => {
  it('projects task checkpoints as runtime-only progress and replicates them', () => {
    const { a, b } = makePair();
    a.append({ type: 'task.created', payload: { taskId: 'parser', title: 'Parser' }, origin: 'agent' });
    a.append({
      type: 'task.checkpoint',
      payload: { taskId: 'parser', status: 'in_progress', summary: 'Plan the parser fix', nextSteps: ['Add an empty input case'] },
      refs: { task: 'parser' },
      origin: 'agent',
    });
    sync(a, b);
    expect(b.getState().tasks.find((t) => t.taskId === 'parser')?.latestProgress).toMatchObject([
      { runtimeOnly: true, status: 'in_progress', summary: 'Plan the parser fix', nextSteps: ['Add an empty input case'] },
    ]);
  });

  it('does not let a later peer checkpoint reopen a completed task', () => {
    const { a, b } = makePair();
    a.append({ type: 'task.created', payload: { taskId: 'parser', title: 'Parser' }, origin: 'agent' });
    sync(a, b);
    a.append({ type: 'progress.reported', payload: { taskId: 'parser', status: 'done', summary: 'Parser fixed' }, origin: 'agent' });
    sync(a, b);
    b.append({ type: 'task.checkpoint', payload: { taskId: 'parser', status: 'in_progress', summary: 'Late checkpoint from partition' }, refs: { task: 'parser' }, origin: 'agent' });
    sync(b, a);
    const task = a.getState().tasks.find((t) => t.taskId === 'parser')!;
    expect(task.status).toBe('done');
    expect(task.latestProgress.some((p) => p.runtimeOnly && p.summary === 'Late checkpoint from partition')).toBe(true);
  });

  it('is identical for the same event set regardless of arrival order', () => {
    const { a, b } = makePair();
    a.append({ type: 'goal.set', payload: { title: 'Ship', successCriteria: ['tests pass'] }, origin: 'agent' });
    a.append({ type: 'task.created', payload: { taskId: 'api', title: 'API' }, origin: 'agent' });
    a.append({ type: 'task.claimed', payload: { taskId: 'api', scope: 'server', paths: ['src/api/**'] }, origin: 'agent' });
    b.append({ type: 'task.claimed', payload: { taskId: 'api', scope: 'client' }, origin: 'agent' });
    a.append({ type: 'agent.registered', payload: { agent: 'sub1', name: 'docs' }, origin: 'system', agent: 'sub1' });
    a.append({ type: 'task.claimed', payload: { taskId: 'docs', scope: 'readme' }, origin: 'agent', agent: 'sub1' });
    a.append({ type: 'task.created', payload: { taskId: 'ui', title: 'UI', dependsOn: ['api'] }, origin: 'agent', agent: 'sub1' });
    b.append(decision('api/format', 'Format', 'JSON'));
    a.append(decision('api/format', 'Format', 'XML'));
    const q = b.append({ type: 'message.posted', payload: { kind: 'question', body: 'Port?', to: a.me }, origin: 'agent' }).event;
    sync(b, a);
    a.append({ type: 'message.posted', payload: { kind: 'reply', body: '8080', replyTo: q.id }, origin: 'agent' });
    a.append({ type: 'progress.reported', payload: { taskId: 'api', status: 'in_progress', summary: 'half', evidence: ['npm test ok'] }, origin: 'agent' });
    const issue = b.append({ type: 'issue.reported', payload: { kind: 'bug', title: 'crash', taskId: 'api' }, origin: 'agent' }).event;
    b.append({ type: 'issue.resolved', payload: { issueId: issue.id }, origin: 'agent' });
    b.append({ type: 'activity.captured', payload: { kind: 'commit', summary: 'c', commits: [{ hash: 'abcdef1', message: 'm' }] }, origin: 'hook' });
    sync(a, b);
    b.append({ type: 'ack.recorded', payload: { eventIds: [q.id] }, origin: 'agent' });
    sync(b, a);

    const all: CatalystEvent[] = a.listSince(0).map((s) => s.event);
    expect(all.length).toBeGreaterThan(15);
    const observer = makeIdentity('Observer');
    const states = [1, 2, 3, 4].map((seed) => {
      const s = openStore(a.projectId, observer);
      // deliver in shuffled batches to exercise parking/draining
      const order = shuffled(all, seed);
      for (let i = 0; i < order.length; i += 3) s.ingest(order.slice(i, i + 3), { via: 'import' });
      expect(s.parkedCount()).toBe(0);
      expect(s.verifyProjection()).toEqual({ ok: true });
      return canonicalJson(s.getState());
    });
    expect(new Set(states).size).toBe(1);
    expect(canonicalJson(project(shuffled(all, 9), observer.participantId))).toBe(states[0]);

    const st = a.getState();
    expect(st.questions[0]).toMatchObject({ answered: true });
    expect(st.issues[0]).toMatchObject({ status: 'resolved' });
    expect(st.tasks.find((t) => t.taskId === 'api')).toMatchObject({ status: 'in_progress', claimConflict: true, title: 'API' });
    expect(st.acknowledgements[q.id]).toEqual([b.me]);
    expect(st.lastMaterial).not.toBeNull();
    expect(st.lastMaterial?.id).not.toBe(st.activity[0]?.id); // activity/ack are not material
    expect(st.conflicts.map((c) => c.scope).sort()).toEqual(['claim', 'decision']);
  });
});

describe('pathsOverlap', () => {
  it('normalises and matches directory prefixes at segment boundaries', () => {
    expect(pathsOverlap(['./src/api/'], ['src/api/auth.ts'])).toEqual(['./src/api/ ↔ src/api/auth.ts']);
    expect(pathsOverlap(['src/api/**'], ['src/api'])).toEqual(['src/api']);
    expect(pathsOverlap(['src/api/*'], ['src/api/x/y.ts'])).toHaveLength(1);
    expect(pathsOverlap(['src/api'], ['src/apiary'])).toEqual([]);
    expect(pathsOverlap(['src/a.ts'], ['src/b.ts'])).toEqual([]);
    expect(pathsOverlap(['**'], ['anything/at/all'])).toHaveLength(1);
    expect(pathsOverlap(['src/*.ts'], ['src/index.ts'])).toHaveLength(1);
    expect(pathsOverlap([], ['src'])).toEqual([]);
  });
});
