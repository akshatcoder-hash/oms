/**
 * The package root must expose the whole public API and no ambiguous
 * star-export collisions (a collision silently drops the symbol).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../src/index.ts';

test('the public API is exported from src/index.ts', () => {
  const functions = [
    'canonicalJson',
    'digestFiles',
    'digestJson',
    'pinContract',
    'verifyPin',
    'refreshPin',
    'readPin',
    'parseEvidence',
    'createVerifierCache',
    'evidenceCacheKey',
    'createEvaluator',
    'createProposer',
    'createContractStore',
    'parseTaskContract',
    'parseTaskContractJson',
    'parseEvaluatorConfig',
    'applyClose',
    'applyPropose',
    'applyReopen',
    'applyActivate',
    'applyFailedRun',
    'activate',
    'readContractFile',
    'writeContractFileAtomic',
    'writeFileAtomic',
    'sha256Hex',
    'digestFileEntries',
    'okResult',
    'failResult',
  ] as const;
  for (const name of functions) {
    assert.equal(typeof api[name], 'function', `${name} must be exported from the package root`);
  }
  const classes = ['PathError', 'DigestError', 'ContractError'] as const;
  for (const name of classes) {
    assert.equal(typeof api[name], 'function', `${name} must be exported from the package root`);
  }
});
