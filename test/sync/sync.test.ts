import { hkdfSync, randomBytes } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { nullLogger } from '../../src/core/log.js';
import { LIMITS, PROTOCOL_VERSION } from '../../src/core/protocol.js';
import { PeerManager } from '../../src/sync/peer.js';
import { confirmCode, deriveInvitePsk, derivePairPsk } from '../../src/sync/crypto.js';
import { encodeInvite, joinWithInvite, parseInvite } from '../../src/sync/pairing.js';
import { connectPeer, createPeerServer, parseAddress, type FramedConnection } from '../../src/sync/transport.js';
import { IDLE_TIMEOUT_MS, MAX_CONNECTIONS_PER_IP, PEER_IDENTITY_PREFIX, type Frame, type HelloFrame } from '../../src/sync/frames.js';
import { identity, MemoryDirectory, MemoryStore } from './fakes.js';

// TCP by default; restricted sandboxes use real TLS over Duplex streams. Set
// CATALYST_TEST_MEMORY_TLS=0 to require TCP, or =1 to explicitly test the fallback.
vi.mock('node:tls', async () => {
  const actual = await vi.importActual<typeof import('node:tls')>('node:tls');
  if (process.env.CATALYST_TEST_MEMORY_TLS === '0') return actual;
  const { memoryTls, canListenOnLoopback } = await import('./memory-network.js');
  if (process.env.CATALYST_TEST_MEMORY_TLS !== '1' && await canListenOnLoopback()) return actual;
  process.stderr.write('[sync tests] Running real TLS over memory streams; TCP loopback is unavailable or explicitly disabled.\n');
  return memoryTls(actual);
});

const project = 'prj_0123456789abcdef01234567';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });

async function until(predicate: () => boolean, timeout = 3500): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function node(name: string, port = 0, existing?: { id: ReturnType<typeof identity>; store: MemoryStore; directory: MemoryDirectory }) {
  const id = existing?.id ?? identity(name);
  const store = existing?.store ?? new MemoryStore(project, id.participantId);
  const directory = existing?.directory ?? new MemoryDirectory();
  const joined = vi.fn();
  const changed = vi.fn();
  const manager = new PeerManager({ store, invites: store, directory, identity: id, projectId: project, projectName: 'Sync test',
    bind: '127.0.0.1', port, advertiseHosts: ['127.0.0.1'], logger: nullLogger, backoff: { minMs: 50, maxMs: 200 },
    statusIntervalMs: 40, onPeerJoined: joined, onStatusChange: changed });
  const result = await manager.start();
  cleanup.push(() => manager.stop());
  return { id, store, directory, manager, port: result.port, joined, changed };
}
type TestNode = Awaited<ReturnType<typeof node>>;
function register(a: TestNode, b: TestNode, key: string) {
  a.directory.addPeer({ participantId: b.id.participantId, name: b.id.name, publicKey: b.id.publicKey, pairKey: key,
    addrs: [`127.0.0.1:${b.port}`], addedAt: new Date().toISOString() });
}
async function pair() {
  const a = await node('Alice'); const b = await node('Bob');
  const key = randomBytes(32).toString('base64');
  register(a, b, key); register(b, a, key);
  a.manager.kick(); b.manager.kick();
  await until(() => a.manager.status()[0]?.state === 'connected' && b.manager.status()[0]?.state === 'connected');
  return { a, b, key };
}
async function raw(a: TestNode, b: TestNode, key: string): Promise<FramedConnection> {
  const conn = await connectPeer({ host: '127.0.0.1', port: a.port, identity: `${PEER_IDENTITY_PREFIX}${project}/${b.id.participantId}`,
    psk: derivePairPsk(key, project, [a.id.participantId, b.id.participantId]), timeoutMs: 700 });
  cleanup.push(() => conn.destroy());
  return conn;
}
function nextFrame(conn: FramedConnection, predicate: (frame: Frame) => boolean): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Expected frame did not arrive')), 1500);
    function finish(error: Error) { clear(); reject(error); }
    function clear() { clearTimeout(timer); conn.off('frame', frame); conn.off('close', closed); conn.off('error', finish); }
    function closed() { finish(new Error('Connection closed before expected frame')); }
    function frame(f: Frame) { if (predicate(f)) { clear(); resolve(f); } }
    conn.on('frame', frame); conn.once('close', closed); conn.once('error', finish);
  });
}
function hello(b: TestNode, overrides: Partial<HelloFrame> = {}): HelloFrame {
  return { t: 'hello', protocol: PROTOCOL_VERSION, software: 'test', project, participant: b.id.participantId,
    name: b.id.name, addrs: [`127.0.0.1:${b.port}`], vector: {}, ...overrides };
}

describe('PSK crypto and invitations', () => {
  it('uses the frozen HKDF inputs and code-point sorting without mutating ids', () => {
    const key = randomBytes(32).toString('base64');
    const ids = ['z', 'A', 'a'];
    expect(derivePairPsk(key, project, ids)).toEqual(Buffer.from(hkdfSync('sha256', Buffer.from(key, 'base64'), project, 'catalyst-psk-v1|A|a|z', 32)));
    expect(ids).toEqual(['z', 'A', 'a']);
    const secret = randomBytes(32).toString('base64url');
    expect(deriveInvitePsk(secret, project, 'id')).toEqual(Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'base64url'), project, 'catalyst-invite-v1|id', 32)));
  });

  it('pairs over an invite, agrees on the TLS code, and rejects reuse', async () => {
    const a = await node('Alice'); const b = await node('Bob');
    const invitation = a.manager.createInvite({});
    const parsed = parseInvite(invitation.token);
    expect(a.store.invitations.get(invitation.inviteId)?.inviteKey).not.toBe(parsed.secret);
    const result = await joinWithInvite(invitation.token, { identity: b.id, addrs: [`127.0.0.1:${b.port}`], logger: nullLogger, timeoutMs: 700 });
    expect(result.projectId).toBe(project);
    expect(result.projectName).toBe('Sync test');
    expect(result.confirmCode).toMatch(/^[0-9a-f]{8}$/);
    expect(a.directory.getPeer(b.id.participantId)?.confirmCode).toBe(result.confirmCode);
    expect(a.directory.getPeer(b.id.participantId)?.pairKey).toBe(result.inviter.pairKey);
    expect(a.joined).toHaveBeenCalledOnce();
    expect(a.store.known.has(b.id.participantId)).toBe(true);
    b.directory.addPeer(result.inviter); b.manager.kick();
    await until(() => a.manager.status()[0]?.state === 'connected' && b.manager.status()[0]?.state === 'connected');
    await expect(joinWithInvite(invitation.token, { identity: identity('Carol'), addrs: [], logger: nullLogger, timeoutMs: 700 }))
      .rejects.toThrow(/Invitation rejected by 127\.0\.0\.1:.*already been used/);
  });

  it('rejects expired and malformed invitations with actionable messages', async () => {
    const a = await node('Alice');
    const payload = parseInvite(a.manager.createInvite({}).token);
    expect(() => parseInvite(encodeInvite({ ...payload, exp: '2020-01-01T00:00:00.000Z' }))).toThrow(/Invitation expired at .*catalyst pair/);
    for (const token of ['cat1_!!!!', 'garbage', 'cat1_' + Buffer.from('{}').toString('base64url'), encodeInvite({ ...payload, v: 2 } as never), encodeInvite({ ...payload, secret: 'short' })]) {
      expect(() => parseInvite(token)).toThrow(/Invalid invitation/);
    }
    a.store.invitations.get(payload.inviteId)!.expiresAt = '2020-01-01T00:00:00.000Z';
    await expect(joinWithInvite(encodeInvite(payload), { identity: identity('Bob'), addrs: [], logger: nullLogger, timeoutMs: 700 })).rejects.toThrow(/Invitation rejected|Could not join invitation/);
  });

  it('tries invitation addresses in order and reports each failed address', async () => {
    const a = await node('Alice'); const b = await node('Bob');
    const invite = parseInvite(a.manager.createInvite({}).token);
    const token = encodeInvite({ ...invite, addrs: ['127.0.0.1:1', ...invite.addrs] });
    const result = await joinWithInvite(token, { identity: b.id, addrs: [], logger: nullLogger, timeoutMs: 300 });
    expect(result.inviter.participantId).toBe(a.id.participantId);
    await expect(joinWithInvite(encodeInvite({ ...invite, addrs: ['127.0.0.1:1', '127.0.0.1:2'] }), { identity: b.id, addrs: [], logger: nullLogger, timeoutMs: 100 }))
      .rejects.toThrow(/127\.0\.0\.1:1:.*\n127\.0\.0\.1:2:.*\n.*firewall.*catalyst pair --host/);
  });
});

describe('peer sessions', () => {
  it('pushes in both directions, acknowledges delivery, and propagates status', async () => {
    const { a, b } = await pair();
    const ae = a.store.append(); const be = b.store.append();
    await until(() => a.store.applied.has(be.id) && b.store.applied.has(ae.id) && a.manager.status()[0]!.pendingOutbound === 0 && b.manager.status()[0]!.pendingOutbound === 0);
    a.store.statusBody.retrieved.push({ id: be.id, at: new Date().toISOString() });
    await until(() => b.store.receivedStatus.get(a.id.participantId)?.retrieved.some(x => x.id === be.id) === true);
    expect(a.manager.status()[0]!.lastSyncAt).toBeTruthy();
    expect(a.changed).toHaveBeenCalled();
  });

  it('queues while paused then replays all authors, including the receiver and a third party, across pages', async () => {
    const { a, b } = await pair();
    b.manager.pause();
    expect(b.manager.isPaused()).toBe(true);
    expect(b.manager.status()[0]!.state).toBe('paused');
    const c = identity('Carol');
    const relayed = a.store.event(c.participantId, 1);
    a.store.ingest([relayed], { via: 'import' });
    for (let i = 0; i < LIMITS.maxEventsPerFrame * 2 + 7; i++) a.store.append();
    const local = b.store.append();
    const recovered = a.store.event(b.id.participantId, 2);
    a.store.ingest([local, recovered], { via: 'import' });
    expect(b.manager.status()[0]!.pendingOutbound).toBeGreaterThan(0);
    b.manager.resume();
    await until(() => a.store.applied.has(local.id) && b.store.applied.has(relayed.id) && b.store.applied.has(recovered.id) && b.store.applied.size === a.store.applied.size
      && a.manager.status()[0]!.pendingOutbound === 0 && b.manager.status()[0]!.pendingOutbound === 0);
    expect(b.store.getVector()[a.id.participantId]).toBe(a.store.getVector()[a.id.participantId]);
    expect(b.store.getVector()[c.participantId]).toBe(1);
    expect(b.store.getVector()[b.id.participantId]).toBe(2);
  });

  it('automatically reconnects and replays after a manager restarts on the same port', async () => {
    const { a, b } = await pair();
    await b.manager.stop();
    await until(() => a.manager.status()[0]!.state !== 'connected');
    const missed = a.store.append();
    const restarted = await node('Bob', b.port, b);
    await until(() => restarted.store.applied.has(missed.id) && a.manager.status()[0]!.pendingOutbound === 0 && a.manager.status()[0]!.state === 'connected');
    expect(restarted.port).toBe(b.port);
  });

  it('converges simultaneous dials to the connection dialed by the smaller id', async () => {
    const { a, b } = await pair();
    type Internals = { connections: Set<FramedConnection>; peers: Map<string, { session?: { outbound: boolean } }> };
    const ai = a.manager as unknown as Internals; const bi = b.manager as unknown as Internals;
    await until(() => ai.connections.size === 1 && bi.connections.size === 1);
    expect(ai.peers.get(b.id.participantId)!.session!.outbound).toBe(a.id.participantId < b.id.participantId);
    expect(bi.peers.get(a.id.participantId)!.session!.outbound).toBe(b.id.participantId < a.id.participantId);
    const event = a.store.append();
    await until(() => b.store.applied.has(event.id) && a.manager.status()[0]!.pendingOutbound === 0);
  });

  it('parks out-of-order wire events, acknowledges parked ids, and drains after the gap', async () => {
    const a = await node('Alice'); const b = await node('Bob');
    const key = randomBytes(32).toString('base64'); register(a, b, key);
    const conn = await raw(a, b, key);
    const ready = nextFrame(conn, f => f.t === 'status'); conn.send(hello(b)); await ready;
    const second = b.store.event(b.id.participantId, 2); const first = b.store.event(b.id.participantId, 1);
    let ack = nextFrame(conn, f => f.t === 'ack'); conn.send({ t: 'events', events: [second], replay: false });
    expect(await ack).toMatchObject({ ids: [second.id] });
    expect(a.store.getVector()[b.id.participantId]).toBeUndefined();
    expect(a.store.parked.size).toBe(1);
    ack = nextFrame(conn, f => f.t === 'ack'); conn.send({ t: 'events', events: [first], replay: false });
    expect(await ack).toMatchObject({ ids: [first.id, second.id] });
    expect(a.store.getVector()[b.id.participantId]).toBe(2);
    expect(a.store.parked.size).toBe(0);
    ack = nextFrame(conn, f => f.t === 'ack'); conn.send({ t: 'events', events: [first], replay: false });
    expect(await ack).toMatchObject({ ids: [first.id] });
  });

  it('forwards ingested events to a third peer without echoing to their source', async () => {
    const { a, b } = await pair(); const c = await node('Carol');
    const key = randomBytes(32).toString('base64'); register(a, c, key); register(c, a, key);
    a.manager.kick(); c.manager.kick();
    await until(() => c.manager.status()[0]?.state === 'connected');
    const ingestAtB = vi.spyOn(b.store, 'ingest');
    const event = b.store.append();
    await until(() => c.store.applied.has(event.id));
    expect(ingestAtB).not.toHaveBeenCalled();
    await until(() => a.store.pendingOutbound(c.id.participantId) === 0);
  });

  it('rejects incoming paired connections while paused and redials updated addresses', async () => {
    const { a, b, key } = await pair();
    a.manager.pause();
    await expect(raw(a, b, key)).rejects.toThrow();
    const queued = b.store.append();
    expect(a.store.applied.has(queued.id)).toBe(false);
    a.manager.setPeerAddrs(b.id.participantId, ['127.0.0.1:1']);
    expect(a.manager.status()[0]!.state).toBe('paused');
    a.manager.setPeerAddrs(b.id.participantId, [`127.0.0.1:${b.port}`]);
    a.manager.resume();
    await until(() => a.store.applied.has(queued.id) && b.store.pendingOutbound(a.id.participantId) === 0);
  });

  it('stops promptly while an outgoing TLS connection is awaiting hello', async () => {
    const a = await node('Alice'); const b = await node('Bob');
    await b.manager.stop();
    const key = randomBytes(32).toString('base64');
    const accepted: FramedConnection[] = [];
    const server = await createPeerServer({ bind: '127.0.0.1', port: b.port,
      resolvePsk: () => derivePairPsk(key, project, [a.id.participantId, b.id.participantId]),
      logger: nullLogger, onConnection: conn => { accepted.push(conn); } });
    cleanup.push(() => server.close());
    register(a, b, key); a.manager.kick();
    await until(() => accepted.length === 1);
    const start = Date.now();
    await a.manager.stop();
    expect(Date.now() - start).toBeLessThan(500);
    expect((a.manager as unknown as { connections: Set<FramedConnection> }).connections.size).toBe(0);
    await until(() => accepted[0]!.socket.destroyed);
  });

  it('closes a silent peer even while sending periodic pings', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const a = await node('Alice'); const b = await node('Bob');
      const key = randomBytes(32).toString('base64'); register(a, b, key);
      const conn = await raw(a, b, key);
      const ready = nextFrame(conn, f => f.t === 'status'); conn.send(hello(b)); await ready;
      const closed = new Promise<void>(resolve => conn.once('close', resolve));
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
      await closed;
      expect(a.manager.status()[0]!.state).toBe('unreachable');
      expect(a.manager.status()[0]!.lastError).toContain('idle timeout');
      await a.manager.stop(); await b.manager.stop();
    } finally { vi.useRealTimers(); }
  });

  it('shares concurrent starts and closes a listener when stopped during startup', async () => {
    const id = identity('Alice'); const store = new MemoryStore(project, id.participantId);
    const manager = new PeerManager({ store, invites: store, directory: new MemoryDirectory(), identity: id,
      projectId: project, projectName: 'test', bind: '127.0.0.1', port: 0, advertiseHosts: ['127.0.0.1'], logger: nullLogger });
    cleanup.push(() => manager.stop());
    const first = manager.start(); const second = manager.start(); const stopped = manager.stop();
    expect(await first).toEqual(await second);
    await stopped;
    const { port } = await first;
    const server = await createPeerServer({ bind: '127.0.0.1', port, resolvePsk: () => null, logger: nullLogger, onConnection: () => {} });
    cleanup.push(() => server.close());
    expect(server.port).toBe(port);
  });
});

describe('transport and protocol rejection', () => {
  it('parses host:port and bracketed IPv6', () => {
    expect(parseAddress('[::1]:4000')).toEqual({ host: '::1', port: 4000 });
    expect(parseAddress('127.0.0.1:4000')).toEqual({ host: '127.0.0.1', port: 4000 });
    for (const addr of ['::1:4000', 'host:0', 'host:65536', 'host:no', 'host']) expect(() => parseAddress(addr)).toThrow(/Invalid peer address/);
  });

  it('rejects wrong PSKs and unknown participants in the TLS handshake', async () => {
    const a = await node('Alice'); const b = await node('Bob');
    const key = randomBytes(32).toString('base64'); register(a, b, key);
    await expect(raw(a, b, randomBytes(32).toString('base64'))).rejects.toThrow();
    const c = await node('Carol');
    await expect(raw(a, c, key)).rejects.toThrow();
    expect(a.store.applied.size).toBe(0);
  });

  it.each([
    [{ project: 'prj_ffffffffffffffffffffffff' }, 'wrong_project'],
    [{ protocol: 99 }, 'incompatible_protocol'],
    [{ participant: 'p_ffffffffffffffffffffffff' }, 'unknown_participant'],
  ] as const)('rejects a mismatching hello: %s', async (overrides, code) => {
    const a = await node('Alice'); const b = await node('Bob');
    const key = randomBytes(32).toString('base64'); register(a, b, key); a.store.append();
    const conn = await raw(a, b, key);
    const frames: Frame[] = []; conn.on('frame', f => frames.push(f));
    const error = nextFrame(conn, f => f.t === 'error'); conn.send(hello(b, overrides));
    const frame = await error;
    expect(frame).toMatchObject({ code, fatal: true });
    if (frame.t === 'error' && code === 'incompatible_protocol') expect(frame.message).toMatch(/99.*2/);
    expect(frames.some(f => f.t === 'events')).toBe(false);
    expect(b.store.applied.size).toBe(0);
  });

  it.each(['oversize', 'json', 'shape'] as const)('rejects invalid NDJSON: %s', async kind => {
    const key = randomBytes(32); const serverConnections: FramedConnection[] = [];
    const server = await createPeerServer({ bind: '127.0.0.1', port: 0, resolvePsk: () => key, logger: nullLogger,
      onConnection: conn => { serverConnections.push(conn); } });
    cleanup.push(() => server.close());
    const conn = await connectPeer({ host: '127.0.0.1', port: server.port, identity: 'test', psk: key });
    cleanup.push(() => conn.destroy());
    const error = nextFrame(conn, f => f.t === 'error');
    conn.socket.write(kind === 'oversize' ? Buffer.alloc(LIMITS.maxFrameBytes + 1, 97) : kind === 'json' ? '{garbage}\n' : '{"t":"hello"}\n');
    expect(await error).toMatchObject({ code: 'bad_frame', fatal: true });
    await until(() => serverConnections[0]?.socket.destroyed === true);
  });

  it('handles fragmented UTF-8 lines and multiple frames in one TLS write', async () => {
    const key = randomBytes(32); const frames: Frame[] = []; let serverCode = '';
    const server = await createPeerServer({ bind: '127.0.0.1', port: 0, resolvePsk: () => key, logger: nullLogger,
      onConnection: conn => { serverCode = confirmCode(conn.socket); conn.on('frame', f => frames.push(f)); } });
    cleanup.push(() => server.close());
    const conn = await connectPeer({ host: '127.0.0.1', port: server.port, identity: 'test', psk: key });
    cleanup.push(() => conn.destroy());
    const bytes = Buffer.from('{"t":"ping","at":"🧪"}\n{"t":"pong","at":"now"}\n');
    const split = bytes.indexOf(Buffer.from('🧪')) + 1;
    conn.socket.write(bytes.subarray(0, split)); conn.socket.write(bytes.subarray(split));
    await until(() => frames.length === 2);
    expect(frames).toEqual([{ t: 'ping', at: '🧪' }, { t: 'pong', at: 'now' }]);
    expect(confirmCode(conn.socket)).toBe(serverCode);
  });

  it('buffers application frames that arrive before the caller attaches a listener', async () => {
    const key = randomBytes(32);
    const server = await createPeerServer({ bind: '127.0.0.1', port: 0, resolvePsk: () => key, logger: nullLogger,
      onConnection: conn => conn.send({ t: 'ping', at: 'early' }) });
    cleanup.push(() => server.close());
    const conn = await connectPeer({ host: '127.0.0.1', port: server.port, identity: 'test', psk: key });
    cleanup.push(() => conn.destroy());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await nextFrame(conn, () => true)).toEqual({ t: 'ping', at: 'early' });
  });

  it('limits concurrent connections per IP and releases slots on close', async () => {
    const key = randomBytes(32);
    const server = await createPeerServer({ bind: '127.0.0.1', port: 0, resolvePsk: () => key, logger: nullLogger,
      onConnection: () => {} });
    cleanup.push(() => server.close());
    const dial = () => connectPeer({ host: '127.0.0.1', port: server.port, identity: 'test', psk: key, timeoutMs: 500 });
    const conns: FramedConnection[] = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) {
      const conn = await dial(); conns.push(conn); cleanup.push(() => conn.destroy());
    }
    await expect(dial()).rejects.toThrow();
    await new Promise<void>(resolve => { conns[0]!.once('close', resolve); conns[0]!.destroy(); });
    // Give the listener's TCP close handler a turn to release its per-IP slot.
    await new Promise(resolve => setTimeout(resolve, 10));
    const replacement = await dial(); cleanup.push(() => replacement.destroy());
    expect(replacement.socket.destroyed).toBe(false);
  });

  it('rejects an oversized outbound frame and closes after flushing its error', async () => {
    const key = randomBytes(32); let accepted: FramedConnection | undefined;
    const server = await createPeerServer({ bind: '127.0.0.1', port: 0, resolvePsk: () => key, logger: nullLogger,
      onConnection: conn => { accepted = conn; } });
    cleanup.push(() => server.close());
    const conn = await connectPeer({ host: '127.0.0.1', port: server.port, identity: 'test', psk: key });
    cleanup.push(() => conn.destroy());
    await until(() => !!accepted);
    const error = nextFrame(accepted!, f => f.t === 'error');
    conn.send({ t: 'ping', at: 'a'.repeat(LIMITS.maxFrameBytes) });
    expect(await error).toMatchObject({ code: 'bad_frame', fatal: true });
    await until(() => conn.socket.destroyed);
  });
});
