/**
 * Module boundaries. Storage (src/store) implements EventStore + InviteStore.
 * Networking (src/sync) consumes SyncStore/InviteStore/PeerDirectory and exports PeerManager + joinWithInvite.
 * The daemon (src/daemon) wires them together.
 */
import type { CatalystEvent, EventRefs, EventType, Origin } from './protocol.js';
import type { PeerSecret } from './config.js';
import type { ForkAlarm, ProjectState } from './state.js';
import type { PeerStatus, SessionInfo, UpdateItem } from './api.js';
import type { Logger } from './log.js';

export interface AppendInput {
  type: EventType;
  payload: Record<string, unknown>;
  refs?: EventRefs;
  supersedes?: string[];
  origin: Origin;
  session?: string;
  /** Agent key of the writing agent inside this participant (default LEAD_AGENT; stored only when not lead). */
  agent?: string;
  /** Idempotency key: appending the same clientId twice returns the first event (duplicate: true). */
  clientId?: string;
}

export interface StoredEvent {
  event: CatalystEvent;
  /** Local insertion order on this node (monotonic). */
  cursor: number;
  receivedAt: string;
  /** 'local' | peer participant id | 'import' */
  source: string;
}

export type IngestSource = { via: 'peer'; peer: string } | { via: 'import' };

export interface IngestResult {
  /** Newly stored and applied (contiguous) events, in apply order. */
  accepted: CatalystEvent[];
  /** Already known (same id). Still safe to ack. */
  duplicates: string[];
  /** Stored in the parking table because an earlier seq from the same author is missing. */
  parked: string[];
  rejected: Array<{ id?: string; reason: string }>;
  forks: ForkAlarm[];
}

export type AppendSource = 'local' | 'peer' | 'import';

/** Content of a `status` frame body (also produced/consumed by the store). */
export interface PeerStatusBody {
  /** Events authored by the receiving peer that agents on this node retrieved, since the last status sent to that peer. */
  retrieved: Array<{ id: string; at: string }>;
  sessions: SessionInfo[];
  /** Local events this node still holds for delivery (informational). */
  pending: number;
}

/** Narrow interface that src/sync depends on. */
export interface SyncStore {
  readonly projectId: string;
  readonly me: string;
  /** Per-author highest CONTIGUOUS seq stored (parked events excluded). */
  getVector(): Record<string, number>;
  /** Events of `author` with seq > afterSeq, ascending, at most `limit`. */
  getEventsAfter(author: string, afterSeq: number, limit: number): CatalystEvent[];
  /** Validate, verify signature, dedupe, park gaps, drain parked. Never throws on bad input; reports rejects. */
  ingest(events: unknown[], source: IngestSource): IngestResult;
  /** Record that `peer` durably holds these events (direct ack). */
  markDelivered(peer: string, ids: string[]): void;
  /** Peer's hello vector proves it holds every event (author, seq ≤ vector[author]). */
  markDeliveredByVector(peer: string, vector: Record<string, number>): void;
  /** Count of events (not authored by `peer`) that `peer` has not acknowledged. */
  pendingOutbound(peer: string): number;
  /** Subscribe to newly applied events (local appends, peer ingests, imports). Returns unsubscribe. */
  onAppend(listener: (events: CatalystEvent[], source: AppendSource) => void): () => void;
  /**
   * Body for the next status frame to `peer` (advances an internal "sent" watermark). `fromStart` re-sends
   * retrieval receipts from the beginning (used on every new connection, since a status frame can be lost
   * with a dropped connection; receipts are idempotent at the receiver).
   */
  takeStatusFor(peer: string, opts?: { fromStart?: boolean }): PeerStatusBody;
  /** Store a peer's status frame (remote retrievals + sessions). */
  applyPeerStatus(peer: string, status: PeerStatusBody): void;
  /** Register a participant key learned during pairing (before its participant.joined event arrives). */
  addKnownParticipant(id: string, name: string, publicKey: string): void;
  /** Persisted peer freshness. */
  setPeerSeen(peer: string, at: string, error?: string): void;
  getPeerSeen(peer: string): { lastSyncAt?: string; lastError?: string } | null;
}

/** Single-use, expiring invitations. Key = HKDF-derived invite PSK (base64); the raw secret is never stored. */
export interface InviteStore {
  createInvite(rec: { inviteId: string; inviteKey: string; expiresAt: string }): void;
  /** Key if the invite exists, is unexpired and unused; else null. Does not consume. */
  getInviteKey(inviteId: string, now: Date): string | null;
  /** Atomically mark used. Returns false if already used/expired/unknown. */
  consumeInvite(inviteId: string, now: Date): boolean;
}

/** Persisted pairwise peers (secrets.json). Implemented by the daemon over src/core/config.ts. */
export interface PeerDirectory {
  listPeers(): PeerSecret[];
  getPeer(id: string): PeerSecret | null;
  addPeer(peer: PeerSecret): void;
  updatePeerAddrs(id: string, addrs: string[]): void;
}

/** Full store surface used by the daemon (superset of SyncStore). */
export interface EventStore extends SyncStore, InviteStore {
  append(input: AppendInput): { event: CatalystEvent; cursor: number; duplicate: boolean };
  getEvent(id: string): StoredEvent | null;
  /** Event previously appended with this idempotency key, if any. */
  findByClientId(clientId: string): StoredEvent | null;
  /**
   * Events with cursor > since, ascending. `excludeAuthor` drops every event of that participant;
   * `excludeAgent` drops only events written by that one agent ({author, agent}; lead = events without agent).
   */
  listSince(since: number, opts?: { limit?: number; excludeAuthor?: string; excludeAgent?: { author: string; agent: string }; types?: string[] }): StoredEvent[];
  latestCursor(): number;
  /** Deterministic projection (cached; invalidated on every insert). */
  getState(): ProjectState;
  /** Rebuild projection from scratch and compare with cached (reproducibility check). */
  verifyProjection(): { ok: boolean; detail?: string };
  /** SQLite FTS5 search over event text; returns event ids ranked. */
  search(query: string, limit: number): string[];
  toUpdateItem(e: StoredEvent): UpdateItem;
  // consumption
  recordRetrieval(session: string, eventIds: string[], at?: string): void;
  /** Event ids this session has been shown (recorded retrievals), oldest first. */
  retrievedBy(session: string): string[];
  getSessionCursor(session: string): number;
  setSessionCursor(session: string, cursor: number): void;
  /** Without `agent`: acknowledged by any of my agents. With `agent`: acknowledged by that agent of mine. */
  isAcknowledgedByMe(eventId: string, agent?: string): boolean;
  // sessions
  upsertSession(info: { id: string; kind: SessionInfo['kind']; claudePid?: number; retrieved?: boolean; at?: string }): SessionInfo;
  listSessions(): SessionInfo[];
  /** Delivery lifecycle for locally authored events. */
  deliveryState(eventId: string): { deliveredTo: Array<{ participant: string; at: string }>; retrievedBy: Array<{ participant: string; at: string }>; acknowledgedBy: Array<{ participant: string; at: string }> };
  peerSessions(peer: string): SessionInfo[];
  parkedCount(): number;
  /** `unacknowledged` = peer events not acked by any of my agents (or by `agent` when given). */
  counts(agent?: string): { events: number; ownEvents: number; peerEvents: number; unacknowledged: number };
  close(): void;
}

/**
 * Queue selection (pure, implemented in src/store/queue.ts as `pickNextTask`): the next task `agent` of `me`
 * should take. Rules, in order:
 *  1. If `taskId` is given, that task (if it exists and is not done) — even if not ready (reason reports it).
 *  2. A task this agent already holds a live claim on that is not done (resume).
 *  3. Otherwise the first task by (assignee === me first, then "any"; order; taskId) that is ready, has no live
 *     claim by anyone, is not done/abandoned, is not assigned to another participant, and whose paths do not
 *     overlap any live claim of another agent (pathsOverlap from src/store/paths-match.ts).
 * `remaining` counts tasks not done; `blocked` lists ready=false tasks waiting on dependencies.
 */
export interface QueuePick {
  task: import('./state.js').TaskView | null;
  reason: 'requested' | 'resume' | 'next' | 'none_ready' | 'all_done' | 'empty' | 'not_found' | 'already_done';
  remaining: number;
  blocked: Array<{ taskId: string; waitingOn: string[] }>;
}

/** Exported by src/sync/peer.ts. */
export interface PeerManagerApi {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  status(): PeerStatus[];
  createInvite(opts: { ttlMinutes?: number; hosts?: string[] }): { token: string; inviteId: string; expiresAt: string; addrs: string[] };
  setPeerAddrs(participant: string, addrs: string[]): void;
  /** Push newly appended events now (also triggered automatically via store.onAppend). */
  kick(): void;
}

/** Constructor options for `new PeerManager(opts)` in src/sync/peer.ts. */
export interface PeerManagerOptions {
  store: SyncStore;
  invites: InviteStore;
  directory: PeerDirectory;
  identity: { participantId: string; name: string; publicKey: string };
  projectId: string;
  projectName: string;
  /** Peer listener bind address, e.g. "0.0.0.0" or "127.0.0.1". */
  bind: string;
  /** 0 = ephemeral (the actual port is returned by start()). */
  port: number;
  /** Hosts advertised in hello frames / invitations; empty = auto-detect non-internal IPv4 (fallback 127.0.0.1). */
  advertiseHosts: string[];
  logger: Logger;
  /** Peer sessions for PeerStatus.sessions (usually store.peerSessions). */
  getPeerSessions?: (peer: string) => SessionInfo[];
  /** Called after a joiner completes pairing with this node. */
  onPeerJoined?: (peer: PeerSecret) => void;
  /** Called whenever any peer's connection state changes. */
  onStatusChange?: (status: PeerStatus[]) => void;
  /** Test hooks. */
  backoff?: { minMs: number; maxMs: number };
  statusIntervalMs?: number;
  now?: () => Date;
}

/**
 * Filesystem fallback draft (.catalyst/inbox/<anything>.json), written by agents when the MCP server/daemon is
 * unavailable. Imported idempotently by the daemon (keyed by clientId); invalid files are moved to inbox/rejected/
 * with a sibling .error.txt. Exactly one of `tool` or `event` must be present.
 */
export interface InboxDraft {
  catalystDraft: 1;
  /** Unique id (e.g. a UUID) — the idempotency key. */
  clientId: string;
  /** Tool-shaped draft: same input as the MCP tool (publish_decision, publish_progress, send_message, claim_task, release_task, report_issue, resolve_issue, set_goal). */
  tool?: string;
  input?: Record<string, unknown>;
  /** Raw append (used by hooks for activity.captured when the daemon is down). */
  event?: { type: string; payload: Record<string, unknown>; refs?: EventRefs; supersedes?: string[] };
  /** Optional: when the draft was written (display only). */
  writtenAt?: string;
}
