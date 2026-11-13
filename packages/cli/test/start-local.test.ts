import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { DEFAULT_BUDGET_CAPS } from '@oms/core';
import { acquireMutationLease, acquireTaskLease, defaultHarnessEnvironment, openBudgetJournal } from '@oms/engine';
import { prepareLocalStarter, localStarterPaths, savedBudgetUsable, selectStarterSession } from '../../../scripts/start-local.ts';
import { parseLaunchOptions } from '../src/harness.ts';
import { writePrivateJson } from '../../../packages/engine/src/workspace/storage.ts';

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
const environment = { ...defaultHarnessEnvironment(), binary: process.execPath };

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oms-local-start-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('starter initialization pins a real independent verifier and preserves edits, session and budget on repeat', async t => {
  const root = fixture(t);
  const first = await prepareLocalStarter(root, environment);
  assert.deepEqual(first.caps, DEFAULT_BUDGET_CAPS);
  assert.equal(first.maxOutputTokens, 32_768);
  assert.equal(first.executionMode, 'interactive');
  assert.ok(first.sessionId);
  const source = join(first.task.codeRoot, 'src', 'cart.mjs');
  const taskBefore = readFileSync(first.task.taskFile, 'utf8');
  const pinBefore = readFileSync(first.task.pinFile, 'utf8');
  const edited = readFileSync(source, 'utf8') + '\n// My persistent edit\n';
  writeFileSync(source, edited);
  const sessionDir = join(first.workspace.stateDir, 'sessions', first.task.id);
  const sessionFile = SessionManager.findById(first.task.codeRoot, first.sessionId, sessionDir);
  assert.ok(sessionFile);
  SessionManager.open(sessionFile, sessionDir).appendMessage({ role: 'user', content: 'Keep this local conversation without dispatching a model.', timestamp: 1 });
  const historyBefore = readFileSync(sessionFile, 'utf8');
  const journal = join(sessionDir, `${first.sessionId}.budget.jsonl`);
  writeFileSync(journal, 'existing-budget-do-not-reset\n');
  const second = await prepareLocalStarter(root, environment);
  assert.equal(second.workspace.id, first.workspace.id);
  assert.deepEqual(second.task, first.task);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(readFileSync(source, 'utf8'), edited);
  assert.equal(readFileSync(first.task.taskFile, 'utf8'), taskBefore);
  assert.equal(readFileSync(first.task.pinFile, 'utf8'), pinBefore);
  assert.equal(readFileSync(journal, 'utf8'), 'existing-budget-do-not-reset\n');
  assert.equal(readFileSync(sessionFile, 'utf8'), historyBefore);
  const verifier = join(first.task.codeRoot, 'verify.mjs');
  const valid = spawnSync(process.execPath, [verifier], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  writeFileSync(source, 'export function totalCents() { return 0; }\n');
  const broken = spawnSync(process.execPath, [verifier], { encoding: 'utf8' });
  assert.notEqual(broken.status, 0, 'independent verification must reject incorrect source');
  assert.equal(execFileSync('git', ['-C', first.workspace.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), first.task.baseOid);
});

test('starter refuses foreign or incomplete paths without adopting or deleting them', async t => {
  const root = fixture(t);
  const paths = localStarterPaths(root);
  mkdirSync(paths.repository, { recursive: true });
  const sentinel = join(paths.repository, 'my-work.txt');
  writeFileSync(sentinel, 'keep my work');
  await assert.rejects(prepareLocalStarter(root, environment), /existing|incomplete|owned/i);
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep my work');
  assert.equal(existsSync(paths.stateRoot), false);
});

test('starter refuses malformed ownership and missing pinned state without reseeding', async t => {
  const root = fixture(t);
  const first = await prepareLocalStarter(root, environment);
  const paths = localStarterPaths(root);
  const pin = readFileSync(first.task.pinFile, 'utf8');
  rmSync(first.task.pinFile);
  await assert.rejects(prepareLocalStarter(root, environment), /incomplete|inspect|preserv/i);
  assert.equal(existsSync(first.task.pinFile), false);
  writeFileSync(first.task.pinFile, pin, { mode: 0o600 });
  writeFileSync(join(paths.metadata, 'owner.json'), '{bad');
  await assert.rejects(prepareLocalStarter(root, environment), /incomplete|inspect|preserv/i);
  assert.equal(readFileSync(first.task.pinFile, 'utf8'), pin);
});

test('run rejects presentation flags and help advertises only in-app switching', () => {
  for (const flag of ['--view', '--theme']) {
    const result = spawnSync(process.execPath, [bin, 'run', flag, flag === '--view' ? 'workbench' : 'gruvbox'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Unknown option ${flag}`));
  }
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--view|--theme/);
  assert.match(help.stdout, /Harness/);
  assert.match(help.stdout, /\/workbench/);
  assert.match(help.stdout, /--bounded/);
  assert.match(help.stdout, /idle time does not expire/);
});

test('bare CLI follows local launch and refuses noninteractive use before preparing state', () => {
  const result = spawnSync(process.execPath, [bin], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal/i);
});

test('concurrent starter initialization waits for the owned setup and returns one task and session', async t => {
  const root = fixture(t);
  const [first, second] = await Promise.all([prepareLocalStarter(root, environment), prepareLocalStarter(root, environment)]);
  assert.equal(first.workspace.id, second.workspace.id);
  assert.equal(first.sessionId, second.sessionId);
  assert.deepEqual(first.task, second.task);
});

test('the readable contract convention does not relax private metadata or writable-contract ownership checks', async t => {
  const root = fixture(t);
  const options = await prepareLocalStarter(root, environment);
  assert.equal(statSync(options.task.taskFile).mode & 0o777, 0o644);
  const owner = join(localStarterPaths(root).metadata, 'owner.json');
  chmodSync(owner, 0o644);
  await assert.rejects(prepareLocalStarter(root, environment), error => error instanceof Error && error.cause instanceof Error);
  chmodSync(owner, 0o600);
  chmodSync(options.task.taskFile, 0o666);
  await assert.rejects(prepareLocalStarter(root, environment), /incomplete|owned/i);
});

test('existing ready metadata is not read until live initialization finishes publishing', async t => {
  const root = fixture(t);
  const first = await prepareLocalStarter(root, environment);
  const paths = localStarterPaths(root);
  const readyFile = join(paths.metadata, 'ready.json');
  const complete = readFileSync(readyFile, 'utf8');
  const lease = acquireMutationLease(join(paths.metadata, 'initialization.lease'));
  writeFileSync(readyFile, '{"schema":');
  let settled = false;
  const reopening = prepareLocalStarter(root, environment).then(
    value => { settled = true; return { value, error: undefined }; },
    error => { settled = true; return { value: undefined, error }; },
  );
  try {
    await delay(30);
    assert.equal(settled, false, 'must wait for initialization even though ready.json already exists');
  } finally {
    writeFileSync(readyFile, complete);
    lease.release();
  }
  const result = await reopening;
  assert.equal(result.error, undefined);
  assert.equal(result.value?.sessionId, first.sessionId);
});

test('bounded expired saved budgets require explicit new-session consent and retain old accounting and history', async t => {
  const root = fixture(t);
  const original = await prepareLocalStarter(root, environment, parseLaunchOptions(['--bounded']));
  const directory = join(original.workspace.stateDir, 'sessions', original.task.id);
  const journal = join(directory, `${original.sessionId}.budget.jsonl`);
  const contents = JSON.stringify({ type: 'budget_open', seq: 1, version: 1, caps: original.caps, startedAt: 0 }) + '\n';
  writeFileSync(journal, contents, { mode: 0o600 });
  assert.equal(savedBudgetUsable(original, 1), true);
  assert.equal(savedBudgetUsable(original, original.caps.wallClockMs + 1), false);
  const before = readFileSync(join(localStarterPaths(root).metadata, 'ready.json'), 'utf8');
  assert.equal(await selectStarterSession(root, original, async () => undefined), undefined);
  assert.equal(readFileSync(join(localStarterPaths(root).metadata, 'ready.json'), 'utf8'), before);
  const renewed = await selectStarterSession(root, original, async message => {
    assert.match(message, /bounded/);
    assert.match(message, /retained/);
    return 'new';
  });
  assert.ok(renewed);
  assert.notEqual(renewed.sessionId, original.sessionId);
  assert.deepEqual(renewed.task, original.task);
  assert.equal(readFileSync(journal, 'utf8'), contents);
  assert.equal((await prepareLocalStarter(root, environment)).sessionId, renewed.sessionId);
  assert.equal(existsSync(join(directory, `${renewed.sessionId}.budget.jsonl`)), true);
});

test('interactive startup keeps the same saved idle conversation and legacy journal without a renewal prompt', async t => {
  const root = fixture(t);
  const original = await prepareLocalStarter(root, environment);
  const directory = join(original.workspace.stateDir, 'sessions', original.task.id);
  const journal = join(directory, `${original.sessionId}.budget.jsonl`);
  const contents = JSON.stringify({ type: 'budget_open', seq: 1, version: 1, caps: original.caps, startedAt: 0 }) + '\n';
  writeFileSync(journal, contents, { mode: 0o600 });
  const sessionFile = SessionManager.findById(original.task.codeRoot, original.sessionId!, directory)!;
  SessionManager.open(sessionFile, directory).appendMessage({ role: 'user', content: 'Keep this conversation after an idle night.', timestamp: 1 });
  const conversation = readFileSync(sessionFile, 'utf8');
  const metadata = readFileSync(join(localStarterPaths(root).metadata, 'ready.json'), 'utf8');
  assert.equal(savedBudgetUsable(original, original.caps.wallClockMs * 100), true);
  const resumed = await selectStarterSession(root, original, async () => { assert.fail('Idle conversation must not need renewal'); });
  assert.equal(resumed?.sessionId, original.sessionId);
  assert.equal(readFileSync(sessionFile, 'utf8'), conversation);
  assert.equal(readFileSync(journal, 'utf8'), contents);
  assert.equal(readFileSync(join(localStarterPaths(root).metadata, 'ready.json'), 'utf8'), metadata);
});

test('starter bounded launch persists explicit caps without inflating limits', async t => {
  const root = fixture(t);
  const launch = parseLaunchOptions(['--bounded', '--tokens', '123', '--spend-usd', '0.000123', '--minutes', '2', '--output-tokens', '17']);
  const options = await prepareLocalStarter(root, environment, launch);
  assert.equal(options.executionMode, 'bounded');
  assert.deepEqual(options.caps, launch.caps);
  assert.equal(options.maxOutputTokens, 17);
  const journal = join(options.workspace.stateDir, 'sessions', options.task.id, `${options.sessionId}.budget.jsonl`);
  assert.deepEqual(JSON.parse(readFileSync(journal, 'utf8').split('\n')[0]!).caps, launch.caps);
  assert.equal(savedBudgetUsable(options), true);
  const before = readFileSync(journal, 'utf8');
  const reopened = await prepareLocalStarter(root, environment, launch);
  assert.equal(reopened.sessionId, options.sessionId);
  assert.deepEqual(reopened.caps, launch.caps);
  assert.equal(savedBudgetUsable(reopened), true);
  assert.equal(savedBudgetUsable({ ...reopened, caps: DEFAULT_BUDGET_CAPS }), false, 'resuming must not silently enlarge explicitly selected caps');
  assert.equal(readFileSync(journal, 'utf8'), before);
});

test('unknown or truncated accounting is not silently reset', async t => {
  const root = fixture(t);
  const options = await prepareLocalStarter(root, environment);
  const journal = join(options.workspace.stateDir, 'sessions', options.task.id, `${options.sessionId}.budget.jsonl`);
  writeFileSync(journal, '{"type":"budget_open"', { mode: 0o600 });
  assert.equal(savedBudgetUsable(options), false);
  assert.equal(await selectStarterSession(root, options, async () => undefined), undefined);
  assert.equal(readFileSync(journal, 'utf8'), '{"type":"budget_open"');
});

test('publishing a starter session includes its actual persisted budget journal', async t => {
  const root = fixture(t);
  const options = await prepareLocalStarter(root, environment);
  const journal = join(options.workspace.stateDir, 'sessions', options.task.id, `${options.sessionId}.budget.jsonl`);
  assert.equal(existsSync(journal), true, 'ready session must already have accounting');
  const events = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'budget_open');
  assert.deepEqual(events[0].caps, DEFAULT_BUDGET_CAPS);
  assert.equal(savedBudgetUsable(options), true);
});

test('missing accounting with retained conversation requires consent rather than reopening with a fresh budget', async t => {
  const root = fixture(t);
  const options = await prepareLocalStarter(root, environment);
  const directory = join(options.workspace.stateDir, 'sessions', options.task.id);
  const sessionFile = SessionManager.findById(options.task.codeRoot, options.sessionId!, directory);
  assert.ok(sessionFile);
  SessionManager.open(sessionFile, directory).appendMessage({ role: 'user', content: 'Retain this conversation.', timestamp: 1 });
  const conversation = readFileSync(sessionFile, 'utf8');
  const journal = join(directory, `${options.sessionId}.budget.jsonl`);
  rmSync(journal, { force: true });
  assert.equal(savedBudgetUsable(options), false);
  assert.equal(await selectStarterSession(root, options, async () => undefined), undefined);
  assert.equal(existsSync(journal), false);
  assert.equal(readFileSync(sessionFile, 'utf8'), conversation);
});

test('pending dispatch accounting is restart-unknown without mutating the existing journal', async t => {
  const root = fixture(t);
  const options = await prepareLocalStarter(root, environment);
  const path = join(options.workspace.stateDir, 'sessions', options.task.id, `${options.sessionId}.budget.jsonl`);
  const lease = acquireTaskLease(options.workspace, options.task.id);
  try {
    const journal = openBudgetJournal({ path, caps: options.caps, clock: Date.now });
    try {
      assert.equal(journal.ledger.beginOperation('turn').ok, true);
      assert.equal(journal.ledger.reserve({ dispatchId: 'pending', logicalTurnId: 'turn', attempt: 1, tokens: 10, spendMicroUsd: 100 }).ok, true);
      assert.equal(journal.ledger.snapshot().accounting, 'pending');
    } finally { journal.close(); }
  } finally { lease.release(); }
  const before = readFileSync(path, 'utf8');
  assert.equal(savedBudgetUsable(options), false);
  assert.equal(await selectStarterSession(root, options, async () => undefined), undefined);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('interactive startup blocks unknown usage but preserves a known spend-exhausted conversation for subscription chat', async t => {
  for (const outcome of ['uncertain', 'known'] as const) {
    const root = fixture(t);
    const options = await prepareLocalStarter(root, environment);
    const path = join(options.workspace.stateDir, 'sessions', options.task.id, `${options.sessionId}.budget.jsonl`);
    const journal = openBudgetJournal({ path, caps: options.caps, clock: Date.now });
    try {
      assert.equal(journal.ledger.beginOperation('turn').ok, true);
      assert.equal(journal.ledger.reserve({ dispatchId: outcome, logicalTurnId: 'turn', attempt: 1, tokens: 10, spendMicroUsd: options.caps.spendMicroUsd }).ok, true);
      assert.equal(journal.ledger.settle({ dispatchId: outcome, receiptId: 'receipt', outcome,
        tokens: outcome === 'known' ? 10 : null, spendMicroUsd: outcome === 'known' ? options.caps.spendMicroUsd : null }).ok, true);
      assert.equal(journal.ledger.snapshot().remaining.spendMicroUsd, 0);
      assert.equal(journal.ledger.reserve({ dispatchId: 'paid-next', logicalTurnId: 'turn', attempt: 2, tokens: 1, spendMicroUsd: 1 }).ok, false);
    } finally { journal.close(); }
    const before = readFileSync(path, 'utf8');
    assert.equal(savedBudgetUsable(options), outcome === 'known');
    const resumed = await selectStarterSession(root, options, async () => {
      assert.equal(outcome, 'uncertain', 'Known API-spend exhaustion must not force an empty subscription chat');
      return undefined;
    });
    assert.equal(resumed?.sessionId, outcome === 'known' ? options.sessionId : undefined);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal((await prepareLocalStarter(root, environment)).sessionId, options.sessionId);
  }
});

test('a controlled pre-lease publication barrier longer than 100ms does not reject a concurrent launcher', async t => {
  const root = fixture(t);
  const first = await prepareLocalStarter(root, environment);
  const paths = localStarterPaths(root);
  const ownerFile = join(paths.metadata, 'owner.json');
  const readyFile = join(paths.metadata, 'ready.json');
  const owner = readFileSync(ownerFile, 'utf8');
  const ready = readFileSync(readyFile, 'utf8');
  rmSync(ownerFile);
  rmSync(readyFile);
  let settled = false;
  const reopening = prepareLocalStarter(root, environment).then(
    value => { settled = true; return { value, error: undefined }; },
    error => { settled = true; return { value: undefined, error }; },
  );
  await delay(250);
  const settledBeforePublication = settled;
  const lease = acquireMutationLease(join(paths.metadata, 'initialization.lease'));
  try {
    writeFileSync(ownerFile, owner, { mode: 0o600, flag: 'wx' });
    writeFileSync(readyFile, ready, { mode: 0o600, flag: 'wx' });
  } finally { lease.release(); }
  const result = await reopening;
  assert.equal(settledBeforePublication, false);
  assert.equal(result.error, undefined);
  assert.equal(result.value?.sessionId, first.sessionId);
});

test('atomic owner and ready publication cannot be combined with an earlier absent-owner observation', async t => {
  const root = fixture(t);
  const first = await prepareLocalStarter(root, environment);
  const paths = localStarterPaths(root);
  const ownerFile = join(paths.metadata, 'owner.json');
  const readyFile = join(paths.metadata, 'ready.json');
  const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  const ready = JSON.parse(readFileSync(readyFile, 'utf8'));
  rmSync(ownerFile);
  rmSync(readyFile);
  const original = fs.lstatSync;
  let published = false;
  const intercepted = t.mock.method(fs, 'lstatSync', (path: unknown, ...args: unknown[]) => {
    try { return Reflect.apply(original, fs, [path, ...args]); }
    catch (error) {
      if (!published && String(path) === ownerFile && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        published = true;
        const lease = acquireMutationLease(join(paths.metadata, 'initialization.lease'));
        try {
          writePrivateJson(ownerFile, owner);
          writePrivateJson(readyFile, ready);
        } finally { lease.release(); }
      }
      throw error;
    }
  });
  syncBuiltinESMExports();
  try {
    const reopened = await prepareLocalStarter(root, environment);
    assert.equal(published, true, 'publication must occur after the reader observed owner absence');
    assert.equal(reopened.sessionId, first.sessionId);
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
});

test('starter Git creation ignores executable ambient filters and global attributes', t => {
  const root = fixture(t);
  const sentinel = join(root, 'global-filter-ran');
  const filter = join(root, 'filter.mjs');
  const attributes = join(root, 'attributes');
  const config = join(root, 'gitconfig');
  writeFileSync(filter, `import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'unexpected execution'); process.stdout.write(readFileSync(0));\n`);
  writeFileSync(attributes, '*.mjs filter=oms-startup-review\n');
  writeFileSync(config, `[core]\n  attributesFile = ${JSON.stringify(attributes)}\n[filter \"oms-startup-review\"]\n  clean = ${JSON.stringify(`\"${process.execPath}\" \"${filter}\"`)}\n  required = true\n`);
  const starter = new URL('../../../scripts/start-local.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { prepareLocalStarter } from ${JSON.stringify(starter)}; import { defaultHarnessEnvironment } from '@oms/engine'; await prepareLocalStarter(${JSON.stringify(root)}, { ...defaultHarnessEnvironment(), binary: process.execPath });`],
    { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: config }, timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(sentinel), false, 'ambient executable Git configuration must not run');
});

test('the starter lives under the given OMS home, not the package root, and survives a dependency tree beside it', async t => {
  const home = fixture(t);
  const packageRoot = fixture(t);
  mkdirSync(join(packageRoot, 'node_modules'));
  writeFileSync(join(packageRoot, 'package-lock.json'), '{}\n');
  const options = await prepareLocalStarter(home, { ...environment, dependencies: packageRoot });
  const paths = localStarterPaths(home);
  for (const path of Object.values(paths)) {
    assert.ok(path.startsWith(join(home, 'starter')), path);
    assert.equal(existsSync(path), true);
  }
  assert.equal(existsSync(join(packageRoot, '.tmp')), false);
  assert.ok(options.task.codeRoot.startsWith(paths.repository));
});

test('an initialization failure reports its cause in one line and tells installed users to run oms', async t => {
  const home = fixture(t);
  await assert.rejects(prepareLocalStarter(home, { ...environment, dependencies: home }), (error: Error) => {
    assert.match(error.message, /Local starter initialization stopped: .*overlap/);
    assert.doesNotMatch(error.message, /\n/);
    assert.match(error.message, /run oms again/);
    assert.doesNotMatch(error.message, /npm start/);
    return true;
  });
});

test('an interrupted first launch with no ready record is discarded and the next launch succeeds', async t => {
  const home = fixture(t);
  await assert.rejects(prepareLocalStarter(home, { ...environment, dependencies: home }), /initialization stopped/);
  const paths = localStarterPaths(home);
  assert.equal(existsSync(join(paths.metadata, 'owner.json')), true);
  assert.equal(existsSync(join(paths.metadata, 'ready.json')), false);
  const options = await prepareLocalStarter(home, environment);
  assert.equal(existsSync(join(paths.metadata, 'ready.json')), true);
  assert.ok(options.sessionId);
  assert.equal((await prepareLocalStarter(home, environment)).sessionId, options.sessionId);
});

test('an unpublished setup with a foreign owner is still refused and preserved', async t => {
  const home = fixture(t);
  await assert.rejects(prepareLocalStarter(home, { ...environment, dependencies: home }), /initialization stopped/);
  const paths = localStarterPaths(home);
  const ownerFile = join(paths.metadata, 'owner.json');
  writeFileSync(ownerFile, JSON.stringify({ schema: 'someone-else' }), { mode: 0o600 });
  await assert.rejects(prepareLocalStarter(home, environment), /incomplete|owned/i);
  assert.equal(existsSync(paths.repository), true);
  assert.equal(existsSync(ownerFile), true);
});
