/**
 * SQLite setup: durable WAL database with versioned migrations. Each database belongs to exactly one project
 * (meta.project_id); opening it for another project throws (project isolation).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

export type Row = Record<string, SQLOutputValue>;

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    author TEXT NOT NULL,
    seq INTEGER NOT NULL,
    lc INTEGER NOT NULL,
    type TEXT NOT NULL,
    ts TEXT NOT NULL,
    json TEXT NOT NULL,
    source TEXT NOT NULL,
    received_at TEXT NOT NULL,
    client_id TEXT UNIQUE,
    UNIQUE(author, seq)
  );
  CREATE INDEX events_type ON events(type);
  CREATE TABLE parked (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    seq INTEGER NOT NULL,
    json TEXT NOT NULL,
    source TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE INDEX parked_author_seq ON parked(author, seq);
  CREATE TABLE participants (id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL, source TEXT NOT NULL);
  CREATE TABLE deliveries (event_id TEXT NOT NULL, peer TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(event_id, peer));
  CREATE TABLE retrievals (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, session TEXT NOT NULL, at TEXT NOT NULL);
  CREATE TABLE remote_retrievals (event_id TEXT NOT NULL, participant TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(event_id, participant));
  CREATE TABLE acks (event_id TEXT NOT NULL, participant TEXT NOT NULL, at TEXT NOT NULL, ack_id TEXT NOT NULL, PRIMARY KEY(event_id, participant));
  CREATE TABLE status_sent (peer TEXT PRIMARY KEY, last_retrieval_rowid INTEGER NOT NULL);
  CREATE TABLE remote_sessions (peer TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    claude_pid INTEGER,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    last_retrieval TEXT
  );
  CREATE TABLE session_cursors (key TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
  CREATE TABLE invites (id TEXT PRIMARY KEY, key TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT);
  CREATE TABLE peer_seen (peer TEXT PRIMARY KEY, last_sync_at TEXT, last_error TEXT);
  CREATE TABLE forks (author TEXT NOT NULL, seq INTEGER NOT NULL, ids TEXT NOT NULL, detected_at TEXT NOT NULL);
  CREATE VIRTUAL TABLE events_fts USING fts5(id UNINDEXED, text);
  `,
];

export function openDatabase(dbPath: string, projectId: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    // Events must be durable before they are delivered or acknowledged.
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

    const getMeta = (key: string) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value as string | undefined;
    const existing = getMeta('project_id');
    if (existing !== undefined && existing !== projectId) {
      throw new Error(`Database ${dbPath} belongs to project ${existing}, not ${projectId}; refusing to open it (project isolation).`);
    }

    const version = Number(getMeta('schema_version') ?? '0');
    if (version > MIGRATIONS.length) {
      throw new Error(`Database ${dbPath} has schema version ${version}, newer than this Catalyst (${MIGRATIONS.length}). Upgrade Catalyst.`);
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(MIGRATIONS[v]!);
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(v + 1));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    if (existing === undefined) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('project_id', projectId);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
