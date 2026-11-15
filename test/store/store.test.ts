import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newProjectId, signEvent, type CatalystEvent } from '../../src/core/protocol.js';
import { SqliteEventStore } from '../../src/store/index.js';
import { decision, makeIdentity, makeNode, makePair, openStore, sync, tempDir } from './helpers.js';

describe('append + durability', () => {
  it('persists events across close/reopen with contiguous seq', () => {
    const projectId = newProjectId();
    const id = makeIdentity('Tiam');
    const dbPath = join(tempDir(), 'c.db');
    let s = SqliteEventStore.open({ dbPath, projectId, identity: id });
    s.bootstrap({ name: 'Tiam', projectName: 'Demo', createdByMe: true });
    s.append({ type: 'goal.set', payload: { title: 'Ship v1' }, origin: 'agent' });
    s.close();

    s = SqliteEventStore.open({ dbPath, projectId, identity: id });
    const events = s.listSince(0).map((e) => e.event);
    expect(events.map((e) => [e.type, e.seq])).toEqual([
      ['participant.joined', 1],
      ['project.created', 2],
      ['goal.set', 3],
    ]);
    expect(s.getVector()).toEqual({ [id.participantId]: 3 });
    s.bootstrap({ name: 'Tiam', projectName: 'Demo', createdByMe: true }); // idempotent
    const next = s.append({ type: 'goal.set', payload: { title: 'Ship v2' }, origin: 'agent' });
    expect(next.event.seq).toBe(4);
    expect(next.event.supersedes).toEqual([events[2]!.id]);
    expect(next.event.lc).toBe(4);
    expect(s.getState().goal.current?.title).toBe('Ship v2');
    s.close();
  });

  it('rejects invalid payloads with an actionable error', () => {
    const s = makeNode(newProjectId(), 'Tiam');
    expect(() => s.append({ type: 'decision.recorded', payload: { topic: 'Bad Topic' }, origin: 'agent' })).toThrow(/Invalid decision.recorded payload/);
    expect(s.latestCursor()).toBe(1);
  });

  it('clientId makes append idempotent', () => {
    const s = makeNode(newProjectId(), 'Tiam');
    let emitted = 0;
    s.onAppend(() => emitted++);
    const first = s.append({ type: 'goal.set', payload: { title: 'G' }, origin: 'fallback', clientId: 'draft-123456' });
    const again = s.append({ type: 'goal.set', payload: { title: 'G' }, origin: 'fallback', clientId: 'draft-123456' });
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.event.id).toBe(first.event.id);
    expect(again.cursor).toBe(first.cursor);
    expect(emitted).toBe(1);
  });

  it('auto-fills refs from payload', () => {
    const s = makeNode(newProjectId(), 'Tiam');
    const e = s.append({ type: 'task.claimed', payload: { taskId: 'api-auth', scope: 'tokens' }, origin: 'agent' }).event;
    expect(e.refs.task).toBe('api-auth');
    const d = s.append(decision('api/format', 'JSON', 'Use JSON')).event;
    expect(d.refs.topic).toBe('api/format');
  });

  it('refuses to open a database that belongs to another project', () => {
    const dbPath = join(tempDir(), 'c.db');
    const id = makeIdentity('Tiam');
    SqliteEventStore.open({ dbPath, projectId: newProjectId(), identity: id }).close();
    expect(() => SqliteEventStore.open({ dbPath, projectId: newProjectId(), identity: id })).toThrow(/belongs to project/);
  });
});

describe('ingest', () => {
  it('accepts peer events once and reports duplicates', () => {
    const { a, b } = makePair();
    const before = b.counts().events;
    const r = sync(a, b);
    expect(r.accepted).toHaveLength(0);
    expect(r.duplicates).toHaveLength(before);
    expect(b.getState().participants.map((p) => p.name).sort()).toEqual(['Namit', 'Tiam']);
  });

  it('emits onAppend once per ingest call with source peer', () => {
    const projectId = newProjectId();
    const a = makeNode(projectId, 'Tiam', true);
    const b = makeNode(projectId, 'Namit');
    const calls: Array<[number, string]> = [];
    b.onAppend((evs, src) => calls.push([evs.length, src]));
    sync(a, b);
    expect(calls).toEqual([[2, 'peer']]);
  });

  it('parks out-of-order events and drains them when the gap fills', () => {
    const { a, b } = makePair();
    const e2 = a.append({ type: 'goal.set', payload: { title: 'g2' }, origin: 'agent' }).event;
    const e3 = a.append({ type: 'goal.set', payload: { title: 'g3' }, origin: 'agent' }).event;
    const e4 = a.append({ type: 'goal.set', payload: { title: 'g4' }, origin: 'agent' }).event;
    const src = { via: 'peer', peer: a.me } as const;
    const r1 = b.ingest([e4, e3], src);
    expect(r1.parked).toEqual([e4.id, e3.id]);
    expect(b.parkedCount()).toBe(2);
    expect(b.getVector()[a.me]).toBe(2);
    const r2 = b.ingest([e2], src);
    expect(r2.accepted.map((e) => e.id)).toEqual([e2.id, e3.id, e4.id]);
    expect(b.getVector()[a.me]).toBe(5);
    expect(b.parkedCount()).toBe(0);
    expect(b.getState().goal.current?.title).toBe('g4');
  });

  it('parks events from an unknown author until participant.joined arrives', () => {
    const projectId = newProjectId();
    const a = makeNode(projectId, 'Tiam', true);
    const b = makeNode(projectId, 'Namit');
    const evs = a.listSince(0).map((s) => s.event); // joined(1), project.created(2)
    const r1 = b.ingest([evs[1]], { via: 'peer', peer: a.me });
    expect(r1.parked).toEqual([evs[1]!.id]);
    const r2 = b.ingest([evs[0]], { via: 'peer', peer: a.me });
    expect(r2.accepted.map((e) => e.seq)).toEqual([1, 2]);
    expect(b.getState().project?.name).toBe('Demo');
  });

  it('rejects bad signatures and tampered payloads', () => {
    const projectId = newProjectId();
    const a = makeNode(projectId, 'Tiam', true);
    const b = makeNode(projectId, 'Namit');
    sync(a, b);
    const e = a.append({ type: 'goal.set', payload: { title: 'real' }, origin: 'agent' }).event;
    const badSig: CatalystEvent = { ...e, sig: Buffer.alloc(64, 1).toString('base64') };
    const tampered: CatalystEvent = { ...e, payload: { title: 'evil' } };
    // Tampered and re-hashed/re-signed by someone else: id matches but signature does not.
    const forged = signEvent({ ...e, payload: { title: 'evil' } }, makeIdentity('Mallory').privateKey);
    const r = b.ingest([badSig, tampered, forged, { nonsense: true }], { via: 'peer', peer: a.me });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      expect.stringMatching(/invalid signature/),
      expect.stringMatching(/content hash/),
      expect.stringMatching(/invalid signature/),
      expect.stringMatching(/invalid event/),
    ]);
    expect(b.ingest([e], { via: 'peer', peer: a.me }).accepted).toHaveLength(1);
  });

  it('detects forks (same author+seq, different id)', () => {
    const projectId = newProjectId();
    const idA = makeIdentity('Tiam');
    const a1 = openStore(projectId, idA);
    const a2 = openStore(projectId, idA); // same identity, separate db (e.g. a restored copy)
    a1.bootstrap({ name: 'Tiam', createdByMe: false });
    a2.bootstrap({ name: 'Tiam (copy)', createdByMe: false });
    const b = makeNode(projectId, 'Namit');
    sync(a1, b);
    const r = sync(a2, b);
    expect(r.forks).toHaveLength(1);
    expect(r.forks[0]).toMatchObject({ author: idA.participantId, seq: 1 });
    expect(r.rejected[0]?.reason).toMatch(/fork/);
    expect(b.getState().forks).toHaveLength(1);
  });

  it('rejects events from another project', () => {
    const a = makeNode(newProjectId(), 'Tiam', true);
    const b = makeNode(newProjectId(), 'Namit');
    const r = sync(a, b);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected.every((x) => /wrong project/.test(x.reason))).toBe(true);
  });

  it('stores and relays unknown event types / versions without projecting them', () => {
    const projectId = newProjectId();
    const idA = makeIdentity('Tiam');
    const a = openStore(projectId, idA);
    a.bootstrap({ name: 'Tiam', createdByMe: false });
    const base = a.listSince(0)[0]!.event;
    const future = signEvent(
      { ...base, seq: 2, lc: 2, type: 'future.thing', payload: { anything: [1, 2] }, supersedes: [] },
      idA.privateKey,
    );
    const v2 = signEvent({ ...base, v: 3, seq: 3, lc: 3, type: 'goal.set', payload: { shape: 'new' }, supersedes: [] }, idA.privateKey);
    const b = makeNode(projectId, 'Namit');
    const r = b.ingest([base, future, v2], { via: 'peer', peer: idA.participantId });
    expect(r.accepted).toHaveLength(3);
    expect(b.getEventsAfter(idA.participantId, 1, 10).map((e) => e.id)).toEqual([future.id, v2.id]);
    const st = b.getState();
    expect(st.opaqueCount).toBe(2);
    expect(st.goal.current).toBeNull();
    expect(b.toUpdateItem(b.getEvent(future.id)!).summary).toMatch(/Unrecognised event type future.thing/);
    expect(b.verifyProjection().ok).toBe(true);
  });
});

describe('sync bookkeeping', () => {
  it('tracks pending outbound via markDelivered and markDeliveredByVector', () => {
    const { a, b } = makePair();
    // a holds 2 own + 1 of b's; b's own events never count as pending for b.
    expect(a.pendingOutbound(b.me)).toBe(2);
    const own = a.listSince(0).filter((s) => s.event.author === a.me);
    a.markDelivered(b.me, [own[0]!.event.id]);
    expect(a.pendingOutbound(b.me)).toBe(1);
    a.markDeliveredByVector(b.me, b.getVector());
    expect(a.pendingOutbound(b.me)).toBe(0);
    const e = a.append({ type: 'goal.set', payload: { title: 'x' }, origin: 'agent' }).event;
    expect(a.pendingOutbound(b.me)).toBe(1);
    expect(a.deliveryState(e.id).deliveredTo).toEqual([]);
    a.markDelivered(b.me, [e.id, e.id]);
    expect(a.deliveryState(e.id).deliveredTo.map((d) => d.participant)).toEqual([b.me]);
  });

  it('builds status bodies with retrievals of the peer’s events and applies peer status', () => {
    const { a, b } = makePair();
    const bEvent = b.listSince(0).find((s) => s.event.author === b.me)!.event;
    a.upsertSession({ id: 'claude:1', kind: 'hook', claudePid: 42, retrieved: true });
    a.upsertSession({ id: 'mcp:9', kind: 'mcp', claudePid: 42 });
    a.recordRetrieval('claude:1', [bEvent.id, a.listSince(0)[0]!.event.id]);
    const status = a.takeStatusFor(b.me);
    expect(status.retrieved.map((r) => r.id)).toEqual([bEvent.id]);
    expect(status.sessions.find((s) => s.id === 'mcp:9')?.linkedSession).toBe('claude:1');
    expect(a.takeStatusFor(b.me).retrieved).toEqual([]); // watermark advanced
    b.applyPeerStatus(a.me, status);
    expect(b.deliveryState(bEvent.id).retrievedBy.map((r) => r.participant)).toEqual([a.me]);
    expect(b.peerSessions(a.me)).toHaveLength(2);
  });

  it('persists peer freshness', () => {
    const { a, b } = makePair();
    expect(a.getPeerSeen(b.me)).toBeNull();
    a.setPeerSeen(b.me, '2026-11-14T10:00:00.000Z');
    a.setPeerSeen(b.me, '2026-11-14T11:00:00.000Z', 'ECONNREFUSED');
    expect(a.getPeerSeen(b.me)).toEqual({ lastSyncAt: '2026-11-14T10:00:00.000Z', lastError: 'ECONNREFUSED' });
  });

  it('invites are single-use and expire', () => {
    const s = makeNode(newProjectId(), 'Tiam');
    const now = new Date('2026-11-14T10:00:00.000Z');
    s.createInvite({ inviteId: 'inv1', inviteKey: 'k1', expiresAt: '2026-11-14T10:15:00.000Z' });
    s.createInvite({ inviteId: 'inv2', inviteKey: 'k2', expiresAt: '2026-11-14T10:15:00.000Z' });
    expect(s.getInviteKey('inv1', now)).toBe('k1');
    expect(s.consumeInvite('inv1', now)).toBe(true);
    expect(s.consumeInvite('inv1', now)).toBe(false);
    expect(s.getInviteKey('inv1', now)).toBeNull();
    const later = new Date('2026-11-14T10:16:00.000Z');
    expect(s.getInviteKey('inv2', later)).toBeNull();
    expect(s.consumeInvite('inv2', later)).toBe(false);
    expect(s.getInviteKey('nope', now)).toBeNull();
  });

  it('search tolerates FTS syntax and finds records', () => {
    const s = makeNode(newProjectId(), 'Tiam');
    const d = s.append(decision('api/auth', 'Bearer tokens', 'Use JWT bearer tokens for the API')).event;
    expect(s.search('jwt', 5)).toEqual([d.id]);
    expect(s.search('"unbalanced AND (', 5)).toEqual([]);
    expect(s.search('***', 5)).toEqual([]);
    expect(s.search('NEAR(', 5)).toEqual([]);
  });
});
