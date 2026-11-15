/**
 * Canonical JSON and file digests, including the escape cases that matter:
 * traversal, absolute paths, symlinks that leave the root and directories.
 */

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DigestError, canonicalJson, digestFileEntries, digestFiles, digestJson, sha256Hex } from '../src/digest.ts';
import { PathError } from '../src/paths.ts';
import { makeProject } from '../test-support/fixture.ts';

function pathErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PathError) return error.code;
    throw error;
  }
  assert.fail('expected a PathError');
}

test('sha256 matches the known digest of "abc"', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('canonical JSON sorts keys and carries no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.equal(canonicalJson('quote " and \\ backslash'), '"quote \\" and \\\\ backslash"');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson({ ok: true, n: -0.5 }), '{"n":-0.5,"ok":true}');
  // Key order of the input must not change the digest.
  assert.equal(digestJson({ x: 1, y: 2 }), digestJson({ y: 2, x: 1 }));
});

test('canonical JSON rejects values JSON cannot represent', () => {
  assert.throws(() => canonicalJson({ n: Number.NaN }), DigestError);
  assert.throws(() => canonicalJson({ n: Number.POSITIVE_INFINITY }), DigestError);
  assert.throws(() => canonicalJson({ u: undefined }), DigestError);
  assert.throws(() => canonicalJson({ d: new Date() }), DigestError);
  assert.throws(() => canonicalJson({ f: () => 1 }), DigestError);
  assert.throws(() => canonicalJson([undefined]), DigestError);

  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  assert.throws(
    () => canonicalJson(circular),
    (error: unknown) => error instanceof DigestError && error.code === 'E_CIRCULAR',
  );
});

test('digestFiles is order independent and content sensitive', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const one = digestFiles(project.root, ['src/main.ts', 'tests/verifier.test.ts']);
  const two = digestFiles(project.root, ['tests/verifier.test.ts', 'src/main.ts']);
  assert.equal(one.digest, two.digest);
  assert.match(one.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    one.files.map((file) => file.path),
    ['src/main.ts', 'tests/verifier.test.ts'],
  );
  assert.equal(digestFileEntries(one.files), one.digest);

  writeFileSync(project.codePath, 'export const amount = 11;\n');
  const changed = digestFiles(project.root, ['src/main.ts']);
  assert.notEqual(changed.digest, one.digest);
});

test('digestFiles rejects traversal, absolute paths and duplicates', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  writeFileSync(join(project.outside, 'secret.ts'), 'outside\n');

  assert.equal(
    pathErrorCode(() => digestFiles(project.root, ['../outside/secret.ts'])),
    'E_PATH_ESCAPE',
  );
  assert.equal(
    pathErrorCode(() => digestFiles(project.root, ['src/../../outside/secret.ts'])),
    'E_PATH_ESCAPE',
  );
  assert.equal(
    pathErrorCode(() => digestFiles(project.root, [project.codePath])),
    'E_ABSOLUTE_PATH',
  );
  assert.equal(
    pathErrorCode(() => digestFiles(project.root, [''])),
    'E_BAD_PATH',
  );
  assert.equal(
    pathErrorCode(() => digestFiles(project.root, ['src/main.ts', './src/main.ts'])),
    'E_DUPLICATE_PATH',
  );
  assert.equal(
    pathErrorCode(() => digestFiles(project.root, ['src'])),
    'E_NOT_A_FILE',
  );
  assert.equal(
    pathErrorCode(() => digestFiles(project.root, ['src/missing.ts'])),
    'E_NOT_FOUND',
  );
});

test('a symlink that leaves the root is rejected', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  writeFileSync(join(project.outside, 'secret.ts'), 'outside\n');

  // File symlink pointing outside the root.
  symlinkSync(join(project.outside, 'secret.ts'), join(project.root, 'tests', 'evil.test.ts'));
  assert.equal(
    pathErrorCode(() => digestFiles(project.root, ['tests/evil.test.ts'])),
    'E_SYMLINK_ESCAPE',
  );

  // Ancestor directory symlink pointing outside the root.
  symlinkSync(project.outside, join(project.root, 'escape'));
  assert.equal(
    pathErrorCode(() => digestFiles(project.root, ['escape/secret.ts'])),
    'E_SYMLINK_ESCAPE',
  );

  // A symlink that stays inside the root is fine and hashes the target content.
  mkdirSync(join(project.root, 'src', 'nested'));
  writeFileSync(join(project.root, 'src', 'nested', 'x.ts'), 'nested\n');
  symlinkSync(join(project.root, 'src', 'nested', 'x.ts'), join(project.root, 'src', 'link.ts'));
  const inside = digestFiles(project.root, ['src/link.ts']);
  const nested = digestFiles(project.root, ['src/nested/x.ts']);
  assert.equal(inside.files[0]?.digest, nested.files[0]?.digest);
});
