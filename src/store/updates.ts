/**
 * get_updates (cursor-based feed per session, records retrieval) and acknowledge_updates (ack.recorded event).
 * Both are per agent: the caller's own events are hidden/ineligible, sibling agents' events count like a peer's.
 */
import type { Origin } from '../core/protocol.js';
import { LIMITS, agentOf } from '../core/protocol.js';
import type { AckResult, SyncSummary, ToolInput, UpdateItem, UpdatesResult } from '../core/api.js';
import type { EventStore, StoredEvent } from '../core/interfaces.js';
import { pathsOverlap } from './paths-match.js';
import { DATA_NOT_INSTRUCTIONS, detailedItemLine, fitSectionsTracked, syncLines } from './text.js';

const MAX_TEXT = 8000;

/** Written by this very agent (author me + same agent key). */
function isOwn(store: EventStore, s: StoredEvent, agent: string): boolean {
  return s.event.author === store.me && agentOf(s.event) === agent;
}

export function getUpdates(store: EventStore, input: ToolInput<'get_updates'>, ctx: { session: string; sync: SyncSummary; agent: string }): UpdatesResult {
  const since = input.since ?? store.getSessionCursor(ctx.session);
  const limit = Math.min(input.limit ?? 20, 50);
  const rows = store.listSince(since, { excludeAgent: input.includeOwn ? undefined : { author: store.me, agent: ctx.agent }, types: input.types });
  const matched = rows.filter((s) => matches(store, s, input, ctx.agent));
  const page = matched.slice(0, limit);
  const candidates: UpdateItem[] = page.map((s) => ({ ...store.toUpdateItem(s), acknowledgedByMe: store.isAcknowledgedByMe(s.event.id, ctx.agent) }));
  const lines = candidates.map((u) => detailedItemLine(u, store.getEvent(u.id)?.event));

  const outcomeFor = (n: number): UpdatesResult['outcome'] =>
    n > 0
      ? 'updates'
      : ctx.sync.peers.some((p) => p.state === 'unreachable' || p.state === 'paused') || ctx.sync.paused
        ? 'no_updates_peer_unreachable'
        : ctx.sync.peers.length === 0 || ctx.sync.peers.every((p) => p.state === 'never_connected')
          ? 'no_updates_never_connected'
          : 'no_updates';
  const headline: Record<UpdatesResult['outcome'], string> = {
    updates: '## Catalyst updates',
    no_updates: '## Catalyst updates: none — no new peer updates since your last check (peer link is up).',
    no_updates_peer_unreachable: '## Catalyst updates: none received — but a peer is UNREACHABLE or sync is paused, so updates may be waiting on their side.',
    no_updates_never_connected: '## Catalyst updates: none — no peer has ever connected, so nothing could have arrived yet.',
  };
  const render = (n: number, more: boolean, cursor: number) =>
    fitSectionsTracked(
      [n > 0 ? `${headline.updates}: ${n}${more ? ' (more available — call get_updates again)' : ''}` : headline[outcomeFor(0)], ...syncLines(ctx.sync)],
      [{ title: 'Updates (oldest first)', lines: lines.slice(0, n), ids: candidates.slice(0, n).map((u) => [u.id]) }],
      [`Next cursor: ${cursor}${more ? ' (call get_updates again for more)' : ''}. Call acknowledge_updates after acting on these.`, DATA_NOT_INSTRUCTIONS],
      MAX_TEXT,
    );

  // Page by what fits in the text budget: only rendered records count as retrieved, and the cursor stops
  // at the last rendered record so nothing is skipped silently.
  const fullCursor = matched.length > limit ? page.at(-1)!.cursor : Math.max(since, store.latestCursor());
  let n = candidates.length;
  let rendered = render(n, matched.length > limit, fullCursor);
  if (rendered.emittedCounts[0]! < n) {
    n = Math.max(rendered.emittedCounts[0]!, Math.min(1, candidates.length));
    rendered = render(n, true, n > 0 ? candidates[n - 1]!.cursor : since);
  }
  const updates = candidates.slice(0, n);
  const hasMore = n < candidates.length || matched.length > limit;
  const nextCursor = n < candidates.length ? (n > 0 ? candidates[n - 1]!.cursor : since) : fullCursor;
  const outcome = outcomeFor(updates.length);
  const text = rendered.text;

  if (updates.length > 0) store.recordRetrieval(ctx.session, updates.map((u) => u.id));
  if (nextCursor > store.getSessionCursor(ctx.session)) store.setSessionCursor(ctx.session, nextCursor);

  return { text, sync: ctx.sync, updates, nextCursor, hasMore, outcome };
}

function matches(store: EventStore, s: StoredEvent, input: ToolInput<'get_updates'>, agent: string): boolean {
  const e = s.event;
  // Peer acks are bookkeeping; only listed when explicitly requested.
  if (e.type === 'ack.recorded' && !input.types?.includes('ack.recorded')) return false;
  const p = e.payload as { taskId?: unknown; topic?: unknown; paths?: unknown };
  if (input.task && e.refs.task !== input.task && p.taskId !== input.task) return false;
  if (input.topic && e.refs.topic !== input.topic && p.topic !== input.topic) return false;
  if (input.paths?.length) {
    const paths = [...(e.refs.paths ?? []), ...(Array.isArray(p.paths) ? (p.paths as string[]) : [])];
    if (pathsOverlap(input.paths, paths).length === 0) return false;
  }
  if (input.unacknowledgedOnly && (isOwn(store, s, agent) || store.isAcknowledgedByMe(e.id, agent))) return false;
  return true;
}

/**
 * Acknowledge peer updates by id and/or up to a cursor. With neither, acknowledges exactly the records this
 * session has been shown (recorded retrievals) — never records a filter hid from it.
 */
export function acknowledge(
  store: EventStore,
  input: ToolInput<'acknowledge_updates'>,
  ctx: { session: string; sync: SyncSummary; origin?: Origin; agent: string },
): AckResult {
  const ids = new Set<string>();
  const eligible = (s: StoredEvent | null): s is StoredEvent =>
    s !== null && !isOwn(store, s, ctx.agent) && s.event.type !== 'ack.recorded' && !store.isAcknowledgedByMe(s.event.id, ctx.agent);

  for (const id of input.eventIds ?? []) {
    const s = store.getEvent(id);
    if (eligible(s)) ids.add(id);
  }
  if (input.eventIds === undefined && input.upToCursor === undefined) {
    for (const id of store.retrievedBy(ctx.session)) {
      if (ids.size >= LIMITS.ackIds) break;
      if (eligible(store.getEvent(id))) ids.add(id);
    }
  }
  const upTo = input.upToCursor;
  if (upTo !== undefined) {
    for (const s of store.listSince(0, { excludeAgent: { author: store.me, agent: ctx.agent } })) {
      if (s.cursor > upTo || ids.size >= LIMITS.ackIds) break;
      if (eligible(s)) ids.add(s.event.id);
    }
  }
  const eventIds = [...ids].slice(0, LIMITS.ackIds);
  if (eventIds.length === 0) {
    return { text: 'Nothing to acknowledge: no unacknowledged updates matched.', sync: ctx.sync, acknowledged: 0 };
  }
  const { event } = store.append({ type: 'ack.recorded', payload: { eventIds }, origin: ctx.origin ?? 'agent', session: ctx.session, agent: ctx.agent });
  return {
    text: `Acknowledged ${eventIds.length} update(s) (ack event ${event.id.slice(0, 8)}, seq ${event.seq}). Your peer will see them as acknowledged after the next sync.`,
    sync: ctx.sync,
    acknowledged: eventIds.length,
    event: { id: event.id, seq: event.seq },
  };
}

