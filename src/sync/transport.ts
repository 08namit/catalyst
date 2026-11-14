import { EventEmitter } from 'node:events';
import { createServer, connect, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import type { Logger } from '../core/log.js';
import { LIMITS } from '../core/protocol.js';
import { HANDSHAKE_TIMEOUT_MS, IDLE_TIMEOUT_MS, MAX_CONNECTIONS_PER_IP, PSK_CIPHERS, type Frame } from './frames.js';

export function parseAddress(addr: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/.exec(addr);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid peer address ${addr}; expected host:port or [IPv6]:port`);
  return { host, port };
}

export function formatAddress(host: string, port: number): string {
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Validate frame structure here; event validity/signatures belong to SyncStore.ingest. */
function isFrame(v: unknown): v is Frame {
  if (!record(v)) return false;
  switch (v.t) {
    case 'hello': return Number.isInteger(v.protocol) && text(v.software) && text(v.project) && text(v.participant) && text(v.name) && strings(v.addrs)
      && record(v.vector) && Object.values(v.vector).every(n => Number.isSafeInteger(n) && (n as number) >= 0);
    case 'events': return Array.isArray(v.events) && v.events.length <= LIMITS.maxEventsPerFrame && typeof v.replay === 'boolean';
    case 'ack': return strings(v.ids) && v.ids.length <= LIMITS.ackIds;
    case 'status': return Array.isArray(v.retrieved) && v.retrieved.every(x => record(x) && text(x.id) && text(x.at))
      && Array.isArray(v.sessions) && v.sessions.every(x => record(x) && text(x.id) && ['hook', 'mcp', 'cli'].includes(x.kind as string) && text(x.firstSeenAt) && text(x.lastSeenAt))
      && Number.isSafeInteger(v.pending) && (v.pending as number) >= 0;
    case 'ping': case 'pong': return text(v.at);
    case 'error': return ['wrong_project', 'incompatible_protocol', 'unknown_participant', 'bad_frame', 'invite_invalid', 'rate_limited', 'internal'].includes(v.code as string)
      && typeof v.message === 'string' && typeof v.fatal === 'boolean';
    case 'join_request': return Number.isInteger(v.protocol) && text(v.project) && text(v.inviteId) && text(v.participant) && text(v.name) && text(v.publicKey) && strings(v.addrs);
    case 'join_accept': return record(v.project) && text(v.project.id) && text(v.project.name) && record(v.inviter) && text(v.inviter.participant)
      && text(v.inviter.name) && text(v.inviter.publicKey) && strings(v.inviter.addrs) && text(v.pairKey) && text(v.confirmCode);
    default: return false;
  }
}

/** NDJSON over an authenticated TLS socket. close() flushes; destroy() cancels immediately. */
export class FramedConnection extends EventEmitter {
  private parts: Buffer[] = [];
  private bytes = 0;
  private closing = false;
  private pendingFrames: Array<{ frame: Frame; bytes: number }> = [];
  private pendingBytes = 0;
  private closeTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly socket: TLSSocket) {
    super();
    this.on('newListener', event => {
      if (event === 'frame') queueMicrotask(() => this.drainFrames());
    });
    this.on('error', () => {}); // A socket may fail before the caller attaches its listeners.
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', error => this.emit('error', error));
    socket.on('close', () => {
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.parts = [];
      this.pendingFrames = [];
      this.pendingBytes = 0;
      this.emit('close');
    });
    socket.on('end', () => {
      if (this.bytes && !this.closing) this.badFrame('Truncated JSON frame');
      else this.close();
    });
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy(new Error('Peer idle timeout')));
  }

  send(frame: Frame): void {
    if (this.closing || this.socket.destroyed) return;
    const line = JSON.stringify(frame);
    if (Buffer.byteLength(line) > LIMITS.maxFrameBytes) {
      this.badFrame(`Frame exceeds ${LIMITS.maxFrameBytes} bytes`);
      return;
    }
    this.socket.write(line + '\n');
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.socket.end();
    this.closeTimer = setTimeout(() => this.socket.destroy(), 250);
    this.closeTimer.unref();
  }

  destroy(): void { this.closing = true; this.socket.destroy(); }

  private badFrame(message: string): void {
    this.send({ t: 'error', code: 'bad_frame', message, fatal: true });
    this.close();
  }

  private drainFrames(): void {
    // TLS can deliver application data in the same turn as secureConnect, before
    // the caller of connectPeer() has resumed and attached its frame listener.
    while (!this.closing && this.listenerCount('frame') && this.pendingFrames.length) {
      const next = this.pendingFrames.shift()!;
      this.pendingBytes -= next.bytes;
      this.emit('frame', next.frame);
    }
  }

  private receive(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length && !this.closing) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      this.bytes += part.length;
      if (this.bytes > LIMITS.maxFrameBytes) { this.badFrame(`Frame exceeds ${LIMITS.maxFrameBytes} bytes`); return; }
      if (part.length) this.parts.push(part);
      if (newline < 0) return;
      const line = Buffer.concat(this.parts, this.bytes).toString('utf8');
      this.parts = [];
      this.bytes = 0;
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { this.badFrame('Invalid JSON frame'); return; }
      if (!isFrame(frame)) { this.badFrame('Invalid frame structure'); return; }
      if (this.listenerCount('frame') && !this.pendingFrames.length) this.emit('frame', frame);
      else {
        const bytes = Buffer.byteLength(line);
        this.pendingBytes += bytes;
        if (this.pendingBytes > LIMITS.maxFrameBytes) { this.badFrame('Too much data before frame consumer attached'); return; }
        this.pendingFrames.push({ frame, bytes });
      }
      start = newline + 1;
    }
  }
}

export interface PeerServer {
  port: number;
  close(): Promise<void>;
}

export async function createPeerServer(opts: {
  bind: string; port: number; resolvePsk(identity: string): Buffer | null;
  onConnection(conn: FramedConnection, identity: string): void; logger: Logger;
}): Promise<PeerServer> {
  const identities = new WeakMap<TLSSocket, string>();
  const sockets = new Set<Socket>();
  const perIp = new Map<string, number>();
  const server = createServer({
    ciphers: PSK_CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    pskCallback(socket, identity) {
      try {
        const psk = opts.resolvePsk(identity);
        if (psk) identities.set(socket, identity);
        return psk;
      } catch (error) { opts.logger.warn('PSK resolution failed', error); return null; }
    },
  }, socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const identity = identities.get(socket);
    if (!identity) { socket.destroy(); return; }
    const conn = new FramedConnection(socket);
    try { opts.onConnection(conn, identity); } catch (error) { opts.logger.error('Peer connection failed', error); conn.destroy(); }
  });
  server.on('connection', socket => {
    const ip = socket.remoteAddress ?? 'unknown';
    const count = perIp.get(ip) ?? 0;
    socket.on('error', error => opts.logger.debug('Peer TCP error', error));
    if (count >= MAX_CONNECTIONS_PER_IP) { socket.destroy(); return; }
    sockets.add(socket);
    perIp.set(ip, count + 1);
    socket.once('close', () => {
      sockets.delete(socket);
      const remaining = (perIp.get(ip) ?? 1) - 1;
      if (remaining) perIp.set(ip, remaining); else perIp.delete(ip);
    });
  });
  server.on('tlsClientError', (error, socket) => { opts.logger.debug('Peer TLS handshake rejected', error); socket.destroy(); });
  server.on('error', error => opts.logger.error('Peer listener error', error));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.bind, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Peer listener has no TCP address');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const socket of sockets) socket.destroy();
    }),
  };
}

export function connectPeer(opts: {
  host: string; port: number; identity: string; psk: Buffer; timeoutMs?: number; signal?: AbortSignal;
}): Promise<FramedConnection> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: opts.host, port: opts.port, ciphers: PSK_CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
      pskCallback: () => ({ psk: opts.psk, identity: opts.identity }),
      checkServerIdentity: () => undefined, rejectUnauthorized: false,
    });
    const timeout = setTimeout(() => fail(new Error('Peer connection timed out')), opts.timeoutMs ?? 5000);
    const abort = () => fail(new Error('Peer connection cancelled'));
    function cleanup() { clearTimeout(timeout); socket.off('error', fail); socket.off('close', closed); opts.signal?.removeEventListener('abort', abort); }
    function fail(error: Error) { cleanup(); socket.on('error', () => {}); socket.destroy(); reject(error); }
    function closed() { fail(new Error('Peer closed during TLS handshake')); }
    socket.once('error', fail);
    socket.once('close', closed);
    socket.once('secureConnect', () => { cleanup(); resolve(new FramedConnection(socket)); });
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
  });
}
