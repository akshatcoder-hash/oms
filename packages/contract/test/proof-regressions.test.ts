import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createEvaluator, createProposer } from '../src/evaluator.ts';
import { createContractStore } from '../src/store.ts';
import { createVerifierCache } from '../src/evidence.ts';
import { parseTaskContract } from '../src/schema.ts';
import { evidenceFor, makeProject } from '../test-support/fixture.ts';
import { acquireSourceAccess } from '../src/source-access.ts';

test('two requirements share inputs but never share a cached verdict', async (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  const cache = createVerifierCache();
  let calls = 0;
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, cache, runner: async (item, ctx) => {
    calls++; return evidenceFor(item, ctx);
  } });
  const proposer = createProposer({ ...p.roots, pinFile: p.pinFile });
  assert.equal(proposer.propose('item-1').ok, true);
  assert.equal((await evaluator.evaluate('item-1')).closed, true);
  assert.equal(createContractStore({ ...p.roots, pinFile: p.pinFile }).activate('item-2').ok, true);
  assert.equal(proposer.propose('item-2').ok, true);
  assert.equal((await evaluator.evaluate('item-2')).closed, true);
  assert.equal(calls, 2);
});

test('changed and legitimately repinned done command cannot replay an old pass', async (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  const initial = p.contract();
  initial.items[0]!.done = [{ kind: 'tests', command: [process.execPath, '-e', 'process.exit(0)'], expect: 'pass' }];
  p.setContract(initial);
  const statuses: (number | null)[] = [];
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, cache: createVerifierCache(), runner: async (item, ctx) => {
    const condition = item.done[0];
    assert.equal(condition?.kind, 'tests');
    if (condition?.kind !== 'tests') throw new Error('expected command');
    const result = spawnSync(condition.command[0]!, condition.command.slice(1), { cwd: ctx.codeRoot });
    statuses.push(result.status);
    return evidenceFor(item, ctx, { passed: result.status === 0 });
  } });
  const proposer = createProposer({ ...p.roots, pinFile: p.pinFile });
  proposer.propose('item-1'); assert.equal((await evaluator.evaluate('item-1')).closed, true);
  const next = p.contract();
  next.items[0]!.done = [{ kind: 'tests', command: [process.execPath, '-e', 'process.exit(1)'], expect: 'pass' }];
  p.setContract(next); proposer.propose('item-1');
  const result = await evaluator.evaluate('item-1');
  assert.equal(result.reason, 'failed');
  assert.deepEqual(statuses, [0, 1]);
});

for (const mutation of ['edit', 'addition', 'manifest', 'snapshot'] as const) {
  test(`${mutation} during awaited verification refuses closure and preserves saved inputs`, async (t) => {
    const p = makeProject(); t.after(() => p.cleanup());
    const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, runner: async (item, ctx) => {
      const before = readFileSync(join(ctx.codeRoot, 'src/main.ts'), 'utf8');
      await Promise.resolve();
      const target = mutation === 'edit' ? p.codePath : mutation === 'addition' ? join(p.root, 'src/imported.ts') : mutation === 'manifest' ? join(p.root, 'package.json') : join(p.root, p.config.snapshotPath!);
      writeFileSync(target, 'changed');
      assert.equal(readFileSync(join(ctx.codeRoot, 'src/main.ts'), 'utf8'), before);
      return evidenceFor(item, ctx);
    } });
    createProposer({ ...p.roots, pinFile: p.pinFile }).propose('item-1');
    assert.equal((await evaluator.evaluate('item-1')).reason, 'inputs-changed');
    const read = evaluator.read(); assert.equal(read.ok && read.value.items[0]?.status, 'proposed');
  });
}

test('later source additions make closed evidence visibly stale without rewriting history', async (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, runner: async (item, ctx) => evidenceFor(item, ctx) });
  createProposer({ ...p.roots, pinFile: p.pinFile }).propose('item-1');
  assert.equal((await evaluator.evaluate('item-1')).closed, true);
  writeFileSync(join(p.root, 'src/new-import.ts'), 'export const value = 2;');
  const read = evaluator.read();
  assert.equal(read.ok && read.value.items[0]?.status, 'stale');
});

test('raw token atoms reject fractions and preserve large unsigned integers', () => {
  const p = { version: 0, items: [{ id: 'x', title: 'x', status: 'active', reopenCount: 0,
    done: [{ kind: 'account', address: '11111111111111111111111111111111', field: 'tokenAmount', equals: '1.5' }] }] };
  assert.equal(parseTaskContract(p).ok, false);
  p.items[0]!.done[0]!.equals = '18446744073709551615';
  assert.equal(parseTaskContract(p).ok, true);
});

test('a mutated runner context cannot redefine the required proof identities', async (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, runner: async (item, ctx) => {
    ctx.codeDigest = '0'.repeat(64);
    return evidenceFor(item, ctx);
  } });
  createProposer({ ...p.roots, pinFile: p.pinFile }).propose('item-1');
  assert.equal((await evaluator.evaluate('item-1')).reason, 'evidence-not-bound');
});

test('pin cannot live elsewhere inside workspace or move the trusted state into code', (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  assert.equal(p.pin({ pinFile: join(p.roots.workspaceRoot, 'pin.json') }).ok, false);
  assert.equal(p.pin({ stateRoot: p.root }).ok, false);
});

test('changing snapshot bytes before verification cannot be labeled offline evidence', async (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  let called = false;
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, runner: async (item, ctx) => {
    called = true; return evidenceFor(item, ctx);
  } });
  createProposer({ ...p.roots, pinFile: p.pinFile }).propose('item-1');
  writeFileSync(join(p.root, p.config.snapshotPath!), 'different snapshot');
  assert.equal((await evaluator.evaluate('item-1')).closed, false);
  assert.equal(called, false);
});

test('adding an imported module outside codePaths invalidates a cached failure', async (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  writeFileSync(join(p.root, 'src/entry.mjs'), "import { value } from './added.mjs'; if(value !== 7) process.exit(1);");
  const contract = p.contract();
  contract.items[0]!.done = [{ kind: 'tests', command: [process.execPath, 'src/entry.mjs'], expect: 'pass' }];
  p.setContract(contract);
  const exits: (number | null)[] = [];
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, cache: createVerifierCache(), runner: async (item, ctx) => {
    const result = spawnSync(process.execPath, ['src/entry.mjs'], { cwd: ctx.codeRoot });
    exits.push(result.status);
    return evidenceFor(item, ctx, { passed: result.status === 0 });
  } });
  const proposer = createProposer({ ...p.roots, pinFile: p.pinFile });
  proposer.propose('item-1');
  assert.equal((await evaluator.evaluate('item-1')).reason, 'failed');
  writeFileSync(join(p.root, 'src/added.mjs'), 'export const value = 7;');
  proposer.propose('item-1');
  assert.equal((await evaluator.evaluate('item-1')).closed, true);
  assert.deepEqual(exits, [1, 0]);
});

test('a changed pinned evaluator timeout cannot reuse a previous verdict', async (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  let calls = 0;
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, cache: createVerifierCache(), runner: async (item, ctx) => {
    calls++; return evidenceFor(item, ctx);
  } });
  const proposer = createProposer({ ...p.roots, pinFile: p.pinFile });
  proposer.propose('item-1'); assert.equal((await evaluator.evaluate('item-1')).closed, true);
  assert.equal(evaluator.reopen('item-1').ok, true);
  p.config.testTimeoutMs = 5000;
  p.pinOrThrow();
  proposer.propose('item-1'); assert.equal((await evaluator.evaluate('item-1')).closed, true);
  assert.equal(calls, 2);
});

test('a changed actual runtime refuses cached evidence before dispatch', async (t) => {
  const p = makeProject(); t.after(() => p.cleanup());
  const cache = createVerifierCache();
  const passing = Object.assign(async (item: Parameters<typeof evidenceFor>[0], ctx: Parameters<typeof evidenceFor>[1]) => evidenceFor(item, ctx), { executionIdentity: 'test:controlled' });
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, cache, runner: passing });
  const proposer = createProposer({ ...p.roots, pinFile: p.pinFile });
  proposer.propose('item-1'); assert.equal((await evaluator.evaluate('item-1')).closed, true);
  const changed = createEvaluator({ ...p.roots, pinFile: p.pinFile, cache,
    runner: Object.assign(async () => { throw new Error('must refuse before runner dispatch'); }, { executionIdentity: 'different-runtime' }),
  });
  const view = changed.read(); assert.equal(view.ok && view.value.items[0]?.status, 'stale');
  evaluator.reopen('item-1'); proposer.propose('item-1');
  assert.equal((await changed.evaluate('item-1')).reason, 'evidence-not-bound');
});

test('capture releases ownership before awaited verification and refuses comparisons under a live writer', async t => {
  const p = makeProject(); t.after(() => p.cleanup());
  let holdWriter = true;
  let releaseWriter: (() => void) | undefined;
  t.after(() => releaseWriter?.());
  const evaluator = createEvaluator({ ...p.roots, pinFile: p.pinFile, runner: async (item, context) => {
    releaseWriter = acquireSourceAccess(p.root, { ...p.roots, kind: 'sandbox' });
    if (!holdWriter) releaseWriter();
    await Promise.resolve();
    return evidenceFor(item, context);
  } });
  assert.equal(createProposer({ ...p.roots, pinFile: p.pinFile }).propose('item-1').ok, true);
  assert.equal((await evaluator.evaluate('item-1')).reason, 'inputs-changed');
  releaseWriter!();
  holdWriter = false;
  assert.equal((await evaluator.evaluate('item-1')).closed, true);
});

test('root substitution after verified pin but before capture cannot read a newly resolved outside tree', async t => {
  const p = makeProject(); t.after(() => p.cleanup());
  const outside = join(p.outside, 'substituted-tree');
  cpSync(p.root, outside, { recursive: true });
  writeFileSync(join(outside, 'outside-marker'), 'outside synthetic bytes');
  let release: (() => void) | undefined;
  let barrierReached = false;
  let runnerCalled = false;
  const evaluator = createEvaluator({
    ...p.roots, pinFile: p.pinFile,
    clock: () => {
      // The existing trusted clock injection is a deterministic barrier after
      // initial pin verification/contract read and immediately before capture.
      barrierReached = true;
      release = acquireSourceAccess(dirname(p.root), { ...p.roots, kind: 'sandbox' });
      renameSync(p.root, `${p.root}-original`);
      symlinkSync(outside, p.root);
      return new Date('2026-01-01T00:00:00.000Z');
    },
    runner: async (item, context) => { runnerCalled = true; return evidenceFor(item, context); },
  });
  assert.equal(createProposer({ ...p.roots, pinFile: p.pinFile }).propose('item-1').ok, true);
  try {
    const result = await evaluator.evaluate('item-1');
    assert.equal(barrierReached, true);
    assert.equal(result.reason, 'code-unreadable');
    assert.equal(runnerCalled, false, 'outside inputs must never reach the runner, even if a later pin check would reject them');
  } finally { release?.(); }
});
