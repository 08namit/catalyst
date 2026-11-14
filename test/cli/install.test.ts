import { describe, expect, it } from 'vitest';
import { ADD_ARGS, DONE_LINE, REMOVE_ARGS, install, nodeVersionOk, uninstall, type InstallDeps, type RunResult } from '../../src/cli/install.js';

/** Fake runner: records calls, answers from a table keyed by "cmd arg arg…". */
function fakeDeps(opts: { onPath?: string[]; node?: string; answers?: Record<string, RunResult> } = {}) {
  const calls: string[] = [];
  const onPath = new Set(opts.onPath ?? ['catalyst', 'claude']);
  const deps: InstallDeps = {
    nodeVersion: opts.node ?? '24.1.0',
    which: (cmd) => (onPath.has(cmd) ? `/usr/local/bin/${cmd}` : null),
    run: (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      return opts.answers?.[key] ?? { code: 1, stdout: '', stderr: `No MCP server found with name: catalyst` };
    },
  };
  return { deps, calls };
}
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

describe('catalyst install', () => {
  it('skips registration when Catalyst is already registered at user scope', () => {
    const { deps, calls } = fakeDeps({ answers: { 'claude mcp get catalyst': ok('catalyst:\n  Scope: User config (available in all your projects)\n  Command: catalyst\n') } });
    const r = install(deps);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['claude mcp get catalyst']);
    expect(r.lines).toContain('Claude Code: Catalyst is already registered for all your projects.');
    expect(r.lines.at(-1)).toBe(DONE_LINE);
    expect(r.lines.length).toBeLessThanOrEqual(6);
  });

  it('registers at user scope when missing', () => {
    const { deps, calls } = fakeDeps({ answers: { [`claude ${ADD_ARGS.join(' ')}`]: ok('Added stdio MCP server catalyst') } });
    const r = install(deps);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['claude mcp get catalyst', 'claude mcp add --scope user catalyst -- catalyst mcp']);
    expect(r.lines).toContain('Claude Code: registered Catalyst for all your projects.');
    expect(r.lines.at(-1)).toBe(DONE_LINE);
    expect(r.lines.length).toBeLessThanOrEqual(6);
  });

  it('registers at user scope when only a project-scope entry exists', () => {
    const { deps, calls } = fakeDeps({
      answers: {
        'claude mcp get catalyst': ok('catalyst:\n  Scope: Project config (shared via .mcp.json)\n'),
        [`claude ${ADD_ARGS.join(' ')}`]: ok(),
      },
    });
    expect(install(deps).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('prints the exact command when claude is not installed', () => {
    const { deps, calls } = fakeDeps({ onPath: ['catalyst'] });
    const r = install(deps);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(r.lines.join('\n')).toContain('claude mcp add --scope user catalyst -- catalyst mcp');
    expect(r.lines.at(-1)).toBe(DONE_LINE);
    expect(r.lines.length).toBeLessThanOrEqual(6);
  });

  it('reports a failed registration with the manual command', () => {
    const { deps } = fakeDeps({ answers: { [`claude ${ADD_ARGS.join(' ')}`]: { code: 1, stdout: '', stderr: 'permission denied\nmore' } } });
    const r = install(deps);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('permission denied');
    expect(r.lines.join('\n')).toContain('claude mcp add --scope user catalyst -- catalyst mcp');
  });

  it('refuses old Node and a missing catalyst command without calling claude', () => {
    const old = fakeDeps({ node: '22.12.0' });
    expect(install(old.deps).ok).toBe(false);
    expect(old.calls).toEqual([]);
    const noCli = fakeDeps({ onPath: ['claude'] });
    const r = install(noCli.deps);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('npm install -g github:08namit/catalyst');
    expect(noCli.calls).toEqual([]);
  });

  it('checks the Node version boundary', () => {
    expect(nodeVersionOk('22.13.0')).toBe(true);
    expect(nodeVersionOk('v26.1.0')).toBe(true);
    expect(nodeVersionOk('22.12.9')).toBe(false);
    expect(nodeVersionOk('20.19.0')).toBe(false);
  });
});

describe('catalyst uninstall', () => {
  it('removes the user-scope registration', () => {
    const { deps, calls } = fakeDeps({ answers: { [`claude ${REMOVE_ARGS.join(' ')}`]: ok('Removed') } });
    const r = uninstall(deps);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['claude mcp remove --scope user catalyst']);
    expect(r.lines[0]).toBe('Claude Code: removed the Catalyst server.');
  });

  it('is fine when nothing was registered', () => {
    const { deps } = fakeDeps();
    const r = uninstall(deps);
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toBe('Claude Code: Catalyst was not registered.');
  });

  it('prints the command when claude is missing', () => {
    const { deps, calls } = fakeDeps({ onPath: ['catalyst'] });
    const r = uninstall(deps);
    expect(calls).toEqual([]);
    expect(r.lines.join('\n')).toContain('claude mcp remove --scope user catalyst');
  });
});
