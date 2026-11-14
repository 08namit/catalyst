/**
 * Test-only fallback for sandboxes denying loopback. No sockets or network
 * access in the adapter: real Node TLS runs over two linked Duplex streams.
 */
import { Duplex } from 'node:stream';
import type * as TLS from 'node:tls';

export async function canListenOnLoopback(): Promise<boolean> {
  const { createServer } = await import('node:net');
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

function streams(): [Duplex, Duplex] {
  let left: Duplex;
  let right: Duplex;
  function side(other: () => Duplex): Duplex {
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) { if (!other().destroyed) other().push(Buffer.from(chunk)); callback(); },
      final(callback) { if (!other().destroyed) other().push(null); callback(); },
      destroy(error, callback) { queueMicrotask(() => other().destroy()); callback(error); },
    });
    Object.defineProperty(stream, 'remoteAddress', { value: '127.0.0.1' });
    stream.on('error', () => {});
    return stream;
  }
  left = side(() => right);
  right = side(() => left);
  return [left, right];
}

export function memoryTls(actual: typeof TLS): typeof TLS {
  let nextPort = 34000;
  const servers = new Map<number, TLS.Server>();
  function createServer(options: TLS.TlsOptions, listener?: (socket: TLS.TLSSocket) => void): TLS.Server {
    const server = actual.createServer(options, listener);
    let port = 0;
    Object.defineProperty(server, 'listen', { value: (requested: number, _host: string, callback: () => void) => {
      port = requested || nextPort++;
      if (servers.has(port)) { queueMicrotask(() => server.emit('error', new Error('EADDRINUSE'))); return server; }
      servers.set(port, server);
      queueMicrotask(callback);
      return server;
    } });
    Object.defineProperty(server, 'address', { value: () => ({ address: '127.0.0.1', family: 'IPv4', port }) });
    Object.defineProperty(server, 'close', { value: (callback: (error?: Error) => void) => {
      if (servers.get(port) === server) servers.delete(port);
      queueMicrotask(() => { server.emit('close'); callback(); });
      return server;
    } });
    return server;
  }
  function connect(options: TLS.ConnectionOptions): TLS.TLSSocket {
    if (options.host !== '127.0.0.1') throw new Error('Memory TLS tests only permit loopback destinations');
    const [serverSide, clientSide] = streams();
    const server = servers.get(options.port!);
    const client = actual.connect({ ...options, socket: clientSide });
    queueMicrotask(() => {
      if (server) server.emit('connection', serverSide);
      else clientSide.destroy(new Error(`connect ECONNREFUSED 127.0.0.1:${options.port}`));
    });
    return client;
  }
  return { ...actual, createServer, connect } as typeof TLS;
}
