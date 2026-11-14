/** Shared daemon wiring types (used by http.ts, tools.ts, inbox.ts, main.ts). */
import type { ApiErrorCode, FileWriteResponse, HealthResponse, InboxImportResponse, SyncSummary } from '../core/api.js';
import type { Identity, ProjectConfig } from '../core/config.js';
import type { EventStore, PeerManagerApi } from '../core/interfaces.js';
import type { Logger } from '../core/log.js';
import type { ProjectPaths } from '../core/paths.js';

export interface DaemonContext {
  paths: ProjectPaths;
  config: ProjectConfig;
  identity: Identity;
  store: EventStore;
  peers: PeerManagerApi;
  logger: Logger;
  /** Per-start bearer token for /api/*. */
  token: string;
  health(): HealthResponse;
  sync(): SyncSummary;
  writeSnapshot(): FileWriteResponse;
  writeHandover(): FileWriteResponse;
  importInbox(minAgeMs?: number): InboxImportResponse;
  /** Stop the daemon (responds first, then exits). */
  shutdown(): void;
}

/** Error carrying an HTTP status + ApiError code; thrown by handlers, rendered by http.ts. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, hint?: string) => new HttpError(400, 'bad_request', message, hint);
