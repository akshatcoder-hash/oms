import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionToolNames } from '../src/runtime/session.ts';

test('build-profile sessions allow deps_fetch, others do not', () => {
  assert.ok(sessionToolNames(true, undefined).includes('deps_fetch'));
  assert.ok(!sessionToolNames(false, undefined).includes('deps_fetch'));
  assert.ok(sessionToolNames(undefined, 'head-tail').includes('read_log'));
});
