/**
 * Minimal stand-in for the Catalyst daemon's loopback API, for MCP/hook tests.
 * Writes .catalyst/config.json + daemon.json into a temp project so probeDaemon/CatalystClient find it.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export type Handler = (req: RecordedRequest) => { status?: number; body: unknown };

export const PROJECT_ID = 'prj_' + 'a'.repeat(24);
const TOKEN = 'test-token';
const NONCE = 'test-nonce';

/** Temp dir with a Catalyst config.json (and optionally a snapshot). */
export function makeProject(opts: { snapshot?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'catalyst-int-'));
  mkdirSync(join(dir, '.catalyst'), { recursive: true });
  writeFileSync(
    join(dir, '.catalyst', 'config.json'),
    JSON.stringify({
      projectId: PROJECT_ID,
      projectName: 'test',
      participantId: 'p_' + 'b'.repeat(24),
      name: 'Tester',
      peerPort: 0,
      peerBind: '127.0.0.1',
      apiPort: 0,
      advertiseHosts: [],
      createdByMe: true,
      createdAt: new Date().toISOString(),
    }),
  );
  if (opts.snapshot !== undefined) writeFileSync(join(dir, '.catalyst', 'snapshot.md'), opts.snapshot);
  return dir;
}

export interface FakeDaemon {
  port: number;
  requests: RecordedRequest[];
  routes: Map<string, Handler>;
  close(): Promise<void>;
}

/** Start a fake daemon for `projectDir`. Routes are keyed "METHOD /path" (path without query). */
export async function startFakeDaemon(projectDir: string, routes: Record<string, Handler> = {}): Promise<FakeDaemon> {
  const requests: RecordedRequest[] = [];
  const table = new Map(Object.entries(routes));
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '/';
      const rec: RecordedRequest = { method: req.method ?? 'GET', path, headers: req.headers, body: text ? JSON.parse(text) : undefined };
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (rec.method === 'GET' && path === '/health') {
        return send(200, { ok: true, projectId: PROJECT_ID, participantId: 'p_' + 'b'.repeat(24), name: 'Tester', nonce: NONCE, pid: process.pid, version: '0.1.0', protocol: 1, apiPort: port, peerPort: 0, startedAt: new Date().toISOString() });
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: 'unauthorized', message: 'bad token' } });
      requests.push(rec);
      const h = table.get(`${rec.method} ${path.split('?')[0]}`);
      if (!h) return send(404, { error: { code: 'not_found', message: `no route ${rec.method} ${path}` } });
      const r = h(rec);
      send(r.status ?? 200, r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  writeFileSync(
    join(projectDir, '.catalyst', 'daemon.json'),
    JSON.stringify({ pid: process.pid, apiPort: port, peerPort: 0, token: TOKEN, nonce: NONCE, startedAt: new Date().toISOString(), projectId: PROJECT_ID }),
  );
  return {
    port,
    requests,
    routes: table,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
