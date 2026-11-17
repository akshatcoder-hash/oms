import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';
import { helperInputCap, RequestGate } from '../src/runtime/helpers/runner.ts';

const stream = () => {
  let end!: () => void;
  const done = new Promise<void>((resolve) => (end = resolve));
  return { end, value: { result: () => done } as unknown as AssistantMessageEventStream };
};
const settled = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30))]);

test('a request that fits starts at once, and one that does not waits for a request in flight to end', async () => {
  const gate = new RequestGate();
  let room = true;
  const first = stream();
  const second = stream();
  await gate.admit(
    () => room,
    () => first.value,
    undefined,
  );
  room = false;
  const waiting = gate.admit(
    () => room,
    () => second.value,
    undefined,
  );
  assert.equal(await settled(waiting), false);
  room = true;
  first.end();
  assert.equal(await settled(waiting), true);
});

test('a request with nothing else in flight is never held back, so its own refusal can be reported', async () => {
  const gate = new RequestGate();
  const only = stream();
  assert.equal(
    await settled(
      gate.admit(
        () => false,
        () => only.value,
        undefined,
      ),
    ),
    true,
  );
});

test('a waiting request stops waiting when it is cancelled', async () => {
  const gate = new RequestGate();
  await gate.admit(
    () => true,
    () => stream().value,
    undefined,
  );
  const controller = new AbortController();
  const waiting = gate.admit(
    () => false,
    () => stream().value,
    controller.signal,
  );
  assert.equal(await settled(waiting), false);
  controller.abort();
  assert.equal(await settled(waiting), true);
});

test('a helper request reserves at most the helper window, never more than the model has', () => {
  const model = (contextWindow: number) => ({ contextWindow }) as Model<never>;
  assert.equal(helperInputCap(undefined, model(1_000_000)), 200_000);
  assert.equal(helperInputCap(undefined, model(4096)), 4096);
  assert.equal(helperInputCap(50_000, model(1_000_000)), 50_000);
});
