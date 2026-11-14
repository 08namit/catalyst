import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { generateKeyPair, newProjectId, participantIdFromPublicKey } from '../../src/core/protocol.js';
import type { Identity } from '../../src/core/config.js';
import type { PeerConnState, SyncSummary } from '../../src/core/api.js';
import { SqliteEventStore } from '../../src/store/index.js';

const dirs: string[] = [];
const stores: SqliteEventStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'catalyst-store-'));
  dirs.push(d);
  return d;
}

export function makeIdentity(name: string): Identity {
  const kp = generateKeyPair();
  return { participantId: participantIdFromPublicKey(kp.publicKey), name, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export function openStore(projectId: string, identity: Identity, dbPath = join(tempDir(), 'catalyst.db')): SqliteEventStore {
  const s = SqliteEventStore.open({ dbPath, projectId, identity });
  stores.push(s);
  return s;
}

/** A participant node with participant.joined (and project.created if createdByMe). */
export function makeNode(projectId: string, name: string, createdByMe = false): SqliteEventStore {
  const s = openStore(projectId, makeIdentity(name));
  s.bootstrap({ name, projectName: 'Demo', createdByMe });
  return s;
}

/** Two nodes in one project that have exchanged their bootstrap events. */
export function makePair(): { projectId: string; a: SqliteEventStore; b: SqliteEventStore } {
  const projectId = newProjectId();
  const a = makeNode(projectId, 'Tiam', true);
  const b = makeNode(projectId, 'Namit');
  sync(a, b);
  sync(b, a);
  return { projectId, a, b };
}

/** Deliver every event `from` holds to `to`. */
export function sync(from: SqliteEventStore, to: SqliteEventStore) {
  return to.ingest(
    from.listSince(0).map((s) => s.event),
    { via: 'peer', peer: from.me },
  );
}

export function syncSummary(state: PeerConnState | null, extra: Partial<SyncSummary> = {}): SyncSummary {
  return {
    paused: false,
    peerPort: 0,
    peers:
      state === null
        ? []
        : [{ participant: 'p_' + '0'.repeat(24), name: 'Peer', state, since: '2026-11-14T10:00:00.000Z', addrs: [], pendingOutbound: 2, sessions: [] }],
    pendingOutbound: 2,
    parkedEvents: 0,
    freshness: state === 'connected' ? 'Connected to Peer.' : `Peer is ${state ?? 'not paired'}.`,
    ...extra,
  };
}

export const decision = (topic: string, title: string, text: string) => ({
  type: 'decision.recorded' as const,
  payload: { topic, title, decision: text, rationale: 'because', status: 'accepted' },
  origin: 'agent' as const,
});
