/**
 * Evidence validation and the verifier cache (memory and file backed).
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createVerifierCache,
  evidenceCacheKey,
  parseEvidence,
  type Evidence,
} from '../src/evidence.ts';
import { PathError } from '../src/paths.ts';
import { FIXED_TIME, makeProject } from '../test-support/fixture.ts';

function sampleEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    itemId: 'item-1',
    specificationDigest: 'e'.repeat(64),
    codeDigest: 'a'.repeat(64),
    verifierDigest: 'b'.repeat(64),
    snapshotDigest: 'c'.repeat(64),
    mode: 'offline-snapshot',
    passed: true,
    details: 'verifier passed',
    at: FIXED_TIME.toISOString(),
    ...overrides,
  };
}

test('a well-formed evidence record parses and drops nothing', () => {
  const evidence = sampleEvidence();
  const parsed = parseEvidence(evidence);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, evidence);
});

test('every malformed evidence field is reported with its path', () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ itemId: '' }, 'itemId', 'E_BAD_ITEM_ID'],
    [{ codeDigest: 'xyz' }, 'codeDigest', 'E_BAD_DIGEST'],
    [{ verifierDigest: 42 }, 'verifierDigest', 'E_BAD_DIGEST'],
    [{ mode: 'live' }, 'mode', 'E_BAD_MODE'],
    [{ passed: 'yes' }, 'passed', 'E_BAD_BOOLEAN'],
    [{ details: 3 }, 'details', 'E_BAD_STRING'],
    [{ at: 'yesterday' }, 'at', 'E_BAD_TIMESTAMP'],
    [{ at: '2026-01-01T00:00:00+01:00' }, 'at', 'E_BAD_TIMESTAMP'],
    [{ extra: true }, 'extra', 'E_UNKNOWN_FIELD'],
  ];
  for (const [patch, path, code] of cases) {
    const parsed = parseEvidence({ ...sampleEvidence(), ...patch });
    assert.equal(parsed.ok, false, `${path} must be rejected`);
    if (parsed.ok) continue;
    const issue = parsed.issues.find((entry) => entry.path === path);
    assert.ok(issue, `expected an issue at ${path}: ${JSON.stringify(parsed.issues)}`);
    assert.equal(issue.code, code);
  }
  assert.equal(parseEvidence(null).ok, false);
  assert.equal(parseEvidence([]).ok, false);
});

test('the cache key covers specification, code, verifier and snapshot', () => {
  const key = evidenceCacheKey({
    specificationDigest: 'e'.repeat(64),
    codeDigest: 'a'.repeat(64),
    verifierDigest: 'b'.repeat(64),
    snapshotDigest: 'c'.repeat(64),
  });
  assert.equal(key, `${'e'.repeat(64)}:${'a'.repeat(64)}:${'b'.repeat(64)}:${'c'.repeat(64)}`);
  assert.notEqual(
    key,
    evidenceCacheKey({
      specificationDigest: 'e'.repeat(64),
      codeDigest: 'd'.repeat(64),
      verifierDigest: 'b'.repeat(64),
      snapshotDigest: 'c'.repeat(64),
    }),
  );
  assert.throws(
    () => evidenceCacheKey({ specificationDigest: 'e'.repeat(64), codeDigest: 'nope', verifierDigest: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64) }),
    TypeError,
  );
});

test('the memory cache stores evidence by key', () => {
  const cache = createVerifierCache();
  const key = evidenceCacheKey(sampleEvidence());
  assert.equal(cache.kind, 'memory');
  assert.equal(cache.get(key), undefined);
  cache.set(key, sampleEvidence());
  assert.equal(cache.has(key), true);
  assert.equal(cache.get(key)?.itemId, 'item-1');
  assert.equal(cache.size(), 1);
});

test('a file-backed cache persists across instances and stays outside the root', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const cachePath = join(project.outside, 'cache.json');
  const key = evidenceCacheKey(sampleEvidence());

  const first = createVerifierCache({ path: cachePath, projectRoot: project.root });
  assert.equal(first.kind, 'file');
  first.set(key, sampleEvidence());

  const second = createVerifierCache({ path: cachePath, projectRoot: project.root });
  assert.equal(second.get(key)?.details, 'verifier passed');
  assert.match(readFileSync(cachePath, 'utf8'), /oms\.verifier-cache\/0/);

  assert.throws(
    () => createVerifierCache({ path: join(project.root, 'cache.json'), projectRoot: project.root }),
    (error: unknown) => error instanceof PathError && error.code === 'E_PATH_INSIDE_ROOT',
  );
});

test('a corrupt cache file is treated as empty and rewritten on the next set', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const cachePath = join(project.outside, 'cache.json');
  writeFileSync(cachePath, 'not json');

  const cache = createVerifierCache({ path: cachePath, projectRoot: project.root });
  assert.equal(cache.size(), 0);
  const key = evidenceCacheKey(sampleEvidence());
  cache.set(key, sampleEvidence());
  const reread = createVerifierCache({ path: cachePath, projectRoot: project.root });
  assert.equal(reread.has(key), true);
});
