import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { PeerConnState, PeerStatus } from '../core/api.js';
import type { PeerSecret } from '../core/config.js';
import type { PeerManagerApi, PeerManagerOptions } from '../core/interfaces.js';
import { LIMITS, PROTOCOL_VERSION, SOFTWARE_VERSION, participantIdFromPublicKey, type CatalystEvent } from '../core/protocol.js';
import { confirmCode, deriveInvitePsk, derivePairPsk } from './crypto.js';
import {
  BACKOFF_MAX_MS, BACKOFF_MIN_MS, HANDSHAKE_TIMEOUT_MS, IDLE_TIMEOUT_MS, INVITE_IDENTITY_PREFIX, INVITE_TTL_MINUTES_DEFAULT,
  PEER_IDENTITY_PREFIX, PING_INTERVAL_MS, type ErrorCode, type Frame, type HelloFrame, type JoinRequestFrame,
} from './frames.js';
import { encodeInvite } from './pairing.js';
import { connectPeer, createPeerServer, formatAddress, parseAddress, type FramedConnection, type PeerServer } from './transport.js';

interface Session {
  conn: FramedConnection;
  peer: string;
  outbound: boolean;
  ready: boolean;
  remoteVector: Record<string, number>;
  lastReceivedAt: number;
  lastStatusAt: number;
  lastStatusSummary?: string;
  deadline: ReturnType<typeof setTimeout>;
}
interface PeerEntry {
  state: PeerConnState;
  since: string;
  lastError?: string;
  lastSyncAt?: string;
  session?: Session;
  timer?: ReturnType<typeof setTimeout>;
  dialing?: Promise<void>;
  controller?: AbortController;
  failures: number;
  redial?: boolean;
}

export class PeerManager implements PeerManagerApi {
  private server?: PeerServer;
  private starting?: Promise<{ port: number }>;
  private running = false;
  private paused = false;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly connections = new Set<FramedConnection>();
  private unsubscribe?: () => void;
  private statusTimer?: ReturnType<typeof setInterval>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private ingestingPeer?: string;

  constructor(private readonly opts: PeerManagerOptions) {}

  private now(): Date { return this.opts.now?.() ?? new Date(); }
  private entry(id: string): PeerEntry {
    let entry = this.peers.get(id);
    if (!entry) {
      const seen = this.opts.store.getPeerSeen(id);
      entry = { state: this.paused ? 'paused' : 'never_connected', since: this.now().toISOString(), failures: 0,
        lastSyncAt: seen?.lastSyncAt, lastError: seen?.lastError };
      this.peers.set(id, entry);
    }
    return entry;
  }

  private transition(id: string, state: PeerConnState, error?: string): void {
    const entry = this.entry(id);
    const changed = entry.state !== state || entry.lastError !== error;
    if (entry.state !== state) entry.since = this.now().toISOString();
    entry.state = state;
    entry.lastError = error;
    if (changed) this.opts.onStatusChange?.(this.status());
  }

  start(): Promise<{ port: number }> {
    if (this.starting) return this.starting;
    if (this.server) return Promise.resolve({ port: this.server.port });
    const task = this.listen();
    this.starting = task;
    void task.then(() => { this.starting = undefined; }, () => { this.starting = undefined; });
    return task;
  }

  private async listen(): Promise<{ port: number }> {
    this.server = await createPeerServer({ bind: this.opts.bind, port: this.opts.port, logger: this.opts.logger,
      resolvePsk: identity => this.resolvePsk(identity), onConnection: (conn, identity) => this.inbound(conn, identity) });
    this.running = true;
    this.unsubscribe = this.opts.store.onAppend((events, source) => {
      if (!this.running || this.paused) return;
      for (const [id, entry] of this.peers) {
        if (entry.session?.ready && !(source === 'peer' && id === this.ingestingPeer)) this.sendEvents(entry.session, events, false);
      }
    });
    this.statusTimer = setInterval(() => {
      if (!this.running || this.paused) return;
      for (const entry of this.peers.values()) if (entry.session?.ready) this.sendStatus(entry.session, false);
      this.discoverPeers();
    }, this.opts.statusIntervalMs ?? 5000);
    this.pingTimer = setInterval(() => {
      if (this.paused) return;
      for (const entry of this.peers.values()) {
        const session = entry.session;
        if (!session) continue;
        if (this.now().getTime() - session.lastReceivedAt >= IDLE_TIMEOUT_MS) {
          entry.lastError = 'Peer idle timeout';
          session.conn.destroy();
        } else session.conn.send({ t: 'ping', at: this.now().toISOString() });
      }
    }, PING_INTERVAL_MS);
    this.discoverPeers();
    return { port: this.server.port };
  }

  private resolvePsk(identity: string): Buffer | null {
    if (this.paused) return null;
    const paired = this.identityPart(identity, PEER_IDENTITY_PREFIX);
    if (paired) {
      const peer = this.opts.directory.getPeer(paired);
      return peer ? derivePairPsk(peer.pairKey, this.opts.projectId, [this.opts.identity.participantId, paired]) : null;
    }
    const inviteId = this.identityPart(identity, INVITE_IDENTITY_PREFIX);
    if (!inviteId) return null;
    const key = this.opts.invites.getInviteKey(inviteId, this.now());
    return key ? Buffer.from(key, 'base64') : null;
  }

  private identityPart(identity: string, prefix: string): string | null {
    if (!identity.startsWith(prefix)) return null;
    const parts = identity.slice(prefix.length).split('/');
    return parts.length === 2 && parts[0] === this.opts.projectId && !!parts[1] ? parts[1] : null;
  }

  private inbound(conn: FramedConnection, identity: string): void {
    if (!this.running || this.paused) { conn.destroy(); return; }
    const peer = this.identityPart(identity, PEER_IDENTITY_PREFIX);
    if (peer) { this.session(conn, peer, false); return; }
    const inviteId = this.identityPart(identity, INVITE_IDENTITY_PREFIX);
    if (!inviteId) { conn.destroy(); return; }
    this.connections.add(conn);
    let handled = false;
    const deadline = setTimeout(() => conn.destroy(), HANDSHAKE_TIMEOUT_MS);
    conn.once('close', () => { clearTimeout(deadline); this.connections.delete(conn); });
    conn.on('error', error => this.opts.logger.debug('Invitation connection error', error));
    conn.on('frame', (frame: Frame) => {
      if (handled) return;
      handled = true;
      clearTimeout(deadline);
      if (this.paused || !this.running) { conn.destroy(); return; }
      try {
        if (frame.t !== 'join_request') this.fail(conn, 'bad_frame', 'Expected join_request');
        else this.acceptJoin(conn, inviteId, frame);
      } catch (error) {
        this.opts.logger.error('Pairing failed', error);
        this.fail(conn, 'internal', 'Pairing could not be completed; ask your peer to create a new invitation');
      }
    });
  }

  private acceptJoin(conn: FramedConnection, inviteId: string, frame: JoinRequestFrame): void {
    if (!this.validateProtocol(conn, frame.protocol, frame.project)) return;
    if (frame.inviteId !== inviteId || participantIdFromPublicKey(frame.publicKey) !== frame.participant
      || frame.participant === this.opts.identity.participantId) {
      this.fail(conn, 'invite_invalid', 'Invitation identity does not match the join request'); return;
    }
    if (!this.opts.invites.consumeInvite(inviteId, this.now())) {
      this.fail(conn, 'invite_invalid', 'Invitation is expired, already used, or unknown; run `catalyst pair` again'); return;
    }
    const pairKey = randomBytes(32).toString('base64');
    const code = confirmCode(conn.socket);
    const peer: PeerSecret = { participantId: frame.participant, name: frame.name, publicKey: frame.publicKey,
      pairKey, addrs: frame.addrs, addedAt: this.now().toISOString(), confirmCode: code };
    this.opts.directory.addPeer(peer);
    this.opts.store.addKnownParticipant(peer.participantId, peer.name, peer.publicKey);
    conn.send({ t: 'join_accept', project: { id: this.opts.projectId, name: this.opts.projectName },
      inviter: { participant: this.opts.identity.participantId, name: this.opts.identity.name, publicKey: this.opts.identity.publicKey,
        addrs: this.addrs() }, pairKey, confirmCode: code });
    conn.close();
    this.opts.onPeerJoined?.(peer);
    this.schedule(peer.participantId, 0);
  }

  private session(conn: FramedConnection, peer: string, outbound: boolean): void {
    if (this.paused || !this.running) { conn.destroy(); return; }
    this.connections.add(conn);
    const session: Session = { conn, peer, outbound, ready: false, remoteVector: {}, lastReceivedAt: this.now().getTime(), lastStatusAt: 0,
      deadline: setTimeout(() => conn.destroy(), HANDSHAKE_TIMEOUT_MS) };
    conn.on('error', (error: Error) => {
      this.opts.logger.debug('Peer connection error', { peer, error: error.message });
      if (this.entry(peer).session === session) this.entry(peer).lastError = error.message;
    });
    conn.once('close', () => {
      clearTimeout(session.deadline);
      this.connections.delete(conn);
      const entry = this.entry(peer);
      if (entry.session !== session) return;
      entry.session = undefined;
      if (!this.paused) this.transition(peer, 'unreachable', entry.lastError ?? 'Peer disconnected');
      this.schedule(peer, this.backoff(entry));
    });
    conn.on('frame', (frame: Frame) => {
      if (this.paused || !this.running) { conn.destroy(); return; }
      try { this.receive(session, frame); }
      catch (error) { this.opts.logger.error('Peer frame handling failed', error); this.fail(conn, 'internal', 'Could not process peer frame'); }
    });
    conn.send({ t: 'hello', protocol: PROTOCOL_VERSION, software: SOFTWARE_VERSION, project: this.opts.projectId,
      participant: this.opts.identity.participantId, name: this.opts.identity.name, addrs: this.addrs(), vector: this.opts.store.getVector() });
  }

  private receive(session: Session, frame: Frame): void {
    const { peer, conn } = session;
    const entry = this.entry(peer);
    const now = this.now().toISOString();
    session.lastReceivedAt = this.now().getTime();
    entry.lastSyncAt = now;
    this.opts.store.setPeerSeen(peer, now);
    if (frame.t === 'error') {
      entry.lastError = `${frame.code}: ${frame.message}`;
      this.opts.logger.warn('Peer reported error', { peer, code: frame.code, message: frame.message });
      if (frame.fatal) conn.close();
      return;
    }
    if (frame.t === 'hello') { this.hello(session, frame); return; }
    if (!session.ready || entry.session !== session) { this.fail(conn, 'bad_frame', 'Expected hello before peer data'); return; }
    switch (frame.t) {
      case 'events': {
        const previous = this.ingestingPeer;
        this.ingestingPeer = peer;
        try {
          const res = this.opts.store.ingest(frame.events, { via: 'peer', peer });
          const ids = [...res.accepted.map(e => e.id), ...res.duplicates, ...res.parked];
          // The sender evidently holds every event it sent us (incl. relayed third-party events).
          this.opts.store.markDelivered(peer, ids);
          if (!ids.length) conn.send({ t: 'ack', ids: [] });
          for (let i = 0; i < ids.length; i += LIMITS.ackIds) conn.send({ t: 'ack', ids: ids.slice(i, i + LIMITS.ackIds) });
          if (res.rejected.length || res.forks.length) this.opts.logger.warn('Peer events rejected', { peer, rejected: res.rejected, forks: res.forks });
        } finally { this.ingestingPeer = previous; }
        return;
      }
      case 'ack': this.opts.store.markDelivered(peer, frame.ids); return;
      case 'status': this.opts.store.applyPeerStatus(peer, { retrieved: frame.retrieved, sessions: frame.sessions, pending: frame.pending }); return;
      case 'ping': conn.send({ t: 'pong', at: frame.at }); return;
      case 'pong': return;
      default: this.fail(conn, 'bad_frame', `Unexpected ${frame.t} on paired connection`);
    }
  }

  private hello(session: Session, frame: HelloFrame): void {
    const { conn, peer } = session;
    if (!this.validateProtocol(conn, frame.protocol, frame.project)) return;
    if (session.ready) { this.fail(conn, 'bad_frame', 'Duplicate hello'); return; }
    if (frame.participant !== peer || !this.opts.directory.getPeer(peer)) {
      this.fail(conn, 'unknown_participant', 'Hello participant does not match the authenticated PSK identity'); return;
    }
    const entry = this.entry(peer);
    const existing = entry.session;
    if (existing) {
      const preferOutbound = this.opts.identity.participantId < peer;
      if (existing.outbound === preferOutbound || session.outbound !== preferOutbound) { conn.close(); return; }
    }
    entry.session = session;
    session.ready = true;
    session.remoteVector = frame.vector;
    clearTimeout(session.deadline);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    existing?.conn.close();
    const current = this.opts.directory.getPeer(peer)!;
    if (JSON.stringify(current.addrs) !== JSON.stringify(frame.addrs)) this.opts.directory.updatePeerAddrs(peer, frame.addrs);
    this.opts.store.markDeliveredByVector(peer, frame.vector);
    entry.failures = 0;
    this.transition(peer, 'connected');
    this.replay(session);
    this.sendStatus(session, true);
  }

  private validateProtocol(conn: FramedConnection, protocol: number, project: string): boolean {
    if (project !== this.opts.projectId) {
      this.fail(conn, 'wrong_project', `Peer project ${project} differs from local project ${this.opts.projectId}`); return false;
    }
    if (protocol !== PROTOCOL_VERSION) {
      this.fail(conn, 'incompatible_protocol', `Peer protocol ${protocol} is incompatible with local protocol ${PROTOCOL_VERSION}; update Catalyst on both laptops`); return false;
    }
    return true;
  }

  private fail(conn: FramedConnection, code: ErrorCode, message: string): void {
    conn.send({ t: 'error', code, message, fatal: true });
    conn.close();
  }

  private replay(session: Session): void {
    for (const author of Object.keys(this.opts.store.getVector()).sort()) {
      let after = session.remoteVector[author] ?? 0;
      while (true) {
        const events = this.opts.store.getEventsAfter(author, after, LIMITS.maxEventsPerFrame);
        if (!events.length) break;
        this.sendEvents(session, events, true);
        const next = events[events.length - 1]!.seq;
        if (next <= after) throw new Error('Store replay did not advance');
        after = next;
      }
    }
  }

  private sendEvents(session: Session, events: CatalystEvent[], replay: boolean): void {
    let batch: CatalystEvent[] = [];
    let bytes = 50;
    for (const event of events) {
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (batch.length && (batch.length >= LIMITS.maxEventsPerFrame || bytes + size > LIMITS.maxFrameBytes)) {
        session.conn.send({ t: 'events', events: batch, replay }); batch = []; bytes = 50;
      }
      batch.push(event); bytes += size;
    }
    if (batch.length) session.conn.send({ t: 'events', events: batch, replay });
  }

  private sendStatus(session: Session, force: boolean): void {
    const now = this.now().getTime();
    if (!force && now - session.lastStatusAt < (this.opts.statusIntervalMs ?? 5000)) return;
    const body = this.opts.store.takeStatusFor(session.peer);
    const summary = JSON.stringify({ sessions: body.sessions, pending: body.pending });
    if (force || body.retrieved.length || summary !== session.lastStatusSummary) {
      session.conn.send({ t: 'status', ...body });
      session.lastStatusAt = now;
      session.lastStatusSummary = summary;
    }
  }

  private discoverPeers(): void {
    for (const peer of this.opts.directory.listPeers()) {
      const entry = this.entry(peer.participantId);
      if (!entry.session && !entry.dialing && !entry.timer) this.schedule(peer.participantId, 0);
    }
  }

  private schedule(peer: string, delay: number): void {
    if (!this.running || this.paused) return;
    const entry = this.entry(peer);
    if (entry.session || entry.dialing || entry.timer) return;
    entry.redial = false;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      const task = this.dial(peer).catch(error => {
        this.opts.logger.error('Peer dial failed', error);
        if (this.running && !this.paused) this.transition(peer, 'unreachable', error instanceof Error ? error.message : String(error));
      });
      entry.dialing = task;
      void task.finally(() => {
        entry.dialing = undefined;
        if (!entry.session) this.schedule(peer, entry.redial ? 0 : this.backoff(entry));
      });
    }, delay);
  }

  private backoff(entry: PeerEntry): number {
    const min = this.opts.backoff?.minMs ?? BACKOFF_MIN_MS;
    const max = this.opts.backoff?.maxMs ?? BACKOFF_MAX_MS;
    const ceiling = Math.min(max, min * 2 ** Math.min(entry.failures++, 20));
    return Math.floor(min + Math.random() * Math.max(0, ceiling - min));
  }

  private async dial(peer: string): Promise<void> {
    const entry = this.entry(peer);
    const controller = new AbortController();
    entry.controller = controller;
    if (!this.running || this.paused || entry.session) return;
    this.transition(peer, 'connecting');
    const errors: string[] = [];
    for (const addr of this.opts.directory.getPeer(peer)?.addrs ?? []) {
      if (!this.running || this.paused || controller.signal.aborted || entry.session) return;
      try {
        const secret = this.opts.directory.getPeer(peer);
        if (!secret) return;
        const conn = await connectPeer({ ...parseAddress(addr), identity: `${PEER_IDENTITY_PREFIX}${this.opts.projectId}/${this.opts.identity.participantId}`,
          psk: derivePairPsk(secret.pairKey, this.opts.projectId, [this.opts.identity.participantId, peer]),
          timeoutMs: 5000, signal: controller.signal });
        if (!this.running || this.paused || controller.signal.aborted) { conn.destroy(); return; }
        const abort = () => conn.destroy();
        controller.signal.addEventListener('abort', abort, { once: true });
        // Wait for hello (or closure) before retrying, so a TLS success cannot create a dial storm.
        await new Promise<void>(resolve => {
          conn.once('close', resolve);
          conn.on('frame', (frame: Frame) => { if (frame.t === 'hello') resolve(); });
          this.session(conn, peer, true);
        });
        controller.signal.removeEventListener('abort', abort);
        if (entry.session || !this.running || this.paused || controller.signal.aborted) return;
        conn.destroy();
        errors.push(`${addr}: ${entry.lastError ?? 'Peer closed before a valid hello'}`);
      } catch (error) { errors.push(`${addr}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (this.running && !this.paused && !entry.session && !controller.signal.aborted) this.transition(peer, 'unreachable', errors.join('; ') || 'No peer addresses configured');
  }

  private hosts(hosts?: string[]): string[] {
    const explicit = hosts ?? this.opts.advertiseHosts;
    if (explicit.length) return explicit;
    const detected = Object.values(networkInterfaces()).flatMap(list => list ?? []).filter(i => !i.internal && i.family === 'IPv4').map(i => i.address);
    return detected.length ? [...new Set(detected)] : ['127.0.0.1'];
  }
  private addrs(hosts?: string[]): string[] { return this.hosts(hosts).map(host => formatAddress(host, this.server?.port ?? this.opts.port)); }

  createInvite({ ttlMinutes = INVITE_TTL_MINUTES_DEFAULT, hosts }: { ttlMinutes?: number; hosts?: string[] }): { token: string; inviteId: string; expiresAt: string; addrs: string[] } {
    if (!this.server || !this.running) throw new Error('Start the peer manager before creating an invitation');
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error('Invitation TTL must be positive');
    const inviteId = randomBytes(12).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + ttlMinutes * 60_000).toISOString();
    this.opts.invites.createInvite({ inviteId, inviteKey: deriveInvitePsk(secret, this.opts.projectId, inviteId).toString('base64'), expiresAt });
    const addrs = this.addrs(hosts);
    const token = encodeInvite({ v: 1, project: this.opts.projectId, projectName: this.opts.projectName, inviteId, secret, addrs, exp: expiresAt,
      inviter: { participant: this.opts.identity.participantId, name: this.opts.identity.name } });
    return { token, inviteId, expiresAt, addrs };
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    for (const peer of this.opts.directory.listPeers()) {
      const entry = this.entry(peer.participantId);
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.controller?.abort();
      entry.session = undefined;
      this.transition(peer.participantId, 'paused');
    }
    for (const conn of this.connections) conn.destroy();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const peer of this.opts.directory.listPeers()) this.transition(peer.participantId, 'unreachable');
    this.discoverPeers();
  }
  isPaused(): boolean { return this.paused; }

  status(): PeerStatus[] {
    return this.opts.directory.listPeers().map(peer => {
      const entry = this.entry(peer.participantId);
      return { participant: peer.participantId, name: peer.name, state: entry.state, since: entry.since,
        lastSyncAt: entry.lastSyncAt, lastError: entry.lastError, addrs: [...peer.addrs],
        pendingOutbound: this.opts.store.pendingOutbound(peer.participantId), sessions: this.opts.getPeerSessions?.(peer.participantId) ?? [],
        confirmCode: peer.confirmCode };
    });
  }

  setPeerAddrs(participant: string, addrs: string[]): void {
    addrs.forEach(parseAddress);
    this.opts.directory.updatePeerAddrs(participant, addrs);
    const entry = this.entry(participant);
    entry.redial = true;
    entry.controller?.abort();
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.session?.conn.destroy();
    entry.session = undefined;
    this.transition(participant, this.paused ? 'paused' : 'unreachable');
    this.schedule(participant, 0);
  }

  kick(): void {
    if (!this.running || this.paused) return;
    for (const peer of this.opts.directory.listPeers()) {
      const entry = this.entry(peer.participantId);
      if (entry.session?.ready) { this.replay(entry.session); this.sendStatus(entry.session, false); }
      else {
        entry.redial = true;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = undefined;
        this.schedule(peer.participantId, 0);
      }
    }
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => {});
    this.running = false;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const entry of this.peers.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.controller?.abort();
    }
    const closing = [...this.connections].map(conn => new Promise<void>(resolve => {
      conn.once('close', resolve);
      conn.destroy();
    }));
    const server = this.server;
    this.server = undefined;
    await server?.close();
    await Promise.all([...closing, ...[...this.peers.values()].map(entry => entry.dialing)]);
  }
}
