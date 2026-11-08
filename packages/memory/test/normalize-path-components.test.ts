import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.ts';

test('valid Unicode and punctuation in relative path components cannot survive normalization', () => {
  const expected = normalize('error E0277: failure at /tmp/private/src/lib.rs:42:7', 'build', 'cargo');
  for (const component of ['privé', 'private$tenant', '@private', 'private+tenant', '私有', 'private(tenant)', 'private%tenant']) {
    for (const separator of ['/', '\\']) {
      const result = normalize(`error E0277: failure at ${component}${separator}src${separator}lib.rs:42:7`, 'build', 'cargo');
      assert.equal(result.key, expected.key, component);
      assert.ok(!result.normalized.includes(component));
      assert.deepEqual(normalize(result.normalized, 'build', 'cargo'), result);
    }
  }
});
