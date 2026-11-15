import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeProgramError, parseErrorCode } from '../src/runtime/error-tables.ts';

test('offline error tables match the pinned upstream names and messages', () => {
  const anchor = decodeProgramError(3012, 'anchor').matches;
  assert.deepEqual(
    anchor.map((m) => [m.name, m.message]),
    [['AccountNotInitialized', 'The program expected this account to be already initialized']],
  );
  assert.equal(
    decodeProgramError(100, 'anchor').matches[0]?.message,
    'Instruction discriminator not provided',
    'Anchor 1.x wording',
  );
  assert.equal(decodeProgramError(1, 'token').matches[0]?.name, 'InsufficientFunds');
  assert.equal(decodeProgramError(0, 'system').matches[0]?.name, 'AccountAlreadyInUse');
  assert.equal(decodeProgramError(0, 'ata').matches[0]?.name, 'InvalidOwner');
  assert.ok(decodeProgramError(40, 'token-2022').matches.length === 1, 'Token-2022 extension codes are covered');
  assert.equal(parseErrorCode('custom program error: 0xbc4'), 3012);
  assert.match(decodeProgramError(6001, undefined).notes.join(' '), /defined by the program itself/);
});
