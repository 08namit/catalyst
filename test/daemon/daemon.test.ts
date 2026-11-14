import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { httpJson } from '../../src/client/index.js';
import type { Briefing, ClaimResult, InboxImportResponse, PublishResult, StatusResponse, UnreadSummary, UpdatesResult } from '../../src/core/api.js';
import { ensureDir, readDaemonInfo, saveConfig, saveIdentity, type DaemonInfo } from '../../src/core/config.js';
import { projectPaths } from '../../src/core/paths.js';
import { generateKeyPair, newProjectId, participantIdFromPublicKey, signEvent, type CatalystEvent } from '../../src/core/protocol.js';
import { DaemonAlreadyRunningError, runDaemon, type DaemonHandle } from '../../src/daemon/main.js';

const dirs: string[] = [];
const handles: DaemonHandle[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'catalyst-daemon-'));
  dirs.push(dir);
  const paths = projectPaths(dir);
  ensureDir(paths.dataDir);
  const keys = generateKeyPair();
  const participantId = participantIdFromPublicKey(keys.publicKey);
  saveIdentity(paths, { participantId, name: 'Tiam', ...keys });
  saveConfig(paths, {
    projectId: newProjectId(),
    projectName: 'demo',
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
  return dir;
}

async function start(dir: string): Promise<{ h: DaemonHandle; info: DaemonInfo }> {
  const h = await runDaemon(dir, { signals: false });
  handles.push(h);
  const info = readDaemonInfo(projectPaths(dir));
  if (!info) throw new Error('daemon.json missing');
  return { h, info };
}

async function api<T>(info: DaemonInfo, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const r = await httpJson(info.apiPort, method, path, { token: info.token, body, headers: { 'x-catalyst-client': 'mcp', 'x-catalyst-session': 'mcp:test', ...headers } });
  return r as { status: number; body: T };
}

/** Events from a simulated second participant ("Namit"), signed with its own key. */
function peerEvents(projectId: string, items: Array<{ type: string; payload: Record<string, unknown>; refs?: CatalystEvent['refs']; supersedes?: string[] }>): { id: string; events: CatalystEvent[] } {
  const keys = generateKeyPair();
  const author = participantIdFromPublicKey(keys.publicKey);
  const all = [{ type: 'participant.joined', payload: { name: 'Namit', publicKey: keys.publicKey } }, ...items];
  const events = all.map((it, i) =>
    signEvent(
      {
        v: 1,
        project: projectId,
        author,
        seq: i + 1,
        lc: 1000 + i,
        ts: new Date().toISOString(),
        type: it.type,
        payload: it.payload,
        refs: 'refs' in it && it.refs ? it.refs : {},
        supersedes: 'supersedes' in it && it.supersedes ? it.supersedes : [],
        origin: 'agent',
      },
      keys.privateKey,
    ),
  );
  return { id: author, events };
}

describe('daemon HTTP security', () => {
  it('requires the bearer token, checks Host and Origin, leaves /health open', async () => {
    const { info } = await start(makeProject());
    const health = await httpJson(info.apiPort, 'GET', '/health', {});
    expect(health.status).toBe(200);
    expect((health.body as { nonce: string }).nonce).toBe(info.nonce);
    expect(JSON.stringify(health.body)).not.toContain(info.token);

    const noToken = await httpJson(info.apiPort, 'GET', '/api/status', {});
    expect(noToken.status).toBe(401);
    expect((noToken.body as { error: { hint: string } }).error.hint).toMatch(/token rotated/i);

    const wrongToken = await httpJson(info.apiPort, 'GET', '/api/status', { token: 'x'.repeat(64) });
    expect(wrongToken.status).toBe(401);

    const badHost = await httpJson(info.apiPort, 'GET', '/api/status', { token: info.token, headers: { host: `evil.example:${info.apiPort}` } });
    expect(badHost.status).toBe(403);

    const badOrigin = await httpJson(info.apiPort, 'GET', '/api/status', { token: info.token, headers: { origin: 'http://evil.example' } });
    expect(badOrigin.status).toBe(403);

    const okOrigin = await httpJson(info.apiPort, 'GET', '/api/status', { token: info.token, headers: { origin: `http://127.0.0.1:${info.apiPort}` } });
    expect(okOrigin.status).toBe(200);

    const traversal = await httpJson(info.apiPort, 'GET', '/..%2f..%2fdaemon.json', {});
    expect(traversal.status).toBe(404);

    const emptyBody = await httpJson(info.apiPort, 'POST', '/api/tools/set_goal', { token: info.token });
    expect(emptyBody.status).toBe(400); // empty body → {} → missing title
  });
});

describe('daemon tools', () => {
  it('set_goal, claim_task overlaps, publish_progress, briefing', async () => {
    const dir = makeProject();
    const { h, info } = await start(dir);

    const goal = await api<PublishResult>(info, 'POST', '/api/tools/set_goal', { title: 'Ship login flow', successCriteria: ['tests pass'] });
    expect(goal.status).toBe(200);
    expect(goal.body.text).toContain('Saved locally');
    expect(goal.body.text).toContain('no peer paired yet');
    expect(goal.body.event.type).toBe('goal.set');

    // Simulated peer claims "api-auth" (touching src/api) before us.
    const peer = peerEvents(h.store.projectId, [
      { type: 'task.created', payload: { taskId: 'api-auth', title: 'API auth' }, refs: { task: 'api-auth' } },
      { type: 'task.claimed', payload: { taskId: 'api-auth', scope: 'token format', paths: ['src/api/**'] }, refs: { task: 'api-auth', paths: ['src/api/**'] } },
    ]);
    const ing = h.store.ingest(peer.events, { via: 'import' });
    expect(ing.rejected).toEqual([]);

    const same = await api<ClaimResult>(info, 'POST', '/api/tools/claim_task', { taskId: 'api-auth', scope: 'refresh tokens' });
    expect(same.status).toBe(200);
    expect(same.body.overlaps.map((o) => o.reason)).toEqual(['same_task']);
    expect(same.body.text).toMatch(/advisory/);
    expect(same.body.text).toMatch(/both claims are preserved/i);
    expect(same.body.conflicts.length).toBe(1);

    const overlap = await api<ClaimResult>(info, 'POST', '/api/tools/claim_task', { taskId: 'api-docs', title: 'API docs', scope: 'docs', paths: ['src/api/README.md'] });
    expect(overlap.body.overlaps.map((o) => o.reason)).toEqual(['path_overlap']);

    const prog = await api<PublishResult>(info, 'POST', '/api/tools/publish_progress', { taskId: 'api-docs', status: 'in_progress', summary: 'drafted docs', evidence: ['npm test: 3 passed'] });
    expect(prog.status).toBe(200);
    expect(prog.body.event.type).toBe('progress.reported');

    const brief = await api<Briefing>(info, 'POST', '/api/tools/get_briefing', {});
    expect(brief.status).toBe(200);
    expect(brief.body.text).toContain('Ship login flow');

    // resolve_conflict on a key with no conflict → 400 listing the open ones
    const noConflict = await api<{ error: { message: string } }>(info, 'POST', '/api/tools/resolve_conflict', { scope: 'decision', key: 'nothing', resolution: 'x' });
    expect(noConflict.status).toBe(400);
    expect(noConflict.body.error.message).toContain('claim:api-auth');
    const resolved = await api<PublishResult>(info, 'POST', '/api/tools/resolve_conflict', { scope: 'claim', key: 'api-auth', resolution: 'Tiam owns it', owner: h.store.me });
    expect(resolved.status).toBe(200);
    expect(resolved.body.conflicts).toEqual([]);

    // reply validation
    const noReplyTo = await api<{ error: { code: string } }>(info, 'POST', '/api/tools/send_message', { kind: 'reply', body: 'yes' });
    expect(noReplyTo.status).toBe(400);
    const unknownTool = await api(info, 'POST', '/api/tools/nope', {});
    expect(unknownTool.status).toBe(400);

    const status = await api<StatusResponse>(info, 'GET', '/api/status');
    expect(status.body.counts.peerEvents).toBe(3);
    expect(status.body.sessions.some((s) => s.id === 'mcp:test' && s.lastRetrievalAt)).toBe(true);
  });

  it('replies to a peer question and reports peer updates', async () => {
    const { h, info } = await start(makeProject());
    const peer = peerEvents(h.store.projectId, [{ type: 'message.posted', payload: { kind: 'question', body: 'Which token format?' } }]);
    h.store.ingest(peer.events, { via: 'import' });
    const question = peer.events[1]!;

    const updates = await api<UpdatesResult>(info, 'POST', '/api/tools/get_updates', {});
    expect(updates.body.outcome).toBe('updates');
    expect(updates.body.updates.some((u) => u.id === question.id)).toBe(true);

    const replyToNonQuestion = await api(info, 'POST', '/api/tools/send_message', { kind: 'reply', body: 'x', replyTo: peer.events[0]!.id });
    expect(replyToNonQuestion.status).toBe(400);
    const reply = await api<PublishResult>(info, 'POST', '/api/tools/send_message', { kind: 'reply', body: 'JWT', replyTo: question.id });
    expect(reply.status).toBe(200);
  });
});

describe('generated files', () => {
  it('writes snapshot and IMPORTANT.md after material events (debounced)', async () => {
    const dir = makeProject();
    const paths = projectPaths(dir);
    const { info } = await start(dir);
    await api(info, 'POST', '/api/tools/set_goal', { title: 'Handover goal' });
    await new Promise((r) => setTimeout(r, 900));
    expect(readFileSync(paths.snapshotMd, 'utf8')).toContain('Handover goal');
    expect(readFileSync(paths.handover, 'utf8')).toContain('Handover goal');
    const r = await api<{ path: string; changed: boolean }>(info, 'POST', '/api/handover');
    expect(r.body).toMatchObject({ path: paths.handover, changed: false });
  });
});

describe('daemon lifecycle', () => {
  it('persists events across restart and rotates the token', async () => {
    const dir = makeProject();
    const first = await start(dir);
    await api(first.info, 'POST', '/api/tools/set_goal', { title: 'Persist me' });
    const before = (await api<StatusResponse>(first.info, 'GET', '/api/status')).body.counts.events;
    await first.h.close();
    handles.splice(handles.indexOf(first.h), 1);
    expect(existsSync(projectPaths(dir).daemonInfo)).toBe(false);
    expect(existsSync(projectPaths(dir).lock)).toBe(false);

    const second = await start(dir);
    expect(second.info.token).not.toBe(first.info.token);
    expect(second.info.nonce).not.toBe(first.info.nonce);
    const old = await httpJson(second.info.apiPort, 'GET', '/api/status', { token: first.info.token });
    expect(old.status).toBe(401);
    const after = await api<StatusResponse>(second.info, 'GET', '/api/status');
    expect(after.body.counts.events).toBe(before);
    expect(h2Goal(second.h)).toBe('Persist me');
    // peer port was persisted on first start, so it stays stable
    expect(second.h.peerPort).toBe(first.h.peerPort);
  });

  it('refuses a second daemon for the same project', async () => {
    const dir = makeProject();
    await start(dir);
    await expect(runDaemon(dir, { signals: false })).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it('takes over a stale lock', async () => {
    const dir = makeProject();
    writeFileSync(projectPaths(dir).lock, '999999\n');
    const { info } = await start(dir);
    expect(info.pid).toBe(process.pid);
  });
});

function h2Goal(h: DaemonHandle): string | undefined {
  return h.store.getState().goal.current?.title;
}

describe('inbox import', () => {
  it('imports a tool draft once and rejects invalid drafts with an error file', async () => {
    const dir = makeProject();
    const paths = projectPaths(dir);
    const { h, info } = await start(dir);
    ensureDir(paths.inbox);
    const draft = { catalystDraft: 1, clientId: 'draft-0001-abcdef', tool: 'publish_progress', input: { status: 'blocked', summary: 'waiting on API' } };
    writeFileSync(join(paths.inbox, 'a.json'), JSON.stringify(draft));
    const first = await api<InboxImportResponse>(info, 'POST', '/api/inbox/import');
    expect(first.body).toMatchObject({ imported: 1, duplicates: 0, rejected: [] });
    const count = h.store.counts().events;

    // Same clientId copied under another name → duplicate, no new event.
    copyFileSync(join(paths.inboxImported, 'a.json'), join(paths.inbox, 'b.json'));
    const second = await api<InboxImportResponse>(info, 'POST', '/api/inbox/import');
    expect(second.body).toMatchObject({ imported: 0, duplicates: 1 });
    expect(h.store.counts().events).toBe(count);
    const fallback = h.store.listSince(0).filter((e) => e.event.origin === 'fallback');
    expect(fallback.length).toBe(1);

    writeFileSync(join(paths.inbox, 'bad.json'), '{ not json');
    writeFileSync(join(paths.inbox, 'invalid.json'), JSON.stringify({ catalystDraft: 1, clientId: 'draft-0002-abcdef', tool: 'publish_progress', input: { status: 'nope' } }));
    writeFileSync(join(paths.inbox, 'tool.json'), JSON.stringify({ catalystDraft: 1, clientId: 'draft-0003-abcdef', tool: 'get_briefing', input: {} }));
    const third = await api<InboxImportResponse>(info, 'POST', '/api/inbox/import');
    expect(third.body.imported).toBe(0);
    expect(third.body.rejected.map((r) => r.file).sort()).toEqual(['bad.json', 'invalid.json', 'tool.json']);
    const rejected = readdirSync(paths.inboxRejected).sort();
    expect(rejected).toEqual(['bad.json', 'bad.json.error.txt', 'invalid.json', 'invalid.json.error.txt', 'tool.json', 'tool.json.error.txt']);
    expect(readFileSync(join(paths.inboxRejected, 'bad.json.error.txt'), 'utf8')).toMatch(/invalid JSON/);
    expect(readdirSync(paths.inbox).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('imports drafts present at startup', async () => {
    const dir = makeProject();
    const paths = projectPaths(dir);
    ensureDir(paths.inbox);
    writeFileSync(join(paths.inbox, 'e.json'), JSON.stringify({ catalystDraft: 1, clientId: 'draft-evt-000001', event: { type: 'activity.captured', payload: { kind: 'session', summary: 'offline session' } } }));
    const { h } = await start(dir);
    expect(h.store.listSince(0).some((e) => e.event.type === 'activity.captured' && e.event.origin === 'fallback')).toBe(true);
    expect(existsSync(join(paths.inboxImported, 'e.json'))).toBe(true);
  });
});

describe('unread summary', () => {
  it('reports new peer updates once per session with markNotified and does not move the get_updates cursor', async () => {
    const { h, info } = await start(makeProject());
    const peer = peerEvents(h.store.projectId, [
      { type: 'decision.recorded', payload: { topic: 'api', title: 'JWT', decision: 'Use JWT', rationale: 'standard', status: 'accepted' }, refs: { topic: 'api' } },
      { type: 'message.posted', payload: { kind: 'question', body: 'ok?' } },
    ]);
    h.store.ingest(peer.events, { via: 'import' });

    const peek = await api<UnreadSummary>(info, 'GET', '/api/unread?session=s1');
    expect(peek.body.newSinceLastNotice).toBe(3);
    expect(peek.body.questionsForMe).toBe(1);
    const mark = await api<UnreadSummary>(info, 'GET', '/api/unread?session=s1&markNotified=1');
    expect(mark.body.newSinceLastNotice).toBe(3);
    const again = await api<UnreadSummary>(info, 'GET', '/api/unread?session=s1&markNotified=1');
    expect(again.body.newSinceLastNotice).toBe(0);
    expect(again.body.count).toBeGreaterThan(0); // still unacknowledged
    const other = await api<UnreadSummary>(info, 'GET', '/api/unread?session=s2');
    expect(other.body.newSinceLastNotice).toBe(3);
    expect(h.store.getSessionCursor('s1')).toBe(0);
  });
});
