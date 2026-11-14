/**
 * Local, gitignored project files under .catalyst/. Secret-bearing files are written 0600 atomically.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProjectPaths } from './paths.js';

/** .catalyst/config.json — no secrets. */
export interface ProjectConfig {
  projectId: string;
  projectName: string;
  participantId: string;
  name: string;
  /** TCP port for the peer listener (0 = pick a free port on first start and persist it). */
  peerPort: number;
  /** Bind address for the peer listener. Default "0.0.0.0" (LAN). Use "127.0.0.1" for single-machine tests. */
  peerBind: string;
  /** Loopback API port (0 = random each start; the actual port is in daemon.json). */
  apiPort: number;
  /** Hosts/IPs advertised in invitations; empty = auto-detect non-internal IPv4. */
  advertiseHosts: string[];
  /** true on the node that ran `catalyst init` (it emits project.created); false on joiners. */
  createdByMe: boolean;
  createdAt: string;
}

/** .catalyst/identity.json (0600) */
export interface Identity {
  participantId: string;
  name: string;
  publicKey: string;
  privateKey: string;
}

/** .catalyst/secrets.json (0600): pairwise keys, bound to this project. */
export interface PeerSecret {
  participantId: string;
  name: string;
  publicKey: string;
  /** base64 32-byte pair key; TLS-PSK = HKDF(pairKey, salt=projectId, info=sorted ids). */
  pairKey: string;
  addrs: string[];
  addedAt: string;
  confirmCode?: string;
}
export interface Secrets {
  projectId: string;
  peers: Record<string, PeerSecret>;
}

/** .catalyst/daemon.json (0600): written by the running daemon. */
export interface DaemonInfo {
  pid: number;
  apiPort: number;
  peerPort: number;
  token: string;
  nonce: string;
  startedAt: string;
  projectId: string;
}

export function ensureDir(path: string, mode = 0o700): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
}

/** Atomic write (temp file + rename). */
export function writeFileAtomic(path: string, data: string, mode = 0o644): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    /* best effort on platforms without chmod */
  }
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
export function writeJson(path: string, value: unknown, secret = false): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n', secret ? 0o600 : 0o644);
}

export function loadConfig(p: ProjectPaths): ProjectConfig {
  const c = readJson<ProjectConfig>(p.config);
  if (!c) throw new Error(`No Catalyst project at ${p.projectDir}. Run \`catalyst init\` or \`catalyst join <invite>\` first.`);
  return c;
}
export function saveConfig(p: ProjectPaths, c: ProjectConfig): void {
  writeJson(p.config, c);
}
export function loadIdentity(p: ProjectPaths): Identity {
  const i = readJson<Identity>(p.identity);
  if (!i) throw new Error(`Missing ${p.identity}. Re-run \`catalyst init\`.`);
  return i;
}
export function saveIdentity(p: ProjectPaths, i: Identity): void {
  writeJson(p.identity, i, true);
}
export function loadSecrets(p: ProjectPaths, projectId: string): Secrets {
  const s = readJson<Secrets>(p.secrets);
  if (!s) return { projectId, peers: {} };
  if (s.projectId !== projectId) throw new Error(`secrets.json belongs to project ${s.projectId}, not ${projectId}; refusing to use it.`);
  return s;
}
export function saveSecrets(p: ProjectPaths, s: Secrets): void {
  writeJson(p.secrets, s, true);
}
export function readDaemonInfo(p: ProjectPaths): DaemonInfo | null {
  try {
    return readJson<DaemonInfo>(p.daemonInfo);
  } catch {
    return null;
  }
}
