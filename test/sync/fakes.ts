import { randomBytes } from 'node:crypto';
import { generateKeyPair, participantIdFromPublicKey, validateEnvelope, type CatalystEvent } from '../../src/core/protocol.js';
import type { AppendSource, IngestResult, IngestSource, InviteStore, PeerDirectory, PeerStatusBody, SyncStore } from '../../src/core/interfaces.js';
import type { PeerSecret } from '../../src/core/config.js';

export function identity(name: string) {
  const keys = generateKeyPair();
  return { ...keys, name, participantId: participantIdFromPublicKey(keys.publicKey) };
}

export class MemoryStore implements SyncStore, InviteStore {
  readonly applied = new Map<string, CatalystEvent>();
  readonly parked = new Map<string, CatalystEvent>();
  readonly deliveries = new Map<string, Set<string>>();
  readonly known = new Map<string, { name: string; publicKey: string }>();
  readonly receivedStatus = new Map<string, PeerStatusBody>();
  readonly seen = new Map<string, { lastSyncAt?: string; lastError?: string }>();
  readonly invitations = new Map<string, { inviteKey: string; expiresAt: string; used: boolean }>();
  private readonly listeners = new Set<(events: CatalystEvent[], source: AppendSource) => void>();
  private vector: Record<string, number> = {};
  statusBody: PeerStatusBody = { retrieved: [], sessions: [], pending: 0 };

  constructor(readonly projectId: string, readonly me: string) {}
  getVector(): Record<string, number> { return { ...this.vector }; }
  getEventsAfter(author: string, afterSeq: number, limit: number): CatalystEvent[] {
    return [...this.applied.values()].filter(e => e.author === author && e.seq > afterSeq).sort((a, b) => a.seq - b.seq).slice(0, limit);
  }
  ingest(events: unknown[], source: IngestSource): IngestResult {
    return this.apply(events, source.via === 'peer' ? 'peer' : 'import');
  }
  private apply(events: unknown[], source: AppendSource): IngestResult {
    const result: IngestResult = { accepted: [], duplicates: [], parked: [], rejected: [], forks: [] };
    for (const input of events) {
      const valid = validateEnvelope(input);
      if (!valid.ok) { result.rejected.push({ reason: valid.error }); continue; }
      const event = valid.event;
      if (event.project !== this.projectId) { result.rejected.push({ id: event.id, reason: 'wrong project' }); continue; }
      if (this.applied.has(event.id) || this.parked.has(event.id)) { result.duplicates.push(event.id); continue; }
      if ([...this.applied.values(), ...this.parked.values()].some(e => e.author === event.author && e.seq === event.seq)) {
        result.rejected.push({ id: event.id, reason: 'fork' }); continue;
      }
      const seq = this.vector[event.author] ?? 0;
      if (event.seq !== seq + 1) { this.parked.set(event.id, event); result.parked.push(event.id); continue; }
      this.applied.set(event.id, event);
      this.vector[event.author] = event.seq;
      result.accepted.push(event);
      while (true) {
        const next = [...this.parked.values()].find(e => e.author === event.author && e.seq === this.vector[event.author]! + 1);
        if (!next) break;
        this.parked.delete(next.id);
        this.applied.set(next.id, next);
        this.vector[next.author] = next.seq;
        result.accepted.push(next);
      }
    }
    if (result.accepted.length) for (const listener of this.listeners) listener(result.accepted, source);
    return result;
  }
  event(author = this.me, seq = (this.vector[author] ?? 0) + 1): CatalystEvent {
    return { v: 1, id: randomBytes(32).toString('hex'), project: this.projectId, author, seq, lc: seq, ts: new Date().toISOString(),
      type: 'message.posted', payload: { kind: 'notification', body: `event ${seq}` }, refs: {}, supersedes: [], origin: 'human', sig: 'fake' };
  }
  append(): CatalystEvent { const event = this.event(); this.apply([event], 'local'); return event; }
  markDelivered(peer: string, ids: string[]): void {
    const delivered = this.deliveries.get(peer) ?? new Set<string>();
    ids.forEach(id => delivered.add(id)); this.deliveries.set(peer, delivered);
  }
  markDeliveredByVector(peer: string, vector: Record<string, number>): void {
    this.markDelivered(peer, [...this.applied.values()].filter(e => e.seq <= (vector[e.author] ?? 0)).map(e => e.id));
  }
  pendingOutbound(peer: string): number {
    return [...this.applied.values()].filter(e => e.author !== peer && !this.deliveries.get(peer)?.has(e.id)).length;
  }
  onAppend(listener: (events: CatalystEvent[], source: AppendSource) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  takeStatusFor(_peer: string): PeerStatusBody {
    const body = { ...this.statusBody, retrieved: [...this.statusBody.retrieved] };
    this.statusBody.retrieved = []; return body;
  }
  applyPeerStatus(peer: string, body: PeerStatusBody): void { this.receivedStatus.set(peer, body); }
  addKnownParticipant(id: string, name: string, publicKey: string): void { this.known.set(id, { name, publicKey }); }
  setPeerSeen(peer: string, at: string, error?: string): void { this.seen.set(peer, { lastSyncAt: at, lastError: error }); }
  getPeerSeen(peer: string) { return this.seen.get(peer) ?? null; }
  createInvite(rec: { inviteId: string; inviteKey: string; expiresAt: string }): void { this.invitations.set(rec.inviteId, { ...rec, used: false }); }
  getInviteKey(inviteId: string, now: Date): string | null {
    const rec = this.invitations.get(inviteId);
    return rec && !rec.used && Date.parse(rec.expiresAt) > now.getTime() ? rec.inviteKey : null;
  }
  consumeInvite(inviteId: string, now: Date): boolean {
    if (!this.getInviteKey(inviteId, now)) return false;
    this.invitations.get(inviteId)!.used = true; return true;
  }
}

export class MemoryDirectory implements PeerDirectory {
  readonly peers = new Map<string, PeerSecret>();
  listPeers(): PeerSecret[] { return [...this.peers.values()]; }
  getPeer(id: string): PeerSecret | null { return this.peers.get(id) ?? null; }
  addPeer(peer: PeerSecret): void { this.peers.set(peer.participantId, { ...peer, addrs: [...peer.addrs] }); }
  updatePeerAddrs(id: string, addrs: string[]): void {
    const peer = this.peers.get(id);
    if (peer) peer.addrs = [...addrs];
  }
}
