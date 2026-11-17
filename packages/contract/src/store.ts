/**
 * The only writer of the task contract in trusted stateRoot.
 *
 * Every mutation is gated on the pin verifying immediately before the write,
 * then the pin's contract digest is refreshed so the evaluator's own allowed
 * transitions do not look like tampering. The generator never receives this
 * object: it gets the proposer surface, which can only move active -> proposed.
 *
 * Residual window: the pin is checked and then the file is written, so a
 * concurrent writer inside the window is not detected. The engine serializes
 * state-changing calls, so there is one writer at a time.
 */

import {
  ContractError,
  applyActivate,
  readContractFile,
  writeContractFileAtomic,
  type Mutation,
} from './contract-io.ts';
import type { PinSet } from './digest.ts';
import { isPathError, resolveFileInsideRoot, type TaskRoots } from './paths.ts';
import { readPin, pinnedContractPath, refreshPin, verifyPin, type Mismatch, type PinVerifyResult } from './pin.ts';
import { failResult, validationIssue, type Result, type ValidationIssue } from './result.ts';
import type { TaskContract } from './types.ts';

export type StoreCode =
  | 'E_PIN_MISMATCH'
  | 'E_PIN_UNREADABLE'
  | 'E_CONTRACT_PATH'
  | 'E_CONTRACT_INVALID'
  | 'E_CONTRACT_WRITE'
  | 'E_PIN_REFRESH';

export type StoreResult<T> =
  | { ok: true; value: T; contract: TaskContract; pinSet: PinSet }
  | {
      ok: false;
      code: StoreCode | string;
      message: string;
      mismatches?: Mismatch[];
      issues?: ValidationIssue[];
    };

export interface ContractStore extends TaskRoots {
  readonly pinFile: string;
  /** Contract path recorded in the pin, or null when the pin is unreadable. */
  contractPath(): string | null;
  verify(): PinVerifyResult;
  read(): Result<TaskContract>;
  mutate<T>(mutator: (contract: TaskContract) => Mutation<T>): StoreResult<T>;
  /** Activate one item; fails when another item is already active. */
  activate(itemId: string): StoreResult<void>;
}

function storeFailure<T>(
  code: string,
  message: string,
  extra: { mismatches?: Mismatch[]; issues?: ValidationIssue[] } = {},
): StoreResult<T> {
  return { ok: false, code, message, ...extra };
}

type PinnedPath =
  { ok: true; path: string } | { ok: false; code: StoreCode; message: string; issues: ValidationIssue[] };

export interface ContractStoreOptions extends TaskRoots {
  /** Pin file path, outside workspaceRoot, stateRoot and codeRoot. */
  pinFile: string;
}

export function createContractStore(options: ContractStoreOptions): ContractStore {
  const { stateRoot, pinFile } = options;

  const pinnedPath = (): PinnedPath => {
    const pin = readPin(pinFile);
    if (!pin.ok) {
      const first = pin.issues[0];
      return {
        ok: false,
        code: 'E_PIN_UNREADABLE',
        message: first === undefined ? 'pin file is unreadable' : first.message,
        issues: pin.issues,
      };
    }
    try {
      pinnedContractPath(pinFile, options);
    } catch (error) {
      return {
        ok: false,
        code: 'E_CONTRACT_PATH',
        message: isPathError(error) ? error.message : 'contract path from the pin is unusable',
        issues: [],
      };
    }
    return { ok: true, path: pin.value.contract.path };
  };

  const store: ContractStore = {
    workspaceRoot: options.workspaceRoot,
    codeRoot: options.codeRoot,
    stateRoot,
    pinFile,

    contractPath(): string | null {
      const resolved = pinnedPath();
      return resolved.ok ? resolved.path : null;
    },

    verify(): PinVerifyResult {
      return verifyPin(pinFile, options);
    },

    read(): Result<TaskContract> {
      const resolved = pinnedPath();
      if (!resolved.ok) {
        return failResult([validationIssue('', resolved.code, resolved.message)]);
      }
      try {
        return readContractFile(resolveFileInsideRoot(stateRoot, resolved.path));
      } catch (error) {
        return failResult([
          validationIssue('', 'E_CONTRACT_PATH', isPathError(error) ? error.message : 'contract path is unusable'),
        ]);
      }
    },

    mutate<T>(mutator: (contract: TaskContract) => Mutation<T>): StoreResult<T> {
      const pinCheck = verifyPin(pinFile, options);
      if (!pinCheck.ok) {
        return storeFailure('E_PIN_MISMATCH', 'refusing to write: the pin does not match the files on disk', {
          mismatches: pinCheck.mismatches,
        });
      }
      let contractAbsolute: string;
      try {
        contractAbsolute = resolveFileInsideRoot(stateRoot, pinCheck.pin.contract.path);
      } catch (error) {
        return storeFailure('E_CONTRACT_PATH', isPathError(error) ? error.message : 'contract path is unusable');
      }
      const contract = readContractFile(contractAbsolute);
      if (!contract.ok) {
        return storeFailure('E_CONTRACT_INVALID', 'task.json is invalid', {
          issues: contract.issues,
        });
      }
      const mutated = mutator(contract.value);
      if (!mutated.ok) {
        return storeFailure(String(mutated.code), mutated.message);
      }
      try {
        writeContractFileAtomic(contractAbsolute, mutated.contract);
      } catch (error) {
        return storeFailure(
          'E_CONTRACT_WRITE',
          error instanceof ContractError ? error.message : 'contract could not be written',
        );
      }
      const refreshed = refreshPin(pinFile, options);
      if (!refreshed.ok) {
        return storeFailure(
          'E_PIN_REFRESH',
          `contract was written but the pin could not be refreshed: ${refreshed.message}`,
        );
      }
      return {
        ok: true,
        value: mutated.value,
        contract: mutated.contract,
        pinSet: refreshed.pinSet,
      };
    },

    activate(itemId: string): StoreResult<void> {
      return store.mutate((contract) => applyActivate(contract, itemId));
    },
  };

  return store;
}
