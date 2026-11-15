import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { openHostRelay } from '../src/host-relay.ts';

function request(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath, () => sock.end('GET / HTTP/1.0\r\n\r\n'));
    let body = '';
    sock.on('data', (chunk) => {
      body += chunk;
    });
    sock.on('end', () => resolve(body));
    sock.on('error', reject);
  });
}

test('host relay exposes only the requested loopback ports through private sockets and removes them on close', async (t) => {
  const server = http.createServer((_req, res) => res.end('LOOPBACK-OK'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  const relay = await openHostRelay([port]);
  let closed = false;
  t.after(async () => {
    if (!closed) await relay.close();
  });
  assert.deepEqual(readdirSync(relay.directory), [`${port}.sock`]);
  assert.equal(
    statSync(path.dirname(relay.directory)).mode & 0o777,
    0o700,
    'relay sockets live under an owner-only directory',
  );
  assert.match(await request(path.join(relay.directory, `${port}.sock`)), /LOOPBACK-OK/);
  const held = net.connect(path.join(relay.directory, `${port}.sock`));
  await once(held, 'connect');
  const heldClosed = once(held, 'close');
  await relay.close();
  closed = true;
  await heldClosed;
  assert.equal(existsSync(path.dirname(relay.directory)), false);
});

test('host relay rejects invalid ports', async () => {
  await assert.rejects(openHostRelay([0]), /port/);
  await assert.rejects(openHostRelay([65536]), /port/);
});
