import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateQueue, isReadMethod } from '../src/queue.ts';
import { SurfnetRpcError } from '../src/rpc.ts';

const fail = (msg: string) => {
  throw new SurfnetRpcError({ code: 'unknown', summary: msg, hint: '', raw: msg });
};

test('write jobs run strictly in submission order', async () => {
  const queue = createStateQueue();
  const order: number[] = [];
  const jobs = [100, 50, 25, 5].map((delay, i) =>
    queue.enqueueWrite(async () => {
      await new Promise((r) => setTimeout(r, delay));
      order.push(i);
      return i;
    }),
  );
  const results = await Promise.all(jobs);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.deepEqual(results, [0, 1, 2, 3]);
});

test('one failing write does not wedge the queue', async () => {
  const queue = createStateQueue();
  await assert.rejects(
    queue.enqueueWrite(async () => fail('boom one')),
    /boom one/,
  );
  await assert.rejects(
    queue.enqueueWrite(async () => fail('boom two')),
    /boom two/,
  );
  const result = await queue.enqueueWrite(async () => 'still alive');
  assert.equal(result, 'still alive');
  assert.equal(queue.pending(), 0);
  await queue.idle();
});

test('later jobs start only after the earlier job settles (even on rejection)', async () => {
  const queue = createStateQueue();
  const events: string[] = [];
  const first = queue.enqueueWrite(async () => {
    events.push('first-start');
    fail('first failed');
  });
  const second = queue.enqueueWrite(async () => {
    events.push('second-start');
    return 'ok';
  });
  await assert.rejects(first, /first failed/);
  assert.equal(await second, 'ok');
  assert.deepEqual(events, ['first-start', 'second-start']);
});

test('idle resolves only after all queued jobs finish', async () => {
  const queue = createStateQueue();
  let done = false;
  queue.enqueueWrite(async () => {
    await new Promise((r) => setTimeout(r, 30));
    done = true;
  });
  assert.ok(queue.pending() > 0);
  await queue.idle();
  assert.equal(done, true);
  assert.equal(queue.pending(), 0);
});

test('isReadMethod classifies reads vs writes; unknown surfnet_* is a write', () => {
  for (const read of [
    'getHealth',
    'getAccountInfo',
    'getLatestBlockhash',
    'surfnet_getSurfnetInfo',
    'surfnet_getLocalSignatures',
  ]) {
    assert.equal(isReadMethod(read), true, read);
  }
  for (const write of [
    'sendTransaction',
    'surfnet_setAccount',
    'surfnet_setTokenAccount',
    'surfnet_exportSnapshot',
    'surfnet_writeProgram',
    'surfnet_timeTravel',
    'surfnet_somethingNewAndUnknown',
  ]) {
    assert.equal(isReadMethod(write), false, write);
  }
});
