/**
 * Two-node end-to-end test: two separate project dirs (A = Alice, B = Bob), each with its own daemon, SQLite
 * database, identity and loopback peer listener, driven through the REAL built CLI and the loopback HTTP API.
 *
 * Run without npm:   node_modules/.bin/vitest run test/e2e/two-node.test.ts   (after `node_modules/.bin/tsc -p
 * tsconfig.build.json && node scripts/copy-static.mjs`, i.e. a build). With npm: `npm run test:e2e`.
 *
 * Scenarios (numbered as in the e2e brief): 1 pairing, 2 delivery lifecycle, 3 question/reply, 4 outage +
 * replay, 5 decision conflict, 6 claim conflict, 7 kill -9 restart recovery, 9 filesystem fallback, 10 IMPORTANT.md.
 * They share one A/B pair and run sequentially; each builds on the previous one's state.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AckResult, Briefing, ClaimResult, DashboardState, InboxImportResponse, PublishResult, UpdatesResult } from '../../src/core/api.js';
import { CatalystClient } from '../../src/client/index.js';
import {
  assertBuilt,
  cleanupNodes,
  cli,
  cliOk,
  client,
  daemonPid,
  daemonProcesses,
  initNode,
  joinNode,
  pidAlive,
  state,
  status,
  tempDir,
  waitFor,
} from './helpers.js';

const TOPIC = 'api/create-task';
const GOAL = 'Ship the task API and the login page';

let A = '';
let B = '';
let ca: CatalystClient;
let cb: CatalystClient;
let alice = '';
let bob = '';

const outbound = (s: DashboardState, id: string) => s.outbound.find((o) => o.id === id);
const peerOf = (s: { sync: { peers: Array<{ participant: string; state: string; pendingOutbound: number; confirmCode?: string }> } }) => s.sync.peers[0];
const hasEvent = async (dir: string, id: string) => (await state(dir)).recent.some((r) => r.id === id);

/** Both nodes hold the same event set and have nothing pending. */
async function waitConverged(): Promise<void> {
  await waitFor('both nodes converged (same event count, nothing pending)', async () => {
    const [sa, sb] = await Promise.all([status(A), status(B)]);
    return sa.counts.events === sb.counts.events && sa.sync.pendingOutbound === 0 && sb.sync.pendingOutbound === 0 && peerOf(sa)?.state === 'connected' && peerOf(sb)?.state === 'connected';
  });
}

// vitest 5 has no describe.sequential; tests inside a suite run in order unless concurrent is set.
describe('two-node e2e (real CLI, real daemons)', { concurrent: false }, () => {
  beforeAll(() => assertBuilt());
  afterAll(async () => {
    await cleanupNodes();
  }, 60_000);

  it('1. init A, pair, join B: both connected with identical confirmation codes; a reused token is rejected', async () => {
    A = await initNode('A', 'Alice');
    const joined = await joinNode(A, 'B', 'Bob');
    B = joined.dir;
    const code = /Confirmation code: ([0-9a-f]{8})/.exec(joined.output)?.[1];
    expect(code, joined.output).toBeTruthy();

    const [sa, sb] = await waitFor('both peers connected', async () => {
      const both = await Promise.all([status(A), status(B)]);
      return both.every((s) => peerOf(s)?.state === 'connected') ? both : null;
    });
    alice = sa.health.participantId;
    bob = sb.health.participantId;
    expect(alice).not.toBe(bob);
    expect(sa.health.projectId).toBe(sb.health.projectId);
    expect(peerOf(sa)!.participant).toBe(bob);
    expect(peerOf(sb)!.participant).toBe(alice);
    expect(peerOf(sa)!.confirmCode).toBe(code);
    expect(peerOf(sb)!.confirmCode).toBe(code);
    // Separate databases / identities.
    expect(sa.dataDir).not.toBe(sb.dataDir);

    const reuse = await cli(['join', joined.token, '--dir', tempDir('reuse'), '--name', 'Mallory', '--peer-bind', '127.0.0.1', '--no-setup']);
    expect(reuse.code).not.toBe(0);
    expect(reuse.stderr).toMatch(/already been used|expired/i);
    expect(reuse.stderr).toMatch(/catalyst pair/);

    ca = client(A, 'e2e:alice-agent');
    cb = client(B, 'e2e:bob-agent');
  });

  it('2. goal + decision on A reach B; delivered → retrieved → acknowledged are tracked separately on A', async () => {
    const goal = await ca.tool<PublishResult>('set_goal', { title: GOAL, successCriteria: ['POST /tasks works end to end'] });
    const dec = await ca.tool<PublishResult>('publish_decision', {
      topic: TOPIC,
      title: 'POST /tasks contract',
      decision: 'POST /tasks takes {title} and returns 201 {id, title, done:false}',
      rationale: 'Frontend and backend build against the same shape',
    });
    expect(dec.event.type).toBe('decision.recorded');

    // Delivered (peer stored it) but not yet retrieved/acknowledged.
    const delivered = await waitFor('decision delivered to B', async () => {
      const o = outbound(await state(A), dec.event.id);
      return o && o.delivery.deliveredTo.some((d) => d.participant === bob) ? o : null;
    });
    expect(delivered.delivery.savedLocally).toBe(true);
    expect(delivered.delivery.retrievedBy).toEqual([]);
    expect(delivered.delivery.acknowledgedBy).toEqual([]);

    const upd = await cb.tool<UpdatesResult>('get_updates', {});
    expect(upd.outcome).toBe('updates');
    const ids = upd.updates.map((u) => u.id);
    expect(ids).toContain(dec.event.id);
    expect(ids).toContain(goal.event.id);
    expect(upd.updates.find((u) => u.id === dec.event.id)!.authorName).toBe('Alice');

    const retrieved = await waitFor('A sees B retrieved the decision', async () => {
      const o = outbound(await state(A), dec.event.id);
      return o && o.delivery.retrievedBy.some((d) => d.participant === bob) ? o : null;
    });
    expect(retrieved.delivery.acknowledgedBy).toEqual([]);

    const ack = await cb.tool<AckResult>('acknowledge_updates', { eventIds: [dec.event.id] });
    expect(ack.acknowledged).toBe(1);
    const acked = await waitFor('A sees B acknowledged the decision', async () => {
      const o = outbound(await state(A), dec.event.id);
      return o && o.delivery.acknowledgedBy.some((d) => d.participant === bob) ? o : null;
    });
    expect(acked.delivery.deliveredTo.map((d) => d.participant)).toContain(bob);
    expect(acked.delivery.retrievedBy.map((d) => d.participant)).toContain(bob);
    // The goal was delivered and retrieved but never acknowledged: the states really are distinct.
    const g = outbound(await state(A), goal.event.id)!;
    expect(g.delivery.deliveredTo.map((d) => d.participant)).toContain(bob);
    expect(g.delivery.acknowledgedBy).toEqual([]);
  });

  it('3. B asks a question, A sees it under "questions for me", replies, and B sees it answered', async () => {
    const q = await cb.tool<PublishResult>('send_message', { kind: 'question', body: 'Should POST /tasks reject empty titles with 400?', to: alice, topic: TOPIC });
    const brief = await waitFor('question in A briefing', async () => {
      const b = await ca.tool<Briefing>('get_briefing', {});
      return b.questionsForMe.some((x) => x.id === q.event.id) ? b : null;
    });
    expect(brief.text).toContain('reject empty titles');

    const reply = await ca.tool<PublishResult>('send_message', { kind: 'reply', replyTo: q.event.id, body: 'Yes: 400 {error:"title required"}' });
    const answered = await waitFor('question answered on B', async () => {
      const s = await state(B);
      const qq = s.state.questions.find((x) => x.id === q.event.id);
      return qq?.answered ? qq : null;
    });
    expect(answered.replies.map((r) => r.id)).toContain(reply.event.id);
    const qa = (await state(A)).state.questions.find((x) => x.id === q.event.id);
    expect(qa?.answered).toBe(true);

    const upd = await cb.tool<UpdatesResult>('get_updates', {});
    expect(upd.updates.map((u) => u.id)).toContain(reply.event.id);
  });

  it('4. outage: B pauses peer networking, both keep working, A reports peer unreachable + pending, resume replays both ways', async () => {
    await ca.tool<UpdatesResult>('get_updates', {}); // drain A's feed
    await cliOk(['peer', 'pause', '--dir', B]);
    await waitFor('A sees B unreachable', async () => {
      const p = peerOf(await status(A));
      return p && p.state !== 'connected' && p.state !== 'connecting' ? p : null;
    });

    const pb = await cb.tool<PublishResult>('publish_progress', { status: 'in_progress', summary: 'Bob: login form wired to POST /tasks (offline)' });
    expect(pb.sync.paused).toBe(true);
    expect(pb.text).toMatch(/paused|queued/i);
    const pa = await ca.tool<PublishResult>('publish_progress', { status: 'in_progress', summary: 'Alice: POST /tasks validation done (offline)' });

    const upd = await ca.tool<UpdatesResult>('get_updates', {});
    expect(upd.updates).toEqual([]);
    expect(upd.outcome).toBe('no_updates_peer_unreachable');
    expect(upd.text).toMatch(/unreachable|paused/i);
    expect(upd.sync.pendingOutbound).toBeGreaterThan(0);
    expect(upd.sync.freshness).not.toMatch(/connected/);

    const sb = await status(B);
    expect(sb.sync.paused).toBe(true);
    expect(sb.sync.pendingOutbound).toBeGreaterThan(0);
    expect(sb.sync.freshness).toMatch(/paused/i);
    // B's local reads still work while paused.
    expect((await cb.tool<Briefing>('get_briefing', {})).goal?.title).toBe(GOAL);

    await cliOk(['peer', 'resume', '--dir', B]);
    await waitFor('A received B offline progress', () => hasEvent(A, pb.event.id));
    await waitFor('B received A offline progress', () => hasEvent(B, pa.event.id));
    await waitConverged();
    const after = await ca.tool<UpdatesResult>('get_updates', {});
    expect(after.outcome).toBe('updates');
    expect(after.updates.map((u) => u.id)).toContain(pb.event.id);
  });

  it('5. concurrent decision revisions while paused are flagged identically on both nodes and resolved', async () => {
    const head = (await state(A)).state.decisions.find((d) => d.topic === TOPIC)!;
    expect(head.heads).toHaveLength(1);
    const base = head.heads[0]!.id;

    await cliOk(['peer', 'pause', '--dir', B]);
    const ra = await ca.tool<PublishResult>('publish_decision', { topic: TOPIC, title: 'POST /tasks v2 (Alice)', decision: 'Return 201 with Location header', rationale: 'REST convention' });
    const rb = await cb.tool<PublishResult>('publish_decision', { topic: TOPIC, title: 'POST /tasks v2 (Bob)', decision: 'Return 200 with the full task list', rationale: 'Saves a round trip' });
    await cliOk(['peer', 'resume', '--dir', B]);

    const conflictOn = async (dir: string) => {
      const s = await state(dir);
      return s.state.conflicts.find((c) => c.scope === 'decision' && c.key === TOPIC) ?? null;
    };
    const [cfA, cfB] = await Promise.all([waitFor('conflict on A', () => conflictOn(A)), waitFor('conflict on B', () => conflictOn(B))]);
    const headsA = cfA.heads.map((h) => h.id).sort();
    expect(headsA).toEqual([ra.event.id, rb.event.id].sort());
    expect(cfB.heads.map((h) => h.id).sort()).toEqual(headsA);
    // Both revisions superseded the same base version.
    const topicA = (await state(A)).state.decisions.find((d) => d.topic === TOPIC)!;
    expect(topicA.conflict).toBe(true);
    for (const h of topicA.heads) expect(h.supersedes).toEqual([base]);
    const st = await status(A);
    expect(st.conflicts.some((c) => c.key === TOPIC)).toBe(true);

    const res = await ca.tool<PublishResult>('resolve_conflict', { scope: 'decision', key: TOPIC, resolution: 'Return 201 {id,title,done} with a Location header', chosen: ra.event.id });
    expect(res.conflicts).toEqual([]);
    await waitFor('conflict cleared on B', async () => ((await conflictOn(B)) ? null : true));
    expect(await conflictOn(A)).toBeNull();
    const topicB = (await state(B)).state.decisions.find((d) => d.topic === TOPIC)!;
    expect(topicB.conflict).toBe(false);
    expect(topicB.heads.map((h) => h.id)).toEqual([res.event.id]);
    expect(topicB.history.length).toBeGreaterThanOrEqual(4); // base, Alice v2, Bob v2, resolution
    for (const id of [base, ra.event.id, rb.event.id]) expect(topicB.history.map((h) => h.id)).toContain(id);
  });

  it('6. concurrent claims of the same task while paused are flagged as a claim conflict on both nodes', async () => {
    await cliOk(['peer', 'pause', '--dir', B]);
    const claimA = await ca.tool<ClaimResult>('claim_task', { taskId: 'frontend-login', title: 'Login page', scope: 'Build the login form', paths: ['sample/web/login/'] });
    const claimB = await cb.tool<ClaimResult>('claim_task', { taskId: 'frontend-login', title: 'Login page', scope: 'Login form + validation', paths: ['sample/web/'] });
    expect(claimA.overlaps).toEqual([]); // nothing known yet while partitioned
    await cliOk(['peer', 'resume', '--dir', B]);

    for (const dir of [A, B]) {
      const cf = await waitFor(`claim conflict on ${dir === A ? 'A' : 'B'}`, async () => (await state(dir)).state.conflicts.find((c) => c.scope === 'claim' && c.key === 'frontend-login'));
      expect(cf.heads.map((h) => h.id).sort()).toEqual([claimA.event.id, claimB.event.id].sort());
      const task = (await state(dir)).state.tasks.find((t) => t.taskId === 'frontend-login')!;
      expect(task.claimConflict).toBe(true);
      expect(task.owners.sort()).toEqual([alice, bob].sort());
    }
    await waitConverged();
  });

  it('7. kill -9 of B while A appends: restart recovers the stale lock and replays everything; duplicate start makes no second daemon', async () => {
    const before = await status(B);
    const pid = daemonPid(B)!;
    expect(pidAlive(pid)).toBe(true);
    process.kill(pid, 'SIGKILL');
    await waitFor('B daemon dead', () => !pidAlive(pid), 5000, 50);
    expect(existsSync(join(B, '.catalyst', 'daemon.lock'))).toBe(true); // stale lock left behind

    const written: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const r = await ca.tool<PublishResult>('publish_progress', { status: 'in_progress', summary: `Alice: step ${i} while Bob was down` });
      written.push(r.event.id);
    }
    await waitFor('A sees B not connected', async () => (peerOf(await status(A))?.state !== 'connected' ? true : null));

    const started = await cliOk(['start', '--dir', B]);
    expect(started).toMatch(/started/);
    const newPid = daemonPid(B)!;
    expect(newPid).not.toBe(pid);
    expect(pidAlive(newPid)).toBe(true);

    for (const id of written) await waitFor(`B received ${id.slice(0, 8)}`, () => hasEvent(B, id));
    await waitConverged();
    const after = await status(B);
    expect(after.counts.ownEvents).toBe(before.counts.ownEvents); // nothing of B's own history lost
    expect(after.counts.events).toBe(before.counts.events + 3);

    // Duplicate starts (CLI twice in parallel + a foreground `daemon`) do not create a second daemon.
    const [s1, s2] = await Promise.all([cliOk(['start', '--dir', B]), cliOk(['start', '--dir', B])]);
    expect(s1).toMatch(/already running/);
    expect(s2).toMatch(/already running/);
    const fg = await cli(['daemon', '--dir', B], { timeoutMs: 15_000 });
    expect(fg.code).toBe(0);
    expect(fg.stderr).toMatch(/already running/i);
    expect(await daemonProcesses(B)).toEqual([newPid]);
    expect(daemonPid(B)).toBe(newPid);
  });

  it('9. fallback: with B stopped, inbox drafts are imported once on start (invalid ones rejected) and reach A', async () => {
    await cliOk(['stop', '--dir', B]);
    const inbox = join(B, '.catalyst', 'inbox');
    mkdirSync(inbox, { recursive: true }); // an agent creates it if the daemon never did
    const snapshot = readFileSync(join(B, '.catalyst', 'snapshot.md'), 'utf8');
    expect(snapshot).toContain('Generated at');
    expect(snapshot).toContain(GOAL);

    const clientId = randomUUID();
    const valid = join(tempDir('drafts'), `${clientId}.json`);
    writeFileSync(valid, JSON.stringify({ catalystDraft: 1, clientId, tool: 'publish_progress', input: { status: 'blocked', summary: 'Bob (fallback): waiting on CORS config', blockers: ['CORS'] } }));
    copyFileSync(valid, join(inbox, `${clientId}.json`));
    writeFileSync(join(inbox, 'broken-draft.json'), JSON.stringify({ catalystDraft: 1, clientId: 'broken-draft-0001', tool: 'publish_progress', input: { status: 'not-a-status' } }));

    await cliOk(['start', '--dir', B]);
    const imported = join(inbox, 'imported');
    const rejected = join(inbox, 'rejected');
    await waitFor('drafts processed', () => existsSync(imported) && readdirSync(imported).includes(`${clientId}.json`) && existsSync(rejected) && readdirSync(rejected).includes('broken-draft.json'));
    expect(readdirSync(rejected)).toContain('broken-draft.json.error.txt');
    expect(readFileSync(join(rejected, 'broken-draft.json.error.txt'), 'utf8').trim().length).toBeGreaterThan(0);

    const findDraft = (s: DashboardState) => s.recent.filter((r) => r.type === 'progress.reported' && r.summary.includes('waiting on CORS'));
    const sB = await state(B);
    expect(findDraft(sB)).toHaveLength(1);
    expect(findDraft(sB)[0]!.origin).toBe('fallback');
    const countBefore = sB.state.eventCount;

    // Re-delivering the same draft (same clientId, new file name) adds nothing.
    copyFileSync(valid, join(inbox, `again-${clientId}.json`));
    const again = await client(B, 'e2e:cli').post<InboxImportResponse>('/api/inbox/import');
    expect(again).toMatchObject({ imported: 0, duplicates: 1, rejected: [] });
    const sB2 = await state(B);
    expect(sB2.state.eventCount).toBe(countBefore);
    expect(findDraft(sB2)).toHaveLength(1);

    await waitFor('fallback progress reached A', async () => findDraft(await state(A)).length === 1);
    await waitConverged();
  });

  it('10. IMPORTANT.md handover blocks are byte-identical on both nodes and include goal, decision and open conflict', async () => {
    await waitConverged();
    await cliOk(['handover', '--dir', A]);
    await cliOk(['handover', '--dir', B]);
    const block = (dir: string) => {
      const text = readFileSync(join(dir, 'IMPORTANT.md'), 'utf8');
      const m = /<!-- catalyst:handover:begin -->[\s\S]*<!-- catalyst:handover:end -->/.exec(text);
      if (!m) throw new Error(`no handover block in ${dir}/IMPORTANT.md:\n${text}`);
      return m[0];
    };
    const ba = block(A);
    const bb = block(B);
    expect(bb).toBe(ba);
    expect(ba).toContain(GOAL);
    expect(ba).toContain('Return 201 {id,title,done} with a Location header'); // the resolved decision
    expect(ba).toContain('Open conflicts');
    expect(ba).toContain('frontend-login');
    expect(ba).not.toMatch(/cat1_|pairKey|privateKey/);
  });
});
