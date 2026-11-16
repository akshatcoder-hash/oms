import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaimTable, normalizePattern, patternsCover, patternsOverlap } from '../src/runtime/helpers/claims.ts';

const live = () => new AbortController().signal;
const settled = async (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30))]);

test('globs cover what they name', () => {
  assert.ok(patternsCover(['src/**'], 'src/a/b.ts'));
  assert.ok(patternsCover(['src/*.ts'], 'src/a.ts'));
  assert.ok(!patternsCover(['src/*.ts'], 'src/a/b.ts'));
  assert.ok(patternsCover(['programs/vault'], 'programs/vault/src/lib.rs'));
  assert.ok(patternsCover(['a.ts'], 'a.ts'));
  assert.ok(!patternsCover(['a.ts'], 'b.ts'));
  assert.ok(patternsCover(['**/*.md'], 'docs/x/y.md'));
});

test('patterns that could name the same file overlap, and disjoint folders do not', () => {
  assert.ok(patternsOverlap(['src/**'], ['src/a.ts']));
  assert.ok(patternsOverlap(['**'], ['anything/at/all.ts']));
  assert.ok(patternsOverlap(['*.ts'], ['a.ts']));
  assert.ok(!patternsOverlap(['src/a.ts'], ['src/b.ts']));
  assert.ok(!patternsOverlap(['programs/**'], ['tests/**']));
});

test('a pattern outside the folder is refused', () => {
  for (const bad of ['/etc/passwd', '../x', 'a/../../b', '']) assert.throws(() => normalizePattern(bad), /not a path/);
  assert.equal(normalizePattern('./src/'), 'src/**');
});

test('disjoint claims are held together, an overlapping one waits for the holder', async () => {
  const table = new ClaimTable();
  const a = await table.acquire('a', ['src/a.ts'], live());
  const b = await table.acquire('b', ['src/b.ts'], live());
  const waits: string[] = [];
  const c = table.acquire('c', ['src/**'], live(), (holder) => waits.push(holder));
  assert.equal(await settled(c), false);
  assert.deepEqual(waits, ['a']);
  a.release();
  assert.equal(await settled(c), false);
  b.release();
  const claim = await c;
  assert.deepEqual(claim.patterns, ['src/**']);
});

test('no files means the whole folder', async () => {
  const table = new ClaimTable();
  const whole = await table.acquire('whole', [], live());
  assert.equal(await settled(table.acquire('other', ['x.ts'], live())), false);
  whole.release();
});

test('waiters go in arrival order: a later claim does not jump one that is ahead of it and overlaps', async () => {
  const table = new ClaimTable();
  const first = await table.acquire('first', ['a/**'], live());
  const order: string[] = [];
  const second = table.acquire('second', ['a/x.ts', 'b/**'], live()).then((claim) => {
    order.push('second');
    return claim;
  });
  const third = table.acquire('third', ['b/y.ts'], live()).then((claim) => {
    order.push('third');
    return claim;
  });
  first.release();
  (await second).release();
  await third;
  assert.deepEqual(order, ['second', 'third']);
});

test('two claims over the same two paths in opposite order cannot deadlock', async () => {
  const table = new ClaimTable();
  const one = table.acquire('one', ['x/a.ts', 'y/b.ts'], live());
  const two = table.acquire('two', ['y/b.ts', 'x/a.ts'], live());
  const claim = await one;
  assert.equal(await settled(two), false);
  claim.release();
  (await two).release();
});

test('a waiting claim stops waiting when it is cancelled, and the ones behind it move up', async () => {
  const table = new ClaimTable();
  const held = await table.acquire('held', ['a.ts'], live());
  const controller = new AbortController();
  const cancelled = table.acquire('cancelled', ['a.ts'], controller.signal);
  const behind = table.acquire('behind', ['a.ts'], live());
  controller.abort(new Error('stop'));
  await assert.rejects(cancelled, /stop/);
  held.release();
  (await behind).release();
});

test('a write by another helper that held a claim during the run is not blamed on this one', async () => {
  const table = new ClaimTable();
  const mine = await table.acquire('mine', ['a.ts'], live());
  const since = Date.now() - 1;
  const other = await table.acquire('other', ['b.ts'], live());
  table.recordWrite(other, 'b.ts');
  other.release();
  assert.ok(table.writtenByOthers(mine, 'b.ts', since));
  assert.ok(!table.writtenByOthers(mine, 'c.ts', since));
  assert.ok(!table.writtenByOthers(mine, 'a.ts', since));
  mine.release();
});

test('S1: @-prefixed claims name the same files as the file tools', async () => {
  const table = new ClaimTable();
  const first = await table.acquire('first', ['@b.ts'], live());
  const second = table.acquire('second', ['b.ts'], live());
  assert.equal(await settled(second), false);
  first.release();
  (await second).release();
});

test('M1: only other live claims contribute protected command prefixes', async () => {
  const table = new ClaimTable();
  const mine = await table.acquire('mine', ['a.ts'], live());
  const peer = await table.acquire('peer', ['src/**/*.ts', 'Cargo.lock'], live());
  assert.deepEqual(table.protectedPrefixes(mine), ['src', 'Cargo.lock']);
  assert.deepEqual(table.protectedPrefixes(peer), ['a.ts']);
  peer.release();
  assert.deepEqual(table.protectedPrefixes(mine), []);
  mine.release();
});
