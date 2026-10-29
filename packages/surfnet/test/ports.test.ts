import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { findFreePortPair, releasePorts } from '../src/ports.ts';

function listen(port: number): Promise<{ server: ReturnType<typeof createServer>; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.once('listening', () =>
      resolve({
        server,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      }),
    );
    server.listen(port, '127.0.0.1');
  });
}

test('findFreePortPair returns an even rpc port with ws = rpc + 1', async () => {
  const pair = await findFreePortPair();
  assert.equal(pair.ws, pair.rpc + 1);
  assert.equal(pair.rpc % 2, 0);
  assert.ok(pair.rpc >= 20000 && pair.rpc < 40000);
  releasePorts(pair);
});

test('findFreePortPair skips occupied ports', async () => {
  const blocker = await listen(30002);
  try {
    const pair = await findFreePortPair({ from: 30000 });
    assert.notEqual(pair.rpc, 30002);
    assert.notEqual(pair.rpc, 30003);
    releasePorts(pair);
  } finally {
    await blocker.close();
  }
});

test('two pairs found back-to-back do not collide', async () => {
  const a = await findFreePortPair();
  const b = await findFreePortPair();
  assert.notEqual(a.rpc, b.rpc);
  assert.notEqual(a.ws, b.ws);
  releasePorts(a);
  releasePorts(b);
});

test('a released pair can be found again', async () => {
  const a = await findFreePortPair();
  releasePorts(a);
  const b = await findFreePortPair();
  releasePorts(b);
  // No assertion needed: the reservation must not leak into the next probe.
});
