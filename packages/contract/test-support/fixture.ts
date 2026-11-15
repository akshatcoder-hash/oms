/**
 * Test fixtures: a throwaway project root, a pin file outside it, and helpers
 * to build evidence bound to a runner context. Every fixture removes its temp
 * directory via `t.after`.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../src/digest.ts';
import type { RunnerContext } from '../src/evaluator.ts';
import type { Evidence } from '../src/evidence.ts';
import { pinContract, refreshPin, type PinFile, type PinResult } from '../src/pin.ts';
import type { ContractItem, EvaluatorConfig, TaskContract } from '../src/types.ts';
import { writeContractFileAtomic } from '../src/contract-io.ts';
import type { TaskRoots } from '../src/paths.ts';

export const PROJECT_PATH = 'task.json';
export const VERIFIER_PATH = 'tests/verifier.test.ts';
export const CODE_PATH = 'src/main.ts';
export const SNAPSHOT_DIGEST = sha256Hex('snapshot:fixture-offline');
export const FIXED_TIME = new Date('2026-01-01T00:00:00.000Z');

export function evaluatorConfig(): EvaluatorConfig {
  return {
    schema: 'oms.evaluator/0',
    snapshotDigest: SNAPSHOT_DIGEST,
    codePaths: [CODE_PATH],
    snapshotPath: '.oms/snapshots/offline.json',
    verifierLabel: 'verifier.test.ts',
    executionIdentity: 'test:controlled',
  };
}

export function baseContract(): TaskContract {
  return {
    version: 0,
    template: 'spl-token',
    items: [
      {
        id: 'item-1',
        title: 'mint, mint-to and transfer leave the expected balances',
        done: [{ kind: 'tests', command: ['npm', 'test'], expect: 'pass' }],
        status: 'active',
        reopenCount: 0,
      },
      {
        id: 'item-2',
        title: 'the destination account holds 10 tokens',
        done: [
          {
            kind: 'account',
            address: '11111111111111111111111111111111',
            field: 'tokenAmount',
            equals: '10',
          },
        ],
        status: 'open',
        reopenCount: 0,
      },
    ],
  };
}

export interface Project {
  /** Temp base directory; contains root/ and outside/. */
  base: string;
  root: string;
  roots: TaskRoots;
  outside: string;
  contractPath: string;
  verifierPath: string;
  codePath: string;
  pinFile: string;
  verifierPaths: string[];
  config: EvaluatorConfig;
  /** Current contract as last written by the fixture. */
  contract(): TaskContract;
  /** Write a contract and re-pin it, as the user's editor would at `/new`. */
  setContract(contract: TaskContract): void;
  writeContractRaw(text: string): void;
  readContractText(): string;
  pin(overrides?: Partial<Parameters<typeof pinContract>[0]>): PinResult;
  pinOrThrow(): void;
  readPinFile(): PinFile;
  cleanup(): void;
}

export function makeProject(): Project {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-contract-test-')));
  const workspaceRoot = join(base, 'workspace');
  const root = join(workspaceRoot, '.oms', 'worktrees', 'task-1');
  const stateRoot = join(workspaceRoot, '.oms', 'tasks', 'task-1');
  const roots = { workspaceRoot, codeRoot: root, stateRoot, sourceControlDir: join(base, 'source-control') };
  mkdirSync(stateRoot, { recursive: true });
  const outside = join(base, 'outside');
  mkdirSync(join(root, '.oms'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });

  const contractPath = join(stateRoot, PROJECT_PATH);
  const verifierPath = join(root, VERIFIER_PATH);
  const codePath = join(root, CODE_PATH);
  const pinFile = join(outside, 'oms-pin.json');

  writeFileSync(verifierPath, "// verifier: do not edit\nimport { test } from 'node:test';\n");
  writeFileSync(codePath, 'export const amount = 10;\n');
  mkdirSync(join(root, '.oms', 'snapshots'), { recursive: true });
  writeFileSync(join(root, '.oms', 'snapshots', 'offline.json'), 'snapshot:fixture-offline');
  writeContractFileAtomic(contractPath, baseContract());

  const config = evaluatorConfig();
  let current = baseContract();

  const project: Project = {
    base,
    root,
    roots,
    outside,
    contractPath,
    verifierPath,
    codePath,
    pinFile,
    verifierPaths: [VERIFIER_PATH],
    config,
    contract: () => structuredClone(current),
    setContract(contract: TaskContract): void {
      writeContractFileAtomic(contractPath, contract);
      current = structuredClone(contract);
      const refreshed = refreshPin(pinFile, roots);
      if (!refreshed.ok) throw new Error(`fixture could not re-pin: ${refreshed.message}`);
    },
    writeContractRaw(text: string): void {
      writeFileSync(contractPath, text);
    },
    readContractText(): string {
      return readFileSync(contractPath, 'utf8');
    },
    pin(overrides = {}): PinResult {
      return pinContract({
        ...roots,
        contractPath: PROJECT_PATH,
        verifierPaths: [VERIFIER_PATH],
        evaluatorConfig: config,
        pinFile,
        ...overrides,
      });
    },
    pinOrThrow(): void {
      const result = project.pin();
      if (!result.ok) throw new Error(`fixture could not pin: ${result.code} ${result.message}`);
    },
    readPinFile(): PinFile {
      return JSON.parse(readFileSync(pinFile, 'utf8')) as PinFile;
    },
    cleanup(): void {
      rmSync(base, { recursive: true, force: true });
    },
  };

  project.pinOrThrow();
  return project;
}

/** Evidence bound to a runner context, with per-test overrides. */
export function evidenceFor(
  item: Pick<ContractItem, 'id'>,
  ctx: RunnerContext,
  overrides: Partial<Evidence> = {},
): Evidence {
  return {
    itemId: item.id,
    specificationDigest: ctx.specificationDigest,
    codeDigest: ctx.codeDigest,
    verifierDigest: ctx.verifierDigest,
    snapshotDigest: ctx.snapshotDigest,
    mode: 'offline-snapshot',
    passed: true,
    details: 'verifier passed',
    at: FIXED_TIME.toISOString(),
    ...overrides,
  };
}

/** A runner that passes and counts its calls. */
export function countingRunner(options: { passed?: boolean; mode?: Evidence['mode'] } = {}): {
  runner: (item: ContractItem, ctx: RunnerContext) => Promise<Evidence>;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    runner: async (item, ctx) => {
      calls += 1;
      return evidenceFor(item, ctx, {
        passed: options.passed ?? true,
        mode: options.mode ?? 'offline-snapshot',
      });
    },
  };
}
