import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { httpJson } from '../../src/client/index.js';
import type {
  AgentRegisterResponse,
  AgentStopResponse,
  ClaimResult,
  InviteToolResult,
  PublishResult,
  StatusResponse,
  StatusToolResult,
  TakeTaskResult,
  UnreadSummary,
  WaitResult,
} from '../../src/core/api.js';
import { ensureDir, readDaemonInfo, saveConfig, saveIdentity, type DaemonInfo } from '../../src/core/config.js';
import { projectPaths } from '../../src/core/paths.js';
import { generateKeyPair, newProjectId, participantIdFromPublicKey, signEvent, type CatalystEvent } from '../../src/core/protocol.js';
import { runDaemon, type DaemonHandle } from '../../src/daemon/main.js';

const dirs: string[] = [];
const handles: DaemonHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<{ h: DaemonHandle; info: DaemonInfo }> {
  const dir = mkdtempSync(join(tmpdir(), 'catalyst-agents-'));
  dirs.push(dir);
  const paths = projectPaths(dir);
  ensureDir(paths.dataDir);
  const keys = generateKeyPair();
  const participantId = participantIdFromPublicKey(keys.publicKey);
  saveIdentity(paths, { participantId, name: 'Tiam', ...keys });
  saveConfig(paths, {
    projectId: newProjectId(),
    projectName: 'notes',
    participantId,
    name: 'Tiam',
    peerPort: 0,
    peerBind: '127.0.0.1',
    apiPort: 0,
    advertiseHosts: ['127.0.0.1'],
    createdByMe: true,
    autoHandover: true,
    createdAt: new Date().toISOString(),
  });
  const h = await runDaemon(dir, { signals: false });
  handles.push(h);
  return { h, info: readDaemonInfo(paths)! };
}

type Res<T> = { status: number; body: T };
function client(info: DaemonInfo) {
  const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs?: number) =>
    httpJson(info.apiPort, method, path, { token: info.token, body, timeoutMs, headers: { 'x-catalyst-client': 'mcp', 'x-catalyst-session': 'mcp:test', ...headers } }) as Promise<Res<T>>;
  /** Tool call as one agent (undefined = the main session / lead). */
  const tool = <T>(name: string, input: Record<string, unknown>, agentId?: string, agentType = 'general-purpose') =>
    call<T>('POST', `/api/tools/${name}`, { ...input, _caller: agentId ? { agentId, agentType } : {} }, {}, 20_000);
  return { call, tool };
}

/** Events from a second participant ("Namit"), optionally with one named agent. */
function namit(projectId: string, items: Array<{ type: string; payload: Record<string, unknown>; agent?: string; refs?: CatalystEvent['refs'] }> = []) {
  const keys = generateKeyPair();
  const author = participantIdFromPublicKey(keys.publicKey);
  const all = [{ type: 'participant.joined', payload: { name: 'Namit', publicKey: keys.publicKey } as Record<string, unknown> }, ...items];
  const events = all.map((it, i) =>
    signEvent(
      {
        v: 2,
        project: projectId,
        author,
        seq: i + 1,
        lc: 1000 + i,
        ts: new Date().toISOString(),
        type: it.type,
        payload: it.payload,
        refs: 'refs' in it && it.refs ? it.refs : {},
        supersedes: [],
        origin: 'agent',
        ...('agent' in it && it.agent ? { agent: it.agent } : {}),
      },
      keys.privateKey,
    ),
  );
  return { id: author, events };
}

const A = 'a1111111111111111';
const B = 'b2222222222222222';

describe('caller → agent', () => {
  it('maps _caller to an agent, auto-registers it with a default name and tags its writes', async () => {
    const { h, info } = await start();
    const { tool } = client(info);
    const r1 = await tool<ClaimResult>('claim_task', { taskId: 'api', title: 'API', scope: 'routes' }, A);
    expect(r1.status).toBe(200);
    await tool('claim_task', { taskId: 'ui', title: 'UI', scope: 'pages' }, B);
    await tool('publish_progress', { status: 'in_progress', summary: 'lead here' });

    const events = h.store.listSince(0).map((s) => s.event);
    const regs = events.filter((e) => e.type === 'agent.registered');
    expect(regs.map((e) => [e.agent, e.payload.name, e.payload.agentType])).toEqual([
      [A, 'general-purpose-1', 'general-purpose'],
      [B, 'general-purpose-2', 'general-purpose'],
    ]);
    expect(events.find((e) => e.type === 'task.claimed' && e.payload.taskId === 'api')?.agent).toBe(A);
    expect(events.find((e) => e.type === 'progress.reported')?.agent).toBeUndefined();
    expect(events.find((e) => e.type === 'task.claimed')?.session).toBe(`mcp:test#${A}`);

    // a second write does not register again
    await tool('publish_progress', { status: 'in_progress', summary: 'more' }, A);
    expect(h.store.listSince(0).filter((s) => s.event.type === 'agent.registered')).toHaveLength(2);
    const view = h.store.getState().agents.find((a) => a.agent === A);
    expect(view?.displayName).toBe('Tiam / general-purpose-1');
  });

  it('set_agent_name renames a subagent and is refused for the main session', async () => {
    const { h, info } = await start();
    const { tool } = client(info);
    const r = await tool<PublishResult>('set_agent_name', { name: 'api' }, A);
    expect(r.status).toBe(200);
    expect(r.body.text).toContain('Tiam / api');
    expect(h.store.getState().agents.find((a) => a.agent === A)?.name).toBe('api');
    expect((await tool('set_agent_name', { name: 'boss' })).status).toBe(400);
  });
});

describe('per-agent claims', () => {
  it('warns about my other agents\' overlapping claims and releases only my own', async () => {
    const { h, info } = await start();
    const { tool } = client(info);
    await tool('claim_task', { taskId: 'api', title: 'API', scope: 'routes', paths: ['src/api/**'] }, A);
    const overlap = await tool<ClaimResult>('claim_task', { taskId: 'docs', title: 'Docs', scope: 'docs', paths: ['src/api/README.md'] }, B);
    expect(overlap.body.overlaps.map((o) => [o.reason, o.taskId, o.ownerName])).toEqual([['path_overlap', 'api', 'Tiam / general-purpose-1']]);

    const same = await tool<ClaimResult>('claim_task', { taskId: 'api', scope: 'also routes' }, B);
    expect(same.body.overlaps.map((o) => o.reason)).toEqual(['same_task']);
    expect(same.body.conflicts).toHaveLength(1);

    // re-claiming by the same agent does not warn about itself
    const again = await tool<ClaimResult>('claim_task', { taskId: 'docs', scope: 'docs v2', paths: ['src/api/README.md'] }, B);
    expect(again.body.overlaps.some((o) => o.taskId === 'docs')).toBe(false);

    const lead = await tool<{ error: { message: string } }>('release_task', { taskId: 'api' });
    expect(lead.status).toBe(400);
    expect(lead.body.error.message).toContain('general-purpose-1');
    expect((await tool('release_task', { taskId: 'api' }, B)).status).toBe(200);
    const api = h.store.getState().tasks.find((t) => t.taskId === 'api')!;
    expect(api.claims.map((c) => c.ownerAgent)).toEqual([A]);
  });
});

describe('recipients', () => {
  it('resolves names, Name/agent, my own agent names and rejects unknown or ambiguous ones', async () => {
    const { h, info } = await start();
    const { tool } = client(info);
    const peer = namit(h.store.projectId, [{ type: 'agent.registered', agent: 'n1', payload: { agent: 'n1', name: 'tests', active: true } }]);
    expect(h.store.ingest(peer.events, { via: 'import' }).rejected).toEqual([]);
    await tool('set_agent_name', { name: 'api' }, A);
    const me = h.store.me;
    const toOf = async (to: string) => {
      const r = await tool<PublishResult>('send_message', { kind: 'notification', body: 'hi', to }, B);
      if (r.status !== 200) return r;
      return h.store.getEvent(r.body.event.id)!.event.payload.to;
    };
    expect(await toOf('all')).toBe('all');
    expect(await toOf('namit')).toBe(peer.id);
    expect(await toOf('Namit/Tests')).toBe(`${peer.id}/n1`);
    expect(await toOf('api')).toBe(`${me}/${A}`);
    expect(await toOf('Tiam/api')).toBe(`${me}/${A}`);
    expect(await toOf(`${peer.id}/n1`)).toBe(`${peer.id}/n1`);

    const unknown = (await toOf('bob')) as Res<{ error: { message: string } }>;
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toContain('"Namit/tests"');
    expect(unknown.body.error.message).toContain('"Tiam/api"');

    await tool('set_agent_name', { name: 'dup' }, A);
    await tool('set_agent_name', { name: 'dup' }, 'c3333333333333333');
    const ambiguous = (await toOf('dup')) as Res<{ error: { message: string } }>;
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.message).toMatch(/ambiguous/);
  });

  it('resolve_conflict accepts an agent as the claim owner', async () => {
    const { h, info } = await start();
    const { tool } = client(info);
    await tool('set_agent_name', { name: 'api' }, A);
    await tool('claim_task', { taskId: 'api', title: 'API', scope: 'x' }, A);
    await tool('claim_task', { taskId: 'api', scope: 'y' }, B);
    const r = await tool<PublishResult>('resolve_conflict', { scope: 'claim', key: 'api', resolution: 'api keeps it', owner: 'Tiam/api' });
    expect(r.status).toBe(200);
    expect(h.store.getEvent(r.body.event.id)!.event.payload).toMatchObject({ owner: h.store.me, ownerAgent: A });
    expect(r.body.conflicts).toEqual([]);
  });
});

describe('task queue', () => {
  it('post_tasks → take_next_task → complete_task honours dependsOn and never hands out a task twice', async () => {
    const { h, info } = await start();
    const { tool } = client(info);
    await tool('publish_decision', { topic: 'notes/schema', title: 'Schema', decision: 'notes(id, body)', rationale: 'simple', taskId: 'core' });
    const bad = await tool<{ error: { message: string } }>('post_tasks', { tasks: [{ taskId: 'x', title: 'X', dependsOn: ['nope'] }] });
    expect(bad.status).toBe(400);
    expect((await tool('post_tasks', { tasks: [{ taskId: 'x', title: 'X', assignee: 'teammate' }] })).status).toBe(400);

    const posted = await tool<PublishResult>('post_tasks', {
      tasks: [
        { taskId: 'core', title: 'Core', description: 'notes model', paths: ['src/core/**'] },
        { taskId: 'api', title: 'API', dependsOn: ['core'], paths: ['src/api/**'] },
        { taskId: 'cli', title: 'CLI', dependsOn: ['core'], paths: ['src/cli/**'], assignee: 'me' },
      ],
    });
    expect(posted.status).toBe(200);
    expect(posted.body.text).toContain('`api` API');
    expect(h.store.getState().tasks.find((t) => t.taskId === 'cli')?.assignee).toBe(h.store.me);

    const t1 = await tool<TakeTaskResult>('take_next_task', {}, A);
    expect(t1.body.pick.reason).toBe('next');
    expect(t1.body.pick.task?.taskId).toBe('core');
    expect(t1.body.claim?.event.type).toBe('task.claimed');
    expect(t1.body.relevant.map((u) => u.type)).toEqual(['decision.recorded']);
    expect(t1.body.text).toContain('complete_task');
    expect(t1.body.me.displayName).toBe('Tiam / general-purpose-1');

    const again = await tool<TakeTaskResult>('take_next_task', {}, A);
    expect(again.body.pick.reason).toBe('resume');
    expect(h.store.getState().tasks.find((t) => t.taskId === 'core')!.claims).toHaveLength(1);

    const t2 = await tool<TakeTaskResult>('take_next_task', {}, B);
    expect(t2.body.pick.reason).toBe('none_ready');
    expect(t2.body.text).toContain('wait_for_updates');

    const done = await tool<PublishResult>('complete_task', { taskId: 'core', summary: 'model done', evidence: ['npm test: 3 passed'] }, A);
    expect(done.status).toBe(200);
    expect(done.body.text).toMatch(/Now ready: .*`api`/);
    expect(h.store.getState().tasks.find((t) => t.taskId === 'core')).toMatchObject({ status: 'done', claims: [] });

    const t3 = await tool<TakeTaskResult>('take_next_task', {}, B);
    expect(t3.body.pick.task?.taskId).toBe('cli'); // assigned to me first
    expect(t3.body.text).toContain('model done'); // finished dependency summary
    const t4 = await tool<TakeTaskResult>('take_next_task', {}, A);
    expect(t4.body.pick.task?.taskId).toBe('api');
    const t5 = await tool<TakeTaskResult>('take_next_task', {}, 'c3333333333333333');
    expect(t5.body.pick.reason).toBe('none_ready');

    await tool('complete_task', { taskId: 'cli', summary: 'ok' }, B);
    await tool('complete_task', { taskId: 'api', summary: 'ok' }, A);
    const end = await tool<TakeTaskResult>('take_next_task', {}, B);
    expect(end.body.pick.reason).toBe('all_done');
  });
});

describe('wait_for_updates', () => {
  it('returns as soon as a relevant update arrives and times out otherwise', async () => {
    const { h, info } = await start();
    const { tool } = client(info);
    const t0 = Date.now();
    const timeout = await tool<WaitResult>('wait_for_updates', { timeoutSec: 1 }, A);
    expect(timeout.body.outcome).toBe('timeout');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);

    // A waits; B asks a question 300 ms later → A wakes up with it.
    const waiting = tool<WaitResult>('wait_for_updates', { timeoutSec: 10 }, A);
    await new Promise((r) => setTimeout(r, 300));
    const q = await tool<PublishResult>('send_message', { kind: 'question', body: 'Which port?' }, B);
    const woke = await waiting;
    expect(woke.body.outcome).toBe('updates');
    expect(woke.body.updates.map((u) => u.id)).toContain(q.body.event.id);
    expect(woke.body.waitedMs).toBeLessThan(3000);
    expect(woke.body.text).toContain('replyTo');

    // Delivered once: the next wait does not return it again; own writes never wake the writer.
    await tool('publish_progress', { status: 'in_progress', summary: 'mine' }, A);
    const quiet = await tool<WaitResult>('wait_for_updates', { timeoutSec: 1 }, A);
    expect(quiet.body.outcome).toBe('timeout');

    // Messages to another agent do not wake A; a reply to A's question does, even with a task filter.
    const ask = await tool<PublishResult>('send_message', { kind: 'question', body: 'Schema?' }, A);
    await tool('set_agent_name', { name: 'web' }, B);
    const filtered = tool<WaitResult>('wait_for_updates', { timeoutSec: 10, task: 'unrelated' }, A);
    await new Promise((r) => setTimeout(r, 200));
    await tool('send_message', { kind: 'notification', body: 'for web only', to: 'web' });
    await tool('send_message', { kind: 'reply', body: 'notes(id)', replyTo: ask.body.event.id }, B);
    const reply = await filtered;
    expect(reply.body.outcome).toBe('updates');
    expect(reply.body.updates.map((u) => u.summary).join(' ')).not.toContain('for web only');
    expect(h.store.listSince(0).length).toBeGreaterThan(0);
  });

  it('returns immediately when updates are already waiting', async () => {
    const { info } = await start();
    const { tool } = client(info);
    await tool('post_tasks', { tasks: [{ taskId: 'one', title: 'One' }] });
    const t0 = Date.now();
    const r = await tool<WaitResult>('wait_for_updates', { timeoutSec: 30 }, A);
    expect(r.body.outcome).toBe('updates');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.body.text).toContain('take_next_task');
  });
});

describe('subagent lifecycle endpoints', () => {
  it('POST /api/agents registers and introduces; /api/agents/stop releases unfinished claims', async () => {
    const { h, info } = await start();
    const { call, tool } = client(info);
    const reg = await call<AgentRegisterResponse>('POST', '/api/agents', { agentId: 'Abc-123', agentType: 'general-purpose', session: 'claude:s1' }, { 'x-catalyst-client': 'hook' });
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ agent: 'abc-123', name: 'general-purpose-1', displayName: 'Tiam / general-purpose-1' });
    expect(reg.body.context).toContain('take_next_task');
    expect(reg.body.context).toContain('wait_for_updates');
    expect(reg.body.context).toContain('set_agent_name');
    // registering again does not duplicate
    await call('POST', '/api/agents', { agentId: 'Abc-123' }, { 'x-catalyst-client': 'hook' });
    expect(h.store.listSince(0).filter((s) => s.event.type === 'agent.registered')).toHaveLength(1);

    await tool('post_tasks', { tasks: [{ taskId: 'one', title: 'One' }, { taskId: 'two', title: 'Two' }] });
    await tool('take_next_task', {}, 'Abc-123');
    await tool('claim_task', { taskId: 'two', scope: 'x' }, 'Abc-123');
    await tool('complete_task', { taskId: 'two', summary: 'done' }, 'Abc-123');
    await tool('claim_task', { taskId: 'two', scope: 'follow-up' }, 'Abc-123');

    const stop = await call<AgentStopResponse>('POST', '/api/agents/stop', { agentId: 'Abc-123' }, { 'x-catalyst-client': 'hook' });
    expect(stop.body).toEqual({ agent: 'abc-123', released: ['one'] });
    const state = h.store.getState();
    expect(state.tasks.find((t) => t.taskId === 'one')?.claims).toEqual([]);
    expect(state.agents.find((a) => a.agent === 'abc-123')?.active).toBe(false);
    const rel = h.store.listSince(0).find((s) => s.event.type === 'task.released' && s.event.payload.reason === 'agent finished');
    expect(rel?.event.agent).toBe('abc-123');

    const status = await call<StatusResponse>('GET', '/api/status');
    expect(status.body.agents.map((a) => a.agent)).toContain('abc-123');
    expect(status.body.queue.total).toBe(2);
  });

  it('POST /api/events attributes hook activity to the subagent in x-catalyst-agent', async () => {
    const { h, info } = await start();
    const { call } = client(info);
    const r = await call<{ event: CatalystEvent }>(
      'POST',
      '/api/events',
      { type: 'activity.captured', payload: { kind: 'commit', summary: 'Commit abc1234: x' }, origin: 'hook', clientId: 'commit:abc1234' },
      { 'x-catalyst-client': 'hook', 'x-catalyst-agent': A },
    );
    expect(r.status).toBe(200);
    expect(r.body.event.agent).toBe(A);
    expect(h.store.getState().agents.some((a) => a.agent === A && a.name === 'agent-1')).toBe(true);
  });

  it('GET /api/unread counts per agent', async () => {
    const { info } = await start();
    const { call, tool } = client(info);
    await tool('send_message', { kind: 'question', body: 'lead, ok?' }, A);
    const lead = await call<UnreadSummary>('GET', '/api/unread?session=s1');
    expect(lead.body.questionsForMe).toBe(1);
    const asA = await call<UnreadSummary>(`GET`, `/api/unread?session=s1&agent=${A}`);
    expect(asA.body.questionsForMe).toBe(0);
  });
});

describe('status, sync controls and invites', () => {
  it('reports in plain English, pauses/resumes and creates an invite line', async () => {
    const { h, info } = await start();
    const { tool } = client(info);
    await tool('post_tasks', { tasks: [{ taskId: 'one', title: 'One' }] });
    await tool('take_next_task', {}, A);
    const s = await tool<StatusToolResult>('catalyst_status', {}, A);
    expect(s.status).toBe(200);
    expect(s.body.me.displayName).toBe('Tiam / general-purpose-1');
    expect(s.body.text).toContain('nobody has joined yet');
    expect(s.body.text).toContain('Tiam / general-purpose-1 (you): working on `one`');
    expect(s.body.queue.inProgress + s.body.queue.ready + s.body.queue.blocked).toBe(1);
    expect(s.body.text).toContain('invite_teammate');

    const paused = await tool<StatusToolResult>('pause_sync', {});
    expect(paused.body.sync.paused).toBe(true);
    expect(paused.body.text).toMatch(/^Peer sync paused/);
    expect(h.peers.isPaused()).toBe(true);
    const resumed = await tool<StatusToolResult>('resume_sync', {});
    expect(resumed.body.sync.paused).toBe(false);

    const inv = await tool<InviteToolResult>('invite_teammate', {});
    expect(inv.status).toBe(200);
    expect(inv.body.invite.token).toMatch(/^cat1_/);
    expect(inv.body.text).toContain(`Open Claude in your copy of the repo and say: join Catalyst with ${inv.body.invite.token}`);
  });
});
