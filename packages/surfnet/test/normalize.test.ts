import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeError } from '../src/normalize.ts';

// Fixtures captured from Surfpool 1.7.0 by probing a live offline surfnet
// (see README.md, "Error fixtures"). Fields not relevant to normalization
// are trimmed.
const FIXTURES = {
  missingFieldScope: {
    message: 'Invalid params: missing field `scope`.',
    code: -32602,
  },
  accountNotFound: {
    message: 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.',
    code: -32002,
    data: { err: 'AccountNotFound', logs: [], unitsConsumed: 0 },
  },
  blockhashNotFound: {
    message: 'Transaction simulation failed: Blockhash not found',
    code: -32002,
    data: { err: 'BlockhashNotFound', logs: [], unitsConsumed: 0 },
  },
  insufficientFundsForRent: {
    message:
      'Transaction simulation failed: Transaction results in an account (1) with insufficient funds for rent: 2 log messages:\nProgram 11111111111111111111111111111111 invoke [1]\nProgram 11111111111111111111111111111111 success',
    code: -32002,
    data: { err: { InsufficientFundsForRent: { account_index: 1 } }, logs: [] },
  },
  programNotDeployed: {
    message: 'Transaction simulation failed: InvalidProgramForExecution',
    code: -32002,
    data: { err: 'InvalidProgramForExecution', logs: [], unitsConsumed: 0 },
  },
  invalidPubkey: {
    message: "Invalid pubkey 'notapubkey'",
    code: -32602,
    data: 'String is the wrong size',
  },
  invalidTuple: {
    message: 'Invalid params: invalid length 1, expected a tuple of size 2.',
    code: -32602,
  },
  methodNotFound: {
    message: 'Method not found',
    code: -32601,
  },
} as const;

test('serde missing-field family normalizes with the field named (fixture: missing field `scope`)', () => {
  const e = normalizeError(FIXTURES.missingFieldScope);
  assert.equal(e.code, 'missing-field');
  assert.match(e.summary, /`scope`/);
  assert.match(e.hint, /request shape/i);
  assert.equal(e.raw, 'Invalid params: missing field `scope`.');
});

test('missing field data maps to missing-field (exact 1.7.0 trigger UNVERIFIED, string match kept)', () => {
  // UNVERIFIED on 1.7.0: issue #350's `missing field data` panic is fixed;
  // surfnet_setAccount now silently defaults a missing `data` (verified by
  // probing). The mapping is kept for the serde family and older versions.
  const e = normalizeError({
    message: 'Result::unwrap() on Err: Error("missing field `data`", line: 0, column: 0)',
  });
  assert.equal(e.code, 'missing-field');
  assert.match(e.summary, /`data`/);
});

test('account-not-found: unfunded fee payer (fixture)', () => {
  const e = normalizeError(FIXTURES.accountNotFound);
  assert.equal(e.code, 'account-not-found');
  assert.match(e.hint, /surfnet_setAccount/);
});

test('blockhash-not-found (fixture)', () => {
  const e = normalizeError(FIXTURES.blockhashNotFound);
  assert.equal(e.code, 'blockhash-not-found');
  assert.match(e.hint, /preflightCommitment/);
});

test('insufficient funds / rent (fixture)', () => {
  const e = normalizeError(FIXTURES.insufficientFundsForRent);
  assert.equal(e.code, 'insufficient-funds');
  assert.match(e.summary, /rent-exempt/);
});

test('program-not-deployed (fixture: InvalidProgramForExecution)', () => {
  const e = normalizeError(FIXTURES.programNotDeployed);
  assert.equal(e.code, 'program-not-deployed');
});

test('invalid params: bad pubkey and short tuple (fixtures)', () => {
  assert.equal(normalizeError(FIXTURES.invalidPubkey).code, 'invalid-params');
  assert.equal(normalizeError(FIXTURES.invalidTuple).code, 'invalid-params');
});

test('method-not-found (fixture)', () => {
  const e = normalizeError(FIXTURES.methodNotFound);
  assert.equal(e.code, 'method-not-found');
});

test('unknown errors pass through with the raw text kept', () => {
  const raw = 'surfwasm exploded in a novel way';
  const e = normalizeError({ message: raw, code: -32000 });
  assert.equal(e.code, 'unknown');
  assert.equal(e.raw, raw);
  assert.equal(e.summary, raw);
});

test('object-form err kinds inside message text are also caught', () => {
  const e = normalizeError({
    message: 'Transaction simulation failed: Blockhash not found',
    data: { err: { SomeNewErrorShape: {} } },
  });
  // The err key alone is not enough for unknown kinds; the message text is.
  assert.equal(e.code, 'blockhash-not-found');
});
