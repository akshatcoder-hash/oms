import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_OPTIONS, renderText, runChecks } from '../src/doctor/checks.ts';
import { nodeEnv } from '../src/doctor/node-env.ts';

test('doctor shows the diagnostic from a real failing Solana shim', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'oms-doctor-shim-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shim = join(directory, 'solana.mjs');
  await writeFile(shim, 'process.stderr.write("QA_SOLANA_ERROR: unable to load Solana runtime\\n"); process.exit(42);');
  const env = nodeEnv();
  const execute = env.exec;
  env.exec = (bin) =>
    bin === 'solana'
      ? execute(process.execPath, [shim])
      : Promise.resolve({ ok: true, out: bin === 'surfpool' ? 'surfpool 1.7.0' : '1' });
  env.env = {};
  env.freeDiskGb = async () => 50;
  env.rpcHealth = async () => ({ ok: true, out: '"ok"' });
  const results = await runChecks(env, DEFAULT_OPTIONS);
  assert.match(
    renderText(results),
    /Solana CLI +QA_SOLANA_ERROR: unable to load Solana runtime The Solana CLI is needed to build and deploy programs\./,
  );
});

test('failed exec prefers stderr, falls back to stdout and keeps diagnostics short', async () => {
  const env = nodeEnv();
  for (const [stderr, stdout, expected] of [
    ['  stderr detail\n', 'stdout detail', 'stderr detail'],
    [' \n', '  stdout detail\n', 'stdout detail'],
    ['first line\nsecond line', '', 'first line second line'],
    ['x'.repeat(400), '', 'x'.repeat(300)],
  ]) {
    const result = await env.exec(process.execPath, [
      '-e',
      `process.stderr.write(${JSON.stringify(stderr)}); process.stdout.write(${JSON.stringify(stdout)}); process.exit(42);`,
    ]);
    assert.deepEqual(result, { ok: false, out: expected });
  }
});

test('failed exec without output keeps the command error and ENOENT stays not installed', async () => {
  const env = nodeEnv();
  const result = await env.exec(process.execPath, ['-e', 'process.exit(42)']);
  assert.equal(result.ok, false);
  assert.match(result.out, /^Command failed:/);
  assert.ok(!result.out.includes('\n'));
  assert.ok(result.out.length <= 300);
  assert.deepEqual(await env.exec(join(tmpdir(), 'oms-missing-command', 'missing'), []), {
    ok: false,
    out: 'not installed',
  });
});

test('successful exec still reports stdout or stderr', async () => {
  const env = nodeEnv();
  assert.deepEqual(await env.exec(process.execPath, ['-e', 'console.log("tool version")']), {
    ok: true,
    out: 'tool version',
  });
  assert.deepEqual(await env.exec(process.execPath, ['-e', 'console.error("stderr version")']), {
    ok: true,
    out: 'stderr version',
  });
});
