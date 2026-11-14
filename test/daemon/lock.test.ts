// Regressions from the adversarial review: a live (slow/unhealthy) daemon's lock must never be stolen;
// dead-pid and reused-pid locks are reclaimed.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDir } from '../../src/core/config.js';
import { projectPaths } from '../../src/core/paths.js';
import { acquireLock, releaseLock } from '../../src/daemon/lifecycle.js';

const procs: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'catalyst-lock-'));
  dirs.push(dir);
  const paths = projectPaths(dir);
  ensureDir(paths.dataDir);
  return paths;
}
function holder(args: string[]): ChildProcess {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', ...args], { stdio: 'ignore' });
  procs.push(p);
  return p;
}

describe('daemon lock', () => {
  it('does not steal the lock of a live daemon that is not (yet) healthy', async () => {
    const paths = setup();
    const p = holder(['catalyst', 'daemon']);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(paths.lock, `${p.pid}\n`);
    await expect(acquireLock(paths, 400)).rejects.toThrow(/not answering health checks/);
    expect(readFileSync(paths.lock, 'utf8').trim()).toBe(String(p.pid));
  });

  it('reclaims a lock whose pid is dead', async () => {
    const paths = setup();
    writeFileSync(paths.lock, '999999\n');
    await acquireLock(paths, 200);
    expect(readFileSync(paths.lock, 'utf8').trim()).toBe(String(process.pid));
    releaseLock(paths);
  });

  it('reclaims a lock whose pid was reused by an unrelated process', async () => {
    const paths = setup();
    const p = holder(['unrelated']);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(paths.lock, `${p.pid}\n`);
    await acquireLock(paths, 200);
    expect(readFileSync(paths.lock, 'utf8').trim()).toBe(String(process.pid));
    releaseLock(paths);
  });
});
