import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.ts';

test('a code-only truncation remains canonical without duplicating its prefix', () => {
  for (const code of ['anchor:3012', 'program:0x1770', 'rustc:E0277', 'ts:2345']) {
    for (const output of [`${code} ${'x'.repeat(300)}`, `${'x'.repeat(300)} ${code}`, code]) {
      const result = normalize(output, 'build', 'other');
      assert.equal(result.code, code);
      assert.deepEqual(normalize(result.normalized, 'build', 'other'), result);
    }
  }
});
