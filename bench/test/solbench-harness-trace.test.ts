import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sliceEgressLog, startWorkspaceTrace } from '../src/solbench-harness/trace.ts';

test('the workspace trace records each changed text file once per version and skips dependencies and binaries', () => {
  const base = mkdtempSync(join(tmpdir(), 'oms-trace-'));
  const work = join(base, 'work');
  const out = join(base, 'trace');
  mkdirSync(join(work, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(work, 'node_modules', 'x', 'index.js'), 'dependency');
  writeFileSync(join(work, 'run.mjs'), 'v1');
  writeFileSync(join(work, 'blob.bin'), Buffer.from([1, 0, 2]));
  try {
    const stop = startWorkspaceTrace(work, out, 60_000);
    writeFileSync(join(work, 'run.mjs'), 'v2');
    stop();
    const rows = readFileSync(join(out, 'index.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.map((row) => row.path),
      ['run.mjs', 'run.mjs'],
      'two versions of the script, nothing else',
    );
    assert.deepEqual(
      rows.map((row) => readFileSync(join(out, 'files', row.sha256), 'utf8')),
      ['v1', 'v2'],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the egress slice keeps only the run window', () => {
  const base = mkdtempSync(join(tmpdir(), 'oms-egress-'));
  const log = join(base, 'egress');
  const out = join(base, 'slice');
  writeFileSync(
    log,
    ['2026-11-14T00:00:00Z', '2026-11-14T00:05:00Z', '2026-11-14T00:10:00Z']
      .map((at) => JSON.stringify({ at, host: 'github.com' }))
      .join('\n') + '\n',
  );
  try {
    sliceEgressLog(log, Date.parse('2026-11-14T00:01:00Z'), Date.parse('2026-11-14T00:06:00Z'), out);
    assert.deepEqual(
      readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).at),
      ['2026-11-14T00:05:00Z'],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
