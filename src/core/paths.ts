/**
 * Locating a Catalyst project. A project is any directory containing `.catalyst/config.json`.
 * Resolution order: explicit dir → $CATALYST_PROJECT_DIR → walk up from cwd.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const DATA_DIR_NAME = '.catalyst';

export interface ProjectPaths {
  projectDir: string;
  dataDir: string;
  config: string;
  identity: string;
  secrets: string;
  daemonInfo: string;
  lock: string;
  db: string;
  snapshotMd: string;
  snapshotJson: string;
  inbox: string;
  inboxImported: string;
  inboxRejected: string;
  logs: string;
  daemonLog: string;
  mcpLog: string;
  hookLog: string;
  /** IMPORTANT.md lives in the project root (committed to git). */
  handover: string;
}

export function projectPaths(projectDir: string): ProjectPaths {
  const p = resolve(projectDir);
  const d = join(p, DATA_DIR_NAME);
  return {
    projectDir: p,
    dataDir: d,
    config: join(d, 'config.json'),
    identity: join(d, 'identity.json'),
    secrets: join(d, 'secrets.json'),
    daemonInfo: join(d, 'daemon.json'),
    lock: join(d, 'daemon.lock'),
    db: join(d, 'catalyst.db'),
    snapshotMd: join(d, 'snapshot.md'),
    snapshotJson: join(d, 'snapshot.json'),
    inbox: join(d, 'inbox'),
    inboxImported: join(d, 'inbox', 'imported'),
    inboxRejected: join(d, 'inbox', 'rejected'),
    logs: join(d, 'logs'),
    daemonLog: join(d, 'logs', 'daemon.log'),
    mcpLog: join(d, 'logs', 'mcp.log'),
    hookLog: join(d, 'logs', 'hooks.log'),
    handover: join(p, 'IMPORTANT.md'),
  };
}

/** Returns the project dir, or null if none found. */
export function findProjectDir(start?: string): string | null {
  if (start) return existsSync(join(resolve(start), DATA_DIR_NAME, 'config.json')) ? resolve(start) : null;
  const env = process.env.CATALYST_PROJECT_DIR;
  if (env) return existsSync(join(resolve(env), DATA_DIR_NAME, 'config.json')) ? resolve(env) : null;
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, DATA_DIR_NAME, 'config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
