/**
 * `catalyst install` / `catalyst uninstall`: one-time, per-person setup. Registers the Catalyst MCP server with
 * Claude Code at user scope so every project can say "set up Catalyst". The process runner and PATH lookup are
 * injectable so tests never touch the real Claude config.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface RunResult {
  /** Exit code; null when the process could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started (e.g. ENOENT). */
  error?: Error;
}

export interface InstallDeps {
  run: (cmd: string, args: string[]) => RunResult;
  /** Absolute path of `cmd` on PATH, or null. */
  which: (cmd: string) => string | null;
  nodeVersion: string;
}

export interface InstallOutcome {
  lines: string[];
  ok: boolean;
}

export const INSTALL_PACKAGE = 'github:08namit/catalyst';
export const ADD_ARGS = ['mcp', 'add', '--scope', 'user', 'catalyst', '--', 'catalyst', 'mcp'];
export const REMOVE_ARGS = ['mcp', 'remove', '--scope', 'user', 'catalyst'];
export const DONE_LINE = 'Done. Open Claude Code in your project and say: "set up Catalyst and invite my teammate" (or "join Catalyst with <invite>").';

export function nodeVersionOk(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

/** `claude mcp get catalyst` succeeded and (when it reports a scope) the scope is the user scope. */
function registeredAtUserScope(r: RunResult): boolean {
  if (r.code !== 0) return false;
  const scope = /scope:\s*(.+)/i.exec(r.stdout)?.[1];
  return scope === undefined || /user/i.test(scope);
}

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? '';

export function install(deps: InstallDeps): InstallOutcome {
  const lines: string[] = [];
  if (!nodeVersionOk(deps.nodeVersion)) {
    return { ok: false, lines: [`Node ${deps.nodeVersion} is too old: Catalyst needs Node 22.13 or newer. Install it from https://nodejs.org and run \`catalyst install\` again.`] };
  }
  if (!deps.which('catalyst')) {
    return {
      ok: false,
      lines: [
        'The `catalyst` command is not on your PATH, so Claude Code could not start it.',
        `Install it with: npm install -g ${INSTALL_PACKAGE}`,
        'Then open a new terminal and run `catalyst install` again.',
      ],
    };
  }
  lines.push(`Node ${deps.nodeVersion.replace(/^v/, '')} and the \`catalyst\` command: OK.`);
  const manual = `claude ${ADD_ARGS.join(' ')}`;
  if (!deps.which('claude')) {
    lines.push('Claude Code (the `claude` command) was not found.');
    lines.push(`After installing Claude Code, run: ${manual}`);
    lines.push(DONE_LINE);
    return { ok: true, lines };
  }
  if (registeredAtUserScope(deps.run('claude', ['mcp', 'get', 'catalyst']))) {
    lines.push('Claude Code: Catalyst is already registered for all your projects.');
  } else {
    const r = deps.run('claude', ADD_ARGS);
    if (r.code !== 0) {
      lines.push(`Claude Code: could not register Catalyst (${firstLine(r.stderr || r.stdout || r.error?.message || 'unknown error')}).`);
      lines.push(`Run this yourself: ${manual}`);
      return { ok: false, lines };
    }
    lines.push('Claude Code: registered Catalyst for all your projects.');
  }
  lines.push(DONE_LINE);
  return { ok: true, lines };
}

export function uninstall(deps: InstallDeps): InstallOutcome {
  const manual = `claude ${REMOVE_ARGS.join(' ')}`;
  if (!deps.which('claude')) {
    return { ok: true, lines: ['Claude Code (the `claude` command) was not found.', `If Catalyst is registered there, remove it with: ${manual}`] };
  }
  const lines: string[] = [];
  const r = deps.run('claude', REMOVE_ARGS);
  if (r.code === 0) lines.push('Claude Code: removed the Catalyst server.');
  else if (/not found|no .*server/i.test(`${r.stderr}\n${r.stdout}`)) lines.push('Claude Code: Catalyst was not registered.');
  else {
    lines.push(`Claude Code: could not remove Catalyst (${firstLine(r.stderr || r.stdout || r.error?.message || 'unknown error')}).`);
    lines.push(`Run this yourself: ${manual}`);
    return { ok: false, lines };
  }
  lines.push('Project data in each project\'s .catalyst/ folder was kept. To remove the files Catalyst added to a project: catalyst uninstall claude');
  lines.push('To remove the command itself: npm uninstall -g catalyst-coord');
  return { ok: true, lines };
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------
export function whichOnPath(cmd: string, pathEnv: string = process.env.PATH ?? ''): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, cmd + ext);
      try {
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

export function realDeps(): InstallDeps {
  return {
    nodeVersion: process.versions.node,
    which: (cmd) => whichOnPath(cmd),
    // Run from the home directory so a project's .mcp.json is not mistaken for the user-scope registration.
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { cwd: homedir(), encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' });
      return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) };
    },
  };
}
