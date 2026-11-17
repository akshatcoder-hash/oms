import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { resolveChatFolder, scratchNotice } from '../src/runtime/chat-folder.ts';

function setup(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-chat-folder-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const stateRoot = join(home, '.oms');
  const scratchRoot = join(base, 'tmp');
  for (const dir of [home, stateRoot, scratchRoot, join(home, '.ssh'), join(home, 'Library'), join(home, 'work')])
    mkdirSync(dir);
  return { base, home, stateRoot, scratchRoot, options: { stateRoot, home, scratchRoot } };
}

test('a project folder under home is used in place, keyed by its real path', (t) => {
  const { home, options } = setup(t);
  const project = join(home, 'work');
  mkdirSync(join(project, '.git'));
  const folder = resolveChatFolder(project, options);
  assert.equal(folder.path, project);
  assert.equal(folder.scratch, false);
  assert.equal(folder.git, true);
  const link = join(home, 'link');
  symlinkSync(project, link);
  assert.deepEqual(resolveChatFolder(link, options), folder);
  assert.notEqual(resolveChatFolder(join(home, 'Library', '..'), options).key, folder.key);
});

test('folders that are or hold personal or system files open a private scratch folder instead', (t) => {
  const { base, home, stateRoot, scratchRoot, options } = setup(t);
  const unsafe = [home, base, '/', join(home, '.ssh'), join(home, 'Library'), stateRoot, join(home, '.oms')];
  mkdirSync(join(stateRoot, 'folders'));
  unsafe.push(join(stateRoot, 'folders'));
  mkdirSync(join(home, '.ssh', 'keys'));
  unsafe.push(join(home, '.ssh', 'keys'));
  for (const path of unsafe) {
    const folder = resolveChatFolder(path, options);
    assert.equal(folder.scratch, true, path);
    assert.equal(folder.path, join(scratchRoot, 'oms-scratch', folder.key));
    assert.equal(folder.requested, realpathSync(path));
    assert.equal(statSync(folder.path).mode & 0o077, 0);
  }
  assert.match(
    scratchNotice('/tmp/x'),
    /^No project here, so this chat uses a scratch folder \(\/tmp\/x\)\. cd into a project folder and run oms to work on it\.$/,
  );
});

test('a missing folder or a file is refused plainly', (t) => {
  const { home, options } = setup(t);
  assert.throws(() => resolveChatFolder(join(home, 'nope'), options), /not a folder OMS can open/);
  writeFileSync(join(home, 'file.txt'), 'x');
  assert.throws(() => resolveChatFolder(join(home, 'file.txt'), options), /not a folder/);
});
