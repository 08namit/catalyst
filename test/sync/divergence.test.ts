// Regression from the adversarial review: equal seq vectors must not hide divergent histories
// (e.g. a restored .catalyst/ that re-used a seq). Uses the real SQLite store and real TLS-PSK peers.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair, newProjectId, participantIdFromPublicKey } from '../../src/core/protocol.js';
import type { Identity } from '../../src/core/config.js';
import { nullLogger } from '../../src/core/log.js';
import { SqliteEventStore } from '../../src/store/index.js';
import { PeerManager } from '../../src/sync/peer.js';
import { MemoryDirectory } from './fakes.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function ident(name: string): Identity {
  const kp = generateKeyPair();
  return { participantId: participantIdFromPublicKey(kp.publicKey), name, ...kp };
}
function store(projectId: string, id: Identity): SqliteEventStore {
  const dir = mkdtempSync(join(tmpdir(), 'catalyst-div-'));
  const s = SqliteEventStore.open({ dbPath: join(dir, 'c.db'), projectId, identity: id });
  cleanup.push(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
async function until(pred: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('divergent history detection', () => {
  it('raises a fork alarm on both sides when the same seq holds different events', async () => {
    const projectId = newProjectId();
    const ia = ident('A');
    const ib = ident('B');
    const a = store(projectId, ia);
    a.bootstrap({ name: 'A', projectName: 'P', createdByMe: true });
    const b = store(projectId, ib);
    b.bootstrap({ name: 'B', createdByMe: false });
    b.ingest(a.listSince(0).map((s) => s.event), { via: 'peer', peer: ia.participantId });
    a.ingest(b.listSince(0).map((s) => s.event), { via: 'peer', peer: ib.participantId });
    const shared = a.listSince(0).map((s) => s.event);

    // A "restores a backup": a fresh store for the same identity with the same history, then appends seq 3,
    // while B independently received a different (authentic) seq 3 from the original A database.
    a.append({ type: 'message.posted', payload: { kind: 'notification', body: 'original seq 3' }, origin: 'agent' });
    b.ingest(a.listSince(0).map((s) => s.event), { via: 'peer', peer: ia.participantId });
    const restored = store(projectId, ia);
    restored.ingest(shared, { via: 'import' });
    restored.ingest(b.listSince(0).filter((s) => s.event.author === ib.participantId).map((s) => s.event), { via: 'import' });
    restored.append({ type: 'message.posted', payload: { kind: 'notification', body: 'different seq 3' }, origin: 'agent' });
    expect(restored.getVector()[ia.participantId]).toBe(b.getVector()[ia.participantId]);

    const pairKey = randomBytes(32).toString('base64');
    const da = new MemoryDirectory();
    const db = new MemoryDirectory();
    const mk = (s: SqliteEventStore, id: Identity, dir: MemoryDirectory) =>
      new PeerManager({
        store: s, invites: s, directory: dir, identity: id, projectId, projectName: 'P', bind: '127.0.0.1', port: 0,
        advertiseHosts: ['127.0.0.1'], logger: nullLogger, backoff: { minMs: 30, maxMs: 100 },
      });
    const ma = mk(restored, ia, da);
    const mb = mk(b, ib, db);
    cleanup.push(() => ma.stop(), () => mb.stop());
    const pa = await ma.start();
    const pb = await mb.start();
    const now = new Date().toISOString();
    da.addPeer({ participantId: ib.participantId, name: 'B', publicKey: ib.publicKey, pairKey, addrs: [`127.0.0.1:${pb.port}`], addedAt: now });
    db.addPeer({ participantId: ia.participantId, name: 'A', publicKey: ia.publicKey, pairKey, addrs: [`127.0.0.1:${pa.port}`], addedAt: now });
    ma.kick();
    mb.kick();

    await until(() => b.getState().forks.length > 0 && restored.getState().forks.length > 0);
    expect(b.getState().forks[0]!.author).toBe(ia.participantId);
    // The divergent event must not be counted as delivered just because the seq counts matched.
    expect(restored.deliveryState(restored.listSince(0).at(-1)!.event.id).deliveredTo).toEqual([]);
  });
});
