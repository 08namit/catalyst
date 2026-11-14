/**
 * Catalyst wire/event protocol (v1). Shared contract for storage, sync, daemon, MCP and hooks.
 * See PROTOCOL.md for the prose description. Keep this file dependency-light (zod + node:crypto only).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { z } from 'zod';

/** v2: signed `agent` envelope field, agent.registered, task queue fields, agent-addressed messages. */
export const PROTOCOL_VERSION = 2 as const;
export const SOFTWARE_VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// Limits (bounded payloads keep MCP responses and peer frames small)
// ---------------------------------------------------------------------------
export const LIMITS = {
  title: 200,
  text: 4000,
  short: 500,
  listItems: 20,
  paths: 50,
  pathLength: 300,
  ackIds: 500,
  maxFrameBytes: 4 * 1024 * 1024,
  maxEventsPerFrame: 200,
} as const;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------
/** Participant ids are self-certifying: "p_" + first 24 hex chars of sha256(publicKey DER). */
export function participantIdFromPublicKey(publicKeyB64: string): string {
  return 'p_' + createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 24);
}
export function newProjectId(): string {
  return 'prj_' + randomBytes(12).toString('hex');
}
export const ID_PATTERNS = {
  participant: /^p_[0-9a-f]{24}$/,
  project: /^prj_[0-9a-f]{24}$/,
  event: /^[0-9a-f]{64}$/,
  /** task ids / topics are human slugs: "api-auth", "db/schema" */
  slug: /^[a-z0-9][a-z0-9._/-]{0,79}$/,
  /**
   * Agent key: stable identity of one agent inside a participant. "lead" = the main Claude session (and any
   * write without agent information); subagents use Claude Code's agent_id (e.g. "a7a6a241124692d30").
   */
  agent: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  /** "p_<24 hex>/<agent key>" — one agent of one participant (message addressing, claim owners). */
  agentAddress: /^p_[0-9a-f]{24}\/[a-z0-9][a-z0-9._-]{0,63}$/,
} as const;

/** Agent key used for the main session and for every event without an `agent` field. */
export const LEAD_AGENT = 'lead' as const;
/** Agent key of an event (events without the field belong to the lead). */
export function agentOf(e: { agent?: string }): string {
  return e.agent ?? LEAD_AGENT;
}
/** Owner key "participant/agent" used for per-agent ownership (claims, progress, decision heads). */
export function ownerKey(participant: string, agent: string = LEAD_AGENT): string {
  return `${participant}/${agent}`;
}
/** Turn an arbitrary Claude agent_id into a valid agent key (lowercase, allowed chars, ≤64). */
export function agentKeyFromId(agentId: string | undefined | null): string {
  if (!agentId) return LEAD_AGENT;
  const k = agentId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64);
  return k.length > 0 && k !== LEAD_AGENT ? k : LEAD_AGENT;
}

export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s.length > 0 ? s : 'untitled';
}

// ---------------------------------------------------------------------------
// Keys and signatures (Ed25519, keys as base64 DER: spki public / pkcs8 private)
// ---------------------------------------------------------------------------
export interface KeyPair {
  publicKey: string;
  privateKey: string;
}
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}
export function signBytes(privateKeyB64: string, data: Buffer): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return sign(null, data, key).toString('base64');
}
export function verifyBytes(publicKeyB64: string, data: Buffer, sigB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return verify(null, data, key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON: recursively sorted keys (code-point order), undefined omitted.
// ---------------------------------------------------------------------------
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number in canonical JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------
export const ORIGINS = ['agent', 'hook', 'human', 'fallback', 'system'] as const;
export type Origin = (typeof ORIGINS)[number];

export const EVENT_TYPES = [
  'project.created',
  'participant.joined',
  'goal.set',
  'task.created',
  'task.claimed',
  'task.released',
  'decision.recorded',
  'progress.reported',
  'issue.reported',
  'issue.resolved',
  'message.posted',
  'conflict.resolved',
  'ack.recorded',
  'activity.captured',
  'agent.registered',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Types that materially change the handover (IMPORTANT.md). ack/activity are excluded on purpose. */
export const MATERIAL_TYPES: ReadonlySet<string> = new Set<EventType>([
  'project.created',
  'participant.joined',
  'goal.set',
  'task.created',
  'task.claimed',
  'task.released',
  'decision.recorded',
  'progress.reported',
  'issue.reported',
  'issue.resolved',
  'message.posted',
  'conflict.resolved',
  'agent.registered',
]);

export interface EventRefs {
  task?: string;
  topic?: string;
  paths?: string[];
}

/** Body that is hashed (id) and signed (sig). */
export interface UnsignedEvent {
  v: number;
  project: string;
  author: string;
  seq: number;
  /** Lamport clock: 1 + max(lc of every event known to the author at creation). Used for deterministic ordering. */
  lc: number;
  /** ISO-8601 UTC wall-clock time. DISPLAY ONLY — never used for ordering or conflict resolution. */
  ts: string;
  type: string;
  payload: Record<string, unknown>;
  refs: EventRefs;
  /** Event ids this event revises/replaces (decision versions, claim heads, goal versions, conflict heads). */
  supersedes: string[];
  origin: Origin;
  /** Local session label (e.g. "claude:<session_id>" or "mcp:<pid>"); informational. */
  session?: string;
  /**
   * Agent key (ID_PATTERNS.agent) of the agent inside `author` that wrote this event. Absent = LEAD_AGENT.
   * Ownership is per (author, agent): decision heads, claims, progress, acks and unread are all per agent.
   */
  agent?: string;
}

export interface CatalystEvent extends UnsignedEvent {
  /** sha256 hex of canonicalJson(UnsignedEvent). */
  id: string;
  /** base64 Ed25519 signature by `author` over canonicalJson(UnsignedEvent). */
  sig: string;
}

export function eventBody(e: UnsignedEvent | CatalystEvent): UnsignedEvent {
  const body: UnsignedEvent = {
    v: e.v,
    project: e.project,
    author: e.author,
    seq: e.seq,
    lc: e.lc,
    ts: e.ts,
    type: e.type,
    payload: e.payload,
    refs: e.refs,
    supersedes: e.supersedes,
    origin: e.origin,
  };
  if (e.session !== undefined) body.session = e.session;
  if (e.agent !== undefined) body.agent = e.agent;
  return body;
}
export function computeEventId(body: UnsignedEvent): string {
  return createHash('sha256').update(canonicalJson(eventBody(body))).digest('hex');
}
export function signEvent(body: UnsignedEvent, privateKeyB64: string): CatalystEvent {
  const b = eventBody(body);
  const bytes = Buffer.from(canonicalJson(b));
  return { ...b, id: createHash('sha256').update(bytes).digest('hex'), sig: signBytes(privateKeyB64, bytes) };
}
/** Verifies hash id and signature. Does NOT check payload schema or seq continuity. */
export function verifyEventSignature(e: CatalystEvent, authorPublicKeyB64: string): { ok: true } | { ok: false; reason: string } {
  const bytes = Buffer.from(canonicalJson(eventBody(e)));
  const id = createHash('sha256').update(bytes).digest('hex');
  if (id !== e.id) return { ok: false, reason: 'event id does not match content hash' };
  if (participantIdFromPublicKey(authorPublicKeyB64) !== e.author) return { ok: false, reason: 'author id does not match public key' };
  if (!verifyBytes(authorPublicKeyB64, bytes, e.sig)) return { ok: false, reason: 'invalid signature' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------
const str = (max: number) => z.string().trim().min(1).max(max);
const strList = (maxItems: number = LIMITS.listItems, maxLen: number = LIMITS.short) => z.array(str(maxLen)).max(maxItems);
export const slugSchema = z.string().regex(ID_PATTERNS.slug, 'must be a lowercase slug like "api-auth" (a-z, 0-9, . _ / -)');
export const eventIdSchema = z.string().regex(ID_PATTERNS.event, 'must be a 64-char hex event id');
export const participantIdSchema = z.string().regex(ID_PATTERNS.participant, 'must be a participant id like p_<24 hex>');
export const pathsSchema = z.array(z.string().min(1).max(LIMITS.pathLength)).max(LIMITS.paths);
export const agentKeySchema = z.string().regex(ID_PATTERNS.agent, 'must be an agent key like "lead" or "a7a6a241124692d30"');
export const agentAddressSchema = z.string().regex(ID_PATTERNS.agentAddress, 'must be "p_<24 hex>/<agent key>"');

export const refsSchema = z
  .object({
    task: slugSchema.optional(),
    topic: slugSchema.optional(),
    paths: pathsSchema.optional(),
  })
  .strict();

export const envelopeSchema = z
  .object({
    v: z.number().int().min(1),
    id: eventIdSchema,
    project: z.string().regex(ID_PATTERNS.project),
    author: participantIdSchema,
    seq: z.number().int().min(1),
    lc: z.number().int().min(1),
    ts: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/, 'must be an ISO-8601 UTC timestamp'),
    type: z.string().min(1).max(64),
    payload: z.record(z.string(), z.unknown()),
    refs: refsSchema,
    supersedes: z.array(eventIdSchema).max(50),
    origin: z.enum(ORIGINS),
    session: z.string().max(200).optional(),
    agent: agentKeySchema.optional(),
    sig: z.string().min(1).max(200),
  })
  .strict();

export const DECISION_STATUSES = ['proposed', 'accepted'] as const;
export const PROGRESS_STATUSES = ['not_started', 'in_progress', 'blocked', 'in_review', 'done', 'abandoned'] as const;
export const MESSAGE_KINDS = ['question', 'reply', 'notification'] as const;
export const ISSUE_KINDS = ['bug', 'blocker', 'risk'] as const;
export const CONFLICT_SCOPES = ['decision', 'claim', 'goal'] as const;
export const ACTIVITY_KINDS = ['commit', 'files', 'session'] as const;

export const payloadSchemas = {
  'project.created': z.object({ name: str(LIMITS.title), description: str(LIMITS.text).optional() }),
  'participant.joined': z.object({ name: str(80), publicKey: z.string().min(40).max(200), role: str(LIMITS.short).optional() }),
  'goal.set': z.object({ title: str(LIMITS.title), description: str(LIMITS.text).optional(), successCriteria: strList().optional() }),
  'task.created': z.object({
    taskId: slugSchema,
    title: str(LIMITS.title),
    description: str(LIMITS.text).optional(),
    paths: pathsSchema.optional(),
    /** Queue: tasks that must be "done" before this one is handed out. */
    dependsOn: z.array(slugSchema).max(LIMITS.listItems).optional(),
    /** Queue: who should take it — a participant id, or "any" (default). */
    assignee: z.union([participantIdSchema, z.literal('any')]).optional(),
    /** Queue: lower first (ties by task id). Default: posting order. */
    order: z.number().int().min(0).max(1_000_000).optional(),
  }),
  'task.claimed': z.object({ taskId: slugSchema, scope: str(LIMITS.text), paths: pathsSchema.optional(), note: str(LIMITS.short).optional() }),
  'task.released': z.object({ taskId: slugSchema, reason: str(LIMITS.short).optional() }),
  'decision.recorded': z.object({
    topic: slugSchema,
    title: str(LIMITS.title),
    decision: str(LIMITS.text),
    rationale: str(LIMITS.text),
    status: z.enum(DECISION_STATUSES),
    codeRefs: strList(LIMITS.listItems, LIMITS.pathLength).optional(),
    alternatives: strList().optional(),
  }),
  'progress.reported': z.object({
    taskId: slugSchema.optional(),
    status: z.enum(PROGRESS_STATUSES),
    summary: str(LIMITS.text),
    blockers: strList().optional(),
    evidence: strList(LIMITS.listItems, LIMITS.text).optional(),
    nextSteps: strList().optional(),
    branch: str(200).optional(),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  }),
  'issue.reported': z.object({ kind: z.enum(ISSUE_KINDS), title: str(LIMITS.title), detail: str(LIMITS.text).optional(), taskId: slugSchema.optional() }),
  'issue.resolved': z.object({ issueId: eventIdSchema, note: str(LIMITS.short).optional() }),
  'message.posted': z.object({
    kind: z.enum(MESSAGE_KINDS),
    body: str(LIMITS.text),
    /** A participant (any of its agents), one agent ("p_…/<agent>"), or "all". */
    to: z.union([participantIdSchema, agentAddressSchema, z.literal('all')]).optional(),
    replyTo: eventIdSchema.optional(),
  }),
  'conflict.resolved': z.object({
    scope: z.enum(CONFLICT_SCOPES),
    key: slugSchema,
    resolution: str(LIMITS.text),
    chosen: eventIdSchema.optional(),
    owner: participantIdSchema.optional(),
    /** For claim conflicts: the agreed owning agent of `owner` (default LEAD_AGENT). */
    ownerAgent: agentKeySchema.optional(),
  }),
  'ack.recorded': z.object({ eventIds: z.array(eventIdSchema).min(1).max(LIMITS.ackIds) }),
  'activity.captured': z.object({
    kind: z.enum(ACTIVITY_KINDS),
    summary: str(LIMITS.short),
    commits: z.array(z.object({ hash: z.string().regex(/^[0-9a-f]{7,40}$/), message: str(LIMITS.short) })).max(LIMITS.listItems).optional(),
    paths: pathsSchema.optional(),
  }),
  /**
   * Names an agent of the author (the event's own `agent` field must equal payload.agent). Latest version per
   * (author, agent) in deterministic order wins. `active: false` = the agent finished (SubagentStop).
   */
  'agent.registered': z.object({
    agent: agentKeySchema,
    name: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/, 'agent name: 1-40 chars, letters/digits/space/._-'),
    agentType: str(80).optional(),
    active: z.boolean().optional(),
  }),
} satisfies Record<EventType, z.ZodType>;

export type PayloadOf<T extends EventType> = z.infer<(typeof payloadSchemas)[T]>;

export function isKnownType(t: string): t is EventType {
  return (EVENT_TYPES as readonly string[]).includes(t);
}

/**
 * Validate an event's payload. Unknown types (from newer peers) are accepted as opaque
 * (forward compatibility): they are stored and relayed but ignored by projections.
 */
export function validatePayload(type: string, payload: unknown): { ok: true; known: boolean } | { ok: false; error: string } {
  if (!isKnownType(type)) return { ok: true, known: false };
  const r = payloadSchemas[type].safeParse(payload);
  return r.success ? { ok: true, known: true } : { ok: false, error: formatZodError(r.error) };
}

/** Full structural validation of a received event (envelope + known payload). Signature checked separately. */
export function validateEnvelope(e: unknown): { ok: true; event: CatalystEvent } | { ok: false; error: string } {
  const r = envelopeSchema.safeParse(e);
  if (!r.success) return { ok: false, error: formatZodError(r.error) };
  const ev = r.data as CatalystEvent;
  if (ev.v > PROTOCOL_VERSION) return { ok: true, event: ev }; // newer: opaque
  const p = validatePayload(ev.type, ev.payload);
  if (!p.ok) return { ok: false, error: `payload for ${ev.type}: ${p.error}` };
  return { ok: true, event: ev };
}

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

// ---------------------------------------------------------------------------
// Deterministic ordering: (lc, author, seq) by code point. Never by ts.
// ---------------------------------------------------------------------------
export function compareEvents(a: Pick<CatalystEvent, 'lc' | 'author' | 'seq'>, b: Pick<CatalystEvent, 'lc' | 'author' | 'seq'>): number {
  if (a.lc !== b.lc) return a.lc - b.lc;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  return a.seq - b.seq;
}

// ---------------------------------------------------------------------------
// Text sanitisation for anything shown to a model (peer content is DATA, never instructions)
// ---------------------------------------------------------------------------
export function sanitizeForContext(text: string, max: number = LIMITS.short): string {
  const cleaned = text
    // strip C0/C1 control chars except newline/tab
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    // neutralise fences and Catalyst markers so peer text cannot close a quoted block
    .replace(/```/g, "'''")
    .replace(/<!--\s*catalyst/gi, '<!-- (quoted) catalyst')
    .replace(/<\/?(system|instructions?|user|assistant)[^>]*>/gi, '[tag removed]');
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
}
