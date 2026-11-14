/**
 * Single-instance lock + daemon.json lifecycle.
 * Lock: .catalyst/daemon.lock created with O_EXCL ('wx') containing our pid.
 * daemon.json (0600) is written only after both listeners are up, and removed on exit.
 */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

function readLockPid(path: string): number {
  try {
    return Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  } catch {
    return NaN;
  }
}

/** Atomic create-with-content: write a temp file, then hard-link it into place (fails if the lock exists). */
function tryCreateLock(paths: ProjectPaths): boolean {
  const tmp = `${paths.lock}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, paths.lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Whether `pid` looks like a Catalyst daemon (guards against pid reuse after a crash). Unknown → assume yes. */
function looksLikeDaemon(pid: number): boolean {
  if (pid === process.pid) return true; // in-process daemon (tests / embedding)
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
    return /catalyst|cli[\\/]index\.js/.test(cmd) && /\bdaemon\b/.test(cmd);
  } catch {
    return pidAlive(pid); // cannot inspect: be conservative and never steal a live process's lock
  }
}

/**
 * Reclaim a stale lock without racing other reclaimers: atomically rename it aside, then verify the moved file
 * still names the stale pid we observed. If not, a live starter's lock was moved — put it back and give up.
 */
function reclaimStaleLock(paths: ProjectPaths, stalePid: number): void {
  const aside = `${paths.lock}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    renameSync(paths.lock, aside);
  } catch {
    return; // already gone/reclaimed by someone else
  }
  const moved = readLockPid(aside);
  if (moved !== stalePid && !(Number.isNaN(moved) && Number.isNaN(stalePid))) {
    try {
      linkSync(aside, paths.lock);
    } catch {
      /* someone created a new lock meanwhile; theirs wins */
    }
  }
  rmSync(aside, { force: true });
}

/**
 * Take the lock or throw.
 * - Lock owner alive and a Catalyst daemon: never reclaimed. Wait up to `waitMs` for it to become healthy →
 *   DaemonAlreadyRunningError; if it never does, throw an actionable error (do not steal a slow daemon's lock).
 * - Owner dead, or the pid was reused by an unrelated process: stale → reclaimed (race-safe) and retried.
 */
export async function acquireLock(paths: ProjectPaths, waitMs = 3000): Promise<void> {
  ensureDir(paths.dataDir);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreateLock(paths)) return;
    const pid = readLockPid(paths.lock);
    if (pidAlive(pid) && looksLikeDaemon(pid)) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const live = await probeDaemon(paths, 500);
        if (live) throw new DaemonAlreadyRunningError(live.info.pid, live.info.apiPort);
        if (!pidAlive(pid)) break; // it died while we waited: stale now
        if (Date.now() >= deadline) {
          throw new Error(
            `Catalyst daemon pid ${pid} holds ${paths.lock} but is not answering health checks. ` +
              `Check ${paths.daemonLog}; if it is stuck, stop it (\`kill ${pid}\`) and run \`catalyst start\` again.`,
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    reclaimStaleLock(paths, pid);
  }
  throw new Error(`Could not acquire ${paths.lock}; another Catalyst daemon may be starting. Retry \`catalyst start\`.`);
}

/** Remove the lock only if it is ours. */
export function releaseLock(paths: ProjectPaths): void {
  if (readLockPid(paths.lock) === process.pid) rmSync(paths.lock, { force: true });
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
