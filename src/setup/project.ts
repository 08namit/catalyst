/**
 * Creating and joining a Catalyst project (shared by the CLI `init`/`join` commands and the MCP adapter's
 * start_project/join_project tools). No console output: results are returned, failures throw Errors with an
 * actionable message.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ensureDir, loadIdentity, loadSecrets, readJson, saveConfig, saveIdentity, saveSecrets, type Identity, type ProjectConfig } from '../core/config.js';
import { projectPaths, type ProjectPaths } from '../core/paths.js';
import { generateKeyPair, newProjectId, participantIdFromPublicKey } from '../core/protocol.js';

export interface InitOptions {
  dir: string;
  name?: string;
  projectName?: string;
  peerPort?: number;
  peerBind?: string;
  apiPort?: number;
  hosts?: string[];
  setup?: boolean;
  start?: boolean;
}

export interface InitResult {
  projectDir: string;
  projectId: string;
  participantId: string;
  name: string;
  projectName: string;
  daemonPid?: number;
  peerPort?: number;
  setupChanges: string[];
}

export interface JoinOptions {
  dir: string;
  invite: string;
  name?: string;
  peerPort?: number;
  peerBind?: string;
  hosts?: string[];
  setup?: boolean;
  start?: boolean;
}

export interface JoinResult extends InitResult {
  inviterName: string;
  confirmCode: string;
  alreadyJoined: boolean;
}

const DEFAULT_BIND = '0.0.0.0';

/** Nearest directory at or above `start` that contains `.git` (directory or file), else null. */
export function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function initProject(o: InitOptions): Promise<InitResult> {
  const dir = resolve(o.dir);
  const paths = projectPaths(dir);
  if (existsSync(paths.config)) throw new Error(`Catalyst is already set up in ${dir} (${paths.config} exists).`);
  const peerBind = o.peerBind ?? DEFAULT_BIND;
  const peerPort = port(o.peerPort, 'peerPort') ?? 0;
  const apiPort = port(o.apiPort, 'apiPort') ?? 0;
  ensureDir(paths.dataDir, 0o700);
  chmodSync(paths.dataDir, 0o700);
  const name = (o.name?.trim() || defaultName()).slice(0, 80);
  const keys = generateKeyPair();
  const participantId = participantIdFromPublicKey(keys.publicKey);
  saveIdentity(paths, { participantId, name, ...keys });
  const config: ProjectConfig = {
    projectId: newProjectId(),
    projectName: o.projectName?.trim() || basename(dir),
    participantId,
    name,
    peerPort,
    peerBind,
    apiPort,
    advertiseHosts: o.hosts ?? loopbackHosts(peerBind),
    createdByMe: true,
    autoHandover: true,
    createdAt: new Date().toISOString(),
  };
  saveConfig(paths, config);
  const finished = await finishSetup(paths, o);
  return { projectDir: dir, projectId: config.projectId, participantId, name, projectName: config.projectName, ...finished };
}

export async function joinProject(o: JoinOptions): Promise<JoinResult> {
  const dir = resolve(o.dir);
  const paths = projectPaths(dir);
  const token = o.invite.trim();
  const { parseInvite, joinWithInvite } = await import('../sync/pairing.js');
  const invite = parseInvite(token);
  const existing = readJson<ProjectConfig>(paths.config);
  if (existing && existing.projectId !== invite.project) {
    throw new Error(
      `${dir} is already Catalyst project "${existing.projectName}" (${existing.projectId}); this invitation is for "${invite.projectName}". Join from a separate checkout.`,
    );
  }
  const peerBind = o.peerBind ?? existing?.peerBind ?? DEFAULT_BIND;
  let identity: Identity;
  if (existing) {
    identity = loadIdentity(paths);
  } else {
    const keys = generateKeyPair();
    identity = { participantId: participantIdFromPublicKey(keys.publicKey), name: (o.name?.trim() || defaultName()).slice(0, 80), ...keys };
  }
  const peerPort = port(o.peerPort, 'peerPort') || existing?.peerPort || (await freePort(peerBind));
  const hosts = o.hosts ?? (existing?.advertiseHosts.length ? existing.advertiseHosts : detectHosts(peerBind));
  const { createLogger } = await import('../core/log.js');
  const logger = createLogger(null, 'join', process.env.CATALYST_DEBUG === '1' ? 'debug' : 'error');
  const joined = await joinWithInvite(token, {
    identity: { participantId: identity.participantId, name: identity.name, publicKey: identity.publicKey },
    addrs: hosts.map((h) => formatAddr(h, peerPort)),
    logger,
  });
  ensureDir(paths.dataDir, 0o700);
  chmodSync(paths.dataDir, 0o700);
  if (!existing) {
    saveIdentity(paths, identity);
    saveConfig(paths, {
      projectId: joined.projectId,
      projectName: joined.projectName,
      participantId: identity.participantId,
      name: identity.name,
      peerPort,
      peerBind,
      apiPort: 0,
      advertiseHosts: o.hosts ?? loopbackHosts(peerBind),
      createdByMe: false,
      autoHandover: true,
      createdAt: new Date().toISOString(),
    });
  }
  const secrets = loadSecrets(paths, joined.projectId);
  secrets.peers[joined.inviter.participantId] = joined.inviter;
  saveSecrets(paths, secrets);
  const finished = await finishSetup(paths, o);
  return {
    projectDir: dir,
    projectId: joined.projectId,
    participantId: identity.participantId,
    name: identity.name,
    projectName: joined.projectName,
    ...finished,
    inviterName: joined.inviter.name,
    confirmCode: joined.confirmCode,
    alreadyJoined: !!existing,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
/** gitignore, Claude setup and daemon start shared by init and join. */
async function finishSetup(paths: ProjectPaths, o: { setup?: boolean; start?: boolean }): Promise<Pick<InitResult, 'daemonPid' | 'peerPort' | 'setupChanges'>> {
  const { ensureGitignore, setupClaude } = await import('./claude.js');
  const setupChanges: string[] = [];
  if (ensureGitignore(paths.projectDir)) setupChanges.push('.gitignore: added .catalyst/');
  if (o.setup !== false) setupChanges.push(...setupClaude(paths.projectDir).changes);
  if (o.start === false) return { setupChanges };
  const { startDaemon } = await import('../client/index.js');
  const { info } = await startDaemon(paths);
  return { setupChanges, daemonPid: info.pid, peerPort: info.peerPort };
}

function port(v: number | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error(`${name} must be an integer between 0 and 65535 (got ${v}).`);
  return v;
}

function defaultName(): string {
  try {
    const n = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    if (n) return n.slice(0, 80);
  } catch {
    /* no git or no user.name */
  }
  return userInfo().username;
}

/** Persisted advertiseHosts: a loopback-bound peer listener is only reachable on 127.0.0.1; otherwise [] = auto-detect. */
function loopbackHosts(bind: string): string[] {
  return bind === '127.0.0.1' || bind === 'localhost' ? ['127.0.0.1'] : [];
}

function detectHosts(bind: string): string[] {
  if (loopbackHosts(bind).length) return loopbackHosts(bind);
  const hosts: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) hosts.push(a.address);
  }
  return hosts.length ? hosts : ['127.0.0.1'];
}

function formatAddr(host: string, p: number): string {
  return host.includes(':') ? `[${host}]:${p}` : `${host}:${p}`;
}

function freePort(bind: string): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, bind, () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(p));
    });
  });
}
