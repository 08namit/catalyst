/**
 * Claude Code integration e2e: `catalyst init` with setup (scenario 1, setup part), the stdio MCP adapter driven
 * by the real MCP SDK client (scenario 11) and the hook entry points (scenario 12), all against real daemons.
 *
 * Run without npm:   node_modules/.bin/vitest run test/e2e/claude-integration.test.ts   (needs dist/cli/index.js).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublishResult } from '../../src/core/api.js';
import { assertBuilt, childEnv, cleanupNodes, cli, CLI, cliOk, client, daemonProcesses, initNode, joinNode, state, status, tempDir, waitFor } from './helpers.js';

const GOAL = 'Integrate Catalyst with Claude Code';
const TOOLS = ['get_briefing', 'claim_task', 'publish_decision', 'publish_progress', 'send_message', 'get_updates', 'acknowledge_updates', 'resolve_conflict'];

describe('Claude Code integration e2e', { concurrent: false }, () => {
  let A = '';
  let B = '';

  beforeAll(async () => {
    assertBuilt();
    A = await initNode('cc-A', 'Alice', []); // full setup
    B = (await joinNode(A, 'cc-B', 'Bob')).dir;
    await client(A, 'e2e:a').tool<PublishResult>('set_goal', { title: GOAL });
  });
  afterAll(async () => {
    await cleanupNodes();
  }, 60_000);

  it('1b. init with setup writes .mcp.json, .claude/settings.json, CLAUDE.md and .gitignore', () => {
    const mcp = JSON.parse(readFileSync(join(A, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers.catalyst).toMatchObject({ command: 'catalyst', args: ['mcp'] });
    const settings = readFileSync(join(A, '.claude', 'settings.json'), 'utf8');
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd']) expect(settings).toContain(ev);
    expect(settings).toContain('catalyst hook session-start');
    expect(readFileSync(join(A, 'CLAUDE.md'), 'utf8')).toContain('<!-- catalyst:begin -->');
    expect(readFileSync(join(A, '.gitignore'), 'utf8').split('\n')).toContain('.catalyst/');
    // --no-setup on B: no Claude files, but .catalyst/ is still gitignored.
    expect(existsSync(join(B, '.mcp.json'))).toBe(false);
    expect(readFileSync(join(B, '.gitignore'), 'utf8')).toContain('.catalyst/');
  });

  it('11. MCP stdio: the SDK client lists all tools and gets a briefing; stdout carries only JSON-RPC', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: A, env: childEnv(), stderr: 'pipe' });
    const errors: unknown[] = [];
    const mcp = new Client({ name: 'catalyst-e2e', version: '0.0.0' });
    mcp.onerror = (e) => errors.push(e);
    await mcp.connect(transport);
    try {
      const { tools } = await mcp.listTools();
      const names = tools.map((t) => t.name);
      for (const t of TOOLS) expect(names).toContain(t);
      const r = await mcp.callTool({ name: 'get_briefing', arguments: {} });
      expect(r.isError).toBeFalsy();
      const text = (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
      expect(text).toContain(GOAL);
      expect(text).toContain('Bob');
      const bad = await mcp.callTool({ name: 'publish_progress', arguments: { status: 'nope', summary: 'x' } }).catch((e: Error) => ({ isError: true, thrown: e.message }));
      expect(bad.isError).toBe(true);
    } finally {
      await mcp.close();
    }
    expect(errors).toEqual([]);
  });

  it('11b. MCP stdio raw: every stdout line is a JSON-RPC message', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: A, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    await waitFor('initialize response', () => stdout.includes('"id":1'), 10_000, 50);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_updates', arguments: {} } });
    await waitFor('tools/call response', () => stdout.includes('"id":2'), 10_000, 50);
    child.stdin.end();
    await new Promise((r) => child.once('exit', r));
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect((JSON.parse(l) as { jsonrpc: string }).jsonrpc).toBe('2.0');
  });

  it('12. hooks: session-start emits JSON additionalContext with the goal; user-prompt-submit notifies only on new peer updates; exit 0', async () => {
    const hook = (event: string, input: Record<string, unknown>, cwd = A) => cli(['hook', event], { cwd, input: JSON.stringify(input) });
    const base = { session_id: 'e2e-session-1', cwd: A };

    const ss = await hook('session-start', { ...base, hook_event_name: 'SessionStart', source: 'startup' });
    expect(ss.code).toBe(0);
    const parsed = JSON.parse(ss.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain(GOAL);

    const ups = async (prompt: string) => {
      const t0 = Date.now();
      const r = await hook('user-prompt-submit', { ...base, hook_event_name: 'UserPromptSubmit', prompt });
      // Spec budget is ≤300 ms in-process; allow generous headroom for node startup on a loaded CI machine.
      expect(Date.now() - t0).toBeLessThan(2000);
      return r;
    };
    await ups('drain anything already pending'); // may or may not print (B's join event); establishes the marker
    const quiet = await ups('nothing new');
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe('');

    const p = await client(B, 'e2e:b').tool<PublishResult>('publish_progress', { status: 'in_progress', summary: 'Bob: hooking up the login form' });
    await waitFor('A received B progress', async () => (await state(A)).recent.some((r) => r.id === p.event.id));
    const loud = await ups('anything new?');
    expect(loud.code).toBe(0);
    const lines = loud.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Catalyst: 1 new peer update/);
    expect(lines[0]).toContain('progress report');

    const again = await ups('and now?');
    expect(again.code).toBe(0);
    expect(again.stdout).toBe('');

    // Outside any Catalyst project: silent, exit 0.
    const elsewhere = tempDir('cc-none');
    const none = await hook('session-start', { session_id: 'x', cwd: elsewhere, hook_event_name: 'SessionStart', source: 'startup' }, elsewhere);
    expect(none.code).toBe(0);
    expect(none.stdout).toBe('');
    // Garbage stdin: still exit 0.
    const junk = await cli(['hook', 'user-prompt-submit'], { cwd: A, input: 'not json' });
    expect(junk.code).toBe(0);
  });

  it('13. daemon down: the SessionStart hook and the MCP adapter autostart it (hook returns promptly, exit 0)', async () => {
    await cliOk(['stop', '--dir', A]);
    expect((await status(A)).running).toBe(false);
    const t0 = Date.now();
    const ss = await cli(['hook', 'session-start'], { cwd: A, input: JSON.stringify({ session_id: 'e2e-session-2', cwd: A, hook_event_name: 'SessionStart', source: 'resume' }) });
    expect(ss.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(8000); // detached spawn: the hook must not wait for the daemon to exit
    const ctx = (JSON.parse(ss.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(GOAL);
    expect((await status(A)).running).toBe(true);

    await cliOk(['stop', '--dir', A]);
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: A, env: childEnv(), stderr: 'pipe' });
    const mcp = new Client({ name: 'catalyst-e2e', version: '0.0.0' });
    await mcp.connect(transport);
    try {
      const r = await mcp.callTool({ name: 'get_briefing', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect((r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')).toContain(GOAL);
    } finally {
      await mcp.close();
    }
    expect((await status(A)).running).toBe(true);
    expect(await daemonProcesses(A)).toHaveLength(1);
  });
});
