import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildMounts, createSandboxSession } from '@oms/sandbox';
import { createTaskFileAccess, MAX_TASK_FILE_BYTES } from '../src/runtime/task-files.ts';
import { Daemon, IMAGE } from '../../sandbox/test-support/daemon.ts';

/** The daemon double runs the file helper with the host's node, standing in for the container. */
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-task-files-session-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  for (const directory of [project, outside, join(project, '.oms', 'verify'), join(project, '.git')])
    mkdirSync(directory, { recursive: true });
  const daemon = new Daemon();
  daemon.onExec = async (_container, argv, capture) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', capture.stdout);
      child.stderr.on('data', capture.stderr);
      child.once('close', (code) => resolve(code ?? 1));
    });
  const session = createSandboxSession(
    {
      taskName: 'files-session',
      image: IMAGE,
      forwarderImage: IMAGE,
      leaseDir: join(base, 'leases'),
      sourceControlDir: join(base, 'control'),
      surfnet: { port: 8899 },
      mounts: buildMounts({ taskName: 'files-session', projectRoot: project }),
    },
    daemon,
  );
  t.after(() => session.close());
  const pinned = join(project, '.oms', 'verify', 'verifier.test.ts');
  writeFileSync(pinned, 'pinned\n');
  const files = createTaskFileAccess((argv, signal) => session.exec(argv, { signal, timeoutMs: 30_000 }), project, [
    pinned,
  ]);
  return { project, outside, daemon, files, pinned };
}

test('read, edit and write go through one long-lived container and keep exact bytes and revisions', async (t) => {
  const { project, daemon, files } = fixture(t);
  writeFileSync(join(project, 'a.txt'), '﻿\tkeep  \r\n界\n');
  const opened = await files.read('a.txt');
  const revision = await files.write('a.txt', Buffer.from('changed\n'), opened.revision);
  assert.equal(readFileSync(join(project, 'a.txt'), 'utf8'), 'changed\n');
  await assert.rejects(files.write('a.txt', Buffer.from('stale\n'), opened.revision), /changed|revision/i);
  assert.equal(
    await files.create('b.txt', Buffer.from('new\n')).then(() => readFileSync(join(project, 'b.txt'), 'utf8')),
    'new\n',
  );
  await assert.rejects(files.create('b.txt', Buffer.from('again\n')), /already exists/i);
  assert.equal(revision.length, 64);
  assert.equal(daemon.execs.length, 5);
  assert.equal(new Set(daemon.execs.map((entry) => entry.container.Id)).size, 1);
  assert.equal([...daemon.containers.values()].filter((c) => c.args.includes('sleep')).length, 1);
});

test('private and control names stay unavailable for every operation', async (t) => {
  const { project, files } = fixture(t);
  for (const name of ['.env.agent', '.keys/id', '.oms/state', '.git/config']) {
    mkdirSync(join(project, name, '..'), { recursive: true });
    writeFileSync(join(project, name), 'secret');
    await assert.rejects(files.read(name), /outside the admitted|private/i, `read ${name}`);
    await assert.rejects(files.write(name, Buffer.from('x')), /outside the admitted|private/i, `write ${name}`);
    await assert.rejects(
      files.create(name + '/child', Buffer.from('x')),
      /outside the admitted|private/i,
      `create ${name}`,
    );
    assert.equal(readFileSync(join(project, name), 'utf8'), 'secret');
  }
});

test('pinned verifier files and their ancestors are read-only; other files stay writable', async (t) => {
  const { project, files, pinned } = fixture(t);
  await assert.rejects(
    files.write('.oms/verify/verifier.test.ts', Buffer.from('evil')),
    /outside the admitted|pinned|private/i,
  );
  await assert.rejects(
    files.write('x.txt', Buffer.from('ok')).then(() => files.makeDirectory('.oms/verify')),
    /outside the admitted|pinned|private/i,
  );
  assert.equal(readFileSync(pinned, 'utf8'), 'pinned\n');
  await files.write('plain.txt', Buffer.from('fine\n'));
  assert.equal(readFileSync(join(project, 'plain.txt'), 'utf8'), 'fine\n');
});

test('symlinks cannot reach outside the task, for reads, writes or directory creation', async (t) => {
  const { project, outside, files } = fixture(t);
  writeFileSync(join(outside, 'host-secret.txt'), 'HOST SECRET');
  symlinkSync(join(outside, 'host-secret.txt'), join(project, 'leak.txt'));
  symlinkSync(outside, join(project, 'escape'));
  await assert.rejects(files.read('leak.txt'));
  await assert.rejects(files.read('escape/host-secret.txt'), /escapes the task/i);
  await assert.rejects(files.write('escape/planted.txt', Buffer.from('x')), /escapes the task/i);
  await assert.rejects(files.makeDirectory('escape/new'), /escapes the task/i);
  assert.equal(readFileSync(join(outside, 'host-secret.txt'), 'utf8'), 'HOST SECRET');
  assert.throws(() => readFileSync(join(outside, 'planted.txt')));
  await assert.rejects(files.read('../outside/host-secret.txt'), /limited to the selected task/i);
});

test('the 64 KiB and text-only limits hold on the new path', async (t) => {
  const { files } = fixture(t);
  await assert.rejects(files.write('big.txt', Buffer.alloc(MAX_TASK_FILE_BYTES + 1, 97)), /64 KiB/);
  await assert.rejects(files.write('bin.txt', Buffer.from([0, 1, 2])), /Binary/);
});

test('a cancelled file operation is reported and leaves the session usable', async (t) => {
  const { daemon, files } = fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(files.read('a.txt', controller.signal));
  assert.equal(daemon.execs.length, 0);
  await files.write('after.txt', Buffer.from('ok\n'));
});
