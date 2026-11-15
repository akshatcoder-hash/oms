/**
 * Trusted host-side relay from private Unix sockets to fixed 127.0.0.1 ports.
 * Native Linux Docker maps host.docker.internal to the bridge gateway, which
 * cannot reach loopback-only services. Bind-mounting these sockets into the
 * forwarder reaches them without any host listener beyond loopback.
 */
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SandboxError } from './errors.ts';

export interface HostRelay {
  /** Contains exactly one `<port>.sock` per requested port. */
  directory: string;
  close(): Promise<void>;
}

export async function openHostRelay(ports: readonly number[]): Promise<HostRelay> {
  for (const port of ports) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
      throw new SandboxError('E_BAD_ARGUMENT', `invalid relay port: ${port}`);
  }
  // The 0700 parent keeps other host users out; the forwarder's fixed uid reaches the sockets only through its bind mount.
  const parent = await mkdtemp(path.join(tmpdir(), 'oms-relay-'));
  const directory = path.join(parent, 'sockets');
  const servers: net.Server[] = [];
  const connections = new Set<net.Socket>();
  const close = async () => {
    for (const socket of connections) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await rm(parent, { recursive: true, force: true });
  };
  try {
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    for (const port of new Set(ports)) {
      // Half-open on both legs keeps a client's early FIN from discarding the reply.
      const server = net.createServer({ allowHalfOpen: true }, (client) => {
        const upstream = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
        for (const socket of [client, upstream]) {
          connections.add(socket);
          socket.on('close', () => connections.delete(socket));
        }
        client.pipe(upstream).pipe(client);
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      });
      servers.push(server);
      const socketPath = path.join(directory, `${port}.sock`);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
      await chmod(socketPath, 0o666);
    }
    return { directory, close };
  } catch (error) {
    await close();
    throw error;
  }
}
