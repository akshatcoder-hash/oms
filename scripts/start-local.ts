import { constants, accessSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createBudgetLedger, type BudgetLedgerEvent } from '@oms/core';
import { acquireMutationLease, backendFor, acquireTaskLease, configuredBackend, createTask, defaultHarnessEnvironment, inspectMutationLease, openBudgetJournal, openWorkspace, prepareHarnessTask, readTask,
  type HarnessEnvironment, type HarnessSessionOptions } from '@oms/engine';
import { runInteractiveHarness } from '../packages/cli/src/interactive.ts';
import { DEFAULT_OPTIONS } from '../packages/cli/src/doctor/checks.ts';
import { chooseLocalAction } from '../packages/cli/src/ownership.ts';
import { parseLaunchOptions, type LaunchOptions } from '../packages/cli/src/harness.ts';
import { commitStarterRepository, initializeStarterRepository } from '../packages/engine/src/workspace/git.ts';
import { writePrivateJson } from '../packages/engine/src/workspace/storage.ts';

const TASK_ID = 'starter';

export interface LocalStarterPaths { repository: string; stateRoot: string; metadata: string }
export function omsHome(): string { return join(homedir(), '.oms'); }

export function localStarterPaths(home: string): LocalStarterPaths {
  const base = join(resolve(home), 'starter');
  return { repository: join(base, 'repo'), stateRoot: join(base, 'state'), metadata: join(base, 'launch') };
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]!.trim();
}

function discardUnpublished(paths: LocalStarterPaths): void {
  for (const path of Object.values(paths)) {
    if (!present(path)) continue;
    owned(path, true);
    rmSync(path, { recursive: true, force: true });
  }
}

type Ready = { schema: 'oms.local-starter/1'; workspaceId: string; baseOid: string; sessionId: string };

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function owned(path: string, directory: boolean, visibility: 'private' | 'contract' = 'private'): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      stat.uid !== process.getuid?.() || (stat.mode & (visibility === 'contract' ? 0o022 : 0o077)) !== 0 || realpathSync(path) !== path) {
    throw new Error('Starter ownership or private permissions changed');
  }
}

function json(path: string): unknown {
  owned(path, false);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function savedReady(metadata: string): Ready {
  const value = json(join(metadata, 'ready.json')) as Partial<Ready> | null;
  if (!value || value.schema !== 'oms.local-starter/1' || typeof value.workspaceId !== 'string' ||
      typeof value.baseOid !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.baseOid) ||
      typeof value.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.sessionId)) throw new Error('Starter record is incomplete');
  return value as Ready;
}

function newStoredSession(options: Pick<HarnessSessionOptions, 'workspace' | 'task' | 'caps' | 'executionMode'>): string {
  const sessionsRoot = join(options.workspace.stateDir, 'sessions');
  const sessions = join(sessionsRoot, options.task.id);
  for (const path of [sessionsRoot, sessions]) {
    if (!present(path)) mkdirSync(path, { mode: 0o700 });
    owned(path, true);
  }
  const manager = SessionManager.create(options.task.codeRoot, sessions);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error('Could not create a persistent starter session');
  // Persist the SDK's own header, not a synthetic prompt. Reopening then retains even an unused budget.
  writeFileSync(file, JSON.stringify(header) + '\n', { mode: 0o600, flag: 'wx' });
  const journal = openBudgetJournal({
    path: join(sessions, `${manager.getSessionId()}.budget.jsonl`), caps: options.caps, clock: Date.now,
    ...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
  });
  journal.close();
  return manager.getSessionId();
}

function preservedError(paths: LocalStarterPaths, cause?: unknown): Error {
  const reason = cause === undefined ? '' : ` (${oneLine(cause)})`;
  return new Error(`Local starter setup is incomplete or no longer matches its owned metadata${reason}. Nothing was reset. Inspect ${paths.metadata}, ${paths.repository} and ${paths.stateRoot}; preserve your files and resolve the mismatched or interrupted setup before running oms again. To use another repository, use oms workspace/task/run instead.`, { cause });
}

/** Initialize exactly once. Existing source, pins, conversations and budgets are never rewritten here. */
export async function prepareLocalStarter(home: string, environment: HarnessEnvironment, launch: LaunchOptions = parseLaunchOptions([])): Promise<HarnessSessionOptions> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  home = realpathSync(home);
  const paths = localStarterPaths(home);
  const expectedOwner = { schema: 'oms.local-starter-owner/2', repository: paths.repository, stateRoot: paths.stateRoot };
  const anyExists = Object.values(paths).some(present);
  if (anyExists) {
    try {
      if (present(paths.metadata)) {
        owned(paths.metadata, true);
        const leaseFile = join(paths.metadata, 'initialization.lease');
        const ownerFile = join(paths.metadata, 'owner.json');
        const readyFile = join(paths.metadata, 'ready.json');
        const deadline = Date.now() + 10_000;
        let announced = false;
        let idleSince: number | undefined;
        for (;;) {
          // Ready is published last. Never combine its new presence with an earlier owner/lease observation.
          if (present(readyFile)) {
            if (JSON.stringify(json(ownerFile)) !== JSON.stringify(expectedOwner)) throw new Error('Foreign starter');
            const state = inspectMutationLease(leaseFile);
            if (state.status === 'stale' || state.status === 'unverifiable') throw new Error('Starter initialization ownership cannot be verified');
            if (state.status === 'absent') break;
          } else {
            const state = inspectMutationLease(leaseFile);
            if (state.status === 'unverifiable') throw new Error('Starter initialization ownership cannot be verified');
            if (present(ownerFile) && JSON.stringify(json(ownerFile)) !== JSON.stringify(expectedOwner)) throw new Error('Foreign starter');
            if (state.status === 'live') idleSince = undefined;
            else {
              // No ready record means no session or conversation was ever created. Without a live initializer the setup is ours and unpublished.
              idleSince ??= Date.now();
              if (state.status === 'stale' || Date.now() - idleSince >= 1_000) {
                discardUnpublished(paths);
                return prepareLocalStarter(home, environment, launch);
              }
            }
          }
          if (Date.now() >= deadline) throw new Error('STARTER_INITIALIZING');
          if (!announced) {
            process.stdout.write('OMS local starter setup is not yet published. Waiting briefly for initialization; your files will not be reset.\n');
            announced = true;
          }
          await delay(100);
        }
      }
      for (const path of Object.values(paths)) owned(path, true);
      if (JSON.stringify(json(join(paths.metadata, 'owner.json'))) !== JSON.stringify(expectedOwner)) throw new Error('Foreign starter');
      const ready = savedReady(paths.metadata);
      const workspace = openWorkspace(paths.repository, { stateRoot: paths.stateRoot });
      const task = readTask(workspace, TASK_ID);
      if (workspace.id !== ready.workspaceId || task.baseOid !== ready.baseOid) throw new Error('Starter identity changed');
      // The contract writer intentionally uses 0644 inside the private task directory.
      owned(task.taskFile, false, 'contract');
      owned(task.pinFile, false);
      const sessions = join(workspace.stateDir, 'sessions', task.id);
      owned(sessions, true);
      const file = SessionManager.findById(task.codeRoot, ready.sessionId, sessions);
      if (!file) throw new Error('Saved session is missing');
      owned(file, false);
      const header = JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0]!);
      if (header.type !== 'session' || header.id !== ready.sessionId || header.cwd !== task.codeRoot) throw new Error('Saved session does not match');
      return { workspace, task, environment, caps: launch.caps, maxOutputTokens: launch.maxOutputTokens, executionMode: launch.executionMode, sessionId: ready.sessionId };
    } catch (error) {
      if (error instanceof Error && error.message === 'STARTER_INITIALIZING') {
        throw new Error('Local starter initialization did not finish within 10 seconds. If another window is initializing, wait for it to finish and run oms again. Otherwise inspect the preserved starter setup for an interrupted initialization. No files were changed by this launch.');
      }
      throw preservedError(paths, error);
    }
  }

  const parent = dirname(paths.metadata);
  mkdirSync(parent, { recursive: true });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid?.() ||
      (parentStat.mode & 0o022) !== 0 || realpathSync(parent) !== parent) throw preservedError(paths);
  // Exclusive creation is also the initialization claim. Interrupted setup remains inspectable, never adopted.
  try { mkdirSync(paths.metadata, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return prepareLocalStarter(home, environment, launch);
    throw preservedError(paths);
  }
  const initialization = acquireMutationLease(join(paths.metadata, 'initialization.lease'));
  try {
    const ownerFile = join(paths.metadata, 'owner.json');
    if (present(ownerFile)) throw new Error('Starter ownership was already published');
    writePrivateJson(ownerFile, expectedOwner);
    mkdirSync(paths.repository, { mode: 0o700 });
    mkdirSync(paths.stateRoot, { mode: 0o700 });
    initializeStarterRepository(paths.repository);
    mkdirSync(join(paths.repository, 'src'));
    writeFileSync(join(paths.repository, 'package.json'), JSON.stringify({ name: 'oms-local-starter', private: true, type: 'module', scripts: { test: 'node verify.mjs' } }, null, 2) + '\n', { flag: 'wx' });
    writeFileSync(join(paths.repository, 'src', 'cart.mjs'), `// Persistent local starter: integer-cent shopping cart arithmetic.\nexport function totalCents(items) {\n  let total = 0;\n  for (const { priceCents, quantity } of items) {\n    if (!Number.isSafeInteger(priceCents) || priceCents < 0 || !Number.isSafeInteger(quantity) || quantity < 0) {\n      throw new RangeError('Prices and quantities must be nonnegative safe integers');\n    }\n    total += priceCents * quantity;\n    if (!Number.isSafeInteger(total)) throw new RangeError('Cart total exceeds safe integer cents');\n  }\n  return total;\n}\n`, { flag: 'wx' });
    writeFileSync(join(paths.repository, 'verify.mjs'), `import assert from 'node:assert/strict';\nimport { totalCents } from './src/cart.mjs';\nassert.equal(totalCents([]), 0);\nassert.equal(totalCents([{ priceCents: 1299, quantity: 2 }, { priceCents: 250, quantity: 3 }]), 3348);\nassert.equal(totalCents([{ priceCents: 99, quantity: 0 }]), 0);\nfor (const item of [{ priceCents: -1, quantity: 1 }, { priceCents: 1.5, quantity: 1 }, { priceCents: 1, quantity: -1 }, { priceCents: 1, quantity: 0.5 }]) assert.throws(() => totalCents([item]), RangeError);\nassert.throws(() => totalCents([{ priceCents: Number.MAX_SAFE_INTEGER, quantity: 2 }]), RangeError);\nconsole.log('Cart arithmetic and input bounds verified');\n`, { flag: 'wx' });
    const baseOid = commitStarterRepository(paths.repository);
    const workspace = openWorkspace(paths.repository, { stateRoot: paths.stateRoot, initialize: { ignore: 'exclude' } });
    const task = createTask(workspace, { id: TASK_ID, baseOid });
    await prepareHarnessTask(workspace, task, environment, {
      contract: { version: 0, items: [{ id: 'cart', title: 'Verify integer-cent cart totals and invalid input rejection', status: 'active', reopenCount: 0,
        done: [{ kind: 'tests', command: ['node', 'verify.mjs'], expect: 'pass' }] }] },
      verifierPaths: ['verify.mjs'], codePaths: ['src/cart.mjs', 'package.json'],
    });
    const taskLease = acquireTaskLease(workspace, task.id);
    try {
      const sessionId = newStoredSession({ workspace, task, caps: launch.caps, executionMode: launch.executionMode });
      const ready: Ready = { schema: 'oms.local-starter/1', workspaceId: workspace.id, baseOid: task.baseOid, sessionId };
      const readyFile = join(paths.metadata, 'ready.json');
      if (present(readyFile)) throw new Error('Starter completion was already published');
      writePrivateJson(readyFile, ready);
      return { workspace, task, environment, caps: launch.caps, maxOutputTokens: launch.maxOutputTokens, executionMode: launch.executionMode, sessionId };
    } finally { taskLease.release(); }
  } catch (cause) {
    throw new Error(`Local starter initialization stopped: ${oneLine(cause)}. Check local Git and runtime prerequisites with oms doctor, then run oms again. The unfinished setup in ${paths.metadata} holds no conversation and is rebuilt on the next launch; no published starter is ever reset.`, { cause });
  } finally {
    initialization.release();
  }
}

export function savedBudgetUsable(options: HarnessSessionOptions, now = Date.now()): boolean {
  const path = join(options.workspace.stateDir, 'sessions', options.task.id, `${options.sessionId}.budget.jsonl`);
  if (!present(path)) return false;
  try {
    owned(path, false);
    const contents = readFileSync(path, 'utf8');
    if (!contents.endsWith('\n') || contents.length === 0) return false;
    const events = contents.slice(0, -1).split('\n').map(line => JSON.parse(line)) as BudgetLedgerEvent[];
    const ledger = createBudgetLedger({ caps: options.caps, clock: () => now, events, persist() { throw new Error('Read-only budget inspection'); } });
    const snapshot = ledger.snapshot();
    if (snapshot.accounting !== 'known' || snapshot.pendingDispatchIds.length !== 0) return false;
    // Runtime migrates known legacy journals; paid dispatch admission still checks retained spend.
    return options.executionMode === 'interactive' || !snapshot.admissionBlocked;
  } catch { return false; }
}

export async function selectStarterSession(home: string, options: HarnessSessionOptions, choose = chooseLocalAction): Promise<HarnessSessionOptions | undefined> {
  const paths = localStarterPaths(home);
  const inspectLease = acquireTaskLease(options.workspace, options.task.id);
  try {
    if (savedReady(paths.metadata).sessionId !== options.sessionId) throw new Error('The local starter session changed. Run oms again to reopen it.');
    if (savedBudgetUsable(options)) return options;
  } finally { inspectLease.release(); }
  // Never hold task ownership while waiting for a human choice.
  const selected = await choose(`The saved session cannot admit work: its limits are exhausted or its accounting needs reconciliation. Conversation and accounting are retained, including unknown charges. Cancel to inspect/reconcile the saved journal, or explicitly start a separate ${options.executionMode ?? 'bounded'} session with the selected caps. This does not resolve previous unknown usage.`, [
    { value: 'new', label: 'Start a new session; retain all previous history and accounting' },
  ]);
  if (selected !== 'new') return undefined;
  const lease = acquireTaskLease(options.workspace, options.task.id);
  try {
    const ready = savedReady(paths.metadata);
    if (ready.sessionId !== options.sessionId) throw new Error('Another window selected a new local session. Run oms again to reopen it; your previous session is retained.');
    const sessionId = newStoredSession(options);
    writePrivateJson(join(paths.metadata, 'ready.json'), { ...ready, sessionId });
    return { ...options, sessionId };
  } finally { lease.release(); }
}

function checkLocalPrerequisites(environment: HarnessEnvironment): void {
  try { accessSync(environment.binary, constants.X_OK); }
  catch { throw new Error(`Surfpool ${DEFAULT_OPTIONS.pinnedSurfpool} is not installed at ${environment.binary}. Run \`oms doctor --install\`, then run oms again. Startup does not install or download tools.`); }
  if (!backendFor(environment).requiresDocker) return;
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 10_000 });
  if (docker.error || docker.status !== 0) throw new Error('Docker is unavailable. Start your local Docker daemon, wait until it is ready, then run oms again. Use oms doctor for details.');
  const image = spawnSync('docker', ['image', 'inspect', environment.image], { stdio: 'ignore', timeout: 10_000 });
  if (image.error || image.status !== 0) throw new Error('The pinned OMS sandbox image is not available locally. Follow the local prerequisites in README.md, then run oms again. Startup will not download an image.');
}

export async function startLocal(args: string[] = []): Promise<void> {
  const launch = parseLaunchOptions(args);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run oms in an interactive terminal such as Ghostty');
  const selected = configuredBackend(launch.values.get('--sandbox'));
  const environment = defaultHarnessEnvironment(undefined, selected);
  checkLocalPrerequisites(environment);
  const home = omsHome();
  const options = await prepareLocalStarter(home, environment, launch);
  process.stdout.write(`OMS · persistent local starter · ${launch.executionMode === 'bounded' ? 'bounded session' : 'interactive chat'}\nYour files and conversation are retained. Opening OMS sends no model request.\n/connect for provider setup · /model to select · /help for commands\n`);
  await runInteractiveHarness(options, { localStarter: true, web: !launch.values.has('--no-web'), beforeOpen: current => selectStarterSession(home, current) });
}
