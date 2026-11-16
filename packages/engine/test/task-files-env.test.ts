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

test('with env denial on, .env and .env.<name> are neither readable nor writable, at any depth', async (t) => {
  const root = folder(t);
  const files = createTaskFileAccess(run, root, [], true);
  for (const name of ['.env', '.env.local', '.env.production', 'sub/.env'])
    await assert.rejects(files.read(name), /outside the admitted task files/, name);
  await assert.rejects(files.write('.env.local', Buffer.from('x')), /outside the admitted task files/);
  await assert.rejects(files.create('.env.staging', Buffer.from('x')), /outside the admitted task files/);
  for (const name of ['.env.example', '.env.sample', '.env.template', '.envrc'])
    assert.equal((await files.read(name)).bytes.toString(), `${name}\n`);
});

test('with env denial on, a listing leaves .env files out', async (t) => {
  const root = folder(t);
  const files = createTaskFileAccess(run, root, [], true);
  const listed = (await files.list('.')).map((entry) => entry.path).sort();
  assert.deepEqual(listed, ['.env.example', '.env.sample', '.env.template', '.envrc', 'sub']);
  assert.deepEqual(
    (await files.list('sub')).map((entry) => entry.path),
    [],
  );
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

test('a pinned task keeps .env files readable', async (t) => {
  const root = folder(t);
  const files = createTaskFileAccess(run, root);
  assert.equal((await files.read('.env')).bytes.toString(), '.env\n');
});
