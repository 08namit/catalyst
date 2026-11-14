/**
 * Daemon client used by the CLI, MCP adapter and hooks. Keep imports light (no zod / MCP SDK) — hooks load this.
 *
 * Discovery: read .catalyst/daemon.json → GET /health → verify projectId + nonce match (pid-reuse safe).
 * Autostart: only callers that pass { autostart: true } may spawn the daemon (MCP adapter, SessionStart hook, CLI start).
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readDaemonInfo, readJson, type DaemonInfo, type ProjectConfig } from '../core/config.js';
import { projectPaths, type ProjectPaths } from '../core/paths.js';
import type { ApiError, HealthResponse } from '../core/api.js';

export class DaemonUnavailableError extends Error {
  /**
   * true when the request certainly never reached a daemon (not running / connection refused), so retrying a
   * write cannot duplicate it. false when it may have been received (e.g. timeout mid-request).
   */
  constructor(
    message: string,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}
export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface ClientOptions {
  /** Client kind sent as x-catalyst-client. */
  client: 'mcp' | 'hook' | 'cli' | 'dashboard';
  session?: string;
  claudePid?: number;
  /** Per-request timeout in ms (default 5000). */
  timeoutMs?: number;
}

export interface RawResponse {
  status: number;
  body: unknown;
}

export function httpJson(port: number, method: string, path: string, opts: { token?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, accept: 'application/json', ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, timeout: opts.timeoutMs ?? 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try {
          body = text.length ? JSON.parse(text) : null;
        } catch {
          /* non-JSON body */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${opts.timeoutMs ?? 5000}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Returns live daemon info if a healthy daemon for THIS project is running, else null. Never throws. */
export async function probeDaemon(paths: ProjectPaths, timeoutMs = 1000): Promise<{ info: DaemonInfo; health: HealthResponse } | null> {
  const info = readDaemonInfo(paths);
  if (!info) return null;
  try {
    const r = await httpJson(info.apiPort, 'GET', '/health', { timeoutMs });
    const h = r.body as HealthResponse;
    if (r.status === 200 && h && h.ok && h.projectId === info.projectId && h.nonce === info.nonce) return { info, health: h };
  } catch {
    /* not running */
  }
  return null;
}

/** Path to the CLI entry (dist/cli/index.js) used to spawn the daemon. */
export function cliEntry(): string {
  return fileURLToPath(new URL('../cli/index.js', import.meta.url));
}

/**
 * Spawn the daemon detached (stdio ignored so hook/MCP parents never wait on it) and wait until healthy.
 * Concurrent callers are safe: the daemon itself takes an exclusive lock; losers exit, and every caller
 * just polls /health.
 */
export async function startDaemon(paths: ProjectPaths, waitMs = 4000): Promise<{ info: DaemonInfo; health: HealthResponse }> {
  const existing = await probeDaemon(paths);
  if (existing) return existing;
  const entry = cliEntry();
  if (!existsSync(entry)) throw new DaemonUnavailableError(`Cannot find Catalyst CLI at ${entry}. Run \`npm run build\` in the Catalyst checkout.`);
  let errFd: number | 'ignore' = 'ignore';
  try {
    errFd = openSync(paths.daemonLog.replace(/daemon\.log$/, 'daemon.stderr.log'), 'a');
  } catch {
    errFd = 'ignore';
  }
  const child = spawn(process.execPath, [entry, 'daemon', '--dir', paths.projectDir], {
    detached: true,
    stdio: ['ignore', 'ignore', errFd],
    env: { ...process.env, CATALYST_DAEMON_CHILD: '1' },
  });
  child.unref();
  if (typeof errFd === 'number') closeSync(errFd);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const live = await probeDaemon(paths, 500);
    if (live) return live;
  }
  throw new DaemonUnavailableError(`Catalyst daemon did not become healthy within ${waitMs}ms. See ${paths.daemonLog}.`);
}

export class CatalystClient {
  private info: DaemonInfo | null = null;
  constructor(
    public readonly paths: ProjectPaths,
    private readonly opts: ClientOptions,
  ) {}

  static forProject(projectDir: string, opts: ClientOptions): CatalystClient {
    return new CatalystClient(projectPaths(projectDir), opts);
  }

  config(): ProjectConfig | null {
    return readJson<ProjectConfig>(this.paths.config);
  }

  /** Connect to a running daemon; optionally autostart it. Throws DaemonUnavailableError. */
  async connect(o: { autostart?: boolean; waitMs?: number; probeTimeoutMs?: number } = {}): Promise<HealthResponse> {
    const live = await probeDaemon(this.paths, o.probeTimeoutMs ?? 1000);
    if (live) {
      this.info = live.info;
      return live.health;
    }
    if (!o.autostart) throw new DaemonUnavailableError('Catalyst daemon is not running. Start it with `catalyst start`.');
    const started = await startDaemon(this.paths, o.waitMs ?? 4000);
    this.info = started.info;
    return started.health;
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    if (!this.info) await this.connect();
    const info = this.info!;
    const headers: Record<string, string> = { 'x-catalyst-client': this.opts.client, ...extraHeaders };
    if (this.opts.session) headers['x-catalyst-session'] = this.opts.session;
    if (this.opts.claudePid) headers['x-catalyst-client-pid'] = String(this.opts.claudePid);
    let r: RawResponse;
    try {
      r = await httpJson(info.apiPort, method, path, { token: info.token, body, timeoutMs: this.opts.timeoutMs, headers });
    } catch (err) {
      this.info = null;
      const code = (err as NodeJS.ErrnoException).code;
      const neverSent = code === 'ECONNREFUSED' || code === 'ENOENT';
      throw new DaemonUnavailableError(`Catalyst daemon unreachable: ${(err as Error).message}`, neverSent);
    }
    if (r.status >= 200 && r.status < 300) return r.body as T;
    const e = (r.body as ApiError | null)?.error;
    if (r.status === 401) this.info = null; // token rotated (daemon restarted) — rediscover next time
    throw new ApiRequestError(r.status, e?.code ?? 'internal', e?.message ?? `HTTP ${r.status}`, e?.hint);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {});
  }
  /** `clientId` is an idempotency key: re-sending the same write with the same key records it once. */
  tool<T>(name: string, input: unknown, opts: { clientId?: string } = {}): Promise<T> {
    return this.request<T>('POST', `/api/tools/${name}`, input ?? {}, opts.clientId ? { 'x-catalyst-client-id': opts.clientId } : {});
  }
}
