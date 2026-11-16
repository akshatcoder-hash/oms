import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createTaskFileAccess, type TaskFileExecutor } from '../src/runtime/task-files.ts';

const run: TaskFileExecutor = (argv) =>
  new Promise((resolve) => {
    execFile(process.execPath, argv.slice(1), { encoding: 'utf8' }, (error, stdout, stderr) =>
      resolve({
        exitCode: error ? 1 : 0,
        stdout,
        stderr,
        truncated: false,
        timedOut: false,
        cancelled: false,
      }),
    );
  });

function folder(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oms-task-env-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'sub'));
  for (const name of [
    '.env',
    '.env.local',
    '.env.production',
    '.env.example',
    '.env.sample',
    '.env.template',
    '.envrc',
  ])
    writeFileSync(join(root, name), `${name}\n`);
  writeFileSync(join(root, 'sub', '.env'), 'nested\n');
  return root;
}

test('.env and .env.<name> are readable, writable and listed at any depth', async (t) => {
  const root = folder(t);
  const files = createTaskFileAccess(run, root);
  for (const name of ['.env', '.env.local', '.env.production', 'sub/.env'])
    assert.ok((await files.read(name)).bytes.length > 0, name);
  await files.write('.env.local', Buffer.from('x'));
  await files.create('.env.staging', Buffer.from('x'));
  const listed = (await files.list('.')).map((entry) => entry.path);
  assert.ok(listed.includes('.env') && listed.includes('.env.local') && listed.includes('.env.staging'));
  assert.deepEqual(
    (await files.list('sub')).map((entry) => entry.path),
    ['sub/.env'],
  );
});

test('the broker-only .env.agent stays out of reach', async (t) => {
  const root = folder(t);
  writeFileSync(join(root, '.env.agent'), 'K=v\n');
  const files = createTaskFileAccess(run, root);
  await assert.rejects(files.read('.env.agent'), /outside the admitted task files/);
});

test('a listing follows no symlink, whether the link is the folder or one of its parents', async (t) => {
  const root = folder(t);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'oms-task-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(outside, 'deep'));
  writeFileSync(join(outside, 'deep', 'secret.txt'), 'x');
  symlinkSync(outside, join(root, 'link'));
  symlinkSync(join(root, 'sub'), join(root, 'sub-alias'));
  const files = createTaskFileAccess(run, root);
  await assert.rejects(files.list('link'), /symlink|directory|ELOOP|ENOTDIR/i);
  await assert.rejects(files.list('link/deep'), /symlink|directory|ELOOP|ENOTDIR/i);
  await assert.rejects(files.list('sub-alias'), /symlink|directory|ELOOP|ENOTDIR/i);
  assert.ok(!(await files.list('.')).some((entry) => entry.path === 'link'), 'a symlink is not listed');
});
