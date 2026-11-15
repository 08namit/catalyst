// v0.2: several agents per participant. Ownership (decision heads, claims, progress, acks, unread) is per (author, agent).
import { describe, expect, it } from 'vitest';
import { newProjectId, signEvent } from '../../src/core/protocol.js';
import { acknowledge, buildBriefing, getUpdates, summarizeEvent } from '../../src/store/index.js';
import type { SqliteEventStore } from '../../src/store/index.js';
import { decision, makeIdentity, makeNode, makePair, openStore, sync, syncSummary } from './helpers.js';

const now = new Date('2026-11-14T12:00:00.000Z');
const API = 'a7a6a241124692d30';
const UI = 'b1c2d3e4f5a6b7c8d';

function register(s: SqliteEventStore, agent: string, name: string, extra: { agentType?: string; active?: boolean } = {}) {
  return s.append({ type: 'agent.registered', payload: { agent, name, ...extra }, origin: 'system', agent }).event;
}
const asAgent = <T extends object>(input: T, agent: string) => ({ ...input, agent });
const claim = (taskId: string, scope: string, paths?: string[]) => ({
  type: 'task.claimed' as const,
  payload: { taskId, scope, ...(paths ? { paths } : {}) },
  origin: 'agent' as const,
});

describe('per-agent decision heads', () => {
  it('two agents of one participant on one topic without supersedes ⇒ conflict', () => {
    const { a } = makePair();
    register(a, API, 'api');
    const d1 = a.append(asAgent(decision('api/format', 'Format', 'JSON'), API)).event;
    const d2 = a.append(asAgent(decision('api/format', 'Format', 'protobuf'), UI)).event;
    expect(d1.agent).toBe(API);
    expect(d2.supersedes).toEqual([]);
    const topic = a.getState().decisions.find((d) => d.topic === 'api/format')!;
    expect(topic.conflict).toBe(true);
    expect(topic.heads.map((h) => h.agentName).sort()).toEqual(['Tiam / api', `Tiam / ${UI.slice(0, 8)}`]);
    expect(a.getState().conflicts.map((c) => c.scope)).toEqual(['decision']);
  });

  it('the same agent re-publishing supersedes its own head (no conflict); lead events carry no agent field', () => {
    const { a } = makePair();
    const d1 = a.append(asAgent(decision('db', 'DB', 'sqlite'), API)).event;
    const d2 = a.append(asAgent(decision('db', 'DB', 'sqlite + WAL'), API)).event;
    expect(d2.supersedes).toEqual([d1.id]);
    const lead = a.append(asAgent(decision('ui', 'UI', 'dark'), 'lead')).event;
    expect('agent' in lead).toBe(false);
    expect(a.getState().decisions.every((d) => !d.conflict)).toBe(true);
  });

  it('explicit supersedes across agents revises without conflict', () => {
    const { a } = makePair();
    const d1 = a.append(asAgent(decision('db', 'DB', 'sqlite'), API)).event;
    a.append({ ...asAgent(decision('db', 'DB', 'postgres'), UI), supersedes: [d1.id] });
    const topic = a.getState().decisions.find((d) => d.topic === 'db')!;
    expect(topic.conflict).toBe(false);
    expect(topic.heads[0]).toMatchObject({ decision: 'postgres', agent: UI });
  });
});

describe('per-agent claims and progress', () => {
  it('claims by two agents of one participant conflict; release only releases the calling agent’s claim', () => {
    const { a } = makePair();
    register(a, API, 'api');
    const c1 = a.append(asAgent(claim('login', 'server'), API)).event;
    const c2 = a.append(asAgent(claim('login', 'client'), UI)).event;
    expect(c2.supersedes).toEqual([]);
    let t = a.getState().tasks.find((x) => x.taskId === 'login')!;
    expect(t.claimConflict).toBe(true);
    expect(t.owners).toEqual([a.me]);
    expect(t.ownerKeys.sort()).toEqual([`${a.me}/${API}`, `${a.me}/${UI}`].sort());
    expect(t.claims.find((c) => c.id === c1.id)).toMatchObject({ ownerAgent: API, ownerName: 'Tiam / api', ownerKey: `${a.me}/${API}` });

    const rel = a.append({ type: 'task.released', payload: { taskId: 'login' }, origin: 'agent', agent: API }).event;
    expect(rel.supersedes).toEqual([c1.id]);
    t = a.getState().tasks.find((x) => x.taskId === 'login')!;
    expect(t.claimConflict).toBe(false);
    expect(t.claims.map((c) => c.id)).toEqual([c2.id]);
    expect(a.getState().agents.find((x) => x.agent === UI)?.claims).toEqual(['login']);
    expect(a.getState().agents.find((x) => x.agent === API)?.claims).toEqual([]);
  });

  it('conflict.resolved assigns the claim to owner + ownerAgent', () => {
    const { a } = makePair();
    register(a, API, 'api');
    a.append(asAgent(claim('db', 'schema'), API));
    a.append(asAgent(claim('db', 'migrations'), UI));
    a.append({ type: 'conflict.resolved', payload: { scope: 'claim', key: 'db', resolution: 'api owns db', owner: a.me, ownerAgent: API }, origin: 'agent' });
    const t = a.getState().tasks.find((x) => x.taskId === 'db')!;
    expect(t.claimConflict).toBe(false);
    expect(t.claims).toHaveLength(1);
    expect(t.claims[0]).toMatchObject({ ownerKey: `${a.me}/${API}`, ownerName: 'Tiam / api', viaResolution: true });
  });

  it('keeps the latest progress per agent', () => {
    const { a } = makePair();
    a.append({ type: 'progress.reported', payload: { taskId: 'x', status: 'in_progress', summary: 'api half' }, origin: 'agent', agent: API });
    a.append({ type: 'progress.reported', payload: { taskId: 'x', status: 'in_progress', summary: 'ui half' }, origin: 'agent', agent: UI });
    a.append({ type: 'progress.reported', payload: { status: 'in_progress', summary: 'general api' }, origin: 'agent', agent: API });
    a.append({ type: 'progress.reported', payload: { status: 'in_progress', summary: 'general lead' }, origin: 'agent' });
    const st = a.getState();
    expect(st.tasks.find((t) => t.taskId === 'x')!.latestProgress.map((p) => p.summary)).toEqual(['api half', 'ui half']);
    expect(st.generalProgress.map((p) => p.summary)).toEqual(['general api', 'general lead']);
  });
});

describe('agent registry', () => {
  it('names agents, honours renames and inactive, always lists every lead, and orders deterministically', () => {
    const { a, b } = makePair();
    register(a, API, 'api', { agentType: 'general-purpose' });
    register(a, API, 'backend', { agentType: 'general-purpose' });
    register(a, UI, 'ui', { active: false });
    b.append(asAgent(decision('x', 'X', 'y'), 'c0ffee00c0ffee00')); // unregistered agent: fallback name
    sync(a, b);
    sync(b, a);
    const st = a.getState();
    // participants in Participants order, lead first, then by name
    const byParticipant: Record<string, string[]> = { Tiam: ['Tiam', 'Tiam / backend', 'Tiam / ui'], Namit: ['Namit', 'Namit / c0ffee00'] };
    expect(st.agents.map((x) => x.displayName)).toEqual(st.participants.flatMap((p) => byParticipant[p.name]!));
    const api = st.agents.find((x) => x.agent === API)!;
    expect(api).toMatchObject({ participant: a.me, address: `${a.me}/${API}`, name: 'backend', agentType: 'general-purpose', active: true, isMe: true });
    expect(st.agents.find((x) => x.agent === UI)!.active).toBe(false);
    expect(st.agents.find((x) => x.participant === b.me && x.agent === 'lead')).toMatchObject({ name: 'lead', displayName: 'Namit', active: true, isMe: false });
    expect(b.getState().agents.map((x) => x.address)).toEqual(st.agents.map((x) => x.address));

    const reg = a.listSince(0).find((s) => s.event.type === 'agent.registered')!;
    expect(a.toUpdateItem(reg)).toMatchObject({ agent: API, agentName: 'Tiam / backend', summary: 'Agent registered: Tiam / api (general-purpose)' });
    const inactive = a.listSince(0).filter((s) => s.event.type === 'agent.registered').at(-1)!;
    expect(a.toUpdateItem(inactive).summary).toBe('Agent finished: Tiam / ui');
  });

  it('rejects agent.registered whose payload.agent differs from the event agent (append and ingest)', () => {
    const projectId = newProjectId();
    const id = makeIdentity('Tiam');
    const a = openStore(projectId, id);
    a.bootstrap({ name: 'Tiam', createdByMe: true });
    expect(() => a.append({ type: 'agent.registered', payload: { agent: API, name: 'api' }, origin: 'system', agent: UI })).toThrow(/must equal the event's agent/);
    expect(() => a.append({ type: 'agent.registered', payload: { agent: API, name: 'api' }, origin: 'system' })).toThrow(/must equal/);
    const good = register(a, API, 'api');
    const forged = signEvent({ ...good, payload: { agent: UI, name: 'api' } }, id.privateKey);
    const b = makeNode(projectId, 'Namit');
    const first = a.listSince(0).map((s) => s.event).filter((e) => e.seq < good.seq);
    const r = b.ingest([...first, forged], { via: 'peer', peer: a.me });
    expect(r.accepted).toHaveLength(first.length);
    expect(r.rejected[0]?.reason).toMatch(/agent.registered payload.agent/);
    expect(b.ingest([good], { via: 'peer', peer: a.me }).accepted).toHaveLength(1);
  });

  it('summaries resolve agent-addressed messages and queue fields', () => {
    const { a, b } = makePair();
    register(a, API, 'api');
    sync(a, b);
    const m = b.append({ type: 'message.posted', payload: { kind: 'question', body: 'Port?', to: `${a.me}/${API}` }, origin: 'agent' }).event;
    const t = b.append({ type: 'task.created', payload: { taskId: 'ui', title: 'UI', dependsOn: ['api'], assignee: a.me }, origin: 'agent' }).event;
    sync(b, a);
    expect(a.toUpdateItem(a.getEvent(m.id)!).summary).toBe('Question (to Tiam / api): Port?');
    expect(a.toUpdateItem(a.getEvent(t.id)!).summary).toBe('Task ui created: UI (depends on api; for Tiam)');
    expect(summarizeEvent(t)).toBe(`Task ui created: UI (depends on api; for ${a.me})`);
  });
});

describe('per-agent consumption', () => {
  function setup() {
    const { a, b } = makePair();
    register(a, API, 'api');
    getUpdates(a, {}, { session: 'lead', sync: syncSummary('connected'), agent: 'lead' });
    getUpdates(a, {}, { session: 'api', sync: syncSummary('connected'), agent: API });
    const sibling = a.append(asAgent(decision('api/format', 'Format', 'JSON'), API)).event;
    const peer = b.append(decision('ui/theme', 'Theme', 'dark')).event;
    sync(b, a);
    return { a, b, sibling, peer };
  }

  it('get_updates hides only the calling agent’s own events', () => {
    const { a, sibling, peer } = setup();
    const lead = getUpdates(a, {}, { session: 'lead', sync: syncSummary('connected'), agent: 'lead' });
    expect(lead.updates.map((u) => u.id)).toEqual([sibling.id, peer.id]);
    expect(lead.updates[0]).toMatchObject({ agent: API, agentName: 'Tiam / api' });
    expect(lead.text).toMatch(/— Tiam \/ api, 2026-|— Tiam \/ api, \d{4}-/);
    const api = getUpdates(a, {}, { session: 'api', sync: syncSummary('connected'), agent: API });
    expect(api.updates.map((u) => u.id)).toEqual([peer.id]);
    const own = getUpdates(a, { since: 0, includeOwn: true, types: ['decision.recorded'] }, { session: 'x', sync: syncSummary('connected'), agent: API });
    expect(own.updates.map((u) => u.id)).toEqual([sibling.id, peer.id]);
    expect(a.listSince(0, { excludeAgent: { author: a.me, agent: 'lead' } }).every((s) => s.event.author !== a.me || s.event.agent === API)).toBe(true);
  });

  it('acknowledgements and unread are per agent', () => {
    const { a, b, sibling, peer } = setup();
    expect(a.counts().unacknowledged).toBe(2); // Namit joined + decision (participant level, peers only)
    expect(a.counts('lead').unacknowledged).toBe(4); // + api's registration and decision
    expect(a.counts(API).unacknowledged).toBe(4); // Namit's 2 + lead's joined/project.created

    const ack = acknowledge(a, { eventIds: [sibling.id, peer.id] }, { session: 'lead', sync: syncSummary('connected'), agent: 'lead' });
    expect(ack.acknowledged).toBe(2);
    expect('agent' in a.getEvent(ack.event!.id)!.event).toBe(false);
    expect(a.isAcknowledgedByMe(peer.id)).toBe(true);
    expect(a.isAcknowledgedByMe(peer.id, 'lead')).toBe(true);
    expect(a.isAcknowledgedByMe(peer.id, API)).toBe(false);
    expect(a.counts(API).unacknowledged).toBe(4);

    // api cannot ack its own decision; acking the peer's records an ack with agent = api
    const own = acknowledge(a, { eventIds: [sibling.id] }, { session: 'api', sync: syncSummary('connected'), agent: API });
    expect(own.acknowledged).toBe(0);
    const ack2 = acknowledge(a, { eventIds: [peer.id] }, { session: 'api', sync: syncSummary('connected'), agent: API });
    expect(a.getEvent(ack2.event!.id)!.event.agent).toBe(API);
    expect(a.isAcknowledgedByMe(peer.id, API)).toBe(true);
    const unacked = getUpdates(a, { since: 0, unacknowledgedOnly: true }, { session: 'y', sync: syncSummary('connected'), agent: API });
    expect(unacked.updates.map((u) => u.id)).not.toContain(peer.id);
    expect(unacked.updates.every((u) => u.acknowledgedByMe === false)).toBe(true);

    expect(a.getState().acknowledgements[peer.id]).toEqual([a.me]);
    expect(a.getState().agentAcknowledgements[peer.id]).toEqual([`${a.me}/lead`, `${a.me}/${API}`]);
    sync(a, b);
    expect(b.deliveryState(peer.id).acknowledgedBy.map((x) => x.participant)).toEqual([a.me]);
  });

  it('briefing: claims, questions and unread for the calling agent', () => {
    const { a, b, sibling } = setup();
    a.append(asAgent(claim('api', 'server'), API));
    a.append(claim('docs', 'readme'));
    const toApi = b.append({ type: 'message.posted', payload: { kind: 'question', body: 'API port?', to: `${a.me}/${API}` }, origin: 'agent' }).event;
    const toTiam = b.append({ type: 'message.posted', payload: { kind: 'question', body: 'Ready?', to: a.me }, origin: 'agent' }).event;
    const fromApi = a.append({ type: 'message.posted', payload: { kind: 'question', body: 'Anyone on docs?', to: 'all' }, origin: 'agent', agent: API }).event;
    sync(b, a);

    const api = buildBriefing(a, {}, { sync: syncSummary('connected'), now, agent: API });
    expect(api.myClaims.map((c) => c.refs.task)).toEqual(['api']);
    expect(api.questionsForMe.map((q) => q.id).sort()).toEqual([toApi.id, toTiam.id].sort());
    expect(api.unread.items.map((u) => u.id)).not.toContain(sibling.id);
    expect(api.text).toMatch(/You: Tiam \/ api \(p_[0-9a-f]+, agent a7a6a241124692d30\)/);
    expect(api.text).toMatch(/Agents: (Namit; )?Tiam \(docs\); Tiam \/ api \(api\)/);

    const lead = buildBriefing(a, {}, { sync: syncSummary('connected'), now, agent: 'lead' });
    expect(lead.myClaims.map((c) => c.refs.task)).toEqual(['docs']);
    expect(lead.questionsForMe.map((q) => q.id).sort()).toEqual([toTiam.id, fromApi.id].sort());
    expect(lead.unread.items.map((u) => u.id)).toContain(sibling.id);
    expect(lead.text).toMatch(/Queue: 0\/2 done, 2 in progress, 0 ready, 0 blocked/);
  });
});
