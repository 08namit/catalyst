/**
 * Filesystem fallback: import .catalyst/inbox/*.json drafts (InboxDraft). Idempotent by clientId.
 * Success → inbox/imported/, invalid → inbox/rejected/ + <file>.error.txt. Files are never deleted.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { appendRequestSchema, type InboxImportResponse, type SyncSummary } from '../core/api.js';
import { ensureDir } from '../core/config.js';
import type { EventStore, InboxDraft } from '../core/interfaces.js';
import type { Logger } from '../core/log.js';
import type { ProjectPaths } from '../core/paths.js';
import { formatZodError, validatePayload } from '../core/protocol.js';
import { runTool } from './tools.js';

export const INBOX_TOOLS = ['publish_decision', 'publish_progress', 'send_message', 'claim_task', 'release_task', 'report_issue', 'resolve_issue', 'set_goal'];
export const INBOX_SESSION = 'inbox:fallback';

function moveTo(dir: string, file: string): string {
  ensureDir(dir);
  let target = join(dir, basename(file));
  if (existsSync(target)) target = join(dir, `${Date.now()}-${basename(file)}`);
  renameSync(file, target);
  return target;
}

/** Returns true when the draft was a duplicate. Throws (any error) for an invalid draft. */
function importDraft(raw: string, store: EventStore, sync: () => SyncSummary): boolean {
  let draft: InboxDraft;
  try {
    draft = JSON.parse(raw) as InboxDraft;
  } catch (err) {
    throw new Error(`invalid JSON: ${(err as Error).message}`);
  }
  if (!draft || typeof draft !== 'object') throw new Error('draft must be a JSON object');
  if (draft.catalystDraft !== 1) throw new Error('missing "catalystDraft": 1');
  if (typeof draft.clientId !== 'string' || draft.clientId.length < 8 || draft.clientId.length > 100) throw new Error('"clientId" must be a unique string of 8-100 chars (e.g. a UUID)');
  if ((draft.tool === undefined) === (draft.event === undefined)) throw new Error('exactly one of "tool" or "event" must be present');
  // Idempotency first: a re-imported draft is a duplicate even if its tool's preconditions no longer hold.
  if (store.findByClientId(draft.clientId)) return true;
  if (draft.tool !== undefined) {
    if (!INBOX_TOOLS.includes(draft.tool)) throw new Error(`tool "${draft.tool}" is not allowed in inbox drafts; allowed: ${INBOX_TOOLS.join(', ')}`);
    return runTool(draft.tool, draft.input ?? {}, { store, sync, session: INBOX_SESSION, sessionKind: 'cli', origin: 'fallback', clientId: draft.clientId }).duplicate;
  }
  const parsed = appendRequestSchema.safeParse({ ...draft.event, origin: 'fallback', clientId: draft.clientId });
  if (!parsed.success) throw new Error(formatZodError(parsed.error));
  const req = parsed.data;
  const v = validatePayload(req.type, req.payload);
  if (!v.ok) throw new Error(`invalid ${req.type} payload: ${v.error}`);
  return store.append({ type: req.type, payload: req.payload, refs: req.refs, supersedes: req.supersedes, origin: 'fallback', session: INBOX_SESSION, clientId: req.clientId }).duplicate;
}

/**
 * minAgeMs: skip files modified more recently than this (an agent may still be writing them). The periodic
 * timer uses 2000; explicit imports (startup, POST /api/inbox/import) use 0.
 */
export function importInbox(paths: ProjectPaths, store: EventStore, sync: () => SyncSummary, logger: Logger, minAgeMs = 0): InboxImportResponse {
  const res: InboxImportResponse = { imported: 0, duplicates: 0, rejected: [] };
  if (!existsSync(paths.inbox)) return res;
  const files = readdirSync(paths.inbox)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(paths.inbox, f))
    .filter((f) => {
      const st = statSync(f);
      return st.isFile() && (minAgeMs <= 0 || Date.now() - st.mtimeMs >= minAgeMs);
    })
    .sort();
  for (const file of files) {
    try {
      const dup = importDraft(readFileSync(file, 'utf8'), store, sync);
      if (dup) res.duplicates++;
      else res.imported++;
      moveTo(paths.inboxImported, file);
    } catch (err) {
      const error = (err as Error).message;
      try {
        const target = moveTo(paths.inboxRejected, file);
        writeFileSync(`${target}.error.txt`, `${error}\n`);
      } catch (moveErr) {
        logger.error('inbox: could not move rejected draft', { file, error: (moveErr as Error).message });
      }
      res.rejected.push({ file: basename(file), error });
      logger.warn('inbox: rejected draft', { file, error });
    }
  }
  if (res.imported || res.duplicates || res.rejected.length) logger.info('inbox import', res);
  return res;
}

export function inboxCounts(paths: ProjectPaths): { pending: number; rejected: number; imported: number } {
  const count = (dir: string, filter: (f: string) => boolean) => (existsSync(dir) ? readdirSync(dir).filter(filter).length : 0);
  const isDraft = (f: string) => f.endsWith('.json');
  return { pending: count(paths.inbox, isDraft), rejected: count(paths.inboxRejected, isDraft), imported: count(paths.inboxImported, isDraft) };
}
