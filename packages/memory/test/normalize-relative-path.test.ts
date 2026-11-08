import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.ts';

test('relative compiler paths are replaced completely and produce stable signature keys', () => {
  const expected = normalize('error E0277: failure at /tmp/private/src/lib.rs:42:7', 'build', 'cargo');
  let seed = 7819;
  for (let i = 0; i < 100; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    for (const path of [`private${seed}/src/lib.rs`, `./private${seed}/lib.rs`, `../private${seed}/lib.rs`, `private${seed}\\src\\lib.rs`]) {
      const result = normalize(`error E0277: failure at ${path}:${i + 1}:7`, 'build', 'cargo');
      assert.equal(result.key, expected.key, path);
      assert.ok(!result.normalized.includes(`private${seed}`));
      assert.deepEqual(normalize(result.normalized, 'build', 'cargo'), result);
    }
  }
});
