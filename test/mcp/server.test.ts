import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalystClient } from '../../src/client/index.js';
import { TOOL_NAMES } from '../../src/core/api.js';
import { nullLogger } from '../../src/core/log.js';
import { projectPaths } from '../../src/core/paths.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { makeProject, startFakeDaemon, type FakeDaemon } from '../hooks/fake-daemon.js';

let daemon: FakeDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

async function connect(dir: string) {
  const paths = projectPaths(dir);
  const client = new CatalystClient(paths, { client: 'mcp', session: 'mcp:1:2', claudePid: 1 });
  const server = createMcpServer({ client, paths, logger: nullLogger });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(b);
  return mcp;
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');

describe('MCP adapter', () => {
  it('lists every tool with instructions', async () => {
    const mcp = await connect(makeProject());
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(40);
    expect(mcp.getInstructions()).toMatch(/get_briefing/);
  });

  it('proxies a call to the daemon and returns its text (bounded)', async () => {
    const dir = makeProject();
    daemon = await startFakeDaemon(dir, {
      'POST /api/tools/publish_decision': () => ({ body: { text: 'Decision recorded: api/auth', sync: {} } }),
      'POST /api/tools/get_briefing': () => ({ body: { text: 'x'.repeat(20000), sync: {} } }),
    });
    const mcp = await connect(dir);
    const input = { topic: 'api/auth', title: 'Auth format', decision: 'Use bearer JWT', rationale: 'Simple' };
    const r = await mcp.callTool({ name: 'publish_decision', arguments: input });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe('Decision recorded: api/auth');
    const req = daemon.requests.find((q) => q.path === '/api/tools/publish_decision');
    expect(req?.body).toEqual(input);
    expect(req?.headers['x-catalyst-session']).toBe('mcp:1:2');
    expect(req?.headers['x-catalyst-client']).toBe('mcp');

    const big = await mcp.callTool({ name: 'get_briefing', arguments: {} });
    expect(textOf(big).length).toBeLessThanOrEqual(9000);
  });

  it('rejects invalid input before reaching the daemon', async () => {
    const dir = makeProject();
    daemon = await startFakeDaemon(dir, {});
    const mcp = await connect(dir);
    const r = await mcp.callTool({ name: 'publish_decision', arguments: { topic: 'Bad Topic!', title: 't', decision: 'd', rationale: 'r' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/slug|topic/i);
    expect(daemon.requests).toHaveLength(0);
  });

  it('maps daemon API errors to isError with hint', async () => {
    const dir = makeProject();
    daemon = await startFakeDaemon(dir, {
      'POST /api/tools/send_message': () => ({ status: 400, body: { error: { code: 'bad_request', message: 'replyTo required', hint: 'Pass the question id' } } }),
    });
    const mcp = await connect(dir);
    const r = await mcp.callTool({ name: 'send_message', arguments: { kind: 'reply', body: 'yes' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('replyTo required');
    expect(textOf(r)).toContain('Pass the question id');
  });

  it('daemon down → error with snapshot excerpt and inbox draft instructions', async () => {
    const dir = makeProject({ snapshot: '# Catalyst snapshot\nGenerated at 2026-11-14T10:00:00Z\n\nDecision api/auth: bearer JWT\n' });
    const mcp = await connect(dir);
    const r = await mcp.callTool({ name: 'publish_progress', arguments: { status: 'in_progress', summary: 'Login form done' } });
    expect(r.isError).toBe(true);
    const t = textOf(r);
    expect(t).toContain('Generated at 2026-11-14T10:00:00Z');
    expect(t).toContain('Decision api/auth: bearer JWT');
    expect(t).toMatch(/\.catalyst\/inbox\/[0-9a-f-]{36}\.json/);
    expect(t).toContain('"catalystDraft": 1');
    expect(t).toContain('"tool": "publish_progress"');
    expect(t).toContain('Login form done');
  });
});
