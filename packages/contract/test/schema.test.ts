/**
 * Schema validation: the contract shape is small, so every rejection is
 * asserted by path and code. Validation never throws, whatever is thrown at it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEvaluatorConfig, parseTaskContract, parseTaskContractJson } from '../src/schema.ts';
import type { ValidationIssue } from '../src/result.ts';
import type { TaskContract } from '../src/types.ts';
import { baseContract, evaluatorConfig } from '../test-support/fixture.ts';

const VALID_EVIDENCE = {
  itemId: 'item-1',
  specificationDigest: 'e'.repeat(64),
  codeDigest: 'a'.repeat(64),
  verifierDigest: 'b'.repeat(64),
  snapshotDigest: 'c'.repeat(64),
  mode: 'offline-snapshot',
} as const;

const PASSING_EVIDENCE = {
  ...VALID_EVIDENCE,
  passed: true,
  details: 'ok',
  at: '2026-01-01T00:00:00.000Z',
};

function issuesOf(input: unknown): ValidationIssue[] {
  const result = parseTaskContract(input);
  assert.equal(result.ok, false, 'expected the contract to be rejected');
  return result.ok ? [] : result.issues;
}

function findIssue(issues: ValidationIssue[], path: string, code?: string): ValidationIssue {
  const found = issues.find((issue) => issue.path === path && (code === undefined || issue.code === code));
  assert.ok(found, `expected an issue at "${path}"${code ? ` with ${code}` : ''}, got ${JSON.stringify(issues)}`);
  return found;
}

function contractWithItem(patch: Record<string, unknown>): unknown {
  const contract = baseContract();
  return { ...contract, items: [{ ...contract.items[0], ...patch }] };
}

test('a valid contract parses into a normalized value', () => {
  const result = parseTaskContract(baseContract());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.version, 0);
  assert.equal(result.value.template, 'spl-token');
  assert.equal(result.value.items.length, 2);
  assert.deepEqual(result.value.items[0]?.done, [{ kind: 'tests', command: ['npm', 'test'], expect: 'pass' }]);
});

test('a valid contract with every condition kind round-trips', () => {
  const contract: TaskContract = {
    version: 0,
    items: [
      {
        id: 'one',
        title: 'all kinds',
        done: [
          { kind: 'tests', command: ['node', '--test'], expect: 'pass' },
          { kind: 'account', address: '11111111111111111111111111111111', field: 'lamports', equals: '1000' },
          { kind: 'account', address: '11111111111111111111111111111111', field: 'dataLen', equals: '0' },
          { kind: 'account', address: '11111111111111111111111111111111', field: 'tokenAmount', equals: '1500000' },
          { kind: 'tx', description: 'the transfer lands' },
        ],
        status: 'open',
        reopenCount: 0,
      },
    ],
  };
  const result = parseTaskContract(contract);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  if (result.ok) assert.deepEqual(result.value, contract);
});

test('the version is pinned to 0', () => {
  const issues = issuesOf({ ...baseContract(), version: 1 });
  findIssue(issues, 'version', 'E_BAD_VERSION');
});

test('non-object input is rejected without throwing', () => {
  for (const input of [null, undefined, 42, 'contract', [], true]) {
    const result = parseTaskContract(input);
    assert.equal(result.ok, false, `${String(input)} must be rejected`);
    if (!result.ok) assert.equal(result.issues[0]?.code, 'E_NOT_OBJECT');
  }
});

test('unknown fields are rejected so v1 fields cannot be smuggled in', () => {
  const issues = issuesOf({ ...baseContract(), extra: true });
  findIssue(issues, 'extra', 'E_UNKNOWN_FIELD');

  const itemIssue = issuesOf(contractWithItem({ closedBy: 'model' }));
  findIssue(itemIssue, 'items[0].closedBy', 'E_UNKNOWN_FIELD');
});

test('a bad condition reports the precise path', () => {
  const badKind = issuesOf(contractWithItem({ done: [{ kind: 'vibes', expect: 'pass' }] }));
  findIssue(badKind, 'items[0].done[0].kind', 'E_BAD_KIND');

  const badExpect = issuesOf(contractWithItem({ done: [{ kind: 'tests', command: ['npm', 'test'], expect: 'fail' }] }));
  findIssue(badExpect, 'items[0].done[0].expect', 'E_BAD_EXPECT');

  const emptyCommand = issuesOf(contractWithItem({ done: [{ kind: 'tests', command: [], expect: 'pass' }] }));
  findIssue(emptyCommand, 'items[0].done[0].command', 'E_BAD_COMMAND');

  const nonStringArg = issuesOf(contractWithItem({ done: [{ kind: 'tests', command: ['npm', 7], expect: 'pass' }] }));
  findIssue(nonStringArg, 'items[0].done[0].command[1]', 'E_BAD_COMMAND');

  const badAddress = issuesOf(
    contractWithItem({
      done: [{ kind: 'account', address: '0OIl-not-base58', field: 'lamports', equals: '1' }],
    }),
  );
  findIssue(badAddress, 'items[0].done[0].address', 'E_BAD_ADDRESS');

  const badField = issuesOf(
    contractWithItem({
      done: [{ kind: 'account', address: '11111111111111111111111111111111', field: 'balance', equals: '1' }],
    }),
  );
  findIssue(badField, 'items[0].done[0].field', 'E_BAD_FIELD');

  const badLamports = issuesOf(
    contractWithItem({
      done: [{ kind: 'account', address: '11111111111111111111111111111111', field: 'lamports', equals: '1 SOL' }],
    }),
  );
  findIssue(badLamports, 'items[0].done[0].equals', 'E_BAD_EQUALS');

  const badOwner = issuesOf(
    contractWithItem({
      done: [{ kind: 'account', address: '11111111111111111111111111111111', field: 'owner', equals: 'me' }],
    }),
  );
  findIssue(badOwner, 'items[0].done[0].equals', 'E_BAD_EQUALS');

  const noDescription = issuesOf(contractWithItem({ done: [{ kind: 'tx', description: '  ' }] }));
  findIssue(noDescription, 'items[0].done[0].description', 'E_BAD_DESCRIPTION');
});

test('an item needs an id, a title, a status, a reopen count and a done condition', () => {
  findIssue(issuesOf(contractWithItem({ id: '' })), 'items[0].id', 'E_BAD_ITEM_ID');
  findIssue(issuesOf(contractWithItem({ title: '' })), 'items[0].title', 'E_BAD_STRING');
  findIssue(issuesOf(contractWithItem({ status: 'done' })), 'items[0].status', 'E_BAD_STATUS');
  findIssue(issuesOf(contractWithItem({ reopenCount: -1 })), 'items[0].reopenCount', 'E_BAD_REOPEN_COUNT');
  findIssue(issuesOf(contractWithItem({ reopenCount: 1.5 })), 'items[0].reopenCount', 'E_BAD_REOPEN_COUNT');
  findIssue(issuesOf(contractWithItem({ done: [] })), 'items[0].done', 'E_EMPTY_DONE');
  findIssue(issuesOf({ ...baseContract(), items: 'nope' }), 'items', 'E_BAD_TYPE');
});

test('ids must be unique', () => {
  const contract = baseContract();
  const issues = issuesOf({
    ...contract,
    items: [contract.items[0], { ...contract.items[1], id: 'item-1' }],
  });
  findIssue(issues, 'items[1].id', 'E_DUPLICATE_ID');
});

test('at most one item may be active', () => {
  const contract = baseContract();
  const issues = issuesOf({
    ...contract,
    items: [
      { ...contract.items[0], status: 'active' },
      { ...contract.items[1], status: 'active' },
    ],
  });
  findIssue(issues, 'items[1].status', 'E_MULTIPLE_ACTIVE');
});

test('a closed item needs a passing evidence record', () => {
  const missing = issuesOf(contractWithItem({ status: 'closed' }));
  findIssue(missing, 'items[0].evidence', 'E_CLOSED_WITHOUT_EVIDENCE');

  const failed = issuesOf(contractWithItem({ status: 'closed', evidence: { ...PASSING_EVIDENCE, passed: false } }));
  findIssue(failed, 'items[0].evidence', 'E_CLOSED_WITH_FAILED_EVIDENCE');

  const mismatched = issuesOf(
    contractWithItem({ status: 'closed', evidence: { ...PASSING_EVIDENCE, itemId: 'item-9' } }),
  );
  findIssue(mismatched, 'items[0].evidence.itemId', 'E_EVIDENCE_ITEM_MISMATCH');

  const accepted = parseTaskContract(contractWithItem({ status: 'closed', evidence: PASSING_EVIDENCE }));
  assert.equal(accepted.ok, true, JSON.stringify(accepted.ok ? null : accepted.issues));
});

test('evidence on a non-closed item is rejected', () => {
  const issues = issuesOf(contractWithItem({ status: 'active', evidence: PASSING_EVIDENCE }));
  findIssue(issues, 'items[0].evidence', 'E_EVIDENCE_ON_ITEM_NOT_CLOSED');
});

test('a malformed evidence record reports paths inside it', () => {
  const issues = issuesOf(
    contractWithItem({
      status: 'closed',
      evidence: { ...PASSING_EVIDENCE, mode: 'mainnet', codeDigest: 'nope' },
    }),
  );
  findIssue(issues, 'items[0].evidence.mode', 'E_BAD_MODE');
  findIssue(issues, 'items[0].evidence.codeDigest', 'E_BAD_DIGEST');
});

test('task.json text is parsed, and broken text is a validation issue', () => {
  const good = parseTaskContractJson(JSON.stringify(baseContract()));
  assert.equal(good.ok, true);
  for (const text of ['', '   ', '{', '{"version":']) {
    const result = parseTaskContractJson(text);
    assert.equal(result.ok, false, `"${text}" must be rejected`);
    if (!result.ok) assert.equal(result.issues[0]?.code, 'E_INVALID_JSON');
  }
  // Valid JSON with the wrong shape is a shape error, not a parse error.
  for (const text of ['null', '[]']) {
    const result = parseTaskContractJson(text);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.issues[0]?.code, 'E_NOT_OBJECT');
  }
});

test('validation never throws on hostile input', () => {
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let index = 0; index < 50; index += 1) {
    const next: Record<string, unknown> = {};
    cursor['items'] = next;
    cursor = next;
  }
  const inputs: unknown[] = [deep, { items: [null] }, { items: [[]] }, { version: 0, items: [{}] }];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseTaskContract(input));
    assert.equal(parseTaskContract(input).ok, false);
  }
});

test('the evaluator config is validated', () => {
  const valid = parseEvaluatorConfig(evaluatorConfig());
  assert.equal(valid.ok, true);

  const wrongTag = parseEvaluatorConfig({ ...evaluatorConfig(), schema: 'oms.evaluator/1' });
  assert.equal(wrongTag.ok, false);
  if (!wrongTag.ok) findIssue(wrongTag.issues, 'schema', 'E_BAD_SCHEMA_TAG');

  const noSnapshot = parseEvaluatorConfig({ ...evaluatorConfig(), snapshotDigest: 'abc' });
  assert.equal(noSnapshot.ok, false);
  if (!noSnapshot.ok) findIssue(noSnapshot.issues, 'snapshotDigest', 'E_BAD_DIGEST');

  const emptyCode = parseEvaluatorConfig({ ...evaluatorConfig(), codePaths: [] });
  assert.equal(emptyCode.ok, false);
  if (!emptyCode.ok) findIssue(emptyCode.issues, 'codePaths', 'E_EMPTY_CODE_PATHS');

  const traversal = parseEvaluatorConfig({ ...evaluatorConfig(), codePaths: ['../outside.ts'] });
  assert.equal(traversal.ok, false);
  if (!traversal.ok) findIssue(traversal.issues, 'codePaths[0]', 'E_BAD_CODE_PATHS');

  const duplicate = parseEvaluatorConfig({
    ...evaluatorConfig(),
    codePaths: ['src/main.ts', 'src/main.ts'],
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) findIssue(duplicate.issues, 'codePaths[1]', 'E_DUPLICATE_CODE_PATH');

  const unknown = parseEvaluatorConfig({ ...evaluatorConfig(), eval: 'trust me' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) findIssue(unknown.issues, 'eval', 'E_UNKNOWN_FIELD');
});

test('pinned test timeout is a positive safe integer and snapshot paths stay relative', () => {
  assert.equal(parseEvaluatorConfig({ ...evaluatorConfig(), testTimeoutMs: 5000 }).ok, true);
  for (const testTimeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseEvaluatorConfig({ ...evaluatorConfig(), testTimeoutMs }).ok, false);
  }
  for (const snapshotPath of ['../outside.json', '/outside.json']) {
    assert.equal(parseEvaluatorConfig({ ...evaluatorConfig(), snapshotPath }).ok, false);
  }
});

test('execution identity is a non-empty pinned string', () => {
  assert.equal(
    parseEvaluatorConfig({ ...evaluatorConfig(), executionIdentity: 'image:sha256:abc;surfpool:sha256:def' }).ok,
    true,
  );
  assert.equal(parseEvaluatorConfig({ ...evaluatorConfig(), executionIdentity: '' }).ok, false);
});
