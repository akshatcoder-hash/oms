import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { scrub, injectionLint } from '../src/scrub.ts';
import { securityLint } from '../src/lint/security.ts';
const body = { symptom: 'error', rootCause: 'types', fixPattern: 'use compatible types', avoid: null };
test('vocabulary blocks fresh private identifiers and preserves public terms', () => {
  const vocabulary = new Set(['anchor-lang', 'accountnotinitialized']);
  for (let i = 0; i < 100; i++) {
    const canary = randomBytes(16).toString('hex');
    const result = scrub(`anchor-lang AccountNotInitialized ${canary} '${canary}' https://rpc.invalid/?token=${canary}`, vocabulary);
    assert.ok(result.localOnly);
    assert.ok(!result.text.includes(canary));
    assert.ok(result.text.includes('anchor-lang AccountNotInitialized'));
  }
});
test('injection lint fails closed', () => {
  for (const value of ['</oms-reference>', 'ignore previous instructions', 'invisible\u200btext']) {
    assert.equal(injectionLint(value), false);
    assert.throws(() => scrub(value, new Set()));
  }
});
test('security lint rejects constraint deletion and unchecked accounts', () => {
  for (const diff of ['- account: Signer<\'info>', '- #[account(signer)]', '- has_one = authority', '- owner = program', '- seeds = [seed]', '+ account: UncheckedAccount<\'info>', '+ /// CHECK: trust me', '+ account: AccountInfo<\'info>']) assert.ok(securityLint(diff, body).length, diff);
  assert.deepEqual(securityLint('- let x = 1;\n+ let x = 2;', body), []);
  assert.ok(securityLint('', { ...body, fixPattern: 'remove the signer check' }).length);
});
