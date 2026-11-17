/**
 * Hand-written validation for `.oms/task.json` and the evaluator config.
 *
 * No schema library: the shape is small, and the error paths are part of the
 * UX (`items[2].done[0].expect`). Validation never throws on bad input.
 */

import { parseEvidence, type Evidence } from './evidence.ts';
import { failResult, okResult, validationIssue, type Result, type ValidationIssue } from './result.ts';
import type { Condition, ContractItem, EvaluatorConfig, ItemStatus, TaskContract } from './types.ts';

const CONTRACT_KEYS = new Set(['version', 'template', 'items']);
const ITEM_KEYS = new Set(['id', 'title', 'done', 'status', 'reopenCount', 'evidence']);
const TESTS_KEYS = new Set(['kind', 'command', 'expect']);
const ACCOUNT_KEYS = new Set(['kind', 'address', 'field', 'equals']);
const TX_KEYS = new Set(['kind', 'description']);
const EVALUATOR_KEYS = new Set([
  'schema',
  'snapshotDigest',
  'codePaths',
  'snapshotPath',
  'verifierLabel',
  'testTimeoutMs',
  'executionIdentity',
]);

const ITEM_STATUSES: readonly ItemStatus[] = ['open', 'active', 'proposed', 'closed', 'blocked'];
const ACCOUNT_FIELDS = ['lamports', 'owner', 'dataLen', 'tokenAmount'] as const;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function itemPath(index: number, field?: string): string {
  const base = `items[${index}]`;
  return field === undefined ? base : `${base}.${field}`;
}

function checkUnknownKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  basePath: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push(
        validationIssue(basePath === '' ? key : `${basePath}.${key}`, 'E_UNKNOWN_FIELD', `unknown field "${key}"`),
      );
    }
  }
}

function parseCondition(input: unknown, path: string, issues: ValidationIssue[]): Condition | null {
  if (!isPlainObject(input)) {
    issues.push(validationIssue(path, 'E_NOT_OBJECT', 'condition must be an object'));
    return null;
  }
  const kind = input['kind'];
  if (kind === 'tests') {
    checkUnknownKeys(input, TESTS_KEYS, path, issues);
    const before = issues.length;
    const command = input['command'];
    if (!Array.isArray(command) || command.length === 0) {
      issues.push(validationIssue(`${path}.command`, 'E_BAD_COMMAND', 'command must be a non-empty array'));
    } else {
      command.forEach((entry, index) => {
        if (!isNonEmptyString(entry)) {
          issues.push(
            validationIssue(
              `${path}.command[${index}]`,
              'E_BAD_COMMAND',
              'every command argument must be a non-empty string',
            ),
          );
        }
      });
    }
    if (input['expect'] !== 'pass') {
      issues.push(validationIssue(`${path}.expect`, 'E_BAD_EXPECT', 'expect must be "pass"'));
    }
    if (issues.length !== before) return null;
    return { kind: 'tests', command: (command as string[]).slice(), expect: 'pass' };
  }

  if (kind === 'account') {
    checkUnknownKeys(input, ACCOUNT_KEYS, path, issues);
    const before = issues.length;
    const address = input['address'];
    if (!isNonEmptyString(address) || !BASE58.test(address)) {
      issues.push(validationIssue(`${path}.address`, 'E_BAD_ADDRESS', 'address must be a base58 Solana address'));
    }
    const field = input['field'];
    if (typeof field !== 'string' || !(ACCOUNT_FIELDS as readonly string[]).includes(field)) {
      issues.push(validationIssue(`${path}.field`, 'E_BAD_FIELD', `field must be one of ${ACCOUNT_FIELDS.join(', ')}`));
    }
    const equals = input['equals'];
    if (!isNonEmptyString(equals)) {
      issues.push(validationIssue(`${path}.equals`, 'E_BAD_EQUALS', 'equals must be a string'));
    } else if (field === 'owner' && !BASE58.test(equals)) {
      issues.push(validationIssue(`${path}.equals`, 'E_BAD_EQUALS', 'owner must be a base58 address'));
    } else if (field === 'lamports' && !UINT.test(equals)) {
      issues.push(validationIssue(`${path}.equals`, 'E_BAD_EQUALS', 'lamports must be a whole number'));
    } else if (field === 'dataLen' && !UINT.test(equals)) {
      issues.push(validationIssue(`${path}.equals`, 'E_BAD_EQUALS', 'dataLen must be a whole number'));
    } else if (field === 'tokenAmount' && !UINT.test(equals)) {
      issues.push(validationIssue(`${path}.equals`, 'E_BAD_EQUALS', 'tokenAmount must be raw unsigned integer atoms'));
    }
    if (issues.length !== before) return null;
    return {
      kind: 'account',
      address: address as string,
      field: field as (typeof ACCOUNT_FIELDS)[number],
      equals: equals as string,
    };
  }

  if (kind === 'tx') {
    checkUnknownKeys(input, TX_KEYS, path, issues);
    const before = issues.length;
    const description = input['description'];
    if (!isNonEmptyString(description)) {
      issues.push(validationIssue(`${path}.description`, 'E_BAD_DESCRIPTION', 'description must be a string'));
    }
    if (issues.length !== before) return null;
    return { kind: 'tx', description: description as string };
  }

  issues.push(validationIssue(`${path}.kind`, 'E_BAD_KIND', 'kind must be "tests", "account" or "tx"'));
  return null;
}

function parseItem(input: unknown, index: number, issues: ValidationIssue[]): ContractItem | null {
  const path = itemPath(index);
  if (!isPlainObject(input)) {
    issues.push(validationIssue(path, 'E_NOT_OBJECT', 'item must be an object'));
    return null;
  }
  checkUnknownKeys(input, ITEM_KEYS, path, issues);
  const before = issues.length;

  const id = input['id'];
  if (!isNonEmptyString(id)) {
    issues.push(validationIssue(itemPath(index, 'id'), 'E_BAD_ITEM_ID', 'id must be a non-empty string'));
  }
  const title = input['title'];
  if (!isNonEmptyString(title)) {
    issues.push(validationIssue(itemPath(index, 'title'), 'E_BAD_STRING', 'title must be a non-empty string'));
  }

  const done: Condition[] = [];
  const rawDone = input['done'];
  if (!Array.isArray(rawDone)) {
    issues.push(validationIssue(itemPath(index, 'done'), 'E_BAD_TYPE', 'done must be an array of conditions'));
  } else if (rawDone.length === 0) {
    issues.push(validationIssue(itemPath(index, 'done'), 'E_EMPTY_DONE', 'an item needs at least one done condition'));
  } else {
    rawDone.forEach((entry, conditionIndex) => {
      const condition = parseCondition(entry, `${itemPath(index, 'done')}[${conditionIndex}]`, issues);
      if (condition !== null) done.push(condition);
    });
  }

  const status = input['status'];
  if (typeof status !== 'string' || !ITEM_STATUSES.includes(status as ItemStatus)) {
    issues.push(
      validationIssue(itemPath(index, 'status'), 'E_BAD_STATUS', `status must be one of ${ITEM_STATUSES.join(', ')}`),
    );
  }

  const reopenCount = input['reopenCount'];
  if (typeof reopenCount !== 'number' || !Number.isInteger(reopenCount) || reopenCount < 0) {
    issues.push(
      validationIssue(
        itemPath(index, 'reopenCount'),
        'E_BAD_REOPEN_COUNT',
        'reopenCount must be a non-negative integer',
      ),
    );
  }

  let evidence: Evidence | undefined;
  const rawEvidence = input['evidence'];
  if (rawEvidence !== undefined) {
    const parsed = parseEvidence(rawEvidence);
    if (!parsed.ok) {
      for (const issue of parsed.issues) {
        const prefix = issue.path === '' ? itemPath(index, 'evidence') : `${itemPath(index, 'evidence')}.${issue.path}`;
        issues.push({ ...issue, path: prefix });
      }
    } else {
      evidence = parsed.value;
      if (status !== 'closed') {
        issues.push(
          validationIssue(
            itemPath(index, 'evidence'),
            'E_EVIDENCE_ON_ITEM_NOT_CLOSED',
            'only a closed item may carry an evidence record',
          ),
        );
      } else if (!evidence.passed) {
        issues.push(
          validationIssue(
            itemPath(index, 'evidence'),
            'E_CLOSED_WITH_FAILED_EVIDENCE',
            'a closed item needs a passing evidence record',
          ),
        );
      }
      if (isNonEmptyString(id) && evidence.itemId !== id) {
        issues.push(
          validationIssue(
            `${itemPath(index, 'evidence')}.itemId`,
            'E_EVIDENCE_ITEM_MISMATCH',
            `evidence is for item "${evidence.itemId}" but sits on "${id}"`,
          ),
        );
      }
    }
  } else if (status === 'closed') {
    issues.push(
      validationIssue(
        itemPath(index, 'evidence'),
        'E_CLOSED_WITHOUT_EVIDENCE',
        'a closed item needs an evidence record',
      ),
    );
  }

  if (issues.length !== before) return null;

  const item: ContractItem = {
    id: id as string,
    title: title as string,
    done,
    status: status as ItemStatus,
    reopenCount: reopenCount as number,
  };
  if (evidence !== undefined) item.evidence = evidence;
  return item;
}

/** Validate a parsed `.oms/task.json` value. */
export function parseTaskContract(input: unknown): Result<TaskContract> {
  if (!isPlainObject(input)) {
    return failResult([validationIssue('', 'E_NOT_OBJECT', 'task contract must be a JSON object')]);
  }
  const issues: ValidationIssue[] = [];
  checkUnknownKeys(input, CONTRACT_KEYS, '', issues);

  if (input['version'] !== 0) {
    issues.push(validationIssue('version', 'E_BAD_VERSION', 'version must be the number 0'));
  }
  const template = input['template'];
  if (template !== undefined && !isNonEmptyString(template)) {
    issues.push(validationIssue('template', 'E_BAD_STRING', 'template must be a non-empty string when present'));
  }

  const items: ContractItem[] = [];
  const rawItems = input['items'];
  if (!Array.isArray(rawItems)) {
    issues.push(validationIssue('items', 'E_BAD_TYPE', 'items must be an array'));
  } else {
    const seenIds = new Map<string, number>();
    let activeIndex: number | undefined;
    rawItems.forEach((entry, index) => {
      const item = parseItem(entry, index, issues);
      if (item !== null) {
        items.push(item);
        const first = seenIds.get(item.id);
        if (first !== undefined) {
          issues.push(
            validationIssue(
              itemPath(index, 'id'),
              'E_DUPLICATE_ID',
              `id "${item.id}" is already used by items[${first}]`,
            ),
          );
        } else {
          seenIds.set(item.id, index);
        }
        if (item.status === 'active') {
          if (activeIndex !== undefined) {
            issues.push(
              validationIssue(
                itemPath(index, 'status'),
                'E_MULTIPLE_ACTIVE',
                `items[${activeIndex}] is already active; only one item may be active`,
              ),
            );
          } else {
            activeIndex = index;
          }
        }
      }
    });
  }

  if (issues.length > 0) return failResult(issues);
  const contract: TaskContract = { version: 0, items };
  if (template !== undefined) contract.template = template as string;
  return okResult(contract);
}

/** Parse raw `task.json` text, then validate it. */
export function parseTaskContractJson(text: string): Result<TaskContract> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return failResult([validationIssue('', 'E_INVALID_JSON', 'task.json is empty')]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failResult([validationIssue('', 'E_INVALID_JSON', 'task.json is not valid JSON')]);
  }
  return parseTaskContract(parsed);
}

function isRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (value.includes('\u0000')) return false;
  if (value.startsWith('/')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}

/** Validate the evaluator config that is pinned next to the contract. */
export function parseEvaluatorConfig(input: unknown): Result<EvaluatorConfig> {
  if (!isPlainObject(input)) {
    return failResult([validationIssue('', 'E_NOT_OBJECT', 'evaluator config must be an object')]);
  }
  const issues: ValidationIssue[] = [];
  checkUnknownKeys(input, EVALUATOR_KEYS, '', issues);

  if (input['schema'] !== 'oms.evaluator/0') {
    issues.push(validationIssue('schema', 'E_BAD_SCHEMA_TAG', 'schema must be "oms.evaluator/0"'));
  }
  if (typeof input['snapshotDigest'] !== 'string' || !HEX64.test(input['snapshotDigest'])) {
    issues.push(validationIssue('snapshotDigest', 'E_BAD_DIGEST', 'snapshotDigest must be a sha256 hex digest'));
  }

  const codePaths: string[] = [];
  const rawCodePaths = input['codePaths'];
  if (!Array.isArray(rawCodePaths)) {
    issues.push(validationIssue('codePaths', 'E_BAD_CODE_PATHS', 'codePaths must be an array of relative paths'));
  } else if (rawCodePaths.length === 0) {
    issues.push(
      validationIssue(
        'codePaths',
        'E_EMPTY_CODE_PATHS',
        'codePaths must list at least one file so evidence is bound to a code revision',
      ),
    );
  } else {
    const seen = new Set<string>();
    rawCodePaths.forEach((entry, index) => {
      if (!isRelativePath(entry)) {
        issues.push(
          validationIssue(
            `codePaths[${index}]`,
            'E_BAD_CODE_PATHS',
            'codePaths entries must be relative paths without ".."',
          ),
        );
        return;
      }
      if (seen.has(entry)) {
        issues.push(validationIssue(`codePaths[${index}]`, 'E_DUPLICATE_CODE_PATH', `duplicate path "${entry}"`));
        return;
      }
      seen.add(entry);
      codePaths.push(entry);
    });
  }

  for (const key of ['snapshotPath', 'verifierLabel'] as const) {
    const value = input[key];
    if (value !== undefined && !isNonEmptyString(value)) {
      issues.push(validationIssue(key, 'E_BAD_STRING', `${key} must be a non-empty string`));
    }
  }
  if (!isNonEmptyString(input['executionIdentity'])) {
    issues.push(validationIssue('executionIdentity', 'E_BAD_STRING', 'executionIdentity must be a non-empty string'));
  }
  if (input['snapshotPath'] !== undefined && !isRelativePath(input['snapshotPath'])) {
    issues.push(validationIssue('snapshotPath', 'E_BAD_PATH', 'snapshotPath must be relative without ".."'));
  }
  const testTimeoutMs = input['testTimeoutMs'];
  if (
    testTimeoutMs !== undefined &&
    (typeof testTimeoutMs !== 'number' || !Number.isSafeInteger(testTimeoutMs) || testTimeoutMs < 1)
  ) {
    issues.push(validationIssue('testTimeoutMs', 'E_BAD_TIMEOUT', 'testTimeoutMs must be a positive safe integer'));
  }

  if (issues.length > 0) return failResult(issues);
  const config: EvaluatorConfig = {
    schema: 'oms.evaluator/0',
    snapshotDigest: input['snapshotDigest'] as string,
    executionIdentity: input['executionIdentity'] as string,
    codePaths,
  };
  if (input['snapshotPath'] !== undefined) config.snapshotPath = input['snapshotPath'] as string;
  if (input['verifierLabel'] !== undefined) config.verifierLabel = input['verifierLabel'] as string;
  if (testTimeoutMs !== undefined) config.testTimeoutMs = testTimeoutMs as number;
  return okResult(config);
}
