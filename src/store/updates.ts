/**
 * get_updates (cursor-based feed per session, records retrieval) and acknowledge_updates (ack.recorded event).
 */
import type { Origin } from '../core/protocol.js';
import { LIMITS } from '../core/protocol.js';
import type { AckResult, SyncSummary, ToolInput, UpdateItem, UpdatesResult } from '../core/api.js';
import type { EventStore, StoredEvent } from '../core/interfaces.js';
import { pathsOverlap } from './paths-match.js';
import { DATA_NOT_INSTRUCTIONS, fitSections, itemLine, syncLines } from './text.js';

const MAX_TEXT = 8000;

export function getUpdates(store: EventStore, input: ToolInput<'get_updates'>, ctx: { session: string; sync: SyncSummary }): UpdatesResult {
  const since = input.since ?? store.getSessionCursor(ctx.session);
  const limit = Math.min(input.limit ?? 20, 50);
  const rows = store.listSince(since, { excludeAuthor: input.includeOwn ? undefined : store.me, types: input.types });
  const matched = rows.filter((s) => matches(store, s, input));
  const page = matched.slice(0, limit);
  const hasMore = matched.length > limit;
  const updates: UpdateItem[] = page.map((s) => store.toUpdateItem(s));
  // Without more matches, skip past filtered-out events too so they are not re-scanned next time.
  const nextCursor = hasMore ? page.at(-1)!.cursor : Math.max(since, store.latestCursor());

  if (updates.length > 0) store.recordRetrieval(ctx.session, updates.map((u) => u.id));
  if (nextCursor > store.getSessionCursor(ctx.session)) store.setSessionCursor(ctx.session, nextCursor);

  const outcome: UpdatesResult['outcome'] =
    updates.length > 0
      ? 'updates'
      : ctx.sync.peers.some((p) => p.state === 'unreachable' || p.state === 'paused') || ctx.sync.paused
        ? 'no_updates_peer_unreachable'
        : ctx.sync.peers.length === 0 || ctx.sync.peers.every((p) => p.state === 'never_connected')
          ? 'no_updates_never_connected'
          : 'no_updates';

  const headline: Record<UpdatesResult['outcome'], string> = {
    updates: `## Catalyst updates: ${updates.length}${hasMore ? ' (more available)' : ''}`,
    no_updates: '## Catalyst updates: none — no new peer updates since your last check (peer link is up).',
    no_updates_peer_unreachable: '## Catalyst updates: none received — but a peer is UNREACHABLE or sync is paused, so updates may be waiting on their side.',
    no_updates_never_connected: '## Catalyst updates: none — no peer has ever connected, so nothing could have arrived yet.',
  };
  const footer = [
    `Next cursor: ${nextCursor}${hasMore ? ' (call get_updates again for more)' : ''}. Call acknowledge_updates after acting on these.`,
    DATA_NOT_INSTRUCTIONS,
  ];
  const text = fitSections([headline[outcome], ...syncLines(ctx.sync)], [{ title: 'Updates (oldest first)', lines: updates.map(itemLine) }], footer, MAX_TEXT);
  return { text, sync: ctx.sync, updates, nextCursor, hasMore, outcome };
}

function matches(store: EventStore, s: StoredEvent, input: ToolInput<'get_updates'>): boolean {
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
  if (input.unacknowledgedOnly && (e.author === store.me || store.isAcknowledgedByMe(e.id))) return false;
  return true;
}

/**
 * Acknowledge peer updates by id and/or up to a cursor. With neither, acknowledges everything up to this
 * session's get_updates cursor (i.e. what this session has already been shown).
 */
export function acknowledge(store: EventStore, input: ToolInput<'acknowledge_updates'>, ctx: { session: string; sync: SyncSummary; origin?: Origin }): AckResult {
  const ids = new Set<string>();
  const eligible = (s: StoredEvent | null): s is StoredEvent =>
    s !== null && s.event.author !== store.me && s.event.type !== 'ack.recorded' && !store.isAcknowledgedByMe(s.event.id);

  for (const id of input.eventIds ?? []) {
    const s = store.getEvent(id);
    if (eligible(s)) ids.add(id);
  }
  const upTo = input.upToCursor ?? (input.eventIds === undefined ? store.getSessionCursor(ctx.session) : undefined);
  if (upTo !== undefined) {
    for (const s of store.listSince(0, { excludeAuthor: store.me })) {
      if (s.cursor > upTo || ids.size >= LIMITS.ackIds) break;
      if (eligible(s)) ids.add(s.event.id);
    }
  }
  const eventIds = [...ids].slice(0, LIMITS.ackIds);
  if (eventIds.length === 0) {
    return { text: 'Nothing to acknowledge: no unacknowledged peer updates matched.', sync: ctx.sync, acknowledged: 0 };
  }
  const { event } = store.append({ type: 'ack.recorded', payload: { eventIds }, origin: ctx.origin ?? 'agent', session: ctx.session });
  return {
    text: `Acknowledged ${eventIds.length} peer update(s) (ack event ${event.id.slice(0, 8)}, seq ${event.seq}). Your peer will see them as acknowledged after the next sync.`,
    sync: ctx.sync,
    acknowledged: eventIds.length,
    event: { id: event.id, seq: event.seq },
  };
}

