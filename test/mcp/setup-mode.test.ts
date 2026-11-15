import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TOOL_NAMES } from '../../src/core/api.js';
import { NO_PROJECT_TEXT, createAdapter } from '../../src/mcp/server.js';
import { startFakeDaemon, type FakeDaemon } from '../hooks/fake-daemon.js';

let daemon: FakeDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');

async function connect(setupDir: string) {
  const server = createAdapter({ projectDir: null, setupDir, setupOptions: { start: false, peerBind: '127.0.0.1' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(b);
  return mcp;
}

describe('MCP adapter without a project', () => {
  it('exposes every tool; only start_project/join_project work until a project exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalyst-nosetup-'));
    const mcp = await connect(dir);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const status = await mcp.callTool({ name: 'catalyst_status', arguments: {} });
    expect(status.isError).toBe(true);
    expect(textOf(status)).toBe(NO_PROJECT_TEXT);
    const badJoin = await mcp.callTool({ name: 'join_project', arguments: { invite: 'cat1_' + 'x'.repeat(30) } });
    expect(badJoin.isError).toBe(true);
    expect(textOf(badJoin)).toMatch(/join failed: Invalid invitation/);
  });

  it('start_project creates the project and switches to project mode in-process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalyst-nosetup-'));
    const mcp = await connect(dir);
    const r = await mcp.callTool({ name: 'start_project', arguments: { yourName: 'Tiam', projectName: 'notes' } });
    expect(r.isError).toBeFalsy();
    const t = textOf(r);
    expect(t).toContain('Catalyst project "notes" is ready');
    expect(t).toMatch(/Restart Claude Code once/);
    expect(existsSync(join(dir, '.catalyst', 'config.json'))).toBe(true);

    // Now in project mode: setup tools say "already set up", other tools go to the daemon.
    const again = await mcp.callTool({ name: 'start_project', arguments: {} });
    expect(again.isError).toBeFalsy();
    expect(textOf(again)).toMatch(/already set up/);
    daemon = await startFakeDaemon(dir, { 'POST /api/tools/catalyst_status': () => ({ body: { text: 'STATUS OK', sync: {} } }) });
    const status = await mcp.callTool({ name: 'catalyst_status', arguments: {} });
    expect(textOf(status)).toBe('STATUS OK');
  });
});
