import { createHash } from 'node:crypto';
import {
  resolveFileInsideRoot,
  digestCodeInputs,
  digestFiles,
  snapshotDigest,
  specificationDigest,
} from '@oms/contract';
import type { ContractItem, Condition, Evaluator, Evidence, Runner, RunnerContext } from '@oms/contract';
import type { SandboxResult } from '@oms/sandbox';
import type { VerifierPort, VerifierRunResult } from './settle.ts';

/** A running offline surfnet the verifier can read from and point tests at. */
export interface SurfnetSession {
  port: number;
  /** Observed by the trusted process adapter, never copied from a requested mode. */
  mode: 'offline-snapshot' | 'forked';
  snapshotDigest: string;
  call(method: string, params?: unknown[]): Promise<unknown>;
  stop(): Promise<void>;
}

export interface SurfnetFactory {
  /** Start a fresh offline surfnet from `snapshotPath` (or empty when undefined). */
  start(snapshotPath: string | undefined): Promise<SurfnetSession>;
}

/** The part of a sandbox run the verifier reads; `SandboxResult` from `@oms/sandbox` is the full result. */
export type SandboxPortResult = Pick<SandboxResult, 'exitCode' | 'stdout' | 'stderr' | 'timedOut'>;

export interface SandboxPort {
  /** Run argv in the run-phase sandbox; the surfnet port is the only reachable host port. */
  run(argv: string[], opts: { codeRoot: string; surfnetPort: number; timeoutMs: number }): Promise<SandboxPortResult>;
}

export interface VerifierRunnerOptions {
  surfnets: SurfnetFactory;
  sandbox: SandboxPort;
  /** Identity derived by the trusted host from the actual approved runtime. */
  executionIdentity: string;
}

const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const TAIL_BYTES = 400;

function tail(text: string): string {
  const t = text.trim();
  return t.length <= TAIL_BYTES ? t : `...${t.slice(-TAIL_BYTES)}`;
}

interface ConditionOutcome {
  passed: boolean;
  detail: string;
}

async function readAccountField(
  session: SurfnetSession,
  address: string,
  field: 'lamports' | 'owner' | 'dataLen' | 'tokenAmount',
): Promise<string | null> {
  if (field === 'tokenAmount') {
    const res = (await session.call('getTokenAccountBalance', [address])) as {
      value?: { amount?: string };
    } | null;
    return res?.value?.amount ?? null;
  }
  const res = (await session.call('getAccountInfo', [address, { encoding: 'base64' }])) as {
    value: { lamports: number; owner: string; data: [string, string] } | null;
  } | null;
  const value = res?.value;
  if (!value) return null;
  if (field === 'lamports') return String(value.lamports);
  if (field === 'owner') return value.owner;
  return String(Buffer.from(value.data[0], 'base64').length);
}

async function checkCondition(
  cond: Condition,
  session: SurfnetSession,
  sandbox: SandboxPort,
  timeoutMs: number,
  codeRoot: string,
): Promise<ConditionOutcome> {
  if (cond.kind === 'tests') {
    const res = await sandbox.run(cond.command, { codeRoot, surfnetPort: session.port, timeoutMs });
    if (res.timedOut) return { passed: false, detail: `tests timed out: ${cond.command.join(' ')}` };
    if (res.exitCode === 0) return { passed: true, detail: `tests passed: ${cond.command.join(' ')}` };
    return {
      passed: false,
      detail: `tests failed (exit ${res.exitCode}): ${cond.command.join(' ')}\n${tail(res.stderr || res.stdout)}`,
    };
  }
  if (cond.kind === 'account') {
    let actual: string | null;
    try {
      actual = await readAccountField(session, cond.address, cond.field);
    } catch (e) {
      return { passed: false, detail: `account ${cond.address} ${cond.field}: read failed (${(e as Error).message})` };
    }
    if (actual === null) return { passed: false, detail: `account ${cond.address} ${cond.field}: not found` };
    return actual === cond.equals
      ? { passed: true, detail: `account ${cond.address} ${cond.field} = ${actual}` }
      : { passed: false, detail: `account ${cond.address} ${cond.field}: expected ${cond.equals}, got ${actual}` };
  }
  // A description cannot be checked by a machine, so it can never count as done.
  return { passed: false, detail: `tx condition is not machine-checkable: ${cond.description}` };
}

/**
 * The real verification run behind the evaluator. Every run starts a fresh
 * offline surfnet from the pinned snapshot, so results are reproducible and a
 * forked (mainnet) run cannot happen here.
 */
export function createVerifierRunner(options: VerifierRunnerOptions): Runner {
  const executionIdentity = options.executionIdentity;
  const runner: Runner = async (item: ContractItem, ctx: RunnerContext): Promise<Evidence> => {
    const timeoutMs = ctx.evaluatorConfig.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
    if (!executionIdentity || ctx.evaluatorConfig.executionIdentity !== executionIdentity) {
      throw new Error('verifier execution identity differs from the pinned evaluator configuration');
    }
    const codeDigest = digestCodeInputs(ctx.codeRoot, ctx.evaluatorConfig);
    const verifierDigest = digestFiles(ctx.codeRoot, ctx.verifierPaths).digest;
    const observedSnapshot = snapshotDigest(ctx.codeRoot, ctx.evaluatorConfig);
    const specDigest = specificationDigest(item, ctx.evaluatorConfig);
    if (
      codeDigest !== ctx.codeDigest ||
      verifierDigest !== ctx.verifierDigest ||
      observedSnapshot !== ctx.snapshotDigest ||
      specDigest !== ctx.specificationDigest
    ) {
      throw new Error('saved verification inputs differ from the evaluator identities');
    }
    const snap = ctx.evaluatorConfig.snapshotPath;
    const snapshotPath = snap === undefined ? undefined : resolveFileInsideRoot(ctx.codeRoot, snap);
    const session = await options.surfnets.start(snapshotPath);
    const lines: string[] = [];
    let passed = item.done.length > 0;
    try {
      if (
        session.snapshotDigest !== observedSnapshot ||
        snapshotDigest(ctx.codeRoot, ctx.evaluatorConfig) !== observedSnapshot
      ) {
        throw new Error('surfnet did not load the verified snapshot bytes');
      }
      if (session.mode !== 'offline-snapshot' && session.mode !== 'forked') {
        throw new Error('surfnet did not report an observed execution mode');
      }
      for (const cond of item.done) {
        const outcome = await checkCondition(cond, session, options.sandbox, timeoutMs, ctx.codeRoot);
        lines.push(`${outcome.passed ? 'PASS' : 'FAIL'} ${outcome.detail}`);
        if (!outcome.passed) {
          passed = false;
          break;
        }
      }
      if (item.done.length === 0) lines.push('FAIL item has no done conditions');
    } finally {
      await session.stop();
    }
    return {
      itemId: item.id,
      specificationDigest: specDigest,
      codeDigest,
      verifierDigest,
      snapshotDigest: observedSnapshot,
      mode: session.mode,
      passed,
      details: lines.join('\n'),
      at: ctx.now.toISOString(),
    };
  };
  return Object.freeze(Object.assign(runner, { executionIdentity }));
}

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface EvaluatorVerifierOptions {
  evaluator: Evaluator;
}

/** Adapts the evaluator to the settle gate's port. Anything that is not a clean verdict is `unavailable`. */
export function createEvaluatorVerifierPort(options: EvaluatorVerifierOptions): VerifierPort {
  return {
    // An unreadable state must reach the gate as unavailable, never successful
    // completion through the 'no proposal' path.
    hasProposal: () => {
      const read = options.evaluator.read();
      return !read.ok || read.value.items.some((i) => i.status === 'proposed' || i.status === 'stale');
    },
    async run(): Promise<VerifierRunResult> {
      const read = options.evaluator.read();
      if (!read.ok)
        return {
          status: 'unavailable',
          summary: `contract state unreadable: ${read.issues.map((i) => `${i.code}: ${i.message}`).join('; ')}`,
        };
      if (read.value.items.some((i) => i.status === 'stale'))
        return { status: 'unavailable', summary: 'closed evidence is stale; reopen and verify against current inputs' };
      const id = read.value.items.find((i) => i.status === 'proposed')?.id;
      if (id === undefined) return { status: 'unavailable', summary: 'no proposed item to verify' };
      const res = await options.evaluator.evaluate(id);
      if (res.closed) return { status: 'pass', summary: `item ${id} verified` };
      if (res.reason === 'failed') {
        return { status: 'fail', failureDigest: digestOf(res.detail), summary: res.detail };
      }
      const detail = 'detail' in res && typeof res.detail === 'string' ? `: ${res.detail}` : '';
      return { status: 'unavailable', summary: `evaluator refused (${res.reason})${detail}` };
    },
  };
}
