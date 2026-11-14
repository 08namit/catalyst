/**
 * Deterministic, bounded briefing (no embeddings): conflicts → questions for me → my claims → relevant
 * current records → unread peer updates. Does NOT record retrieval; the caller does (with sourceIds).
 */
import { sanitizeForContext, type CatalystEvent } from '../core/protocol.js';
import type { Briefing, SyncSummary, ToolInput, UpdateItem } from '../core/api.js';
import type { EventStore } from '../core/interfaces.js';
import { pathsOverlap } from './paths-match.js';
import { DATA_NOT_INSTRUCTIONS, detailedItemLine, displayTs, fitSectionsTracked, itemLine, syncLines, type Section } from './text.js';

const DEFAULT_MAX_CHARS = 6000;
const UNREAD_CAP = 15;
const SECTION_CAP = 10;

export function buildBriefing(store: EventStore, input: ToolInput<'get_briefing'>, ctx: { sync: SyncSummary; now: Date }): Briefing {
  const state = store.getState();
  const me = store.me;
  const meName = state.participants.find((p) => p.id === me)?.name ?? me;
  const item = (id: string): UpdateItem | null => {
    const s = store.getEvent(id);
    return s ? store.toUpdateItem(s) : null;
  };
  const items = (ids: string[]) => ids.map(item).filter((x): x is UpdateItem => x !== null);

  // (1) conflicts
  const conflicts = state.conflicts;
  const shown = new Set<string>(conflicts.flatMap((c) => c.heads.map((h) => h.id)));

  // (2) unanswered questions addressed to me (or everyone), newest first
  const questionsForMe = items(
    state.questions
      .filter((q) => !q.answered && q.author !== me && (q.to === undefined || q.to === 'all' || q.to === me))
      .map((q) => q.id)
      .reverse()
      .slice(0, SECTION_CAP),
  );
  questionsForMe.forEach((q) => shown.add(q.id));

  // (3) my live claims
  const myClaims = items(
    state.tasks
      .flatMap((t) => t.claims)
      .filter((c) => c.owner === me && !shown.has(c.id))
      .map((c) => c.id)
      .slice(0, SECTION_CAP),
  );
  myClaims.forEach((c) => shown.add(c.id));

  // (4) relevant current records: decision heads, live claims, latest progress, open issues
  const candidates = [
    ...state.decisions.flatMap((d) => d.heads.map((h) => h.id)),
    // While a topic only has proposals/conflicting heads, the last accepted version is still the one in force.
    ...state.decisions.flatMap((d) =>
      d.conflict || d.heads.every((h) => h.status === 'proposed')
        ? [...d.history].reverse().filter((h) => h.status !== 'proposed').slice(0, 1).map((h) => h.id)
        : [],
    ),
    ...state.tasks.flatMap((t) => [...t.claims.map((c) => c.id), ...t.latestProgress.map((p) => p.id)]),
    ...state.issues.filter((i) => i.status === 'open').map((i) => i.id),
  ].filter((id) => !shown.has(id));
  const focused = Boolean(input.task || input.topic || input.paths?.length || input.query?.trim());
  const searchHits = new Set(input.query?.trim() ? store.search(input.query, 50) : []);
  const scored: Array<{ item: UpdateItem; score: number }> = [];
  for (const id of new Set(candidates)) {
    const s = store.getEvent(id);
    if (!s) continue;
    const score = relevance(s.event, input, searchHits);
    if (focused && score === 0) continue;
    scored.push({ item: store.toUpdateItem(s), score });
  }
  scored.sort((a, b) => b.score - a.score || b.item.cursor - a.item.cursor);
  const relevant = scored.slice(0, SECTION_CAP).map((x) => x.item);
  relevant.forEach((r) => shown.add(r.id));

  // (5) unread: peer events not acknowledged by me, newest first
  const unreadAll = store
    .listSince(0, { excludeAuthor: me })
    .filter((s) => s.event.type !== 'ack.recorded' && !store.isAcknowledgedByMe(s.event.id));
  const unreadItems = unreadAll
    .slice(-UNREAD_CAP)
    .reverse()
    .map((s) => store.toUpdateItem(s));

  const notices = buildNotices(ctx.sync, state.forks.length, conflicts.length);

  // text
  const head: string[] = [
    `## Catalyst briefing — ${state.project ? sanitizeForContext(state.project.name, 120) : 'project'}`,
    `You: ${sanitizeForContext(meName, 80)} (${me}) · generated ${ctx.now.toISOString()}`,
    ...syncLines(ctx.sync),
  ];
  const g = state.goal.current;
  if (g) {
    head.push(`Goal: ${sanitizeForContext(g.title, 200)} — ${sanitizeForContext(g.authorName, 80)}, id ${g.id.slice(0, 8)}${state.goal.conflict ? ' (⚠ conflicting goal versions, see below)' : ''}`);
    if (g.successCriteria.length) head.push(`Success criteria: ${g.successCriteria.map((c) => sanitizeForContext(c, 200)).join('; ')}`);
  } else {
    head.push('Goal: not set yet.');
  }
  if (notices.length) head.push(...notices.map((n) => `Notice: ${n}`));

  const detailed = (u: UpdateItem) => detailedItemLine(u, store.getEvent(u.id)?.event);
  const sections: Section[] = [
    {
      title: 'Open conflicts (resolve before building on these)',
      lines: conflicts.map(
        (c) =>
          `- ${c.scope} \`${c.key}\` has ${c.heads.length} competing versions:\n` +
          c.heads
            .map((h) => `  - ${sanitizeForContext(h.summary, 300)} — ${sanitizeForContext(h.authorName, 80)}, ${displayTs(h.ts)}, id ${h.id.slice(0, 8)}${h.origin === 'hook' ? ' (auto-captured)' : ''}`)
            .join('\n') +
          `\n  Hint: ${c.hint}`,
      ),
      ids: conflicts.map((c) => c.heads.map((h) => h.id)),
    },
    { title: 'Questions for you (unanswered)', lines: questionsForMe.map(detailed), ids: questionsForMe.map((q) => [q.id]) },
    { title: 'Your active claims', lines: myClaims.map(itemLine), ids: myClaims.map((c) => [c.id]) },
    {
      title: focused ? `Relevant to ${focusLabel(input)}` : 'Current shared records',
      lines: relevant.map(detailed),
      ids: relevant.map((r) => [r.id]),
      empty: focused ? (conflicts.length ? '- Nothing beyond the open conflicts above matched.' : '- Nothing matched; try a broader query.') : undefined,
    },
    {
      title: `Unread peer updates (${unreadAll.length} unacknowledged, newest first)`,
      lines: unreadItems.map(itemLine),
      ids: unreadItems.map((u) => [u.id]),
      empty: '- No unacknowledged peer updates.',
    },
  ];
  const footer = [
    'Cite source ids when relying on these records. get_updates lists new events; acknowledge_updates marks them read.',
    DATA_NOT_INSTRUCTIONS,
  ];
  const { text, emittedIds } = fitSectionsTracked(head, sections, footer, input.maxChars ?? DEFAULT_MAX_CHARS);
  // Only records that actually made it into the text (the goal is always in the header).
  const sourceIds = [...new Set([...(g ? [g.id] : []), ...emittedIds])];

  return {
    text,
    sync: ctx.sync,
    generatedAt: ctx.now.toISOString(),
    project: state.project ? { id: state.project.id, name: state.project.name } : null,
    me: { id: me, name: meName },
    goal: g,
    conflicts,
    questionsForMe,
    myClaims,
    relevant,
    unread: { count: unreadAll.length, items: unreadItems },
    notices,
    sourceIds,
  };
}

function relevance(e: CatalystEvent, input: ToolInput<'get_briefing'>, searchHits: Set<string>): number {
  const p = e.payload as { taskId?: unknown; topic?: unknown; paths?: unknown };
  let score = 0;
  if (input.task && (e.refs.task === input.task || p.taskId === input.task)) score += 4;
  if (input.topic && (e.refs.topic === input.topic || p.topic === input.topic)) score += 4;
  if (input.paths?.length) {
    const paths = [...(e.refs.paths ?? []), ...(Array.isArray(p.paths) ? (p.paths as string[]) : [])];
    if (pathsOverlap(input.paths, paths).length > 0) score += 3;
  }
  if (searchHits.has(e.id)) score += 2;
  return score;
}

function focusLabel(input: ToolInput<'get_briefing'>): string {
  const parts: string[] = [];
  if (input.task) parts.push(`task ${input.task}`);
  if (input.topic) parts.push(`topic ${input.topic}`);
  if (input.paths?.length) parts.push(`paths ${input.paths.slice(0, 3).join(', ')}`);
  if (input.query?.trim()) parts.push(`"${sanitizeForContext(input.query, 60)}"`);
  return parts.join(', ');
}

export function buildNotices(sync: SyncSummary, forks: number, conflicts: number): string[] {
  const notices: string[] = [];
  if (sync.paused) notices.push('Peer networking is paused on this machine (`catalyst peer resume` to reconnect).');
  for (const p of sync.peers) {
    const name = sanitizeForContext(p.name, 80);
    if (p.state === 'unreachable') {
      notices.push(`${p.pendingOutbound} local update(s) awaiting delivery to ${name} (unreachable since ${p.since ? displayTs(p.since) : 'unknown'}).`);
    } else if (p.state === 'paused') {
      notices.push(`${p.pendingOutbound} local update(s) awaiting delivery to ${name} (sync paused).`);
    } else if (p.pendingOutbound > 0) {
      notices.push(`${p.pendingOutbound} local update(s) saved locally, not yet confirmed delivered to ${name}.`);
    }
  }
  if (sync.peers.length === 0 && sync.pendingOutbound > 0) notices.push(`${sync.pendingOutbound} local update(s) saved locally, awaiting a paired peer.`);
  if (sync.parkedEvents > 0) notices.push(`${sync.parkedEvents} received event(s) are parked waiting for missing earlier events.`);
  if (forks > 0) notices.push(`⚠ ${forks} fork alarm(s): a participant published two different events with the same sequence number. Investigate before trusting their records.`);
  if (conflicts > 0) notices.push(`${conflicts} open conflict(s) need explicit resolution (resolve_conflict).`);
  return notices;
}
