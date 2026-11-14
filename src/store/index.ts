/**
 * SqliteEventStore: append-only, signed event log for one project (EventStore + SyncStore + InviteStore).
 * Own events get seq/lc/ts/id/sig assigned inside the insert transaction; received events are validated,
 * signature-checked, deduplicated, parked on gaps and drained in seq order.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  PROTOCOL_VERSION,
  canonicalJson,
  participantIdFromPublicKey,
  sanitizeForContext,
  signEvent,
  validateEnvelope,
  validatePayload,
  verifyEventSignature,
  computeEventId,
  type CatalystEvent,
  type EventRefs,
  type PayloadOf,
  type UnsignedEvent,
} from '../core/protocol.js';
import type { Identity } from '../core/config.js';
import type { Logger } from '../core/log.js';
import { nullLogger } from '../core/log.js';
import type { SessionInfo, UpdateItem } from '../core/api.js';
import type { ForkAlarm, ProjectState } from '../core/state.js';
import type {
  AppendInput,
  AppendSource,
  EventStore,
  IngestResult,
  IngestSource,
  PeerStatusBody,
  StoredEvent,
} from '../core/interfaces.js';
import { openDatabase, type Row } from './db.js';
import { project } from './projections.js';
import { summarizeEvent } from './text.js';

export { project } from './projections.js';
export { buildBriefing } from './briefing.js';
export { getUpdates, acknowledge } from './updates.js';
export { pathsOverlap } from './paths-match.js';
export { summarizeEvent } from './text.js';

const STATUS_RETRIEVAL_CAP = 200;
const SESSION_LIST_CAP = 50;

export interface OpenStoreOptions {
  dbPath: string;
  projectId: string;
  identity: Identity;
  logger?: Logger;
  now?: () => Date;
}

type Listener = (events: CatalystEvent[], source: AppendSource) => void;

export class SqliteEventStore implements EventStore {
  readonly projectId: string;
  readonly me: string;
  private readonly listeners = new Set<Listener>();
  private cached: ProjectState | null = null;

  private constructor(
    private readonly db: DatabaseSync,
    projectId: string,
    private readonly identity: Identity,
    private readonly logger: Logger,
    private readonly now: () => Date,
  ) {
    this.projectId = projectId;
    this.me = identity.participantId;
  }

  static open(opts: OpenStoreOptions): SqliteEventStore {
    if (participantIdFromPublicKey(opts.identity.publicKey) !== opts.identity.participantId) {
      throw new Error('identity.json is inconsistent: participantId does not match publicKey. Re-run `catalyst init`.');
    }
    const db = openDatabase(opts.dbPath, opts.projectId);
    const store = new SqliteEventStore(db, opts.projectId, opts.identity, opts.logger ?? nullLogger, opts.now ?? (() => new Date()));
    store.db
      .prepare('INSERT OR IGNORE INTO participants (id, name, public_key, source) VALUES (?, ?, ?, ?)')
      .run(store.me, opts.identity.name, opts.identity.publicKey, 'self');
    return store;
  }

  /** Emit participant.joined (seq 1) if this participant has no events yet, and project.created on the creating node. */
  bootstrap(opts: { name: string; projectName?: string; createdByMe: boolean }): void {
    if (this.count('SELECT COUNT(*) AS n FROM events WHERE author = ?', this.me) === 0) {
      this.append({ type: 'participant.joined', payload: { name: opts.name, publicKey: this.identity.publicKey }, origin: 'system' });
    }
    if (opts.createdByMe && this.count("SELECT COUNT(*) AS n FROM events WHERE type = 'project.created'") === 0) {
      this.append({ type: 'project.created', payload: { name: opts.projectName ?? 'Catalyst project' }, origin: 'system' });
    }
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  private nowIso(): string {
    return this.now().toISOString();
  }

  private count(sql: string, ...params: Array<string | number>): number {
    return Number(this.db.prepare(sql).get(...params)?.n ?? 0);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private toStored(row: Row): StoredEvent {
    return {
      event: JSON.parse(row.json as string) as CatalystEvent,
      cursor: Number(row.cursor),
      receivedAt: row.received_at as string,
      source: row.source as string,
    };
  }

  private emit(events: CatalystEvent[], source: AppendSource): void {
    if (events.length === 0) return;
    for (const l of this.listeners) {
      try {
        l(events, source);
      } catch (err) {
        this.logger.error('onAppend listener failed', err);
      }
    }
  }

  private insertEvent(e: CatalystEvent, source: string, clientId: string | null): number {
    const r = this.db
      .prepare(
        'INSERT INTO events (id, author, seq, lc, type, ts, json, source, received_at, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(e.id, e.author, e.seq, e.lc, e.type, e.ts, JSON.stringify(e), source, this.nowIso(), clientId);
    const cursor = Number(r.lastInsertRowid);
    this.db.prepare('INSERT INTO events_fts (rowid, id, text) VALUES (?, ?, ?)').run(cursor, e.id, ftsText(e));
    if (e.v <= PROTOCOL_VERSION) {
      if (e.type === 'participant.joined') {
        const p = e.payload as PayloadOf<'participant.joined'>;
        this.db
          .prepare(
            'INSERT INTO participants (id, name, public_key, source) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name',
          )
          .run(e.author, p.name, p.publicKey, 'event');
      } else if (e.type === 'ack.recorded') {
        const ins = this.db.prepare('INSERT OR IGNORE INTO acks (event_id, participant, at, ack_id) VALUES (?, ?, ?, ?)');
        for (const id of (e.payload as PayloadOf<'ack.recorded'>).eventIds) ins.run(id, e.author, e.ts, e.id);
      }
    }
    this.cached = null;
    return cursor;
  }

  private publicKeyOf(id: string): string | null {
    return (this.db.prepare('SELECT public_key FROM participants WHERE id = ?').get(id)?.public_key as string | undefined) ?? null;
  }

  private nameOf(id: string): string {
    return (this.db.prepare('SELECT name FROM participants WHERE id = ?').get(id)?.name as string | undefined) ?? id;
  }

  private contiguous(author: string): number {
    return Number(this.db.prepare('SELECT MAX(seq) AS s FROM events WHERE author = ?').get(author)?.s ?? 0);
  }

  // ---------------------------------------------------------------------------
  // append (local)
  // ---------------------------------------------------------------------------
  append(input: AppendInput): { event: CatalystEvent; cursor: number; duplicate: boolean } {
    const result = this.tx(() => {
      if (input.clientId) {
        const row = this.db.prepare('SELECT * FROM events WHERE client_id = ?').get(input.clientId);
        if (row) {
          const s = this.toStored(row);
          return { event: s.event, cursor: s.cursor, duplicate: true };
        }
      }
      const valid = validatePayload(input.type, input.payload);
      if (!valid.ok) throw new Error(`Invalid ${input.type} payload: ${valid.error}. Fix the listed fields and retry.`);

      const refs: EventRefs = { ...(input.refs ?? {}) };
      const p = input.payload as Record<string, unknown>;
      if (refs.task === undefined && typeof p.taskId === 'string') refs.task = p.taskId;
      if (refs.topic === undefined && typeof p.topic === 'string') refs.topic = p.topic;
      if (input.type === 'conflict.resolved') {
        const c = p as PayloadOf<'conflict.resolved'>;
        if (c.scope === 'decision') refs.topic ??= c.key;
        if (c.scope === 'claim') refs.task ??= c.key;
      }
      const supersedes = input.supersedes && input.supersedes.length > 0 ? input.supersedes : this.defaultSupersedes(input);

      const body: UnsignedEvent = {
        v: PROTOCOL_VERSION,
        project: this.projectId,
        author: this.me,
        seq: this.contiguous(this.me) + 1,
        lc: Number(this.db.prepare('SELECT MAX(lc) AS m FROM events').get()?.m ?? 0) + 1,
        ts: this.nowIso(),
        type: input.type,
        payload: input.payload,
        refs,
        supersedes,
        origin: input.origin,
      };
      if (input.session !== undefined) body.session = input.session;
      const event = signEvent(body, this.identity.privateKey);
      const check = validateEnvelope(event);
      if (!check.ok) throw new Error(`Invalid ${input.type} event: ${check.error}`);
      const cursor = this.insertEvent(event, 'local', input.clientId ?? null);
      return { event, cursor, duplicate: false };
    });
    if (!result.duplicate) this.emit([result.event], 'local');
    return result;
  }

  private defaultSupersedes(input: AppendInput): string[] {
    const state = this.getState();
    const p = input.payload as Record<string, unknown>;
    const topicHeads = (topic: unknown) => state.decisions.find((d) => d.topic === topic)?.heads.map((h) => h.id) ?? [];
    const claimHeads = (taskId: unknown, mineOnly: boolean) =>
      state.tasks
        .find((t) => t.taskId === taskId)
        ?.claims.filter((c) => !mineOnly || c.owner === this.me)
        .map((c) => c.id) ?? [];
    switch (input.type) {
      case 'decision.recorded':
        return topicHeads(p.topic);
      case 'task.claimed':
      case 'task.released':
        return claimHeads(p.taskId, true);
      case 'goal.set':
        return state.goal.heads.map((g) => g.id);
      case 'conflict.resolved':
        if (p.scope === 'decision') return topicHeads(p.key);
        if (p.scope === 'claim') return claimHeads(p.key, false);
        return state.goal.heads.map((g) => g.id);
      default:
        return [];
    }
  }

  // ---------------------------------------------------------------------------
  // ingest (peer / import)
  // ---------------------------------------------------------------------------
  ingest(events: unknown[], source: IngestSource): IngestResult {
    const result: IngestResult = { accepted: [], duplicates: [], parked: [], rejected: [], forks: [] };
    const sourceLabel = source.via === 'peer' ? source.peer : 'import';
    try {
      this.tx(() => {
        const touched = new Set<string>();
        for (const raw of events) {
          try {
            const author = this.ingestOne(raw, sourceLabel, result);
            if (author) touched.add(author);
          } catch (err) {
            result.rejected.push({ id: rawId(raw), reason: `internal error: ${(err as Error).message}` });
          }
        }
        for (const author of touched) this.drainParked(author, result);
      });
    } catch (err) {
      this.logger.error('ingest transaction failed', err);
      return { accepted: [], duplicates: [], parked: [], rejected: events.map((r) => ({ id: rawId(r), reason: `storage error: ${(err as Error).message}` })), forks: [] };
    }
    if (result.rejected.length > 0) this.logger.warn('ingest rejected events', { source: sourceLabel, rejected: result.rejected.slice(0, 10) });
    this.emit(result.accepted, source.via === 'peer' ? 'peer' : 'import');
    return result;
  }

  /** Author key for verifying `e`: participant.joined is self-certifying; otherwise a registered key (or null). */
  private keyFor(e: CatalystEvent): { key: string | null; error?: string } {
    if (e.type === 'participant.joined' && e.v <= PROTOCOL_VERSION) {
      const key = (e.payload as PayloadOf<'participant.joined'>).publicKey;
      if (participantIdFromPublicKey(key) !== e.author) return { key: null, error: 'participant.joined publicKey does not match author id' };
      return { key };
    }
    return { key: this.publicKeyOf(e.author) };
  }

  private recordFork(author: string, seq: number, ids: string[], result: IngestResult): void {
    const fork: ForkAlarm = { author, seq, eventIds: ids, detectedAt: this.nowIso() };
    this.db.prepare('INSERT INTO forks (author, seq, ids, detected_at) VALUES (?, ?, ?, ?)').run(fork.author, fork.seq, JSON.stringify(fork.eventIds), fork.detectedAt);
    this.cached = null;
    result.forks.push(fork);
    this.logger.error('fork detected', fork);
  }

  /**
   * Returns the author when the event was stored or parked (so parked successors can be drained).
   * Order matters for safety: authenticate (hash, and signature when the key is known) BEFORE dedupe/fork
   * classification, so a forged event can neither reserve a seq slot nor fabricate a fork alarm.
   */
  private ingestOne(raw: unknown, sourceLabel: string, result: IngestResult): string | null {
    const v = validateEnvelope(raw);
    if (!v.ok) {
      result.rejected.push({ id: rawId(raw), reason: `invalid event: ${v.error}` });
      return null;
    }
    const e = v.event;
    if (e.project !== this.projectId) {
      result.rejected.push({ id: e.id, reason: `wrong project: event belongs to ${e.project}, this node is ${this.projectId}` });
      return null;
    }
    if (computeEventId(e) !== e.id) {
      result.rejected.push({ id: e.id, reason: 'event id does not match content hash' });
      return null;
    }
    const { key, error } = this.keyFor(e);
    if (error) {
      result.rejected.push({ id: e.id, reason: error });
      return null;
    }
    if (key !== null) {
      const sig = verifyEventSignature(e, key);
      if (!sig.ok) {
        result.rejected.push({ id: e.id, reason: `signature check failed: ${sig.reason}` });
        return null;
      }
    }
    if (this.db.prepare('SELECT 1 AS x FROM events WHERE id = ? UNION ALL SELECT 1 FROM parked WHERE id = ?').get(e.id, e.id)) {
      result.duplicates.push(e.id);
      return null;
    }
    // Stored events are always verified, so a verified clash with one is a genuine fork.
    const stored = this.db.prepare('SELECT id FROM events WHERE author = ? AND seq = ?').get(e.author, e.seq)?.id as string | undefined;
    if (stored !== undefined) {
      if (key === null) {
        result.rejected.push({ id: e.id, reason: `unverifiable event for ${e.author} seq ${e.seq}, which is already stored` });
        return null;
      }
      this.recordFork(e.author, e.seq, [stored, e.id], result);
      result.rejected.push({ id: e.id, reason: `fork: ${e.author} seq ${e.seq} already exists as ${stored.slice(0, 8)}` });
      return null;
    }
    if (key === null || e.seq > this.contiguous(e.author) + 1) {
      // Unknown key (arrives with the author's participant.joined) or a gap: park. Several candidates may be parked
      // for one slot; they are authenticated and fork-checked when drained.
      this.db
        .prepare('INSERT INTO parked (id, author, seq, json, source, received_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(e.id, e.author, e.seq, JSON.stringify(e), sourceLabel, this.nowIso());
      result.parked.push(e.id);
      return e.author;
    }
    this.insertEvent(e, sourceLabel, null);
    result.accepted.push(e);
    return e.author;
  }

  private drainParked(author: string, result: IngestResult): void {
    for (;;) {
      const next = this.contiguous(author) + 1;
      const rows = this.db.prepare('SELECT id, json, source FROM parked WHERE author = ? AND seq = ?').all(author, next);
      if (rows.length === 0) return;
      const valid: Array<{ e: CatalystEvent; source: string }> = [];
      for (const row of rows) {
        const e = JSON.parse(row.json as string) as CatalystEvent;
        const { key, error } = this.keyFor(e);
        if (key === null && !error) return; // still waiting for the author's key
        const sig = key === null ? { ok: false as const, reason: error ?? 'no key' } : verifyEventSignature(e, key);
        if (!sig.ok) {
          this.db.prepare('DELETE FROM parked WHERE id = ?').run(e.id);
          result.parked = result.parked.filter((id) => id !== e.id);
          result.rejected.push({ id: e.id, reason: `signature check failed: ${sig.reason}` });
          continue;
        }
        valid.push({ e, source: row.source as string });
      }
      if (valid.length === 0) continue; // all candidates were forgeries; the slot is still open
      if (valid.length > 1) {
        // Two authentic events for one slot: a real fork (e.g. a restored .catalyst/). Never pick one silently.
        this.recordFork(author, next, valid.map((x) => x.e.id), result);
        return;
      }
      const { e, source } = valid[0]!;
      this.db.prepare('DELETE FROM parked WHERE id = ?').run(e.id);
      this.insertEvent(e, source, null);
      result.parked = result.parked.filter((id) => id !== e.id);
      result.accepted.push(e);
    }
  }

  // ---------------------------------------------------------------------------
  // SyncStore
  // ---------------------------------------------------------------------------
  getVector(): Record<string, number> {
    const v: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT author, MAX(seq) AS s FROM events GROUP BY author ORDER BY author').all()) v[r.author as string] = Number(r.s);
    return v;
  }

  getEventsAfter(author: string, afterSeq: number, limit: number): CatalystEvent[] {
    return this.db
      .prepare('SELECT json FROM events WHERE author = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(author, afterSeq, limit)
      .map((r) => JSON.parse(r.json as string) as CatalystEvent);
  }

  markDelivered(peer: string, ids: string[]): void {
    if (ids.length === 0) return;
    const at = this.nowIso();
    this.tx(() => {
      const ins = this.db.prepare('INSERT OR IGNORE INTO deliveries (event_id, peer, at) SELECT id, ?, ? FROM events WHERE id = ?');
      for (const id of ids) ins.run(peer, at, id);
    });
  }

  markDeliveredByVector(peer: string, vector: Record<string, number>): void {
    const at = this.nowIso();
    this.tx(() => {
      const ins = this.db.prepare('INSERT OR IGNORE INTO deliveries (event_id, peer, at) SELECT id, ?, ? FROM events WHERE author = ? AND seq <= ?');
      for (const [author, seq] of Object.entries(vector)) {
        if (author === peer || typeof seq !== 'number' || !Number.isFinite(seq)) continue;
        ins.run(peer, at, author, seq);
      }
    });
  }

  pendingOutbound(peer: string): number {
    return this.count(
      'SELECT COUNT(*) AS n FROM events e WHERE e.author != ? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.event_id = e.id AND d.peer = ?)',
      peer,
      peer,
    );
  }

  onAppend(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  takeStatusFor(peer: string, opts: { fromStart?: boolean } = {}): PeerStatusBody {
    const retrieved = this.tx(() => {
      const mark = opts.fromStart ? 0 : Number(this.db.prepare('SELECT last_retrieval_rowid AS m FROM status_sent WHERE peer = ?').get(peer)?.m ?? 0);
      const rows = this.db
        .prepare('SELECT r.id AS rid, r.event_id, r.at FROM retrievals r JOIN events e ON e.id = r.event_id WHERE e.author = ? AND r.id > ? ORDER BY r.id LIMIT ?')
        .all(peer, mark, STATUS_RETRIEVAL_CAP);
      const last = rows.at(-1);
      if (last) {
        this.db
          .prepare('INSERT INTO status_sent (peer, last_retrieval_rowid) VALUES (?, ?) ON CONFLICT(peer) DO UPDATE SET last_retrieval_rowid = excluded.last_retrieval_rowid')
          .run(peer, Number(last.rid));
      }
      const seen = new Map<string, string>();
      for (const r of rows) if (!seen.has(r.event_id as string)) seen.set(r.event_id as string, r.at as string);
      return [...seen].map(([id, at]) => ({ id, at }));
    });
    return { retrieved, sessions: this.listSessions(), pending: this.pendingOutbound(peer) };
  }

  applyPeerStatus(peer: string, status: PeerStatusBody): void {
    this.tx(() => {
      const ins = this.db.prepare('INSERT OR IGNORE INTO remote_retrievals (event_id, participant, at) VALUES (?, ?, ?)');
      for (const r of Array.isArray(status.retrieved) ? status.retrieved.slice(0, 1000) : []) {
        if (r && typeof r.id === 'string' && typeof r.at === 'string') ins.run(r.id, peer, r.at);
      }
      const sessions = Array.isArray(status.sessions) ? status.sessions.slice(0, SESSION_LIST_CAP) : [];
      this.db.prepare('INSERT OR REPLACE INTO remote_sessions (peer, json) VALUES (?, ?)').run(peer, JSON.stringify(sessions));
    });
  }

  addKnownParticipant(id: string, name: string, publicKey: string): void {
    if (participantIdFromPublicKey(publicKey) !== id) throw new Error(`Public key does not match participant id ${id}; refusing to register it.`);
    this.db
      .prepare('INSERT INTO participants (id, name, public_key, source) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, name, publicKey, 'pairing');
  }

  /** Without `error`: records a successful sync at `at` (clears lastError). With `error`: records the error, keeps lastSyncAt. */
  setPeerSeen(peer: string, at: string, error?: string): void {
    if (error === undefined) {
      this.db
        .prepare('INSERT INTO peer_seen (peer, last_sync_at, last_error) VALUES (?, ?, NULL) ON CONFLICT(peer) DO UPDATE SET last_sync_at = excluded.last_sync_at, last_error = NULL')
        .run(peer, at);
    } else {
      this.db
        .prepare('INSERT INTO peer_seen (peer, last_sync_at, last_error) VALUES (?, NULL, ?) ON CONFLICT(peer) DO UPDATE SET last_error = excluded.last_error')
        .run(peer, error);
    }
  }

  getPeerSeen(peer: string): { lastSyncAt?: string; lastError?: string } | null {
    const r = this.db.prepare('SELECT last_sync_at, last_error FROM peer_seen WHERE peer = ?').get(peer);
    if (!r) return null;
    const out: { lastSyncAt?: string; lastError?: string } = {};
    if (r.last_sync_at !== null) out.lastSyncAt = r.last_sync_at as string;
    if (r.last_error !== null) out.lastError = r.last_error as string;
    return out;
  }

  // ---------------------------------------------------------------------------
  // InviteStore
  // ---------------------------------------------------------------------------
  createInvite(rec: { inviteId: string; inviteKey: string; expiresAt: string }): void {
    const exp = Date.parse(rec.expiresAt);
    if (!Number.isFinite(exp)) throw new Error(`Invalid invite expiry: ${rec.expiresAt}`);
    this.db.prepare('INSERT INTO invites (id, key, expires_at, used_at) VALUES (?, ?, ?, NULL)').run(rec.inviteId, rec.inviteKey, exp);
  }

  getInviteKey(inviteId: string, now: Date): string | null {
    const r = this.db.prepare('SELECT key FROM invites WHERE id = ? AND used_at IS NULL AND expires_at > ?').get(inviteId, now.getTime());
    return (r?.key as string | undefined) ?? null;
  }

  consumeInvite(inviteId: string, now: Date): boolean {
    const r = this.db
      .prepare('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
      .run(now.toISOString(), inviteId, now.getTime());
    return Number(r.changes) === 1;
  }

  // ---------------------------------------------------------------------------
  // EventStore
  // ---------------------------------------------------------------------------
  findByClientId(clientId: string): StoredEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE client_id = ?').get(clientId);
    return row ? this.toStored(row) : null;
  }

  getEvent(id: string): StoredEvent | null {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    return r ? this.toStored(r) : null;
  }

  listSince(since: number, opts: { limit?: number; excludeAuthor?: string; types?: string[] } = {}): StoredEvent[] {
    let sql = 'SELECT * FROM events WHERE cursor > ?';
    const params: Array<string | number> = [since];
    if (opts.excludeAuthor !== undefined) {
      sql += ' AND author != ?';
      params.push(opts.excludeAuthor);
    }
    if (opts.types && opts.types.length > 0) {
      sql += ` AND type IN (${opts.types.map(() => '?').join(',')})`;
      params.push(...opts.types);
    }
    sql += ' ORDER BY cursor LIMIT ?';
    params.push(opts.limit ?? -1);
    return this.db.prepare(sql).all(...params).map((r) => this.toStored(r));
  }

  latestCursor(): number {
    return Number(this.db.prepare('SELECT MAX(cursor) AS c FROM events').get()?.c ?? 0);
  }

  private loadAll(): CatalystEvent[] {
    return this.db.prepare('SELECT json FROM events').all().map((r) => JSON.parse(r.json as string) as CatalystEvent);
  }

  private loadForks(): ForkAlarm[] {
    return this.db
      .prepare('SELECT author, seq, ids, detected_at FROM forks ORDER BY rowid')
      .all()
      .map((r) => ({ author: r.author as string, seq: Number(r.seq), eventIds: JSON.parse(r.ids as string) as string[], detectedAt: r.detected_at as string }));
  }

  getState(): ProjectState {
    this.cached ??= project(this.loadAll(), this.me, this.loadForks());
    return this.cached;
  }

  verifyProjection(): { ok: boolean; detail?: string } {
    const cached = canonicalJson(this.getState());
    const fresh = canonicalJson(project(this.loadAll(), this.me, this.loadForks()));
    if (cached === fresh) return { ok: true };
    let i = 0;
    while (i < cached.length && cached[i] === fresh[i]) i++;
    return { ok: false, detail: `projection mismatch at char ${i}: cached …${cached.slice(i, i + 80)}… vs rebuilt …${fresh.slice(i, i + 80)}…` };
  }

  search(query: string, limit: number): string[] {
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t}"*`).join(' OR ');
    try {
      return this.db
        .prepare('SELECT id FROM events_fts WHERE events_fts MATCH ? ORDER BY rank LIMIT ?')
        .all(match, Math.max(1, limit))
        .map((r) => r.id as string);
    } catch (err) {
      this.logger.warn('search failed', { query, err: (err as Error).message });
      return [];
    }
  }

  toUpdateItem(s: StoredEvent): UpdateItem {
    const e = s.event;
    return {
      id: e.id,
      author: e.author,
      authorName: this.nameOf(e.author),
      seq: e.seq,
      ts: e.ts,
      origin: e.origin,
      cursor: s.cursor,
      type: e.type,
      refs: e.refs,
      summary: sanitizeForContext(summarizeEvent(e), 300),
      acknowledgedByMe: this.isAcknowledgedByMe(e.id),
    };
  }

  retrievedBy(session: string): string[] {
    return this.db
      .prepare('SELECT event_id, MIN(rowid) AS r FROM retrievals WHERE session = ? GROUP BY event_id ORDER BY r')
      .all(session)
      .map((row) => row.event_id as string);
  }

  recordRetrieval(session: string, eventIds: string[], at: string = this.nowIso()): void {
    if (eventIds.length === 0) return;
    this.tx(() => {
      const ins = this.db.prepare('INSERT INTO retrievals (event_id, session, at) VALUES (?, ?, ?)');
      for (const id of new Set(eventIds)) ins.run(id, session, at);
      this.db.prepare('UPDATE sessions SET last_retrieval = ? WHERE id = ?').run(at, session);
    });
  }

  getSessionCursor(session: string): number {
    return Number(this.db.prepare('SELECT cursor FROM session_cursors WHERE key = ?').get(session)?.cursor ?? 0);
  }

  setSessionCursor(session: string, cursor: number): void {
    this.db
      .prepare('INSERT INTO session_cursors (key, cursor) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET cursor = excluded.cursor')
      .run(session, cursor);
  }

  isAcknowledgedByMe(eventId: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM acks WHERE event_id = ? AND participant = ?').get(eventId, this.me) !== undefined;
  }

  upsertSession(info: { id: string; kind: SessionInfo['kind']; claudePid?: number; retrieved?: boolean; at?: string }): SessionInfo {
    const at = info.at ?? this.nowIso();
    this.db
      .prepare(
        `INSERT INTO sessions (id, kind, claude_pid, first_seen, last_seen, last_retrieval) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, claude_pid = COALESCE(excluded.claude_pid, claude_pid),
           last_seen = excluded.last_seen, last_retrieval = COALESCE(excluded.last_retrieval, last_retrieval)`,
      )
      .run(info.id, info.kind, info.claudePid ?? null, at, at, info.retrieved ? at : null);
    return this.toSession(this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.id)!);
  }

  private toSession(r: Row): SessionInfo {
    const s: SessionInfo = { id: r.id as string, kind: r.kind as SessionInfo['kind'], firstSeenAt: r.first_seen as string, lastSeenAt: r.last_seen as string };
    if (r.claude_pid !== null) {
      s.claudePid = Number(r.claude_pid);
      const linked = this.db
        .prepare('SELECT id FROM sessions WHERE claude_pid = ? AND kind != ? AND id != ? ORDER BY last_seen DESC LIMIT 1')
        .get(s.claudePid, s.kind, s.id);
      if (linked) s.linkedSession = linked.id as string;
    }
    if (r.last_retrieval !== null) s.lastRetrievalAt = r.last_retrieval as string;
    return s;
  }

  listSessions(): SessionInfo[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY last_seen DESC, id LIMIT ?')
      .all(SESSION_LIST_CAP)
      .map((r) => this.toSession(r));
  }

  deliveryState(eventId: string): {
    deliveredTo: Array<{ participant: string; at: string }>;
    retrievedBy: Array<{ participant: string; at: string }>;
    acknowledgedBy: Array<{ participant: string; at: string }>;
  } {
    const rows = (sql: string) =>
      this.db
        .prepare(sql)
        .all(eventId)
        .map((r) => ({ participant: r.p as string, at: r.at as string }));
    return {
      deliveredTo: rows('SELECT peer AS p, at FROM deliveries WHERE event_id = ? ORDER BY at, peer'),
      retrievedBy: rows('SELECT participant AS p, at FROM remote_retrievals WHERE event_id = ? ORDER BY at, participant'),
      acknowledgedBy: rows('SELECT participant AS p, at FROM acks WHERE event_id = ? ORDER BY at, participant'),
    };
  }

  peerSessions(peer: string): SessionInfo[] {
    const r = this.db.prepare('SELECT json FROM remote_sessions WHERE peer = ?').get(peer);
    return r ? (JSON.parse(r.json as string) as SessionInfo[]) : [];
  }

  parkedCount(): number {
    return this.count('SELECT COUNT(*) AS n FROM parked');
  }

  /** Peer events (excluding ack.recorded) that this participant has not acknowledged, oldest first. */
  unacknowledged(limit = -1): StoredEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM events e WHERE e.author != ? AND e.type != 'ack.recorded' AND NOT EXISTS (SELECT 1 FROM acks a WHERE a.event_id = e.id AND a.participant = ?) ORDER BY cursor LIMIT ?",
      )
      .all(this.me, this.me, limit)
      .map((r) => this.toStored(r));
  }

  counts(): { events: number; ownEvents: number; peerEvents: number; unacknowledged: number } {
    return {
      events: this.count('SELECT COUNT(*) AS n FROM events'),
      ownEvents: this.count('SELECT COUNT(*) AS n FROM events WHERE author = ?', this.me),
      peerEvents: this.count('SELECT COUNT(*) AS n FROM events WHERE author != ?', this.me),
      unacknowledged: this.count(
        "SELECT COUNT(*) AS n FROM events e WHERE e.author != ? AND e.type != 'ack.recorded' AND NOT EXISTS (SELECT 1 FROM acks a WHERE a.event_id = e.id AND a.participant = ?)",
        this.me,
        this.me,
      ),
    };
  }

  close(): void {
    this.listeners.clear();
    if (this.db.isOpen) this.db.close();
  }
}

function rawId(raw: unknown): string | undefined {
  return raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? ((raw as { id: string }).id.slice(0, 64)) : undefined;
}

const NON_TEXT_KEYS = new Set(['publicKey', 'eventIds', 'issueId', 'replyTo', 'chosen', 'owner', 'to', 'hash']);

/** Text indexed by FTS5: type + refs + every string value of the payload except keys/ids. */
function ftsText(e: CatalystEvent): string {
  const parts: string[] = [e.type, e.refs.task ?? '', e.refs.topic ?? '', ...(e.refs.paths ?? [])];
  const walk = (v: unknown, key?: string) => {
    if (key !== undefined && NON_TEXT_KEYS.has(key)) return;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(e.payload);
  return parts.filter(Boolean).join('\n').slice(0, 20_000);
}
