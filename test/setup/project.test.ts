import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupClaude } from '../../src/setup/claude.js';
import { findGitRoot, initProject, joinProject } from '../../src/setup/project.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('setupClaude agent hooks', () => {
  it('installs PreToolUse (mcp__catalyst__.*), SubagentStart and SubagentStop with the same wrapper', () => {
    const dir = tmp('catalyst-setup-agents-');
    setupClaude(dir);
    const s = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(s.hooks.PreToolUse).toEqual([
      { matcher: 'mcp__catalyst__.*', hooks: [{ type: 'command', command: 'command -v catalyst >/dev/null 2>&1 && catalyst hook pre-tool-use || true', timeout: 5 }] },
    ]);
    expect(s.hooks.SubagentStart[0].hooks[0].command).toBe('command -v catalyst >/dev/null 2>&1 && catalyst hook subagent-start || true');
    expect(s.hooks.SubagentStop[0].hooks[0].command).toBe('command -v catalyst >/dev/null 2>&1 && catalyst hook subagent-stop || true');
    const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    for (const t of ['post_tasks', 'take_next_task', 'complete_task', 'wait_for_updates', 'publish_decision', 'send_message']) expect(md).toContain(t);
    expect(setupClaude(dir).changes).toEqual([]);
  });
});

describe('initProject / joinProject', () => {
  it('initialises a project without console output and refuses a second init', async () => {
    const dir = tmp('catalyst-init-');
    const r = await initProject({ dir, name: 'Tiam', projectName: 'notes', peerBind: '127.0.0.1', start: false });
    expect(r).toMatchObject({ projectDir: dir, name: 'Tiam', projectName: 'notes' });
    expect(r.projectId).toMatch(/^prj_/);
    expect(r.participantId).toMatch(/^p_/);
    expect(r.daemonPid).toBeUndefined();
    expect(r.setupChanges.some((c) => c.startsWith('.claude/settings.json'))).toBe(true);
    const config = JSON.parse(readFileSync(join(dir, '.catalyst', 'config.json'), 'utf8'));
    expect(config).toMatchObject({ projectName: 'notes', peerBind: '127.0.0.1', advertiseHosts: ['127.0.0.1'], createdByMe: true });
    await expect(initProject({ dir, start: false })).rejects.toThrow(/already set up/);
  });

  it('defaults peerBind to 0.0.0.0 and can skip Claude setup', async () => {
    const dir = tmp('catalyst-init-');
    const r = await initProject({ dir, name: 'X', setup: false, start: false });
    expect(JSON.parse(readFileSync(join(dir, '.catalyst', 'config.json'), 'utf8')).peerBind).toBe('0.0.0.0');
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    expect(r.setupChanges).toEqual(['.gitignore: added .catalyst/']);
  });

  it('rejects an invalid invite with a clear error', async () => {
    await expect(joinProject({ dir: tmp('catalyst-join-'), invite: 'cat1_nope', start: false })).rejects.toThrow(/Invalid invitation/);
  });

  it('findGitRoot walks up to the directory containing .git', () => {
    const dir = tmp('catalyst-git-');
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    expect(findGitRoot(join(dir, 'a', 'b'))).toBe(dir);
    expect(findGitRoot('/')).toBeNull();
  });
});
