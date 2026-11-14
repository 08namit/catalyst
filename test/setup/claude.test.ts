import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureGitignore, setupClaude, uninstallClaude } from '../../src/setup/claude.js';

const ORIG_MCP = JSON.stringify({ mcpServers: { other: { command: 'other-server', args: ['--x'] } }, extra: true }, null, 2) + '\n';
const ORIG_SETTINGS =
  JSON.stringify(
    {
      model: 'opus',
      permissions: { allow: ['Bash(npm test)'], deny: ['Read(.env)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'npx prettier --write', timeout: 10 }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
      },
      env: { FOO: '1' },
    },
    null,
    2,
  ) + '\n';
const ORIG_MD = '# My project\n\nUse pnpm. Never touch legacy/.\n';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'catalyst-setup-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.mcp.json'), ORIG_MCP);
  writeFileSync(join(dir, '.claude', 'settings.json'), ORIG_SETTINGS);
  writeFileSync(join(dir, 'CLAUDE.md'), ORIG_MD);
  return dir;
}
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const files = ['.mcp.json', '.claude/settings.json', 'CLAUDE.md'];
const snapshot = (dir: string) => files.map((f) => read(dir, f));

describe('setupClaude', () => {
  it('adds Catalyst config while preserving existing configuration', () => {
    const dir = project();
    const { changes } = setupClaude(dir);
    expect(changes).toHaveLength(3);

    const mcp = JSON.parse(read(dir, '.mcp.json'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['other', 'catalyst']);
    expect(mcp.mcpServers.other).toEqual({ command: 'other-server', args: ['--x'] });
    expect(mcp.mcpServers.catalyst).toEqual({ command: 'catalyst', args: ['mcp'] });
    expect(mcp.extra).toBe(true);

    const s = JSON.parse(read(dir, '.claude/settings.json'));
    expect(s.model).toBe('opus');
    expect(s.env).toEqual({ FOO: '1' });
    expect(s.permissions.allow).toEqual(['Bash(npm test)', 'mcp__catalyst']);
    expect(s.permissions.deny).toEqual(['Read(.env)']);
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'echo done' }] }]);
    expect(s.hooks.PostToolUse[0]).toEqual({ matcher: 'Write', hooks: [{ type: 'command', command: 'npx prettier --write', timeout: 10 }] });
    expect(s.hooks.PostToolUse[1]).toEqual({
      matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit',
      hooks: [{ type: 'command', command: 'command -v catalyst >/dev/null 2>&1 && catalyst hook post-tool-use || true', timeout: 5 }],
    });
    expect(s.hooks.SessionStart).toEqual([
      { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'command -v catalyst >/dev/null 2>&1 && catalyst hook session-start || true', timeout: 15 }] },
    ]);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain('catalyst hook user-prompt-submit');
    expect(s.hooks.SessionEnd[0].hooks[0]).toMatchObject({ command: expect.stringContaining('catalyst hook session-end'), timeout: 5 });
    expect(s.hooks.UserPromptSubmit[0].matcher).toBeUndefined();

    const md = read(dir, 'CLAUDE.md');
    expect(md.startsWith(ORIG_MD)).toBe(true);
    expect(md).toContain('<!-- catalyst:begin -->');
    expect(md).toContain('IMPORTANT.md');
    expect(md).toContain('<!-- catalyst:end -->');

    // one-time backups of the pre-existing files
    for (const f of files) expect(readFileSync(join(dir, `${f}.catalyst-backup`), 'utf8')).toBe([ORIG_MCP, ORIG_SETTINGS, ORIG_MD][files.indexOf(f)]);
  });

  it('is idempotent', () => {
    const dir = project();
    setupClaude(dir);
    const first = snapshot(dir);
    expect(setupClaude(dir).changes).toEqual([]);
    expect(snapshot(dir)).toEqual(first);
  });

  it('replaces (not duplicates) entries when the command changes', () => {
    const dir = project();
    setupClaude(dir);
    setupClaude(dir, { command: '/opt/bin/catalyst' });
    const s = JSON.parse(read(dir, '.claude/settings.json'));
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('command -v /opt/bin/catalyst >/dev/null 2>&1 && /opt/bin/catalyst hook session-start || true');
    expect(JSON.parse(read(dir, '.mcp.json')).mcpServers.catalyst).toEqual({ command: '/opt/bin/catalyst', args: ['mcp'] });
    expect(read(dir, 'CLAUDE.md').match(/catalyst:begin/g)).toHaveLength(1);
    // backups still hold the ORIGINAL content
    expect(read(dir, '.mcp.json.catalyst-backup')).toBe(ORIG_MCP);
  });

  it('creates missing files in an empty project and uninstall removes them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalyst-setup-empty-'));
    setupClaude(dir);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
    expect(read(dir, 'CLAUDE.md').startsWith('<!-- catalyst:begin -->')).toBe(true);
    expect(existsSync(join(dir, '.mcp.json.catalyst-backup'))).toBe(false);
    uninstallClaude(dir);
    for (const f of files) expect(existsSync(join(dir, f))).toBe(false);
  });

  it('throws on invalid JSON and changes nothing', () => {
    const dir = project();
    writeFileSync(join(dir, '.claude', 'settings.json'), '{ "hooks": ');
    expect(() => setupClaude(dir)).toThrow(/settings\.json is not valid JSON/);
    expect(read(dir, '.mcp.json')).toBe(ORIG_MCP);
    expect(read(dir, 'CLAUDE.md')).toBe(ORIG_MD);
    expect(read(dir, '.claude/settings.json')).toBe('{ "hooks": ');
    expect(existsSync(join(dir, '.mcp.json.catalyst-backup'))).toBe(false);
  });
});

describe('uninstallClaude', () => {
  it('removes only Catalyst parts, restoring the original files exactly', () => {
    const dir = project();
    setupClaude(dir);
    const { changes } = uninstallClaude(dir);
    expect(changes.join('\n')).toMatch(/\.catalyst/);
    expect(read(dir, '.mcp.json')).toBe(ORIG_MCP);
    expect(read(dir, '.claude/settings.json')).toBe(ORIG_SETTINGS);
    expect(read(dir, 'CLAUDE.md')).toBe(ORIG_MD);
  });

  it('is a no-op when Catalyst is not installed', () => {
    const dir = project();
    uninstallClaude(dir);
    expect(snapshot(dir)).toEqual([ORIG_MCP, ORIG_SETTINGS, ORIG_MD]);
  });
});

describe('ensureGitignore', () => {
  it('adds entries once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalyst-gi-'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/');
    expect(ensureGitignore(dir)).toBe(true);
    const after = read(dir, '.gitignore');
    expect(after.startsWith('node_modules/\n')).toBe(true);
    expect(after.split('\n')).toContain('.catalyst/');
    expect(after.split('\n')).toContain('.claude/settings.local.json');
    expect(ensureGitignore(dir)).toBe(false);
    expect(read(dir, '.gitignore')).toBe(after);
  });

  it('creates .gitignore when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalyst-gi-'));
    expect(ensureGitignore(dir)).toBe(true);
    expect(read(dir, '.gitignore')).toContain('.catalyst/\n');
  });
});

describe('examples', () => {
  it('match what setupClaude generates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalyst-ex-'));
    setupClaude(dir);
    const ex = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../examples', f), 'utf8'));
    expect(JSON.parse(read(dir, '.claude/settings.json'))).toEqual(ex('claude-settings.example.json'));
    expect(JSON.parse(read(dir, '.mcp.json'))).toEqual(ex('mcp.json.example'));
  });
});
