import { setImmediate as nextTurn } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HarnessSession, TaskTerminal } from '@oms/engine';
import { TerminalPane } from '../src/tui/terminal-pane.ts';
import { getTheme } from '../src/tui/theme.ts';
import { barrier } from '../test-support/interface-terminal.ts';
import type { SandboxResult } from '@oms/sandbox';

import { TerminalStoppedError } from '../../engine/src/runtime/task-terminal.ts';
test('terminal stop blocks input before asynchronous cleanup finishes', async () => {
  const exit = barrier<SandboxResult>();
  let closing = false;
  let writes = 0;
  const terminal: TaskTerminal = {
    write() { if (closing) throw new Error('terminal closing'); writes++; },
    resize() {}, subscribe() { return () => {}; }, exited: exit.promise,
    async close() { closing = true; await exit.promise; },
  };
  const harness = { startTerminal: async () => terminal } as Pick<HarnessSession, 'startTerminal'>;
  const pane = new TerminalPane(harness, { theme: () => getTheme('gruvbox')!,
    columns: () => 80, rows: () => 10, render() {}, notice() {} });
  try {
    await pane.start(); pane.focus.focused = true;
    pane.focus.handleInput?.('a'); assert.equal(writes, 1);
    const stopped = pane.stop();
    await Promise.resolve();
    assert.equal(closing, true);
    pane.focus.handleInput?.('b');
    assert.equal(writes, 1);
    exit.resolve({ exitCode: 130, stdout: '', stderr: '', cancelled: true, timedOut: false, truncated: false });
    await stopped;
  } finally {
    exit.resolve({ exitCode: 130, stdout: '', stderr: '', cancelled: true, timedOut: false, truncated: false });
    await pane.dispose();
  }
});

test('resize during natural terminal shutdown stops the pane without ending the application', async () => {
  const exit = barrier<SandboxResult>();
  let stopped = false;
  let writes = 0;
  const terminal: TaskTerminal = {
    write() { if (stopped) throw new TerminalStoppedError(); writes++; },
    resize() { if (stopped) throw new TerminalStoppedError(); },
    subscribe() { return () => {}; }, exited: exit.promise,
    async close() { await exit.promise; },
  };
  const pane = new TerminalPane({ startTerminal: async () => terminal }, {
    theme: () => getTheme('gruvbox')!, columns: () => 80, rows: () => 10, render() {}, notice() {},
  });
  try {
    await pane.start(); pane.focus.focused = true;
    stopped = true;
    pane.focus.render(41);
    pane.focus.handleInput?.('x');
    assert.equal(writes, 0);
  } finally {
    exit.resolve({ exitCode: 0, stdout: '', stderr: '', cancelled: false, timedOut: false, truncated: false });
    await pane.dispose();
  }
});

test('authoritative terminal cleanup failure cannot advertise or attempt a fake retry', async () => {
  const exit = barrier<SandboxResult>();
  const closed = exit.promise.then(() => {});
  let attempts = 0;
  let starts = 0;
  let writes = 0;
  const terminal: TaskTerminal = {
    write() { writes++; }, resize() {}, subscribe: () => () => {}, exited: exit.promise,
    close() { attempts++; return closed; },
  };
  const pane = new TerminalPane({ startTerminal: async () => { starts++; return terminal; } }, {
    theme: () => getTheme('gruvbox')!, columns: () => 40, rows: () => 8, render() {}, notice() {},
  });
  try {
    await pane.start();
    const stopping = pane.stop();
    exit.reject(new Error('authoritative cleanup uncertain'));
    await stopping;
    await nextTurn();
    pane.focus.handleInput?.('not sent');
    assert.equal(writes, 0);
    assert.equal(pane.running, false);
    assert.match(pane.hint, /recover/i);
    assert.doesNotMatch(pane.hint, /retr|Enter start/i);
    await pane.stop(); await pane.start();
    assert.equal(attempts, 1);
    assert.equal(starts, 1);
  } finally { await pane.dispose(); }
});
