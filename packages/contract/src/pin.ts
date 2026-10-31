/**
 * Pin sets: the digest triple the evaluator trusts.
 *
 * At `/new` the contract, the verifier files and the evaluator config are
 * digested and written to a pin file. That file must live **outside** the
 * workspace, state and code roots. The generator only receives codeRoot;
 * stateRoot and the external pin remain trusted host capabilities.
 * The evaluator recomputes digests on every decision and refuses mismatches.
 */

import { readFileSync } from 'node:fs';
import { readContractFile } from './contract-io.ts';
import {
  DigestError,
  digestFileEntries,
  digestFiles,
  digestJson,
  type FileDigest,
  type PinSet,
} from './digest.ts';
import { writeFileAtomic } from './atomic.ts';
import {
  PathError,
  resolveTaskRoots,
  type TaskRoots,
  isPathError,
  resolveFileInsideRoot,
  toPosixRelative,
} from './paths.ts';
import { failResult, okResult, validationIssue, type Result, type ValidationIssue } from './result.ts';
import { parseEvaluatorConfig } from './schema.ts';

export const PIN_SCHEMA = 'oms.pin/1';

export interface PinFile {
  schema: typeof PIN_SCHEMA;
  roots: TaskRoots;
  pin: PinSet;
  contract: { path: string; digest: string };
  verifier: { digest: string; files: FileDigest[] };
  /** The exact config value that was digested, so verification needs no disk state. */
  evaluatorConfig: unknown;
  createdAt: string;
}

export interface PinOptions extends TaskRoots {
  /** Contract path relative to the trusted stateRoot. */
  contractPath: string;
  /** Verifier files, relative to codeRoot. At least one is required. */
  verifierPaths: readonly string[];
  /** Evaluator config; digested as canonical JSON and validated. */
  evaluatorConfig: unknown;
  /** Pin file outside workspaceRoot, stateRoot and codeRoot; trusted caller only. */
  pinFile: string;
}

export type PinResult =
  | { ok: true; pinSet: PinSet; pinFile: string; files: FileDigest[] }
  | { ok: false; code: string; message: string; path?: string };

export interface Mismatch {
  what: 'contract' | 'verifier' | 'evaluatorConfig' | 'pinFile';
  expected: string;
  actual: string;
  detail?: string;
  /** For verifier mismatches: which files changed. */
  files?: string[];
}

export type PinVerifyResult =
  | { ok: true; pinSet: PinSet; pin: PinFile }
  | { ok: false; mismatches: Mismatch[] };

const HEX64 = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

function pinFailure(error: unknown): Extract<PinResult, { ok: false }> {
  if (isPathError(error)) {
    return { ok: false, code: error.code, message: error.message, path: error.path };
  }
  if (error instanceof DigestError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return { ok: false, code: 'E_PIN_WRITE', message: 'pin could not be written' };
}

/** Read and structurally validate a pin file. */
export function readPin(pinFile: string): Result<PinFile> {
  let text: string;
  try {
    text = readFileSync(pinFile, 'utf8');
  } catch {
    return failResult([validationIssue('', 'E_PIN_MISSING', 'pin file is missing or unreadable')]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failResult([validationIssue('', 'E_BAD_PIN_FILE', 'pin file is not valid JSON')]);
  }
  if (!isPlainObject(parsed)) {
    return failResult([validationIssue('', 'E_BAD_PIN_FILE', 'pin file must be a JSON object')]);
  }
  const issues: ValidationIssue[] = [];
  if (parsed['schema'] !== PIN_SCHEMA) {
    issues.push(validationIssue('schema', 'E_BAD_PIN_FILE', `schema must be "${PIN_SCHEMA}"`));
  }
  const pin = parsed['pin'];
  const roots = parsed['roots'];
  if (!isPlainObject(roots) || !['workspaceRoot', 'stateRoot', 'codeRoot'].every((key) => typeof roots[key] === 'string')) {
    issues.push(validationIssue('roots', 'E_BAD_PIN_FILE', 'pin must record its trusted roots'));
  }
  if (!isPlainObject(pin)) {
    issues.push(validationIssue('pin', 'E_BAD_PIN_FILE', 'pin must be an object'));
  } else {
    for (const field of ['contractDigest', 'verifierDigest', 'evaluatorConfigDigest']) {
      if (!isDigest(pin[field])) {
        issues.push(validationIssue(`pin.${field}`, 'E_BAD_DIGEST', `${field} must be a sha256 hex digest`));
      }
    }
  }
  const contract = parsed['contract'];
  if (!isPlainObject(contract) || typeof contract['path'] !== 'string' || !isDigest(contract['digest'])) {
    issues.push(
      validationIssue('contract', 'E_BAD_PIN_FILE', 'contract must be { path, digest }'),
    );
  } else {
    const contractPath = contract['path'] as string;
    try {
      if (toPosixRelative(contractPath) !== contractPath) {
        issues.push(validationIssue('contract.path', 'E_BAD_PIN_FILE', 'contract.path must be normalized'));
      }
    } catch (error) {
      const message = isPathError(error) ? error.message : 'contract.path is invalid';
      issues.push(validationIssue('contract.path', 'E_BAD_PIN_FILE', message));
    }
  }
  const verifier = parsed['verifier'];
  const rawFiles = isPlainObject(verifier) ? verifier['files'] : undefined;
  if (!isPlainObject(verifier) || !Array.isArray(rawFiles) || rawFiles.length === 0) {
    issues.push(
      validationIssue('verifier', 'E_BAD_PIN_FILE', 'verifier must hold a non-empty files array'),
    );
  } else {
    const files: FileDigest[] = [];
    rawFiles.forEach((entry, index) => {
      if (!isPlainObject(entry) || typeof entry['path'] !== 'string' || !isDigest(entry['digest'])) {
        issues.push(
          validationIssue(`verifier.files[${index}]`, 'E_BAD_PIN_FILE', 'entry must be { path, digest }'),
        );
        return;
      }
      files.push({ path: entry['path'] as string, digest: entry['digest'] as string });
    });
    if (files.length === rawFiles.length && isDigest(verifier['digest'])) {
      if (digestFileEntries(files) !== verifier['digest']) {
        issues.push(
          validationIssue(
            'verifier.digest',
            'E_BAD_PIN_FILE',
            'verifier.digest does not match its own file entries',
          ),
        );
      }
    } else if (!isDigest(verifier['digest'])) {
      issues.push(validationIssue('verifier.digest', 'E_BAD_DIGEST', 'verifier.digest must be a sha256 hex digest'));
    }
  }
  if (parsed['evaluatorConfig'] === undefined) {
    issues.push(validationIssue('evaluatorConfig', 'E_BAD_PIN_FILE', 'evaluatorConfig is missing'));
  }
  if (issues.length > 0) return failResult(issues);

  // Cross-field consistency: the redundant copies inside the pin file must agree.
  const pinSet = pin as unknown as PinSet;
  const contractRecord = contract as { path: string; digest: string };
  const verifierRecord = verifier as { digest: string; files: FileDigest[] };
  if (contractRecord.digest !== pinSet.contractDigest) {
    issues.push(validationIssue('contract.digest', 'E_BAD_PIN_FILE', 'contract.digest does not match pin.contractDigest'));
  }
  if (verifierRecord.digest !== pinSet.verifierDigest) {
    issues.push(validationIssue('verifier.digest', 'E_BAD_PIN_FILE', 'verifier.digest does not match pin.verifierDigest'));
  }
  if (issues.length > 0) return failResult(issues);

  return okResult({
    schema: PIN_SCHEMA,
    roots: roots as unknown as TaskRoots,
    pin: pinSet,
    contract: { path: contractRecord.path, digest: contractRecord.digest },
    verifier: { digest: verifierRecord.digest, files: verifierRecord.files.map((file) => ({ ...file })) },
    evaluatorConfig: (parsed as Record<string, unknown>)['evaluatorConfig'],
    createdAt: typeof parsed['createdAt'] === 'string' ? (parsed['createdAt'] as string) : '',
  });
}

function writePinFile(pinFile: string, pin: PinFile): void {
  writeFileAtomic(pinFile, `${JSON.stringify(pin, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Digest the contract, the verifier files and the evaluator config, then write
 * the pin file. State and code roots are disjoint, and the external pin records
 * their canonical identities so a caller cannot silently substitute roots.
 */
export function pinContract(options: PinOptions): PinResult {
  try {
    const roots = resolveTaskRoots(options, options.pinFile);

    if (options.verifierPaths.length === 0) {
      return { ok: false, code: 'E_NO_VERIFIER', message: 'at least one verifier path is required' };
    }

    const config = parseEvaluatorConfig(options.evaluatorConfig);
    if (!config.ok) {
      const first = config.issues[0];
      return {
        ok: false,
        code: 'E_CONFIG_INVALID',
        message:
          first === undefined
            ? 'evaluator config is invalid'
            : `${first.path === '' ? 'evaluatorConfig' : first.path}: ${first.message}`,
      };
    }

    const contractRel = toPosixRelative(options.contractPath);
    const contractDigest = digestFiles(roots.stateRoot, [contractRel], options).digest;

    // Do not pin a contract that will not parse: the pin would then record a
    // task nobody can work on, and the failure would only surface later.
    const contract = readContractFile(resolveFileInsideRoot(roots.stateRoot, contractRel));
    if (!contract.ok) {
      const first = contract.issues[0];
      return {
        ok: false,
        code: 'E_CONTRACT_INVALID',
        message:
          first === undefined ? 'task.json is invalid' : `${first.path === '' ? 'contract' : first.path}: ${first.message}`,
        path: contractRel,
      };
    }

    const verifier = digestFiles(roots.codeRoot, options.verifierPaths, options);
    const evaluatorConfigDigest = digestJson(options.evaluatorConfig);
    const pinSet: PinSet = {
      contractDigest,
      verifierDigest: verifier.digest,
      evaluatorConfigDigest,
    };

    const pin: PinFile = {
      schema: PIN_SCHEMA,
      roots,
      pin: pinSet,
      contract: { path: contractRel, digest: contractDigest },
      verifier: { digest: verifier.digest, files: verifier.files },
      evaluatorConfig: options.evaluatorConfig,
      createdAt: new Date().toISOString(),
    };
    writePinFile(options.pinFile, pin);
    return { ok: true, pinSet, pinFile: options.pinFile, files: verifier.files };
  } catch (error) {
    return pinFailure(error);
  }
}

/**
 * Recompute every pinned digest from the filesystem and compare with the pin.
 * Returns all mismatches, not just the first.
 */
export function verifyPin(pinFile: string, roots: TaskRoots): PinVerifyResult {
  const pinResult = readPin(pinFile);
  if (!pinResult.ok) {
    const first = pinResult.issues[0];
    return {
      ok: false,
      mismatches: [
        {
          what: 'pinFile',
          expected: `a readable ${PIN_SCHEMA} pin`,
          actual: first === undefined ? 'unreadable' : first.code,
          detail: first === undefined ? undefined : first.message,
        },
      ],
    };
  }
  const pin = pinResult.value;
  const mismatches: Mismatch[] = [];

  let resolved: TaskRoots;
  try {
    resolved = resolveTaskRoots(roots, pinFile);
    if (digestJson(resolved) !== digestJson(pin.roots)) throw new Error('trusted task roots differ from the pin');
  } catch (error) {
    return {
      ok: false,
      mismatches: [
        {
          what: 'pinFile',
          expected: 'a project root that exists',
          actual: 'E_BAD_ROOT',
          detail: error instanceof Error ? error.message : undefined,
        },
      ],
    };
  }

  try {
    const contract = digestFiles(resolved.stateRoot, [pin.contract.path], roots);
    if (contract.digest !== pin.pin.contractDigest) {
      mismatches.push({
        what: 'contract',
        expected: pin.pin.contractDigest,
        actual: contract.digest,
        detail: `${pin.contract.path} changed since it was pinned`,
      });
    }
  } catch (error) {
    mismatches.push({
      what: 'contract',
      expected: pin.pin.contractDigest,
      actual: 'unreadable',
      detail: `${pin.contract.path}: ${isPathError(error) ? `${error.code} ${error.message}` : 'unreadable'}`,
    });
  }

  try {
    const verifier = digestFiles(
      resolved.codeRoot,
      pin.verifier.files.map((file) => file.path),
      roots,
    );
    if (verifier.digest !== pin.pin.verifierDigest) {
      const before = new Map(pin.verifier.files.map((file) => [file.path, file.digest]));
      const changed = verifier.files
        .filter((file) => before.get(file.path) !== file.digest)
        .map((file) => file.path);
      for (const file of pin.verifier.files) {
        if (!verifier.files.some((entry) => entry.path === file.path)) changed.push(file.path);
      }
      mismatches.push({
        what: 'verifier',
        expected: pin.pin.verifierDigest,
        actual: verifier.digest,
        detail: 'a pinned verifier file changed',
        files: changed.sort(),
      });
    }
  } catch (error) {
    mismatches.push({
      what: 'verifier',
      expected: pin.pin.verifierDigest,
      actual: 'unreadable',
      detail: isPathError(error) ? `${error.code} ${error.message}` : 'verifier files are unreadable',
    });
  }

  let configDigest: string;
  try {
    configDigest = digestJson(pin.evaluatorConfig);
  } catch {
    configDigest = 'unusable';
  }
  if (configDigest !== pin.pin.evaluatorConfigDigest) {
    mismatches.push({
      what: 'evaluatorConfig',
      expected: pin.pin.evaluatorConfigDigest,
      actual: configDigest,
      detail: 'the pinned evaluator config does not match its own digest',
    });
  }

  if (mismatches.length > 0) return { ok: false, mismatches };
  return { ok: true, pinSet: pin.pin, pin };
}

/**
 * Refresh the pinned contract digest after a mutation the evaluator itself
 * allowed (propose, close, reopen, reopen-count, activate). Verifier and config
 * digests are untouched, and the pin is re-read first so a concurrent user edit
 * is still detected.
 */
export function refreshPin(pinFile: string, roots: TaskRoots): PinResult {
  const existing = readPin(pinFile);
  if (!existing.ok) {
    const first = existing.issues[0];
    return {
      ok: false,
      code: first === undefined ? 'E_BAD_PIN_FILE' : first.code,
      message: first === undefined ? 'pin file is invalid' : first.message,
    };
  }
  try {
    const resolved = resolveTaskRoots(roots, pinFile);
    const pin = existing.value;
    if (digestJson(resolved) !== digestJson(pin.roots)) throw new Error('trusted task roots differ from the pin');
    const contract = digestFiles(resolved.stateRoot, [pin.contract.path], roots);
    const next: PinFile = {
      ...pin,
      pin: { ...pin.pin, contractDigest: contract.digest },
      contract: { path: pin.contract.path, digest: contract.digest },
      createdAt: new Date().toISOString(),
    };
    writePinFile(pinFile, next);
    return { ok: true, pinSet: next.pin, pinFile, files: pin.verifier.files };
  } catch (error) {
    return pinFailure(error);
  }
}

/** Absolute path of the contract recorded in the pin, inside trusted stateRoot. */
export function pinnedContractPath(pinFile: string, roots: TaskRoots): string {
  const pin = readPin(pinFile);
  if (!pin.ok) {
    const first = pin.issues[0];
    throw new PathError(
      'E_UNRESOLVABLE',
      first === undefined ? 'pin file is invalid' : first.message,
      pinFile,
    );
  }
  const resolved = resolveTaskRoots(roots, pinFile);
  if (digestJson(resolved) !== digestJson(pin.value.roots)) throw new PathError('E_BAD_ROOT', 'trusted task roots differ from the pin');
  return resolveFileInsideRoot(resolved.stateRoot, pin.value.contract.path);
}
