/**
 * Reading and writing `.oms/task.json`.
 *
 * Writes are atomic (temp file + rename) and validated first, so a bug in a
 * mutation can never persist an invalid contract. The `apply*` functions are
 * pure: they take a contract and return a new one, which makes every
 * transition testable without a filesystem.
 */

import { readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomic.ts';
import type { Evidence } from './evidence.ts';
import { failResult, okResult, validationIssue, type Result } from './result.ts';
import { parseTaskContract, parseTaskContractJson } from './schema.ts';
import type { ContractItem, TaskContract } from './types.ts';

export type MutationCode =
  | 'E_UNKNOWN_ITEM'
  | 'E_ITEM_NOT_ACTIVE'
  | 'E_ITEM_NOT_PROPOSED'
  | 'E_ITEM_NOT_REOPENABLE'
  | 'E_ALREADY_ACTIVE'
  | 'E_ITEM_CLOSED'
  | 'E_BAD_EVIDENCE';

export type Mutation<T> =
  | { ok: true; contract: TaskContract; value: T }
  | { ok: false; code: MutationCode; message: string };

export class ContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

function clone(contract: TaskContract): TaskContract {
  return structuredClone(contract);
}

function findItem(contract: TaskContract, itemId: string): ContractItem | undefined {
  return contract.items.find((item) => item.id === itemId);
}

function mutationFailure(code: MutationCode, message: string): Mutation<never> {
  return { ok: false, code, message };
}

export function readContractFile(contractPath: string): Result<TaskContract> {
  let text: string;
  try {
    text = readFileSync(contractPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return failResult([
      validationIssue(
        '',
        code === 'ENOENT' ? 'E_CONTRACT_MISSING' : 'E_CONTRACT_UNREADABLE',
        code === 'ENOENT' ? 'task.json does not exist' : 'task.json could not be read',
      ),
    ]);
  }
  return parseTaskContractJson(text);
}

/**
 * Validate and write the contract atomically. Throws `ContractError` if the
 * value would not parse back: a write that produces an unreadable contract is a
 * bug, not user input.
 */
export function writeContractFileAtomic(contractPath: string, contract: TaskContract): void {
  const validated = parseTaskContract(contract);
  if (!validated.ok) {
    const first = validated.issues[0];
    throw new ContractError(
      'E_INVALID_CONTRACT',
      first === undefined
        ? 'contract is invalid'
        : `${first.path === '' ? 'contract' : first.path}: ${first.message}`,
    );
  }
  writeFileAtomic(contractPath, `${JSON.stringify(validated.value, null, 2)}\n`, { mode: 0o644 });
}

/**
 * Activate one item. At most one item may be active, so activating a second one
 * while another is active fails instead of silently switching.
 */
export function applyActivate(contract: TaskContract, itemId: string): Mutation<void> {
  const next = clone(contract);
  const item = findItem(next, itemId);
  if (item === undefined) {
    return mutationFailure('E_UNKNOWN_ITEM', `unknown item "${itemId}"`);
  }
  if (item.status === 'active') {
    return { ok: true, contract: next, value: undefined };
  }
  if (item.status === 'closed') {
    return mutationFailure('E_ITEM_CLOSED', `item "${itemId}" is closed; reopen it first`);
  }
  const other = next.items.find((entry) => entry.status === 'active');
  if (other !== undefined) {
    return mutationFailure(
      'E_ALREADY_ACTIVE',
      `item "${other.id}" is already active; only one item may be active`,
    );
  }
  item.status = 'active';
  delete item.evidence;
  return { ok: true, contract: next, value: undefined };
}

/** The generator's only transition: active -> proposed. */
export function applyPropose(contract: TaskContract, itemId: string): Mutation<void> {
  const next = clone(contract);
  const item = findItem(next, itemId);
  if (item === undefined) {
    return mutationFailure('E_UNKNOWN_ITEM', `unknown item "${itemId}"`);
  }
  if (item.status !== 'active') {
    return mutationFailure(
      'E_ITEM_NOT_ACTIVE',
      `item "${itemId}" is ${item.status}; only an active item can be proposed`,
    );
  }
  item.status = 'proposed';
  return { ok: true, contract: next, value: undefined };
}

/** User/evaluator action: put a closed, blocked or proposed item back to work. */
export function applyReopen(contract: TaskContract, itemId: string): Mutation<void> {
  const next = clone(contract);
  const item = findItem(next, itemId);
  if (item === undefined) {
    return mutationFailure('E_UNKNOWN_ITEM', `unknown item "${itemId}"`);
  }
  if (item.status !== 'closed' && item.status !== 'blocked' && item.status !== 'proposed') {
    return mutationFailure(
      'E_ITEM_NOT_REOPENABLE',
      `item "${itemId}" is ${item.status}; reopen applies to closed, blocked or proposed items`,
    );
  }
  item.status = 'active';
  delete item.evidence;
  return { ok: true, contract: next, value: undefined };
}

/**
 * Close an item with evidence. Defense in depth: the same bar the evaluator
 * enforces is enforced here, so no code path can persist a closure on
 * forked, failing, unbound or mismatched evidence.
 */
export function applyClose(
  contract: TaskContract,
  itemId: string,
  evidence: Evidence,
): Mutation<void> {
  const next = clone(contract);
  const item = findItem(next, itemId);
  if (item === undefined) {
    return mutationFailure('E_UNKNOWN_ITEM', `unknown item "${itemId}"`);
  }
  if (item.status !== 'proposed') {
    return mutationFailure(
      'E_ITEM_NOT_PROPOSED',
      `item "${itemId}" is ${item.status}; only a proposed item can be closed`,
    );
  }
  if (evidence.itemId !== itemId) {
    return mutationFailure('E_BAD_EVIDENCE', 'evidence is for a different item');
  }
  if (!evidence.passed) {
    return mutationFailure('E_BAD_EVIDENCE', 'failing evidence cannot close an item');
  }
  if (evidence.mode !== 'offline-snapshot') {
    return mutationFailure(
      'E_BAD_EVIDENCE',
      'only reproducible offline-snapshot evidence can close an item',
    );
  }
  item.status = 'closed';
  item.evidence = structuredClone(evidence);
  return { ok: true, contract: next, value: undefined };
}

/**
 * Record a failed verification run: back to active with one more reopen, or
 * blocked once the reopen cap is reached so the UI can ask a human.
 */
export function applyFailedRun(
  contract: TaskContract,
  itemId: string,
  maxReopen: number,
): Mutation<{ reopenCount: number; blocked: boolean }> {
  const next = clone(contract);
  const item = findItem(next, itemId);
  if (item === undefined) {
    return mutationFailure('E_UNKNOWN_ITEM', `unknown item "${itemId}"`);
  }
  if (item.status !== 'proposed') {
    return mutationFailure(
      'E_ITEM_NOT_PROPOSED',
      `item "${itemId}" is ${item.status}; only a proposed item can fail a run`,
    );
  }
  const reopenCount = item.reopenCount + 1;
  const blocked = reopenCount >= maxReopen;
  item.reopenCount = reopenCount;
  item.status = blocked ? 'blocked' : 'active';
  delete item.evidence;
  return { ok: true, contract: next, value: { reopenCount, blocked } };
}

/**
 * File-based activation, unpinned. The engine should prefer the pin-aware
 * store (`createContractStore`); this exists for bootstrap and tests.
 */
export function activate(contractPath: string, itemId: string): Result<TaskContract> {
  const read = readContractFile(contractPath);
  if (!read.ok) return read;
  const mutation = applyActivate(read.value, itemId);
  if (!mutation.ok) {
    return failResult([validationIssue('', mutation.code, mutation.message)]);
  }
  try {
    writeContractFileAtomic(contractPath, mutation.contract);
  } catch (error) {
    const message = error instanceof ContractError ? error.message : 'contract could not be written';
    return failResult([validationIssue('', 'E_CONTRACT_WRITE', message)]);
  }
  return okResult(mutation.contract);
}
