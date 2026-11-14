import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preToolUseOutput, runHook } from '../../src/hooks/entry.js';
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

describe('pre-tool-use', () => {
  it('stamps the subagent onto the Catalyst tool input without calling the daemon', async () => {
    const dir = makeProject();
    daemon = await startFakeDaemon(dir, {});
    const tool_input = { taskId: 'api', scope: 'routes', _caller: { agentId: 'spoofed' } };
    await runHook('pre-tool-use', { dir, input: { session_id: SID, tool_name: 'mcp__catalyst__claim_task', tool_input, agent_id: 'a7a6a241124692d30', agent_type: 'general-purpose' } });
    expect(JSON.parse(out.join(''))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { taskId: 'api', scope: 'routes', _caller: { agentId: 'a7a6a241124692d30', agentType: 'general-purpose' } },
      },
    });
    expect(daemon.requests).toHaveLength(0);
  });

  it('marks the main thread with an empty _caller and ignores other tools', () => {
    expect(preToolUseOutput({ tool_name: 'mcp__catalyst__get_briefing', tool_input: { task: 'x', _caller: { agentId: 'fake' } } })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { task: 'x', _caller: {} } },
    });
    expect(preToolUseOutput({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeNull();
  });

  it('works outside a Catalyst project (setup tools before start_project)', async () => {
    await runHook('pre-tool-use', { dir: '/', input: { tool_name: 'mcp__catalyst__start_project', tool_input: {} } });
    expect(JSON.parse(out.join('')).hookSpecificOutput.updatedInput).toEqual({ _caller: {} });
  });
});

describe('subagent-start / subagent-stop', () => {
  it('registers the subagent and prints its context as SubagentStart additionalContext', async () => {
    const dir = makeProject();
    daemon = await startFakeDaemon(dir, {
      'POST /api/agents': () => ({ body: { agent: 'a1', name: 'general-purpose-1', displayName: 'Tester / general-purpose-1', context: 'You are Catalyst agent "Tester / general-purpose-1". Use take_next_task.' } }),
    });
    await runHook('subagent-start', { dir, input: { session_id: SID, agent_id: 'a1', agent_type: 'general-purpose' } });
    const parsed = JSON.parse(out.join(''));
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SubagentStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('take_next_task');
    expect(daemon.requests[0]?.body).toEqual({ agentId: 'a1', agentType: 'general-purpose', session: `claude:${SID}` });
  });

  it('prints nothing when the daemon fails', async () => {
    const dir = makeProject();
    daemon = await startFakeDaemon(dir, { 'POST /api/agents': () => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } }) });
    await runHook('subagent-start', { dir, input: { session_id: SID, agent_id: 'a1' } });
    expect(out.join('')).toBe('');
  });

  it('subagent-stop flushes the agent\'s touched files under that agent and stops it', async () => {
    const dir = makeProject();
    daemon = await startFakeDaemon(dir, {
      'POST /api/events': () => ({ body: { ok: true } }),
      'POST /api/agents/stop': () => ({ body: { agent: 'a1', released: [] } }),
    });
    await runHook('post-tool-use', { dir, input: { session_id: SID, agent_id: 'a1', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'x.ts') } } });
    expect(existsSync(join(dir, '.catalyst', 'sessions', `${SID}--a1.touched`))).toBe(true);
    await runHook('subagent-stop', { dir, input: { session_id: SID, agent_id: 'a1' } });
    const ev = daemon.requests.find((r) => r.path === '/api/events');
    expect(ev?.headers['x-catalyst-agent']).toBe('a1');
    expect(ev?.body).toMatchObject({ type: 'activity.captured', payload: { kind: 'files', paths: ['src/x.ts'] } });
    expect(daemon.requests.find((r) => r.path === '/api/agents/stop')?.body).toEqual({ agentId: 'a1' });
    expect(existsSync(join(dir, '.catalyst', 'sessions', `${SID}--a1.touched`))).toBe(false);
    expect(out.join('')).toBe('');
  });

  it('a commit made inside a subagent carries the agent', async () => {
    const dir = makeProject();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'Add a');
    daemon = await startFakeDaemon(dir, { 'POST /api/events': () => ({ body: { ok: true } }) });
    await runHook('post-tool-use', { dir, input: { session_id: SID, agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'git commit -m "Add a"' } } });
    expect(daemon.requests.find((r) => r.path === '/api/events')?.headers['x-catalyst-agent']).toBe('a1');
  });
});
