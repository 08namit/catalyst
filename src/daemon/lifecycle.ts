/**
 * Single-instance lock + daemon.json lifecycle.
 * Lock: .catalyst/daemon.lock created with O_EXCL ('wx') containing our pid.
 * daemon.json (0600) is written only after both listeners are up, and removed on exit.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ensureDir, writeJson, type DaemonInfo } from '../core/config.js';
import type { ProjectPaths } from '../core/paths.js';
import { probeDaemon } from '../client/index.js';

export class DaemonAlreadyRunningError extends Error {
  constructor(
    public pid: number,
    public apiPort?: number,
  ) {
    super(`Catalyst daemon already running (pid ${pid}${apiPort ? `, api port ${apiPort}` : ''}).`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockPid(paths: ProjectPaths): number {
  try {
    return Number.parseInt(readFileSync(paths.lock, 'utf8').trim(), 10);
  } catch {
    return NaN;
  }
}

function tryCreateLock(paths: ProjectPaths): boolean {
  try {
    writeFileSync(paths.lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Take the lock or throw DaemonAlreadyRunningError.
 * An existing lock whose pid is alive is given `waitMs` to become healthy (it may still be starting up);
 * a lock whose pid is dead, or alive but never healthy, is stale: removed and retried once.
 */
export async function acquireLock(paths: ProjectPaths, waitMs = 3000): Promise<void> {
  ensureDir(paths.dataDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreateLock(paths)) return;
    const pid = readLockPid(paths);
    if (pidAlive(pid)) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const live = await probeDaemon(paths, 500);
        if (live) throw new DaemonAlreadyRunningError(live.info.pid, live.info.apiPort);
        if (Date.now() >= deadline || !pidAlive(pid)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    rmSync(paths.lock, { force: true });
  }
  throw new Error(`Could not acquire ${paths.lock}; another Catalyst daemon may be starting. Retry \`catalyst start\`.`);
}

/** Remove the lock only if it is ours. */
export function releaseLock(paths: ProjectPaths): void {
  if (readLockPid(paths) === process.pid) rmSync(paths.lock, { force: true });
}

export function newDaemonSecrets(): { token: string; nonce: string } {
  return { token: randomBytes(32).toString('hex'), nonce: randomBytes(16).toString('hex') };
}

export function writeDaemonInfo(paths: ProjectPaths, info: DaemonInfo): void {
  writeJson(paths.daemonInfo, info, true);
}

/** Remove daemon.json only if it describes this daemon (nonce match). */
export function removeDaemonInfo(paths: ProjectPaths, nonce: string): void {
  try {
    const cur = JSON.parse(readFileSync(paths.daemonInfo, 'utf8')) as DaemonInfo;
    if (cur.nonce !== nonce) return;
  } catch {
    return;
  }
  rmSync(paths.daemonInfo, { force: true });
}
