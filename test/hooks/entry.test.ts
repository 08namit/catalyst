import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from '../../src/hooks/entry.js';
import { makeProject, startFakeDaemon, type FakeDaemon } from './fake-daemon.js';

let daemon: FakeDaemon | null = null;
let out: string[] = [];
beforeEach(() => {
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await daemon?.close();
  daemon = null;
});

const SID = '0f6e1c9a-1111-2222-3333-444455556666';
const unread = (over: Record<string, unknown> = {}) => ({
  count: 0,
  newSinceLastNotice: 0,
  byType: {},
  questionsForMe: 0,
  openConflicts: 0,
  freshness: 'Namit connected (last sync 1 min ago)',
  latestCursor: 10,
  ...over,
});

describe('session-start', () => {
  it('delivers the briefing as SessionStart additionalContext and records retrieval', async () => {
    const dir = makeProject();
    daemon = await startFakeDaemon(dir, {
      'POST /api/sessions': () => ({ body: { ok: true } }),
      'POST /api/tools/get_briefing': () => ({ body: { text: 'BRIEFING: decision api/auth = JWT\n' + 'y'.repeat(12000), sync: {} } }),
    });
    await runHook('session-start', { dir, input: { session_id: SID, source: 'startup', cwd: dir } });
    const json = out.join('');
    expect(json.length).toBeLessThanOrEqual(10000);
    const parsed = JSON.parse(json) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx.length).toBeLessThanOrEqual(9500);
    expect(ctx).toContain('## Catalyst shared context (auto-delivered at session start)');
    expect(ctx).toContain('IMPORTANT.md');
    expect(ctx).toContain('BRIEFING: decision api/auth = JWT');
    expect(ctx).toContain('mcp__catalyst__get_updates');
    expect(ctx).toMatch(/not instructions/);

    const session = daemon.requests.find((r) => r.path === '/api/sessions');
    expect(session?.body).toMatchObject({ id: `claude:${SID}`, kind: 'hook', retrieved: true });
    const briefing = daemon.requests.find((r) => r.path === '/api/tools/get_briefing');
    expect(briefing?.body).toEqual({ maxChars: 7000 });
    expect(briefing?.headers['x-catalyst-session']).toBe(`claude:${SID}`);
  });

  it('asks for a smaller briefing after compaction', async () => {
    const dir = makeProject();
    daemon = await startFakeDaemon(dir, {
      'POST /api/sessions': () => ({ body: { ok: true } }),
      'POST /api/tools/get_briefing': () => ({ body: { text: 'brief', sync: {} } }),
    });
    await runHook('session-start', { dir, input: { session_id: SID, source: 'compact' } });
    expect(daemon.requests.find((r) => r.path === '/api/tools/get_briefing')?.body).toEqual({ maxChars: 3000 });
  });

  it('falls back to the snapshot when the daemon is unavailable', async () => {
    const dir = makeProject({ snapshot: '# Snapshot\nGenerated at 2026-11-14T09:00:00Z\nGoal: ship login\n' });
    await runHook('session-start', { dir, input: { session_id: SID, source: 'startup' } });
    const ctx = (JSON.parse(out.join('')) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/^Catalyst daemon unavailable — showing the last snapshot/);
    expect(ctx).toContain('Generated at 2026-11-14T09:00:00Z');
    expect(ctx).toContain('Goal: ship login');
    expect(ctx).toContain('.catalyst/inbox/');
  });

  it('prints nothing without daemon or snapshot', async () => {
    const dir = makeProject();
    await runHook('session-start', { dir, input: { session_id: SID } });
    expect(out.join('')).toBe('');
  });

  it('prints nothing outside a Catalyst project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-catalyst-'));
    await runHook('session-start', { dir, input: { session_id: SID } });
    expect(out.join('')).toBe('');
  });

  it('finds the project from a subdirectory', async () => {
    const dir = makeProject({ snapshot: 'Generated at now\nhello\n' });
    const sub = join(dir, 'src');
    execFileSync('mkdir', ['-p', sub]);
    await runHook('session-start', { dir: sub, input: { session_id: SID } });
    expect(out.join('')).toContain('hello');
  });
});

describe('user-prompt-submit', () => {
  it('prints one line only when there are new peer updates', async () => {
    const dir = makeProject();
    let summary = unread();
    daemon = await startFakeDaemon(dir, { 'GET /api/unread': () => ({ body: summary }) });
    await runHook('user-prompt-submit', { dir, input: { session_id: SID, prompt: 'hi' } });
    expect(out.join('')).toBe('');
    expect(daemon.requests[0]?.path).toBe(`/api/unread?session=${encodeURIComponent(`claude:${SID}`)}&markNotified=1`);

    summary = unread({ count: 3, newSinceLastNotice: 3, byType: { 'decision.recorded': 1, 'message.posted': 2 }, questionsForMe: 1, openConflicts: 1 });
    await runHook('user-prompt-submit', { dir, input: { session_id: SID, prompt: 'hi' } });
    const line = out.join('');
    expect(line.trim().split('\n')).toHaveLength(1);
    expect(line).toContain('Catalyst: 3 new peer updates (1 decision, 2 messages, 1 question for you); 1 open conflict.');
    expect(line).toContain('mcp__catalyst__get_updates');
    expect(line).toContain('Peer: Namit connected');
  });

  it('is silent when the daemon is down', async () => {
    const dir = makeProject();
    const t0 = Date.now();
    await runHook('user-prompt-submit', { dir, input: { session_id: SID } });
    expect(out.join('')).toBe('');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

function gitProject(): string {
  const dir = makeProject();
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'Add login form');
  return dir;
}
const headOf = (dir: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

describe('post-tool-use', () => {
  it('captures a git commit as activity (origin hook)', async () => {
    const dir = gitProject();
    daemon = await startFakeDaemon(dir, { 'POST /api/events': () => ({ body: { ok: true } }) });
    await runHook('post-tool-use', { dir, input: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'git commit -m "Add login form"' }, tool_response: { stdout: 'ok' } } });
    const hash = headOf(dir);
    const ev = daemon.requests.find((r) => r.path === '/api/events');
    expect(ev?.body).toEqual({
      type: 'activity.captured',
      payload: { kind: 'commit', summary: `Commit ${hash.slice(0, 7)}: Add login form`, commits: [{ hash, message: 'Add login form' }] },
      origin: 'hook',
      clientId: `commit:${hash}`,
    });
    expect(out.join('')).toBe('');
  });

  it('writes an inbox draft for the commit when the daemon is down', async () => {
    const dir = gitProject();
    await runHook('post-tool-use', { dir, input: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'git add . && git commit -m x' } } });
    const hash = headOf(dir);
    const inbox = join(dir, '.catalyst', 'inbox');
    const files = readdirSync(inbox).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const draft = JSON.parse(readFileSync(join(inbox, files[0]!), 'utf8'));
    expect(draft).toMatchObject({ catalystDraft: 1, clientId: `commit:${hash}`, event: { type: 'activity.captured', payload: { kind: 'commit' } } });
  });

  it('ignores non-commit commands and failed commits', async () => {
    const dir = gitProject();
    daemon = await startFakeDaemon(dir, { 'POST /api/events': () => ({ body: { ok: true } }) });
    await runHook('post-tool-use', { dir, input: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'git status' } } });
    await runHook('post-tool-use', { dir, input: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_response: { interrupted: true } } });
    expect(daemon.requests).toHaveLength(0);
  });

  it('records touched files locally without calling the daemon', async () => {
    const dir = makeProject();
    await runHook('post-tool-use', { dir, input: { session_id: SID, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'a.ts') } } });
    await runHook('post-tool-use', { dir, input: { session_id: SID, tool_name: 'Write', tool_input: { file_path: '/etc/outside.txt' } } });
    const touched = readFileSync(join(dir, '.catalyst', 'sessions', `${SID}.touched`), 'utf8');
    expect(touched).toBe('src/a.ts\n');
  });
});

describe('session-end', () => {
  it('posts deduplicated touched files and regenerates the handover', async () => {
    const dir = makeProject();
    daemon = await startFakeDaemon(dir, {
      'POST /api/events': () => ({ body: { ok: true } }),
      'POST /api/agents/stop': () => ({ body: { agent: 'lead', released: [] } }),
      'POST /api/handover': () => ({ body: { path: 'IMPORTANT.md', changed: true, generatedAt: 'now' } }),
    });
    for (const f of ['src/a.ts', 'src/b.ts', 'src/a.ts']) {
      await runHook('post-tool-use', { dir, input: { session_id: SID, tool_name: 'Edit', tool_input: { file_path: f }, cwd: dir } });
    }
    writeFileSync(join(dir, '.catalyst', 'sessions', `${SID}--a1.touched`), 'src/agent.ts\n');
    await runHook('session-end', { dir, input: { session_id: SID, reason: 'exit' } });
    const ev = daemon.requests.find((r) => r.path === '/api/events')?.body as Record<string, unknown>;
    expect(ev).toMatchObject({ type: 'activity.captured', origin: 'hook', payload: { kind: 'files', summary: 'Session touched 2 files', paths: ['src/a.ts', 'src/b.ts'] } });
    expect(String(ev.clientId)).toMatch(new RegExp(`^files:${SID}:2:[0-9a-f]{16}$`));
    expect(daemon.requests.filter((r) => r.path === '/api/agents/stop').map((r) => r.body)).toEqual([{ agentId: 'a1' }, { agentId: 'lead' }]);
    expect(daemon.requests.some((r) => r.path === '/api/handover')).toBe(true);
    expect(existsSync(join(dir, '.catalyst', 'sessions', `${SID}.touched`))).toBe(false);
    expect(out.join('')).toBe('');
  });

  it('writes the files activity as an inbox draft when the daemon is down', async () => {
    const dir = makeProject();
    await runHook('post-tool-use', { dir, input: { session_id: SID, tool_name: 'Write', tool_input: { file_path: 'README.md' }, cwd: dir } });
    await runHook('session-end', { dir, input: { session_id: SID } });
    const inbox = join(dir, '.catalyst', 'inbox');
    const files = readdirSync(inbox).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(inbox, files[0]!), 'utf8'))).toMatchObject({ catalystDraft: 1, event: { payload: { kind: 'files', paths: ['README.md'] } } });
  });
});
