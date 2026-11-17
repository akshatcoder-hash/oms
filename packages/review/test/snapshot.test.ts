import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSnapshot, redactReviewText } from '../src/snapshot.ts';

test('snapshot excludes secret files, key arrays and symlinks before any model can read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oms-review-snapshot-'));
  try {
    await mkdir(join(root, 'target/deploy'), { recursive: true });
    await writeFile(join(root, 'target/deploy/x-keypair.json'), JSON.stringify(Array(64).fill(3)));
    await writeFile(join(root, 'ordinary.json'), JSON.stringify(Array(64).fill(4)));
    await writeFile(join(root, '.env.local'), 'SECRET_ENV_MARKER');
    await writeFile(join(root, 'identity.pem'), 'SECRET_PEM_MARKER');
    await symlink('/etc/passwd', join(root, 'outside.rs'));
    await writeFile(join(root, 'lib.rs'), 'pub fn entry() {}\n');
    const snapshot = await captureSnapshot(root);
    assert.deepEqual([...snapshot.inventory().keys()], ['lib.rs']);
    assert.equal(snapshot.excludedFiles, 5);
    for (const path of [
      '../lib.rs',
      '/etc/passwd',
      'outside.rs',
      '.env.local',
      'ordinary.json',
      'target/deploy/x-keypair.json',
    ]) {
      assert.throws(() => snapshot.read(path));
    }
    assert.equal(snapshot.read('lib.rs'), 'pub fn entry() {}\n');
    await writeFile(join(root, 'lib.rs'), 'changed after capture');
    assert.equal(snapshot.read('lib.rs'), 'pub fn entry() {}\n');
    assert.deepEqual(snapshot.grep('entry'), [{ file: 'lib.rs', line: 1, text: 'pub fn entry() {}' }]);
    assert.deepEqual(snapshot.grep('SECRET'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scrubbing removes PEM blocks and 64-byte base58 values but keeps public keys', () => {
  const fakeSecret = '1'.repeat(64);
  const publicKey = '1'.repeat(32);
  assert.equal(redactReviewText(`secret=${fakeSecret}; public=${publicKey}`), `secret=[REDACTED]; public=${publicKey}`);
  assert.equal(
    redactReviewText('before\n-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\nafter'),
    'before\n[REDACTED]\n\n\nafter',
  );
  assert.equal(redactReviewText('-----BEGIN PRIVATE KEY-----\nunfinished'), '[REDACTED]\n');
});

test('snapshot resource limits fail closed instead of pretending review was complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oms-review-limit-'));
  try {
    await writeFile(join(root, 'a.rs'), '123456789');
    const snapshot = await captureSnapshot(root, { fileBytes: 5 });
    assert.equal(snapshot.excludedFiles, 1);
    assert.equal(snapshot.inventory().size, 0);
    await assert.rejects(captureSnapshot(root, { totalBytes: 5 }), /budget exhausted/);
    await assert.rejects(captureSnapshot(root, { fileBytes: -1 }), /Invalid snapshot limits/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('multiline redaction preserves original source line locations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oms-review-lines-'));
  try {
    const source = '/* -----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY----- */\npub fn withdraw() {}\n';
    await writeFile(join(root, 'lib.rs'), source);
    const snapshot = await captureSnapshot(root);
    assert.equal(snapshot.inventory().get('lib.rs'), source.split('\n').length);
    assert.equal(snapshot.grep('withdraw')[0]!.line, 4);
    assert.ok(!snapshot.read('lib.rs').includes('FAKE'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshot capture works on non-Linux hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oms-review-snapshot-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    await writeFile(join(root, 'lib.rs'), 'pub fn entry() {}\n');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    assert.deepEqual([...(await captureSnapshot(root)).inventory().keys()], ['lib.rs']);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    await rm(root, { recursive: true, force: true });
  }
});
