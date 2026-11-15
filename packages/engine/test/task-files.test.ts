import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildMounts, runInSandbox } from '@oms/sandbox';
import { createTaskFileAccess, MAX_TASK_FILE_BYTES } from '../src/runtime/task-files.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE;

test('shared file access preserves bytes, refuses stale saves and keeps the task boundary', { timeout: 120_000 }, async t => {
  if (await skipUnavailable(t, { docker: [image, forwarderImage] }) || !image || !forwarderImage) return;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-task-files-')));
  const project = join(base, 'project');
  const state = join(base, 'state');
  const signer = join(base, 'signer');
  for (const directory of [project, state, signer]) mkdirSync(directory, { mode: 0o700 });
  const taskName = 'files-' + randomUUID();
  const mounts = buildMounts({ projectRoot: project, taskName, forbidden: { signerDir: signer, stateDir: state }, heavyDirs: [] });
  const files = createTaskFileAccess((argv, signal) => runInSandbox({
    backend: 'docker', taskName, phase: 'run', argv, mounts, image, forwarderImage, timeoutMs: 30_000,
    leaseDir: join(base, 'leases'), sourceControlDir: join(base, 'source-control'),
    surfnet: { port: 9 }, signal,
  }));
  try {
    await t.test('unchanged and changed saves retain exact supported text bytes', async () => {
      const original = Buffer.from('\ufeff\talpha  \r\n界🌱\nlast\t', 'utf8');
      writeFileSync(join(project, 'source.txt'), original);
      const opened = await files.read('source.txt');
      assert.deepEqual(opened.bytes, original);
      assert.equal(opened.revision, createHash('sha256').update(original).digest('hex'));
      await files.write('source.txt', opened.bytes, opened.revision);
      assert.deepEqual(readFileSync(join(project, 'source.txt')), original);
      const changed = Buffer.from('\ufeff\tupdated  \r\n界🌱\nlast\t', 'utf8');
      const revision = await files.write('source.txt', changed, opened.revision);
      assert.deepEqual(readFileSync(join(project, 'source.txt')), changed);
      assert.equal(revision, createHash('sha256').update(changed).digest('hex'));
    });

    await t.test('external edits survive a stale save instead of being overwritten', async () => {
      writeFileSync(join(project, 'conflict.txt'), 'first');
      const opened = await files.read('conflict.txt');
      writeFileSync(join(project, 'conflict.txt'), 'external edit');
      await assert.rejects(files.write('conflict.txt', Buffer.from('stale draft'), opened.revision), /changed|revision/i);
      assert.equal(readFileSync(join(project, 'conflict.txt'), 'utf8'), 'external edit');
    });

    await t.test('new files publish complete UTF-8 bytes atomically without replacing existing names', async () => {
      const bytes = Buffer.from('\ufeff界🌱\r\nnew file\n');
      const revision = await files.create('new.txt', bytes);
      assert.deepEqual(readFileSync(join(project, 'new.txt')), bytes);
      assert.equal(revision, createHash('sha256').update(bytes).digest('hex'));
      await assert.rejects(files.create('new.txt', Buffer.from('replacement')), /exist/i);
      assert.deepEqual(readFileSync(join(project, 'new.txt')), bytes);
      symlinkSync('new.txt', join(project, 'new-alias'));
      await assert.rejects(files.create('new-alias', Buffer.from('replacement')), /exist/i);
      assert.deepEqual(readFileSync(join(project, 'new.txt')), bytes);
      await assert.rejects(files.create('.env.agent', Buffer.from('private')));
      await assert.rejects(files.create('../outside.txt', bytes));
      await assert.rejects(files.create('bad-utf8.txt', Buffer.from([0xff])));
      const controller = new AbortController(); controller.abort();
      await assert.rejects(files.create('cancelled.txt', bytes, controller.signal));
    });

    await t.test('listing navigates task directories without private names or any symlink traversal', async () => {
      mkdirSync(join(project, 'src'));
      mkdirSync(join(project, '.oms'));
      mkdirSync(join(project, '.keys'));
      writeFileSync(join(project, '.env.agent'), 'private');
      writeFileSync(join(project, 'src', '界.ts'), 'export {};');
      symlinkSync('src', join(project, 'src-alias'));
      symlinkSync('.oms', join(project, 'private-alias'));
      symlinkSync('source.txt', join(project, 'file-alias'));
      const root = await files.list();
      assert.ok(root.some(entry => entry.path === 'src' && entry.kind === 'directory'));
      assert.ok(root.some(entry => entry.path === 'source.txt' && entry.kind === 'file'));
      assert.ok(root.every(entry => !['.git', '.oms', '.keys', '.env.agent', 'src-alias', 'private-alias', 'file-alias'].includes(entry.path)));
      assert.deepEqual(await files.list('src'), [{ path: 'src/界.ts', kind: 'file' }]);
      await assert.rejects(files.list('src-alias'), /symlink|directory|ELOOP|ENOTDIR/i);
      await assert.rejects(files.list('private-alias'), /symlink|directory|ELOOP|ENOTDIR/i);
      await assert.rejects(files.list('../outside'));
      await assert.rejects(files.list('.oms'));
      await assert.rejects(files.list('source.txt'));
      const controller = new AbortController(); controller.abort();
      await assert.rejects(files.list('.', controller.signal));
    });

    await t.test('listing refuses oversized directories rather than silently hiding entries', async () => {
      mkdirSync(join(project, 'many'));
      for (let index = 0; index < 513; index++) writeFileSync(join(project, 'many', `${index}.txt`), '');
      await assert.rejects(files.list('many'), /512|limit/i);
    });

    await t.test('control names, outside paths and escaping links are refused', async () => {
      symlinkSync('/etc/passwd', join(project, 'escape'));
      await assert.rejects(files.read('../outside.txt'));
      await assert.rejects(files.read('escape'));
      await assert.rejects(files.write('.env.agent', Buffer.from('forbidden')));
      await assert.rejects(files.write('.git/config', Buffer.from('forbidden')));
      assert.equal(readFileSync(join(project, 'source.txt'), 'utf8'), '\ufeff\tupdated  \r\n界🌱\nlast\t');
    });

    await t.test('oversized, malformed UTF-8 and binary data are refused without mutation', async () => {
      writeFileSync(join(project, 'large.txt'), Buffer.alloc(MAX_TASK_FILE_BYTES + 1, 65));
      writeFileSync(join(project, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0x61]));
      writeFileSync(join(project, 'binary.txt'), Buffer.from([0x61, 0, 0x62]));
      await assert.rejects(files.read('large.txt'));
      await assert.rejects(files.read('invalid.txt'));
      await assert.rejects(files.read('binary.txt'));
      await assert.rejects(files.write('source.txt', Buffer.alloc(MAX_TASK_FILE_BYTES + 1, 65)));
      await assert.rejects(files.write('source.txt', Buffer.from([0xff])));
      assert.equal(readFileSync(join(project, 'source.txt'), 'utf8'), '\ufeff\tupdated  \r\n界🌱\nlast\t');
    });

    await t.test('pre-cancelled operations cannot modify the source', async () => {
      const controller = new AbortController(); controller.abort();
      await assert.rejects(files.write('source.txt', Buffer.from('cancelled'), undefined, controller.signal));
      assert.equal(readFileSync(join(project, 'source.txt'), 'utf8'), '\ufeff\tupdated  \r\n界🌱\nlast\t');
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});
