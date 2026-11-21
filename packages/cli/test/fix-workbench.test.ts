import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TaskFileAccess } from '@oms/engine';
import { chatFixture, fixture, type FakeSession } from '../test-support/fake-session.ts';
import { runOmsInterface } from '../src/tui/interface.ts';
import { InterfaceTerminal } from '../test-support/interface-terminal.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
/** A project on disk (a real folder, so quick open and search can use git and ripgrep) behind the task-files interface. */
function project(initial: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'oms-ide-'));
  const disk = new Map<string, string>();
  const put = (name: string, text: string) => {
    disk.set(name, text);
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  for (const [name, text] of Object.entries(initial)) put(name, text);
  const listed: string[] = [];
  const files: TaskFileAccess = {
    async list(path = '.') {
      listed.push(path);
      const prefix = path === '.' ? '' : path + '/';
      const entries = new Map<string, 'file' | 'directory'>();
      for (const key of disk.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        entries.set(prefix + rest.split('/')[0]!, rest.includes('/') ? 'directory' : 'file');
      }
      return [...entries].map(([path, kind]) => ({ path, kind }));
    },
    async read(path) {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${root}/${path}'`);
      return { bytes: Buffer.from(text), revision: digest(text) };
    },
    async write(path, bytes, revision) {
      if (revision !== digest(disk.get(path) ?? '')) throw new Error('file changed after the edit read');
      const text = Buffer.from(bytes).toString('utf8');
      put(path, text);
      return digest(text);
    },
    async create(path, bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      put(path, text);
      return digest(text);
    },
    async access() {},
    async makeDirectory() {},
  };
  return { root, disk, put, files, listed, done: () => rmSync(root, { recursive: true, force: true }) };
}
function open(
  f: FakeSession,
  p: ReturnType<typeof project>,
  columns: number,
  rows: number,
  kind: 'task' | 'chat' = 'task',
) {
  const session = kind === 'chat' ? chatFixture() : f;
  Object.assign(session.harness, { files: p.files, root: p.root });
  if (kind === 'task') Object.assign((session.harness as unknown as { task: object }).task, { codeRoot: p.root });
  const terminal = new InterfaceTerminal(columns, rows);
  const run = runOmsInterface(session.harness, { terminal, view: 'workbench' });
  // A failing test may leave unsaved files: the second Ctrl+Q confirms the discard so the run always ends.
  const done = async () => {
    terminal.send('\x11');
    const timer = setTimeout(() => terminal.send('\x11'), 300);
    try {
      await run;
    } finally {
      clearTimeout(timer);
      terminal.vt.dispose();
    }
  };
  return { session, terminal, run, done };
}
const SOURCE = Array.from({ length: 60 }, (_, n) => `line ${n + 1}`).join('\n');
const key = { f6: '\x1b[17~', ctrlB: '\x02', altJ: '\x1bj' };

test('80 columns: with the explorer over the editor, F6 and typing never reach the hidden editor', async () => {
  const p = project({ 'README.md': 'hello', 'src/lib.rs': SOURCE });
  const { terminal, done } = open(fixture(), p, 80, 30, 'chat');
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send('\x10');
    terminal.send('README');
    terminal.send('\r');
    await terminal.until((s) => s.includes('hello'));
    terminal.send(key.ctrlB);
    await terminal.until((s) => s.includes('▾ files'));
    terminal.send(key.f6);
    // The only other place for keys is the composer, which is drawn: the editor underneath is skipped.
    terminal.send('zzz');
    const screen = await terminal.until((s) => s.includes('❯ zzz'));
    assert.doesNotMatch(screen, /●/, 'nothing in the open list is marked unsaved');
    terminal.send('\x01');
    terminal.send('\x7f');
    terminal.send(key.f6);
    terminal.send(key.ctrlB);
    const back = await terminal.until((s) => s.includes('hello') && !s.includes('▾ files'));
    assert.doesNotMatch(back, /zzz|●/, 'the editor was not edited while it was hidden');
    assert.equal(p.disk.get('README.md'), 'hello');
  } finally {
    await done();
    p.done();
  }
});

test('narrowing the window below 100 columns while the editor has focus does not leave typing in a hidden buffer', async () => {
  const p = project({ 'README.md': 'hello', 'src/lib.rs': SOURCE });
  const { terminal, done } = open(fixture(), p, 120, 30, 'chat');
  try {
    await terminal.until((screen) => screen.includes('▾ files'));
    terminal.send(key.ctrlB);
    await terminal.until((s) => !s.includes('▾ files'));
    terminal.send(key.ctrlB);
    await terminal.until((s) => s.includes('▾ files'));
    terminal.send('\x10');
    terminal.send('README');
    terminal.send('\r');
    await terminal.until((s) => s.includes('hello'));
    terminal.setSize(90, 30);
    // At 90 columns the explorer (pinned open) covers the whole editor area.
    await terminal.until((s) => s.includes('▾ files') && !s.includes('1 hello'));
    terminal.send('QQQ');
    await terminal.screen();
    terminal.setSize(120, 30);
    const screen = await terminal.until((s) => s.includes('hello'));
    assert.doesNotMatch(screen, /QQQ/, 'the keys did not go to the editor while the explorer covered it');
  } finally {
    await done();
    p.done();
  }
});

test('on a 15-row terminal an open panel takes the body, and F6 stays on what is drawn', async () => {
  const p = project({ 'README.md': 'hello' });
  const { terminal, done } = open(fixture(), p, 100, 15, 'chat');
  try {
    await terminal.until((screen) => screen.includes('No file open'));
    terminal.send(key.altJ);
    await terminal.until((s) => /terminal\s+problems\s+output/.test(s) && !s.includes('No file open'));
    for (let press = 0; press < 4; press++) {
      terminal.send(key.f6);
      const screen = await terminal.screen();
      const hints = screen.split('\n').at(-1)!;
      assert.doesNotMatch(screen, /No file open/);
      assert.doesNotMatch(
        hints,
        /↑↓ move · enter open|ctrl\+s save|space preview|^ *ctrl\+k commands · ctrl\+p open/,
        `F6 ${press + 1} stopped on a hidden area`,
      );
    }
  } finally {
    await done();
    p.done();
  }
});
