/**
 * Loopback HTTP API (127.0.0.1 only) + dashboard static files. Contract: src/core/api.ts.
 * Security: Host/Origin allow-list (DNS rebinding, CSRF), per-start bearer token on /api/*, 1 MB body limit.
 */
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentRegisterRequestSchema,
  agentStopRequestSchema,
  appendRequestSchema,
  inviteRequestSchema,
  peerAddrRequestSchema,
  sessionRequestSchema,
  type AgentRegisterResponse,
  type AgentStopResponse,
  type ApiError,
  type DashboardState,
  type DeliveryState,
  type SessionInfo,
  type StatusResponse,
  type UnreadSummary,
  type UpdateItem,
} from '../core/api.js';
import type { Origin } from '../core/protocol.js';
import { ID_PATTERNS, LEAD_AGENT, MATERIAL_TYPES, agentKeyFromId, formatZodError, ownerKey, validatePayload } from '../core/protocol.js';
import type { z } from 'zod';
import { summarizeQueue } from '../store/queue.js';
import { agentContext, agentSession, appendRegistration, callerView, defaultAgentName, ensureRegistered, latestRegistration } from './agents.js';
import { HttpError, badRequest, type DaemonContext } from './context.js';
import { inboxCounts } from './inbox.js';
import { runToolAsync } from './tools.js';

const MAX_BODY = 1024 * 1024;
const STATIC_DIR = fileURLToPath(new URL('../dashboard/static/', import.meta.url));
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const TOKEN_HINT = 'Token rotated? Re-read .catalyst/daemon.json / restart the client (the daemon issues a new token on every start).';

type Client = 'mcp' | 'hook' | 'cli' | 'dashboard';

interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  client: Client;
  session: string;
  clientPid?: number;
  /** Idempotency key header (x-catalyst-client-id), validated before use. */
  clientId?: string;
  /** Claude agent_id of the writing subagent (x-catalyst-agent; hooks inside a subagent). */
  agentId?: string;
  /** Aborted when the client disconnects (ends a wait_for_updates long-poll). */
  signal: AbortSignal;
}

export interface ApiServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startApiServer(ctx: DaemonContext, port: number): Promise<ApiServer> {
  const server = createServer((req, res) => {
    handle(ctx, req, res, actualPort).catch((err) => sendError(res, err, ctx));
  });
  let actualPort = 0;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const addr = server.address();
  actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// request plumbing
// ---------------------------------------------------------------------------
function send(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

function sendError(res: ServerResponse, err: unknown, ctx: DaemonContext): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    const body: ApiError = { error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } };
    send(res, err.status, body);
    return;
  }
  ctx.logger.error('api: internal error', err);
  const body: ApiError = { error: { code: 'internal', message: `Internal daemon error: ${(err as Error)?.message ?? String(err)}`, hint: `See ${ctx.paths.daemonLog}.` } };
  send(res, 500, body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'bad_request', 'Request body exceeds 1 MB.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolveBody({});
      try {
        resolveBody(JSON.parse(text));
      } catch (err) {
        reject(badRequest(`Body is not valid JSON: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (\S+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest(formatZodError(r.error));
  return r.data;
}

/** Peer-manager input errors (bad address, TTL) are caller mistakes, not daemon failures. */
function asBadRequest<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}

const ORIGIN_BY_CLIENT: Record<Client, Origin> = { mcp: 'agent', hook: 'hook', cli: 'human', dashboard: 'human' };
const KIND_BY_CLIENT: Record<Client, SessionInfo['kind']> = { mcp: 'mcp', hook: 'hook', cli: 'cli', dashboard: 'cli' };

async function handle(ctx: DaemonContext, req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'forbidden', `Host "${host ?? ''}" not allowed; use http://127.0.0.1:${port}.`);
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new HttpError(403, 'forbidden', `Origin "${origin}" not allowed.`);

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const method = req.method ?? 'GET';
  if (method === 'GET' && url.pathname === '/health') return send(res, 200, ctx.health());
  if (!url.pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(404, 'not_found', `No route ${method} ${url.pathname}.`);
    return serveStatic(res, url.pathname);
  }
  if (!tokenOk(req.headers.authorization, ctx.token)) throw new HttpError(401, 'unauthorized', 'Missing or invalid bearer token.', TOKEN_HINT);

  const rawClient = String(req.headers['x-catalyst-client'] ?? 'cli');
  const client: Client = rawClient === 'mcp' || rawClient === 'hook' || rawClient === 'dashboard' ? rawClient : 'cli';
  const pid = Number(req.headers['x-catalyst-client-pid']);
  const aborter = new AbortController();
  res.on('close', () => aborter.abort());
  const r: Req = {
    method,
    path: url.pathname,
    query: url.searchParams,
    body: method === 'POST' ? await readBody(req) : undefined,
    client,
    session: String(req.headers['x-catalyst-session'] ?? '') || `${client}:anon`,
    ...(Number.isInteger(pid) && pid > 0 ? { clientPid: pid } : {}),
    clientId: typeof req.headers['x-catalyst-client-id'] === 'string' ? req.headers['x-catalyst-client-id'] : undefined,
    agentId: typeof req.headers['x-catalyst-agent'] === 'string' && req.headers['x-catalyst-agent'].length <= 100 ? req.headers['x-catalyst-agent'] : undefined,
    signal: aborter.signal,
  };
  // Every route except the wait_for_updates long-poll runs synchronously, so writes stay serialized.
  const result = await route(ctx, r);
  if (res.destroyed || res.writableEnded) return;
  send(res, 200, result);
  if (r.path === '/api/shutdown') setImmediate(() => ctx.shutdown());
}

function route(ctx: DaemonContext, r: Req): unknown | Promise<unknown> {
  const { store, peers } = ctx;
  const key = `${r.method} ${r.path}`;
  if (r.method === 'POST' && r.path.startsWith('/api/tools/')) {
    const name = decodeURIComponent(r.path.slice('/api/tools/'.length));
    // Optional idempotency key for writes (MCP adapter sets it before dispatch so retries/drafts can't duplicate).
    const rawKey = r.clientId;
    const clientId = typeof rawKey === 'string' && /^[A-Za-z0-9:_.-]{8,100}$/.test(rawKey) ? rawKey : undefined;
    const call = { store, sync: ctx.sync, session: r.session, sessionKind: KIND_BY_CLIENT[r.client], origin: ORIGIN_BY_CLIENT[r.client], clientId, peers, signal: r.signal };
    return runToolAsync(name, r.body, call).then((o) => o.result);
  }
  switch (key) {
    case 'GET /api/status':
      return status(ctx);
    case 'GET /api/state':
      return dashboardState(ctx);
    case 'GET /api/unread':
      return unread(ctx, r.query.get('session') || r.session, r.query.get('markNotified') === '1', r.query.get('agent') ?? undefined);
    case 'GET /api/verify': {
      // Used by `catalyst doctor`: projection reproducibility + fork alarms.
      return { projection: store.verifyProjection(), forks: store.getState().forks };
    }
    case 'POST /api/events': {
      const body = parse(appendRequestSchema, r.body);
      const v = validatePayload(body.type, body.payload);
      if (!v.ok) throw badRequest(`Invalid ${body.type} payload: ${v.error}`);
      const origin = body.origin ?? ORIGIN_BY_CLIENT[r.client];
      const agent = agentKeyFromId(r.agentId);
      const session = agentSession(r.session, agent);
      if (agent !== LEAD_AGENT && !(body.clientId && store.findByClientId(body.clientId))) ensureRegistered(store, { agent }, origin, session);
      return store.append({
        type: body.type,
        payload: body.payload,
        refs: body.refs,
        supersedes: body.supersedes,
        origin,
        session,
        agent,
        clientId: body.clientId,
      });
    }
    case 'POST /api/agents':
      return registerAgent(ctx, parse(agentRegisterRequestSchema, r.body), r);
    case 'POST /api/agents/stop':
      return stopAgent(ctx, parse(agentStopRequestSchema, r.body), r);
    case 'POST /api/sessions': {
      const body = parse(sessionRequestSchema, r.body);
      const claudePid = body.claudePid ?? r.clientPid;
      store.upsertSession({ id: body.id, kind: body.kind, ...(claudePid ? { claudePid } : {}), ...(body.retrieved ? { retrieved: true } : {}) });
      return linkSessions(store.listSessions()).find((s) => s.id === body.id);
    }
    case 'POST /api/invites': {
      const body = parse(inviteRequestSchema, r.body);
      return asBadRequest(() => peers.createInvite(body));
    }
    case 'POST /api/peer/pause':
      peers.pause();
      return ctx.sync();
    case 'POST /api/peer/resume':
      peers.resume();
      return ctx.sync();
    case 'POST /api/peer/addr': {
      const body = parse(peerAddrRequestSchema, r.body);
      if (!peers.status().some((p) => p.participant === body.participant)) {
        throw new HttpError(404, 'not_found', `Unknown peer ${body.participant}.`, 'List peers with `catalyst peer list`.');
      }
      asBadRequest(() => peers.setPeerAddrs(body.participant, body.addrs));
      return ctx.sync();
    }
    case 'POST /api/handover':
      return ctx.writeHandover();
    case 'POST /api/snapshot':
      return ctx.writeSnapshot();
    case 'POST /api/inbox/import':
      return ctx.importInbox();
    case 'POST /api/shutdown':
      return { ok: true };
  }
  throw new HttpError(404, 'not_found', `No route ${r.method} ${r.path}.`);
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------
/** Best-effort: link MCP adapter sessions with hook sessions that share a Claude pid. */
export function linkSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.map((s) => {
    if (s.linkedSession || !s.claudePid) return s;
    const other = sessions.find((o) => o.id !== s.id && o.kind !== s.kind && o.claudePid === s.claudePid);
    return other ? { ...s, linkedSession: other.id } : s;
  });
}

function mtimeIso(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function status(ctx: DaemonContext): StatusResponse {
  const { store, paths } = ctx;
  const state = store.getState();
  return {
    health: ctx.health(),
    dataDir: paths.dataDir,
    projectDir: paths.projectDir,
    sync: ctx.sync(),
    counts: { ...store.counts(), conflicts: state.conflicts.length, forks: state.forks.length },
    sessions: linkSessions(store.listSessions()),
    inbox: inboxCounts(paths),
    snapshot: { path: paths.snapshotMd, ...optional('generatedAt', mtimeIso(paths.snapshotMd)) },
    handover: { path: paths.handover, ...optional('generatedAt', mtimeIso(paths.handover)) },
    agents: state.agents,
    queue: summarizeQueue(state),
  };
}

function optional<K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [k]: v }) as { [P in K]?: V };
}

function dashboardState(ctx: DaemonContext): DashboardState {
  const { store } = ctx;
  const latest = store.latestCursor();
  const recentStored = store.listSince(Math.max(0, latest - 1000), {}).slice(-100);
  const recent: UpdateItem[] = recentStored.map((e) => store.toUpdateItem(e)).reverse();
  const ownStored = store.listSince(Math.max(0, latest - 2000), {}).filter((e) => e.event.author === store.me).slice(-100);
  const outbound = ownStored
    .map((e) => {
      const delivery: DeliveryState = { savedLocally: true, ...store.deliveryState(e.event.id) };
      return { ...store.toUpdateItem(e), delivery };
    })
    .reverse();
  return {
    generatedAt: new Date().toISOString(),
    health: ctx.health(),
    state: store.getState(),
    sync: ctx.sync(),
    sessions: linkSessions(store.listSessions()),
    outbound,
    recent,
    fixture: process.env.CATALYST_FIXTURE === '1',
  };
}

/** Counts for one agent of mine (default lead): its own events are excluded, its sibling agents' are not. */
function unread(ctx: DaemonContext, session: string, markNotified: boolean, rawAgent?: string): UnreadSummary {
  const { store } = ctx;
  const me = store.me;
  const agent = rawAgent && ID_PATTERNS.agent.test(rawAgent) ? rawAgent : LEAD_AGENT;
  const address = ownerKey(me, agent);
  const state = store.getState();
  const noticeKey = `notify:${agentSession(session, agent)}`;
  const latestCursor = store.latestCursor();
  const fresh = store
    .listSince(store.getSessionCursor(noticeKey), { excludeAgent: { author: me, agent } })
    .filter((e) => MATERIAL_TYPES.has(e.event.type) && e.event.type !== 'agent.registered');
  const byType: Record<string, number> = {};
  for (const e of fresh) byType[e.event.type] = (byType[e.event.type] ?? 0) + 1;
  const questionsForMe = state.questions.filter(
    (q) => !q.answered && !(q.author === me && q.agent === agent) && (q.to === undefined || q.to === 'all' || q.to === me || q.to === address),
  ).length;
  if (markNotified) store.setSessionCursor(noticeKey, latestCursor);
  return {
    count: store.counts(agent).unacknowledged,
    newSinceLastNotice: fresh.length,
    byType,
    questionsForMe,
    openConflicts: state.conflicts.length,
    freshness: ctx.sync().freshness,
    latestCursor,
  };
}

// ---------------------------------------------------------------------------
// subagent lifecycle (SubagentStart / SubagentStop hooks)
// ---------------------------------------------------------------------------
function registerAgent(ctx: DaemonContext, body: z.infer<typeof agentRegisterRequestSchema>, r: Req): AgentRegisterResponse {
  const { store } = ctx;
  const agent = agentKeyFromId(body.agentId);
  const session = agentSession(body.session ?? r.session, agent);
  const origin = ORIGIN_BY_CLIENT[r.client];
  if (agent !== LEAD_AGENT) {
    const prev = latestRegistration(store, agent);
    const agentType = body.agentType?.trim() || prev?.agentType;
    if (!prev || !prev.active) {
      const name = prev?.name ?? defaultAgentName(store.getState(), store.me, agentType);
      appendRegistration(store, { agent, name, ...(agentType ? { agentType } : {}), active: true, origin, session });
    }
  }
  const view = callerView(store.getState(), store.me, agent);
  const { text, sourceIds } = agentContext(store, view, ctx.sync(), agent);
  if (sourceIds.length) store.recordRetrieval(session, sourceIds);
  return { agent, name: view.name, displayName: view.displayName, context: text };
}

function stopAgent(ctx: DaemonContext, body: z.infer<typeof agentStopRequestSchema>, r: Req): AgentStopResponse {
  const { store } = ctx;
  const agent = agentKeyFromId(body.agentId);
  if (agent === LEAD_AGENT) return { agent, released: [] };
  const origin = ORIGIN_BY_CLIENT[r.client];
  const session = agentSession(r.session, agent);
  const key = ownerKey(store.me, agent);
  const released: string[] = [];
  for (const t of store.getState().tasks) {
    const mine = t.claims.filter((c) => c.ownerKey === key).map((c) => c.id);
    if (mine.length === 0 || t.status === 'done') continue;
    store.append({ type: 'task.released', payload: { taskId: t.taskId, reason: 'agent finished' }, refs: { task: t.taskId }, supersedes: mine, origin, session, agent });
    released.push(t.taskId);
  }
  const prev = latestRegistration(store, agent);
  if (prev?.active) appendRegistration(store, { agent, name: prev.name, ...(prev.agentType ? { agentType: prev.agentType } : {}), active: false, origin, session });
  return { agent, released };
}

function serveStatic(res: ServerResponse, pathname: string): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    throw new HttpError(400, 'bad_request', 'Malformed path.');
  }
  const file = resolve(STATIC_DIR, '.' + rel);
  if (rel.includes('\0') || !file.startsWith(STATIC_DIR.endsWith(sep) ? STATIC_DIR : STATIC_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
    throw new HttpError(404, 'not_found', `No such file ${pathname}.`);
  }
  const data = readFileSync(file);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(data);
}
