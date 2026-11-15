import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_BUDGET_CAPS } from '@oms/core';
import type { HarnessSession, HarnessSessionOptions } from '@oms/engine';
import { resumeHarnessArguments } from '../src/interactive.ts';
import { headlessCaps, headlessInputTokens, parseLaunchOptions, runHarnessCommand } from '../src/harness.ts';

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

test('resume command binds the OMS session and current native model instead of the original launch selection', () => {
  const options = {
    environment: { binary: '/trusted/surfpool' },
    modelSelection: { provider: 'openai', id: 'old-model' },
  } as HarnessSessionOptions;
  const harness = {
    workspace: { root: '/repo with spaces', stateDir: '/private/state/workspaces/w' },
    task: { id: 'task-one' },
    session: { model: { provider: 'claude-code', id: 'sonnet' } },
  } as HarnessSession;
  const args = resumeHarnessArguments(options, harness, 'oms-owner-id', ['--tokens', '123']);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value('--session'), 'oms-owner-id');
  assert.equal(value('--provider'), 'claude-code');
  assert.equal(value('--model'), 'sonnet');
  assert.equal(value('--workspace'), '/repo with spaces');
  assert.equal(value('--task'), 'task-one');
  assert.equal(value('--surfpool-binary'), '/trusted/surfpool');
  assert.equal(value('--tokens'), '123');
  assert.equal(args.includes('old-model'), false);
});

test('local workspace initialization records an ignored repository and external state without a model request', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-cli-workspace-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const stateRoot = join(base, 'user-state');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const result = spawnSync(
    process.execPath,
    [bin, 'workspace', 'init', repo, '--ignore', 'exclude', '--state-root', stateRoot],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const workspace = JSON.parse(result.stdout);
  assert.equal(workspace.root, repo);
  assert.equal(workspace.omsDir, join(repo, '.oms'));
  assert.ok(workspace.stateDir.startsWith(stateRoot + '/'));
  assert.equal(JSON.parse(readFileSync(join(repo, '.oms', 'workspace.json'), 'utf8')).id, workspace.id);
  execFileSync('git', ['-C', repo, 'check-ignore', '--quiet', '.oms/workspace.json']);
  assert.equal(existsSync(join(stateRoot, 'agent')), false);
});

test('workspace initialization needs an explicit ignore decision and never creates state on refusal', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-cli-refusal-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', base]);
  const result = spawnSync(process.execPath, [bin, 'workspace', 'init', base], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(base, '.oms')), false);
});

test('invalid requirement data never prints planted credential content or creates a task', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-cli-invalid-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const requirement = join(base, 'invalid.json');
  const sentinel = 'SYNTHETIC-DO-NOT-ECHO-CREDENTIAL';
  writeFileSync(requirement, '{"privateKey":"' + sentinel + '",bad-json');
  const result = spawnSync(
    process.execPath,
    [bin, 'task', 'create', '--workspace', base, '--base', 'a'.repeat(40), '--requirements', requirement],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes(sentinel) && !result.stdout.includes(sentinel));
  assert.match(result.stderr, /verifierPaths/);
  assert.equal(existsSync(join(base, '.oms')), false);
});

test('a noninteractive launch refuses before creating a workspace or contacting a model', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-cli-no-tty-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [bin, 'run', '--workspace', base], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(base, '.oms')), false);
});

test('normal CLI launch is interactive and bounded mode is explicit without changing caps', () => {
  const normal = parseLaunchOptions([]);
  const bounded = parseLaunchOptions(['--bounded']);
  assert.equal(normal.executionMode, 'interactive');
  assert.equal(bounded.executionMode, 'bounded');
  assert.deepEqual(normal.caps, DEFAULT_BUDGET_CAPS);
  assert.deepEqual(bounded.caps, normal.caps);
  assert.equal(normal.maxOutputTokens, 32_768);
  for (const mode of [[], ['--bounded']]) {
    const parsed = parseLaunchOptions([
      ...mode,
      '--tokens',
      '123',
      '--spend-usd',
      '0.000123',
      '--minutes',
      '2',
      '--output-tokens',
      '17',
    ]);
    assert.equal(parsed.executionMode, mode.length ? 'bounded' : 'interactive');
    assert.deepEqual(parsed.caps, { tokens: 123, spendMicroUsd: 123, wallClockMs: 120_000 });
    assert.equal(parsed.maxOutputTokens, 17);
  }
});

test('headless caps default to $4 and 40 minutes but honor explicit flags', () => {
  assert.deepEqual(headlessCaps(parseLaunchOptions([])), {
    ...DEFAULT_BUDGET_CAPS,
    spendMicroUsd: 4_000_000,
    wallClockMs: 40 * 60_000,
  });
  const explicit = headlessCaps(parseLaunchOptions(['--spend-usd', '10', '--minutes', '90']));
  assert.equal(explicit.spendMicroUsd, 10_000_000);
  assert.equal(explicit.wallClockMs, 90 * 60_000);
});

test('headless native Claude omits the default input cap and rejects an explicit unsupported cap before opening a workspace', async (t) => {
  assert.equal(headlessInputTokens(parseLaunchOptions([]), 'claude-code'), undefined);
  for (const provider of ['openai', 'openai-codex', undefined]) {
    assert.equal(headlessInputTokens(parseLaunchOptions([]), provider), 65_536);
    const explicit = parseLaunchOptions(['--input-tokens', '128'], ['--input-tokens']);
    assert.equal(headlessInputTokens(explicit, provider), 128);
  }
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-claude-input-cap-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  await assert.rejects(
    runHarnessCommand('run', [
      '--headless',
      '--workspace',
      base,
      '--task',
      'test',
      '--provider',
      'claude-code',
      '--model',
      'sonnet',
      '--json-out',
      join(base, 'record.json'),
      '--input-tokens',
      '128',
    ]),
    /--input-tokens is unavailable for Claude Code/,
  );
  assert.equal(existsSync(join(base, '.oms')), false);
  assert.equal(existsSync(join(base, 'record.json')), false);
});

test('launch cap parsing refuses malformed, repeated and unsafe values before creating state', () => {
  for (const args of [
    ['--bounded', '--bounded'],
    ['--tokens'],
    ['--tokens', '0'],
    ['--tokens', '1.5'],
    ['--tokens', '9007199254740992'],
    ['--minutes', '9007199254740991'],
    ['--spend-usd', '0'],
    ['--spend-usd', '1.0000001'],
    ['--spend-usd', '9007199255'],
    ['--output-tokens', '-1'],
    ['--tokens', '1', '--tokens', '2'],
  ])
    assert.throws(() => parseLaunchOptions(args), Error, args.join(' '));
});

test('the benchmark knowledge switches are still admitted and are off unless passed', () => {
  const parsed = parseLaunchOptions(
    ['--headless', '--knowledge', '--knowledge-hint'],
    ['--headless', '--knowledge', '--knowledge-hint'],
    ['--headless', '--knowledge', '--knowledge-hint'],
  );
  assert.equal(parsed.values.has('--knowledge'), true);
  assert.equal(parsed.values.has('--knowledge-hint'), true);
  assert.equal(
    parseLaunchOptions(
      ['--headless'],
      ['--headless', '--knowledge', '--knowledge-hint'],
      ['--headless', '--knowledge', '--knowledge-hint'],
    ).values.has('--knowledge-hint'),
    false,
  );
});
