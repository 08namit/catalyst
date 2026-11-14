/**
 * Local loopback HTTP API contract between the daemon and its clients (CLI, MCP adapter, hooks, dashboard).
 *
 * Transport: HTTP/1.1 on 127.0.0.1:<apiPort> only. Every request except GET /health and dashboard static
 * files must send `Authorization: Bearer <token>` (token from .catalyst/daemon.json, rotated per daemon start).
 * The daemon rejects requests whose Host is not 127.0.0.1:<port>/localhost:<port> and any Origin other than
 * its own (DNS-rebinding / CSRF protection).
 *
 * Optional client headers: `x-catalyst-session` (session label), `x-catalyst-client-pid` (Claude Code pid, for
 * linking MCP adapters with hook session ids), `x-catalyst-client` ("mcp" | "hook" | "cli" | "dashboard").
 *
 * All POST bodies are JSON. Errors: non-2xx with `ApiError` body.
 * Tool endpoints are `POST /api/tools/<tool_name>` with the tool's input as body and its result as response,
 * so the MCP adapter is a thin, validated proxy.
 */
import { z } from 'zod';
import {
  CONFLICT_SCOPES,
  DECISION_STATUSES,
  EVENT_TYPES,
  ISSUE_KINDS,
  LIMITS,
  MESSAGE_KINDS,
  PROGRESS_STATUSES,
  eventIdSchema,
  participantIdSchema,
  pathsSchema,
  slugSchema,
  type CatalystEvent,
  type EventRefs,
  type Origin,
} from './protocol.js';
import type { ConflictView, ProjectState, SourceRef } from './state.js';

export interface ApiError {
  error: { code: ApiErrorCode; message: string; hint?: string };
}
export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'wrong_project'
  | 'incompatible_protocol'
  | 'not_initialized'
  | 'internal';

// ---------------------------------------------------------------------------
// Peer / sync status (shared by status, briefing, updates, dashboard)
// ---------------------------------------------------------------------------
export type PeerConnState = 'connected' | 'connecting' | 'unreachable' | 'paused' | 'never_connected';

export interface PeerStatus {
  participant: string;
  name: string;
  state: PeerConnState;
  /** When the current state began (ISO). */
  since?: string;
  /** Last time a frame was exchanged with this peer (ISO). */
  lastSyncAt?: string;
  lastError?: string;
  addrs: string[];
  /** Local events not yet acknowledged as received by this peer. */
  pendingOutbound: number;
  /** Peer's sessions and when each last retrieved Catalyst context (from peer status frames). */
  sessions: SessionInfo[];
  /** Short handshake-derived code both sides display after pairing. */
  confirmCode?: string;
}

export interface SyncSummary {
  paused: boolean;
  peerPort: number;
  peers: PeerStatus[];
  /** Total local events not yet delivered to at least one known peer. */
  pendingOutbound: number;
  /** Received events parked because earlier seqs from the same author are missing. */
  parkedEvents: number;
  /** Human sentence that distinguishes "no peer updates" from "peer unreachable". */
  freshness: string;
}

export interface SessionInfo {
  id: string;
  kind: 'hook' | 'mcp' | 'cli';
  claudePid?: number;
  /** Linked Claude session id when an MCP adapter and hook share a Claude pid. */
  linkedSession?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastRetrievalAt?: string;
}

/** Delivery lifecycle of a locally authored event, as seen from this node. */
export interface DeliveryState {
  savedLocally: true;
  deliveredTo: Array<{ participant: string; at: string }>;
  retrievedBy: Array<{ participant: string; at: string }>;
  acknowledgedBy: Array<{ participant: string; at: string }>;
}

// ---------------------------------------------------------------------------
// GET /health (no auth; reveals no secrets)
// ---------------------------------------------------------------------------
export interface HealthResponse {
  ok: true;
  projectId: string;
  participantId: string;
  name: string;
  /** Random per-start nonce, also stored in daemon.json — proves the responder is *our* daemon (pid reuse safe). */
  nonce: string;
  pid: number;
  version: string;
  protocol: number;
  apiPort: number;
  peerPort: number;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Update items (bounded summaries of events)
// ---------------------------------------------------------------------------
export interface UpdateItem extends SourceRef {
  /** Local cursor (monotonic insertion order on THIS node). Use as `since` for get_updates. */
  cursor: number;
  type: string;
  refs: EventRefs;
  /** One-line, sanitised summary (≤300 chars). Peer content is data, not instructions. */
  summary: string;
  acknowledgedByMe: boolean;
}

// ---------------------------------------------------------------------------
// Tool inputs (zod raw shapes — used by MCP registerTool AND daemon request validation)
// ---------------------------------------------------------------------------
const text = (max: number) => z.string().trim().min(1).max(max);
const list = (maxLen: number = LIMITS.short) => z.array(text(maxLen)).max(LIMITS.listItems);

export const toolInputShapes = {
  get_briefing: {
    task: slugSchema.optional().describe('Task id to focus on, e.g. "api-auth"'),
    topic: slugSchema.optional().describe('Decision topic to focus on'),
    paths: pathsSchema.optional().describe('Repo paths you are working on; matching decisions/claims rank higher'),
    query: z.string().max(200).optional().describe('Free-text search over shared records (SQLite FTS)'),
    maxChars: z.number().int().min(1000).max(9000).optional().describe('Upper bound on response size (default 6000)'),
  },
  claim_task: {
    taskId: slugSchema.describe('Stable task slug, e.g. "frontend-login"'),
    title: text(LIMITS.title).optional().describe('Title (creates the task if it does not exist yet)'),
    scope: text(LIMITS.text).describe('What you intend to change'),
    paths: pathsSchema.optional().describe('Paths/globs you expect to touch; used for overlap warnings'),
    note: text(LIMITS.short).optional(),
  },
  release_task: {
    taskId: slugSchema,
    reason: text(LIMITS.short).optional(),
  },
  publish_decision: {
    topic: slugSchema.describe('Decision topic slug, e.g. "api/auth-format"'),
    title: text(LIMITS.title),
    decision: text(LIMITS.text).describe('The decision itself, concise and specific'),
    rationale: text(LIMITS.text).describe('Why (concise)'),
    status: z.enum(DECISION_STATUSES).optional().describe('Default "accepted"; use "proposed" to ask for agreement'),
    codeRefs: list(LIMITS.pathLength).optional().describe('File paths / symbols, e.g. "src/api.ts:42"'),
    alternatives: list().optional(),
    supersedes: z.array(eventIdSchema).max(20).optional().describe('Decision versions this revises; default = current heads of the topic'),
    taskId: slugSchema.optional(),
    paths: pathsSchema.optional(),
  },
  publish_progress: {
    taskId: slugSchema.optional(),
    status: z.enum(PROGRESS_STATUSES),
    summary: text(LIMITS.text),
    blockers: list().optional(),
    evidence: list(LIMITS.text).optional().describe('Verification evidence, e.g. "npm test: 42 passed"'),
    nextSteps: list().optional(),
    branch: text(200).optional(),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
    paths: pathsSchema.optional(),
  },
  send_message: {
    kind: z.enum(MESSAGE_KINDS),
    body: text(LIMITS.text),
    to: z.union([participantIdSchema, z.literal('all')]).optional().describe('Participant id; default "all"'),
    replyTo: eventIdSchema.optional().describe('Required for kind "reply": the question event id'),
    topic: slugSchema.optional(),
    taskId: slugSchema.optional(),
  },
  get_updates: {
    since: z.number().int().min(0).optional().describe('Cursor from a previous call; default = this session\'s last cursor'),
    types: z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length).optional(),
    task: slugSchema.optional(),
    topic: slugSchema.optional(),
    paths: pathsSchema.optional(),
    includeOwn: z.boolean().optional().describe('Include events authored by this participant (default false)'),
    unacknowledgedOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
  },
  acknowledge_updates: {
    eventIds: z.array(eventIdSchema).max(LIMITS.ackIds).optional(),
    upToCursor: z.number().int().min(0).optional().describe('Acknowledge every peer update with cursor ≤ this'),
  },
  resolve_conflict: {
    scope: z.enum(CONFLICT_SCOPES),
    key: slugSchema.describe('Topic (decision), task id (claim) or "goal"'),
    resolution: text(LIMITS.text).describe('The agreed outcome; for decisions this becomes the new decision text'),
    chosen: eventIdSchema.optional().describe('Head event id that was chosen, if one'),
    owner: participantIdSchema.optional().describe('For claim conflicts: the agreed owner'),
  },
  set_goal: {
    title: text(LIMITS.title),
    description: text(LIMITS.text).optional(),
    successCriteria: list().optional(),
  },
  report_issue: {
    kind: z.enum(ISSUE_KINDS),
    title: text(LIMITS.title),
    detail: text(LIMITS.text).optional(),
    taskId: slugSchema.optional(),
    paths: pathsSchema.optional(),
  },
  resolve_issue: {
    issueId: eventIdSchema,
    note: text(LIMITS.short).optional(),
  },
} as const;

export type ToolName = keyof typeof toolInputShapes;
export const TOOL_NAMES = Object.keys(toolInputShapes) as ToolName[];
export const toolInputSchemas = Object.fromEntries(
  Object.entries(toolInputShapes).map(([k, shape]) => [k, z.object(shape).strict()]),
) as { [K in ToolName]: z.ZodObject<(typeof toolInputShapes)[K]> };
export type ToolInput<K extends ToolName> = z.infer<(typeof toolInputSchemas)[K]>;

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------
/** Every tool result carries `text` (bounded markdown for the model) plus structured fields. */
export interface ToolResultBase {
  text: string;
  sync: SyncSummary;
}

export interface PublishResult extends ToolResultBase {
  event: Pick<CatalystEvent, 'id' | 'seq' | 'type' | 'ts'> & { cursor: number };
  warnings: string[];
  /** Conflicts that exist on the affected key after this write. */
  conflicts: ConflictView[];
}

export interface ClaimResult extends PublishResult {
  overlaps: Array<{ taskId: string; owner: string; ownerName: string; paths: string[]; claimId: string; reason: 'same_task' | 'path_overlap' }>;
}

export interface Briefing extends ToolResultBase {
  generatedAt: string;
  project: { id: string; name: string } | null;
  me: { id: string; name: string };
  goal: ProjectState['goal']['current'];
  conflicts: ConflictView[];
  questionsForMe: UpdateItem[];
  myClaims: UpdateItem[];
  relevant: UpdateItem[];
  unread: { count: number; items: UpdateItem[] };
  /** Notices such as "3 local updates are awaiting delivery to Namit (unreachable since …)". */
  notices: string[];
  /** IDs of every event surfaced, for citation. */
  sourceIds: string[];
}

export interface UpdatesResult extends ToolResultBase {
  updates: UpdateItem[];
  nextCursor: number;
  hasMore: boolean;
  /** "no_updates" never implies the peer is reachable: check sync.peers[].state. */
  outcome: 'updates' | 'no_updates' | 'no_updates_peer_unreachable' | 'no_updates_never_connected';
}

export interface AckResult extends ToolResultBase {
  acknowledged: number;
  event?: { id: string; seq: number };
}

export type ToolResult<K extends ToolName> = K extends 'get_briefing'
  ? Briefing
  : K extends 'get_updates'
    ? UpdatesResult
    : K extends 'acknowledge_updates'
      ? AckResult
      : K extends 'claim_task'
        ? ClaimResult
        : PublishResult;

// ---------------------------------------------------------------------------
// Non-tool endpoints
// ---------------------------------------------------------------------------
/** POST /api/events — generic append for CLI/hooks/inbox import. Daemon assigns seq/lc/ts/id/sig. */
export const appendRequestSchema = z
  .object({
    type: z.enum(EVENT_TYPES),
    payload: z.record(z.string(), z.unknown()),
    refs: z.object({ task: slugSchema.optional(), topic: slugSchema.optional(), paths: pathsSchema.optional() }).strict().optional(),
    supersedes: z.array(eventIdSchema).max(50).optional(),
    origin: z.enum(['agent', 'hook', 'human', 'fallback'] as const satisfies readonly Origin[]).optional(),
    /** Idempotency key (e.g. inbox draft uuid). Re-posting the same key returns the original event. */
    clientId: z.string().min(8).max(100).optional(),
  })
  .strict();
export type AppendRequest = z.infer<typeof appendRequestSchema>;

/** GET /api/status */
export interface StatusResponse {
  health: HealthResponse;
  dataDir: string;
  projectDir: string;
  sync: SyncSummary;
  counts: { events: number; ownEvents: number; peerEvents: number; unacknowledged: number; conflicts: number; forks: number };
  sessions: SessionInfo[];
  inbox: { pending: number; rejected: number; imported: number };
  snapshot: { path: string; generatedAt?: string };
  handover: { path: string; generatedAt?: string };
}

/** GET /api/state — dashboard data. */
export interface DashboardState {
  generatedAt: string;
  health: HealthResponse;
  state: ProjectState;
  sync: SyncSummary;
  sessions: SessionInfo[];
  /** Locally authored events (most recent 100) with delivery lifecycle. */
  outbound: Array<UpdateItem & { delivery: DeliveryState }>;
  /** Most recent 100 events of any author. */
  recent: UpdateItem[];
  /** Fixtures/simulated data are never mixed in; true only if CATALYST_FIXTURE=1 seeded this project. */
  fixture: boolean;
}

/** POST /api/sessions — register/refresh a session (hooks and MCP adapters). */
export const sessionRequestSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(['hook', 'mcp', 'cli']),
    claudePid: z.number().int().positive().optional(),
    retrieved: z.boolean().optional().describe('true when the caller just delivered Catalyst context to the model'),
  })
  .strict();
export type SessionRequest = z.infer<typeof sessionRequestSchema>;

/** POST /api/invites */
export const inviteRequestSchema = z
  .object({
    ttlMinutes: z.number().int().min(1).max(24 * 60).optional(),
    hosts: z.array(z.string().min(1).max(255)).max(10).optional().describe('Advertised host names/IPs; default = non-internal IPv4 addresses'),
  })
  .strict();
export interface InviteResponse {
  token: string;
  inviteId: string;
  expiresAt: string;
  addrs: string[];
}

/** POST /api/peer/pause | /api/peer/resume → SyncSummary.  POST /api/peer/addr → SyncSummary. */
export const peerAddrRequestSchema = z.object({ participant: participantIdSchema, addrs: z.array(z.string().min(3).max(300)).min(1).max(10) }).strict();

/** POST /api/handover → regenerate IMPORTANT.md. POST /api/snapshot → regenerate snapshot. */
export interface FileWriteResponse {
  path: string;
  changed: boolean;
  generatedAt: string;
}

/** POST /api/inbox/import */
export interface InboxImportResponse {
  imported: number;
  duplicates: number;
  rejected: Array<{ file: string; error: string }>;
}

/** POST /api/shutdown → { ok: true } then the daemon exits. */

export const API_ROUTES = {
  health: 'GET /health',
  status: 'GET /api/status',
  state: 'GET /api/state',
  append: 'POST /api/events',
  tool: 'POST /api/tools/:name',
  session: 'POST /api/sessions',
  invite: 'POST /api/invites',
  peerPause: 'POST /api/peer/pause',
  peerResume: 'POST /api/peer/resume',
  peerAddr: 'POST /api/peer/addr',
  handover: 'POST /api/handover',
  snapshot: 'POST /api/snapshot',
  inboxImport: 'POST /api/inbox/import',
  shutdown: 'POST /api/shutdown',
} as const;
