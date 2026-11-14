/**
 * Daemon entry: one per project per laptop. Owns the event store, loopback API, peer sync, inbox import,
 * snapshot + IMPORTANT.md regeneration.
 */
import type { FileWriteResponse, HealthResponse, PeerStatus, SyncSummary } from '../core/api.js';
import { loadConfig, loadIdentity, loadSecrets, saveConfig } from '../core/config.js';
import type { EventStore, PeerManagerApi } from '../core/interfaces.js';
import { createLogger } from '../core/log.js';
import { projectPaths } from '../core/paths.js';
import { MATERIAL_TYPES, PROTOCOL_VERSION, SOFTWARE_VERSION } from '../core/protocol.js';
import { updateHandoverFile } from '../handover/important.js';
import { writeSnapshot } from '../handover/snapshot.js';
import { SqliteEventStore } from '../store/index.js';
import { PeerManager } from '../sync/peer.js';
import type { DaemonContext } from './context.js';
import { startApiServer, type ApiServer } from './http.js';
import { importInbox } from './inbox.js';
import { acquireLock, newDaemonSecrets, releaseLock, removeDaemonInfo, writeDaemonInfo } from './lifecycle.js';
import { SecretsPeerDirectory } from './peers.js';

export { DaemonAlreadyRunningError } from './lifecycle.js';

export interface DaemonHandle {
  apiPort: number;
  peerPort: number;
  close(): Promise<void>;
  store: EventStore;
  peers: PeerManagerApi;
}

const INBOX_INTERVAL_MS = 10_000;
const DEBOUNCE_MS = 500;

export async function runDaemon(projectDir: string, opts: { signals?: boolean } = {}): Promise<DaemonHandle> {
  const paths = projectPaths(projectDir);
  const config = loadConfig(paths);
  const identity = loadIdentity(paths);
  const logger = createLogger(paths.daemonLog, 'daemon');

  await acquireLock(paths);
  const { token, nonce } = newDaemonSecrets();
  const startedAt = new Date().toISOString();
  let store: EventStore | undefined;
  let peers: PeerManager | undefined;
  let api: ApiServer | undefined;
  let peerPort = 0;
  let closed: Promise<void> | null = null;
  const timers: { inbox?: NodeJS.Timeout; files?: NodeJS.Timeout } = {};
  let unsubscribe: (() => void) | undefined;
  let pendingMaterial = false;
  let filesPending = false;

  const sync = (): SyncSummary => {
    const statuses = peers!.status();
    const paused = peers!.isPaused();
    return {
      paused,
      peerPort,
      peers: statuses,
      pendingOutbound: statuses.reduce((m, p) => Math.max(m, p.pendingOutbound), 0),
      parkedEvents: store!.parkedCount(),
      freshness: describeFreshness(paused, statuses, new Date()),
    };
  };

  const doSnapshot = (): FileWriteResponse => {
    const generatedAt = new Date().toISOString();
    writeSnapshot(paths, store!.getState(), sync(), generatedAt);
    return { path: paths.snapshotMd, changed: true, generatedAt };
  };
  const doHandover = (): FileWriteResponse => {
    const generatedAt = new Date().toISOString();
    const r = updateHandoverFile(paths.handover, store!.getState());
    return { path: paths.handover, changed: r.changed, generatedAt };
  };

  const flushFiles = () => {
    clearTimeout(timers.files);
    timers.files = undefined;
    if (!filesPending) return;
    filesPending = false;
    try {
      doSnapshot();
      if (pendingMaterial && config.autoHandover !== false) doHandover();
      pendingMaterial = false;
    } catch (err) {
      logger.error('snapshot/handover write failed', err);
    }
  };
  const scheduleFiles = (material: boolean) => {
    if (material) pendingMaterial = true;
    filesPending = true;
    clearTimeout(timers.files);
    timers.files = setTimeout(flushFiles, DEBOUNCE_MS);
  };

  const close = (): Promise<void> => {
    closed ??= (async () => {
      logger.info('daemon stopping');
      clearInterval(timers.inbox);
      unsubscribe?.();
      if (store) flushFiles();
      removeDaemonInfo(paths, nonce);
      await api?.close().catch((err) => logger.warn('api close failed', err));
      await peers?.stop().catch((err) => logger.warn('peer stop failed', err));
      try {
        store?.close();
      } catch (err) {
        logger.warn('store close failed', err);
      }
      releaseLock(paths);
      logger.info('daemon stopped');
    })();
    return closed;
  };

  try {
    const opened = SqliteEventStore.open({ dbPath: paths.db, projectId: config.projectId, identity, logger });
    store = opened;
    opened.bootstrap({ name: config.name, projectName: config.projectName, createdByMe: config.createdByMe });
    const directory = new SecretsPeerDirectory(paths, config.projectId);
    for (const p of Object.values(loadSecrets(paths, config.projectId).peers)) store.addKnownParticipant(p.participantId, p.name, p.publicKey);

    peers = new PeerManager({
      store,
      invites: store,
      directory,
      identity: { participantId: identity.participantId, name: identity.name, publicKey: identity.publicKey },
      projectId: config.projectId,
      projectName: config.projectName,
      bind: config.peerBind,
      port: config.peerPort,
      advertiseHosts: config.advertiseHosts,
      logger: createLogger(paths.daemonLog, 'sync'),
      getPeerSessions: (p) => store!.peerSessions(p),
      onPeerJoined: (p) => logger.info('peer joined', { participant: p.participantId, name: p.name }),
      onStatusChange: () => scheduleFiles(false),
    });
    peerPort = (await peers.start()).port;
    if (config.peerPort === 0) {
      // Persist the assigned port so invitations and peers' stored addresses stay valid across restarts.
      const fresh = loadConfig(paths);
      saveConfig(paths, { ...fresh, peerPort });
    }

    let apiPort = 0;
    const health = (): HealthResponse => ({
      ok: true,
      projectId: config.projectId,
      participantId: identity.participantId,
      name: identity.name,
      nonce,
      pid: process.pid,
      version: SOFTWARE_VERSION,
      protocol: PROTOCOL_VERSION,
      apiPort,
      peerPort,
      startedAt,
    });
    const ctx: DaemonContext = {
      paths,
      config,
      identity,
      store,
      peers,
      logger,
      token,
      health,
      sync,
      writeSnapshot: doSnapshot,
      writeHandover: doHandover,
      importInbox: (minAgeMs?: number) => importInbox(paths, store!, sync, logger, minAgeMs),
      shutdown: () => {
        void close().then(() => {
          if (opts.signals) process.exit(0);
        });
      },
    };
    api = await startApiServer(ctx, config.apiPort);
    apiPort = api.port;

    writeDaemonInfo(paths, { pid: process.pid, apiPort, peerPort, token, nonce, startedAt, projectId: config.projectId });
    logger.info('daemon started', { pid: process.pid, apiPort, peerPort });

    unsubscribe = store.onAppend((events) => scheduleFiles(events.some((e) => MATERIAL_TYPES.has(e.type))));
    ctx.importInbox();
    timers.inbox = setInterval(() => {
      try {
        ctx.importInbox(2000);
      } catch (err) {
        logger.error('inbox import failed', err);
      }
    }, INBOX_INTERVAL_MS);
    timers.inbox.unref();
    scheduleFiles(false);
  } catch (err) {
    logger.error('daemon failed to start', err);
    await close();
    throw err;
  }

  if (opts.signals) installSignalHandlers(close, () => {
    removeDaemonInfo(paths, nonce);
    releaseLock(paths);
  }, logger);

  return { apiPort: api.port, peerPort, close, store, peers };
}

function installSignalHandlers(close: () => Promise<void>, emergencyCleanup: () => void, logger: ReturnType<typeof createLogger>): void {
  const stop = (signal: string) => {
    logger.info(`received ${signal}`);
    const force = setTimeout(() => {
      emergencyCleanup();
      process.exit(1);
    }, 5000);
    force.unref();
    void close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  const fatal = (err: unknown) => {
    logger.error('fatal error', err);
    emergencyCleanup();
    process.exit(1);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
}

// ---------------------------------------------------------------------------
// Freshness sentence: never confuse "no updates" with "peer unreachable".
// ---------------------------------------------------------------------------
export function describeFreshness(paused: boolean, peers: PeerStatus[], now: Date): string {
  const queued = (n: number) => (n > 0 ? ` (${n} update${n === 1 ? '' : 's'} queued)` : '');
  if (paused) {
    const pending = peers.reduce((m, p) => Math.max(m, p.pendingOutbound), 0);
    return `Peer sync paused by user (\`catalyst peer resume\`)${queued(pending)} — updates are saved locally.`;
  }
  if (peers.length === 0) return 'No peer paired yet (`catalyst pair`) — updates are saved locally.';
  return peers
    .map((p) => {
      const last = p.lastSyncAt ? `last sync ${ago(p.lastSyncAt, now)}` : 'never synced';
      switch (p.state) {
        case 'connected':
          return `Peer ${p.name} connected; ${last}.`;
        case 'connecting':
          return `Connecting to peer ${p.name}; ${last}${queued(p.pendingOutbound)}.`;
        case 'never_connected':
          return `Peer ${p.name} has not connected yet${queued(p.pendingOutbound)} — updates are saved locally.`;
        case 'paused':
          return `Peer ${p.name} paused${queued(p.pendingOutbound)}.`;
        default:
          return `Peer ${p.name} unreachable${p.since ? ` since ${clock(p.since)}` : ''}${queued(p.pendingOutbound)} — remote context may be stale.`;
      }
    })
    .join(' ');
}

function ago(iso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  const sameDay = new Date().toDateString() === d.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.toISOString().slice(0, 10)} ${hm}`;
}
