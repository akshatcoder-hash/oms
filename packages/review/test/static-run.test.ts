import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runStaticPass, type StaticRequest } from '../src/static/run.ts';
import type { ReviewSnapshot } from '../src/snapshot.ts';

function snapshot(files: Record<string, string>): ReviewSnapshot {
  return {
    excludedFiles: 0,
    inventory: () => new Map(Object.entries(files).map(([file, source]) => [file, source.split('\n').length])),
    read: (file) => {
      if (!(file in files)) throw new Error('Absent');
      return files[file]!;
    },
    grep: () => [],
  };
}
const empty = {
  exitCode: 0,
  stdout: JSON.stringify({ hits: [], handlers: [], implementedRules: [] }),
  timedOut: false,
  truncated: false,
};
const hit = {
  tool: 'oms-sast',
  ruleId: 'missing-signer/anchor-field',
  class: 'missing-signer',
  severity: 'high',
  location: { file: 'src/a.rs', line: 1 },
  message: 'Review authority',
};

test('static pass binds explicit captured inputs and offline command contracts', async () => {
  const requests: StaticRequest[] = [];
  const files = {
    'src/a.rs': 'pub fn a() {}',
    'src/b.rs': 'pub fn b() {}',
    'Cargo.toml': '[package]',
    'Cargo.lock': 'version=4',
    'other/Cargo.lock': 'unrelated',
    'README.md': 'not a scanner input',
  };
  const result = await runStaticPass(
    snapshot(files),
    { sources: ['src/b.rs', 'src/a.rs', 'src/a.rs'], manifest: 'Cargo.toml', lockfile: 'Cargo.lock' },
    {
      async run(request) {
        requests.push(request);
        files['src/b.rs'] = 'changed after capture';
        if (request.tool === 'cargo-audit')
          return {
            ...empty,
            stdout: JSON.stringify({
              database: {},
              lockfile: {},
              settings: { target_arch: [], target_os: [], severity: null, ignore: [], informational_warnings: [] },
              vulnerabilities: { found: false, count: 0, list: [] },
              warnings: {},
            }),
          };
        return empty;
      },
    },
  );
  assert.equal(requests.length, 4);
  assert.deepEqual(
    requests.map((r) => r.argv),
    [
      ['oms-sast', '--file', 'src/a.rs', '--lockfile', 'Cargo.lock'],
      ['oms-sast', '--file', 'src/b.rs', '--lockfile', 'Cargo.lock'],
      ['oms-sast', '--manifest', 'Cargo.toml'],
      ['cargo-audit', 'audit', '--no-fetch', '--db', '/opt/advisory-db', '--file', '/work/Cargo.lock', '--json'],
    ],
  );
  assert.deepEqual(
    requests.map((r) => [...r.files.keys()]),
    [['src/a.rs', 'Cargo.lock'], ['src/b.rs', 'Cargo.lock'], ['Cargo.toml'], ['Cargo.lock']],
  );
  assert.equal(requests[1]!.files.get('src/b.rs'), 'pub fn b() {}');
  for (const request of requests) {
    assert.equal(request.network, 'none');
    assert.equal(request.readOnly, true);
    assert.equal(request.cwd, '/work');
    assert.equal(request.timeoutMs, 300000);
    assert.equal(request.outputBytes, 4 * 1024 * 1024);
  }
  assert.ok(result.scans.every((scan) => scan.status === 'ok'));
  assert.deepEqual(result.hits, []);
  assert.equal('coverage' in result, false);
});

test('execution failures and invalid outputs retain other static hits without raw diagnostics', async () => {
  const result = await runStaticPass(
    snapshot({ 'src/a.rs': 'fn a() {}', 'src/b.rs': 'bad', 'src/c.rs': 'fn c() {}' }),
    { sources: ['src/c.rs', 'src/b.rs', 'src/a.rs'] },
    {
      async run(request) {
        if (request.argv[2] === 'src/b.rs') throw new Error('sensitive raw diagnostic');
        if (request.argv[2] === 'src/c.rs') return { ...empty, timedOut: true };
        return {
          ...empty,
          stdout: JSON.stringify({
            hits: [hit, { ...hit, location: { file: '../outside', line: 1 } }],
            handlers: [],
            implementedRules: [hit.ruleId],
          }),
        };
      },
    },
  );
  assert.deepEqual(result.hits, [hit]);
  assert.equal(result.invalidOutputs, 1);
  assert.equal('handlers' in result, false);
  assert.deepEqual(
    result.scans.slice(0, 3).map((scan) => scan.status),
    ['failed', 'failed', 'failed'],
  );
  assert.ok(!JSON.stringify(result).includes('sensitive raw diagnostic'));
});

test('invalid scope is rejected before any tool runs', async () => {
  let calls = 0;
  const port = {
    async run() {
      calls++;
      return empty;
    },
  };
  const captured = snapshot({ 'ok.rs': '', '../escape.rs': '', 'Cargo.toml': '', 'Cargo.lock': '', 'README.md': '' });
  for (const scope of [
    { sources: ['ok.rs', '../escape.rs'] },
    { sources: ['missing.rs'] },
    { sources: ['README.md'] },
    { sources: ['ok.rs'], lockfile: 'README.md' },
    { sources: ['ok.rs'], manifest: 'Cargo.lock' },
  ]) {
    await assert.rejects(runStaticPass(captured, scope, port), /Invalid static analysis scope/);
  }
  assert.equal(calls, 0);
});

test('empty scope is visibly skipped, never clean', async () => {
  const result = await runStaticPass(
    snapshot({}),
    { sources: [] },
    {
      async run() {
        assert.fail('No invocation expected');
      },
    },
  );
  assert.equal(result.scans.length, 3);
  assert.ok(result.scans.every((scan) => scan.status === 'skipped'));
  assert.deepEqual(result.hits, []);
});

test('whole-pass deadline clamps each step and leaves remaining checks visibly unrun', async () => {
  let time = 0;
  const requests: StaticRequest[] = [];
  const result = await runStaticPass(
    snapshot({ 'src/a.rs': '', 'src/b.rs': '', 'Cargo.toml': '', 'Cargo.lock': '' }),
    { sources: ['src/b.rs', 'src/a.rs'], manifest: 'Cargo.toml', lockfile: 'Cargo.lock' },
    {
      async run(request) {
        requests.push(request);
        time += requests.length === 1 ? 300000 : 100000;
        return { ...empty, stdout: JSON.stringify({ hits: [hit], handlers: [], implementedRules: [hit.ruleId] }) };
      },
    },
    { timeoutMs: 400000, outputBytes: 1024 * 1024 },
    () => time,
  );
  assert.deepEqual(
    requests.map((request) => request.timeoutMs),
    [300000, 100000],
  );
  assert.equal(result.hits.length, 1);
  assert.deepEqual(
    result.scans.slice(2).map((scan) => [scan.status, scan.reason]),
    [
      ['skipped', 'Static pass budget exhausted'],
      ['skipped', 'Static pass budget exhausted'],
    ],
  );
});

test('stdout budget counts UTF-8 bytes even for invalid output and clamps the next collection', async () => {
  const requests: StaticRequest[] = [];
  const result = await runStaticPass(
    snapshot({ 'a.rs': '', 'b.rs': '', 'c.rs': '' }),
    { sources: ['a.rs', 'b.rs', 'c.rs'] },
    {
      async run(request) {
        requests.push(request);
        return { ...empty, stdout: requests.length === 1 ? 'é' : 'bad' };
      },
    },
    { timeoutMs: 1000, outputBytes: 5 },
    () => 0,
  );
  assert.deepEqual(
    requests.map((request) => request.outputBytes),
    [5, 3],
  );
  assert.deepEqual(
    result.scans.slice(0, 3).map((scan) => scan.status),
    ['failed', 'failed', 'skipped'],
  );
});

test('exceptions retain output reservations and over-limit ports receive no further work', async () => {
  for (const throws of [true, false]) {
    let calls = 0;
    const result = await runStaticPass(
      snapshot({ 'a.rs': '', 'b.rs': '' }),
      { sources: ['a.rs', 'b.rs'] },
      {
        async run() {
          calls++;
          if (throws) throw new Error('private diagnostic');
          return { ...empty, stdout: 'x'.repeat(6) };
        },
      },
      { timeoutMs: 1000, outputBytes: 5 },
      () => 0,
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      result.scans.slice(0, 2).map((scan) => scan.status),
      ['failed', 'skipped'],
    );
    assert.ok(!JSON.stringify(result).includes('private diagnostic'));
  }
});

test('snapshot capture time is included in the admission deadline', async () => {
  let time = 0;
  const captured = snapshot({ 'a.rs': '' });
  captured.read = () => {
    time = 1000;
    return '';
  };
  const result = await runStaticPass(
    captured,
    { sources: ['a.rs'] },
    {
      async run() {
        assert.fail('No time remains for a tool invocation');
      },
    },
    { timeoutMs: 1000, outputBytes: 100 },
    () => time,
  );
  assert.equal(result.scans[0]!.reason, 'Static pass budget exhausted');
});

test('invalid or expanded pass budgets are refused before snapshot reads or execution', async () => {
  const captured = snapshot({ 'a.rs': '' });
  captured.read = () => {
    assert.fail('No snapshot read expected');
  };
  for (const budget of [
    { timeoutMs: 0, outputBytes: 1 },
    { timeoutMs: 1, outputBytes: 0 },
    { timeoutMs: NaN, outputBytes: 1 },
    { timeoutMs: 1, outputBytes: Infinity },
    { timeoutMs: 900001, outputBytes: 1 },
    { timeoutMs: 1, outputBytes: 32 * 1024 * 1024 + 1 },
    { timeoutMs: 1.5, outputBytes: 1 },
    { timeoutMs: 1, outputBytes: 1.5 },
  ]) {
    await assert.rejects(
      runStaticPass(
        captured,
        { sources: ['a.rs'] },
        {
          async run() {
            assert.fail('No execution expected');
          },
        },
        budget,
      ),
      /Invalid static analysis budget/,
    );
  }
});
