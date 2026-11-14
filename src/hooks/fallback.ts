/**
 * Filesystem fallback helpers shared by the hooks and the MCP adapter.
 * Node built-ins + src/core/config only: hooks must stay free of zod / the MCP SDK / node:sqlite.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../core/config.js';
import type { InboxDraft } from '../core/interfaces.js';
import type { ProjectPaths } from '../core/paths.js';

/** First `maxChars` of .catalyst/snapshot.md, always including its generation time. Null if missing/unreadable. */
export function readSnapshotExcerpt(paths: ProjectPaths, maxChars: number): string | null {
  if (!existsSync(paths.snapshotMd)) return null;
  let text: string;
  let mtime: string;
  try {
    text = readFileSync(paths.snapshotMd, 'utf8');
    mtime = statSync(paths.snapshotMd).mtime.toISOString();
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  const generatedLine = text.split('\n').find((l) => /generated at/i.test(l));
  let body = text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated — full file: .catalyst/snapshot.md]` : text;
  if (!generatedLine) body = `(snapshot file last written ${mtime})\n${body}`;
  else if (!body.includes(generatedLine)) body = `${generatedLine.trim()}\n${body}`;
  return body;
}

/** Write a draft to .catalyst/inbox/<clientId>.json (atomic). Same clientId → same file, so retries overwrite. */
export function writeInboxDraft(paths: ProjectPaths, draft: InboxDraft): string {
  const file = join(paths.inbox, `${draft.clientId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  writeFileAtomic(file, JSON.stringify(draft, null, 2) + '\n');
  return file;
}
