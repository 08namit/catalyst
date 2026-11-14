/**
 * Shared helpers for the end-to-end tests: they drive the REAL built CLI (`node dist/cli/index.js`) as child
 * processes against throwaway project directories under os.tmpdir(), one directory (= one participant, one
 * daemon, one database, one identity) per node. Every daemon started here is stopped by `cleanupNodes()`.
 *
 * Requires a build: `npm run build` (the tests fail fast with a clear message otherwise).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalystClient } from '../../src/client/index.js';
import type { DashboardState, StatusResponse } from '../../src/core/api.js';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const CLI = join(ROOT, 'dist', 'cli', 'index.js');

export function assertBuilt(): void {
  if (!existsSync(CLI)) throw new Error(`${CLI} not found — run \`npm run build\` before the e2e tests.`);
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI. Never throws on a non-zero exit; inspect `code`. */
/**
 * Environment for child processes: drop variables that would point Catalyst at a real project (e.g. when the
 * tests themselves run inside a Claude Code session, CLAUDE_PROJECT_DIR is set).
 */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'CLAUDE_PROJECT_DIR' && k !== 'CATALYST_PROJECT_DIR' && k !== 'CATALYST_DEBUG') env[k] = v;
  return { ...env, ...extra };
}

export function cli(args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<CliResult> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: opts.cwd ?? tmpdir(), timeout: opts.timeoutMs ?? 20_000, env: childEnv(opts.env), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Run the CLI and fail with its output if it exits non-zero. */
export async function cliOk(args: string[], opts: Parameters<typeof cli>[1] = {}): Promise<string> {
  const r = await cli(args, opts);
  if (r.code !== 0) throw new Error(`catalyst ${args.join(' ')} exited ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r.stdout;
}

const createdDirs: string[] = [];

export function tempDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `catalyst-e2e-${label}-`));
  createdDirs.push(d);
  return d;
}

/** Initialise a node (first developer) with a loopback peer listener and start its daemon. */
export async function initNode(label: string, name: string, extra: string[] = ['--no-setup']): Promise<string> {
  const dir = tempDir(label);
  await cliOk(['init', '--dir', dir, '--name', name, '--peer-bind', '127.0.0.1', '--project-name', `e2e-${label}`, ...extra]);
  return dir;
}

export function extractToken(pairOutput: string): string {
  const m = /cat1_[A-Za-z0-9_-]+/.exec(pairOutput);
  if (!m) throw new Error(`no invitation token in:\n${pairOutput}`);
  return m[0];
}

export async function pair(dir: string): Promise<string> {
  return extractToken(await cliOk(['pair', '--dir', dir]));
}

/** Join a fresh node B to A's project via a new invitation. Returns B's dir and the join output. */
export async function joinNode(aDir: string, label: string, name: string, extra: string[] = ['--no-setup']): Promise<{ dir: string; token: string; output: string }> {
  const token = await pair(aDir);
  const dir = tempDir(label);
  const output = await cliOk(['join', token, '--dir', dir, '--name', name, '--peer-bind', '127.0.0.1', ...extra]);
  return { dir, token, output };
}

export function client(dir: string, session = 'e2e:test'): CatalystClient {
  return CatalystClient.forProject(dir, { client: 'mcp', session, timeoutMs: 10_000 });
}

export async function status(dir: string): Promise<StatusResponse & { running: boolean; conflicts: DashboardState['state']['conflicts'] }> {
  return JSON.parse(await cliOk(['status', '--json', '--dir', dir])) as StatusResponse & { running: boolean; conflicts: DashboardState['state']['conflicts'] };
}

export async function state(dir: string): Promise<DashboardState> {
  return client(dir, 'e2e:observer').get<DashboardState>('/api/state');
}

/** Poll `fn` until it returns a truthy value (returned) or the timeout elapses (throws with the last value/error). */
export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
      last = v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}. Last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function daemonPid(dir: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, '.catalyst', 'daemon.json'), 'utf8')) as { pid?: number }).pid;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Process ids of `catalyst daemon` processes whose --dir is `dir` (detects duplicate daemons). */
export async function daemonProcesses(dir: string): Promise<number[]> {
  const out = await new Promise<string>((done) => execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 10 * 1024 * 1024 }, (_e, so) => done(String(so))));
  // A daemon autostarted from a process whose cwd is the project gets the realpath (/private/var/… on macOS).
  const names = new Set([dir, existsSync(dir) ? realpathSync(dir) : dir]);
  return out
    .split('\n')
    .filter((l) => [...names].some((d) => l.includes(`${CLI} daemon --dir ${d}`) && l.trimEnd().endsWith(d)))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

/** Stop every daemon started for the temp dirs, kill leftovers, delete the dirs. */
export async function cleanupNodes(): Promise<void> {
  const dirs = createdDirs.splice(0);
  await Promise.all(dirs.map((d) => (existsSync(join(d, '.catalyst', 'config.json')) ? cli(['stop', '--dir', d], { timeoutMs: 15_000 }) : Promise.resolve())));
  for (const d of dirs) {
    // Only processes verified (via ps) to be a Catalyst daemon for this dir; the pid in daemon.json alone could
    // have been reused by an unrelated process after the daemon exited.
    for (const pid of await daemonProcesses(d)) {
      if (pidAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
    rmSync(d, { recursive: true, force: true });
  }
}
