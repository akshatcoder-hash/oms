import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { acquireMutationLease, inspectMutationLease, WorkspaceError, type HarnessSession, type HarnessSessionOptions, type MutationLease } from '@oms/engine';
import { openHarnessWithOwnership, ownershipScreenLines, type OwnershipPrompt } from '../src/ownership.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'oms-ownership-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'mutation.lease');
  const options = { workspace: { root: '/fixtures/ledger\x1b]2;unsafe-title\x07\nforged' },
    task: { id: 'welcome\x1b[2J', leaseFile: file } } as HarnessSessionOptions;
  const lease = acquireMutationLease(file);
  const opened = {} as HarnessSession;
  let starts = 0;
  const start = async () => { starts++; const next = acquireMutationLease(file); next.release(); return opened; };
  return { file, options, lease, opened, start, starts: () => starts };
}

function prompt(choose: OwnershipPrompt['choose'], confirmStop: OwnershipPrompt['confirmStop'] = async () => false): OwnershipPrompt {
  return { choose, confirmStop, close() {} };
}

test('duplicate launch does not signal automatically and cancellation leaves the existing owner unchanged', async t => {
  const f = fixture(t);
  const before = readFileSync(f.file, 'utf8');
  let signals = 0;
  const result = await openHarnessWithOwnership(f.options, {
    start: f.start, stop: async () => { signals++; return 'released'; },
    prompt: prompt(async screen => {
      assert.equal(screen.status, 'live');
      const text = ownershipScreenLines(screen).join('\n');
      assert.match(text, /Return to the existing window/);
      assert.doesNotMatch(text, /\x1b|\x07|token|pid|kill|unsafe-title/);
      assert.ok(!text.includes(f.lease.token));
      return 'cancel';
    }),
  });
  assert.equal(result, undefined);
  assert.equal(signals, 0);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(f.starts(), 0);
  f.lease.release();
});

test('a cancelled discard confirmation returns to choices without signaling', async t => {
  const f = fixture(t);
  let choices = 0;
  let confirmations = 0;
  let signals = 0;
  await openHarnessWithOwnership(f.options, { start: f.start,
    stop: async () => { signals++; return 'released'; },
    prompt: prompt(async () => ++choices === 1 ? 'stop' : 'cancel', async screen => {
      confirmations++;
      assert.equal(screen.status, 'live');
      return false;
    }),
  });
  assert.equal(confirmations, 1);
  assert.equal(signals, 0);
  f.lease.release();
});

test('retry uses existing startup only after the previous owner releases its lease', async t => {
  const f = fixture(t);
  const result = await openHarnessWithOwnership(f.options, { start: f.start,
    prompt: prompt(async () => { f.lease.release(); return 'retry'; }),
  });
  assert.equal(result, f.opened);
  assert.equal(f.starts(), 1);
});

test('confirmed stop passes the exact observed owner and starts only after release', async t => {
  const f = fixture(t);
  const result = await openHarnessWithOwnership(f.options, { start: f.start,
    prompt: prompt(async () => 'stop', async () => true),
    stop: async (file, owner) => {
      assert.equal(file, f.file); assert.equal(owner.token, f.lease.token);
      f.lease.release(); return 'released';
    },
  });
  assert.equal(result, f.opened);
});

test('changed ownership and bounded stop refusals return to choices without retrying startup', async t => {
  for (const failure of ['changed', 'timed-out'] as const) {
    const f = fixture(t);
    let choices = 0;
    await openHarnessWithOwnership(f.options, { start: f.start,
      prompt: prompt(async screen => {
        if (++choices === 1) return 'stop';
        assert.match(screen.notice ?? '', failure === 'changed' ? /changed/ : /still running/);
        return 'cancel';
      }, async () => true),
      stop: async () => {
        if (failure === 'changed') throw new WorkspaceError('LEASE_OWNERSHIP_LOST', 'private nonce \x1b[2J');
        return 'timed-out';
      },
    });
    assert.equal(f.starts(), 0);
    f.lease.release();
  }
});

test('a stale owner from a closed terminal is recovered once without asking, then the task opens', async t => {
  const f = fixture(t);
  const record = JSON.parse(readFileSync(f.file, 'utf8'));
  f.lease.release();
  writeFileSync(f.file, JSON.stringify({ ...record, start: 'exited-owner' }), { mode: 0o600 });
  let recoveries = 0;
  let signals = 0;
  const result = await openHarnessWithOwnership(f.options, { start: f.start,
    stop: async () => { signals++; return 'released'; },
    recover: async (_workspace, _task, expected) => { recoveries++; assert.equal(expected.token, record.token); rmSync(f.file); },
    prompt: prompt(async () => assert.fail('no choice is needed when recovery verifies cleanup')),
  });
  assert.equal(result, f.opened);
  assert.equal(recoveries, 1);
  assert.equal(signals, 0);
});

test('when automatic recovery cannot verify cleanup, the stale choices show why and nothing is deleted', async t => {
  const f = fixture(t);
  const record = JSON.parse(readFileSync(f.file, 'utf8'));
  f.lease.release();
  writeFileSync(f.file, JSON.stringify({ ...record, start: 'exited-owner' }), { mode: 0o600 });
  let recoveries = 0;
  await openHarnessWithOwnership(f.options, { start: f.start,
    recover: async () => { recoveries++; throw new WorkspaceError('RECOVERY_PROCESS_RUNNING', 'private detail'); },
    prompt: prompt(async screen => {
      assert.equal(screen.status, 'stale'); assert.equal(screen.canStop, false);
      assert.match(screen.notice ?? '', /did not stop gracefully/);
      assert.match(ownershipScreenLines(screen).join(' '), /Recover saved workspace/);
      return 'cancel';
    }),
  });
  assert.equal(recoveries, 1);
  assert.equal(f.starts(), 0);
  assert.equal(inspectMutationLease(f.file).status, 'stale');
});

test('explicit recovery passes the exact owner and opens only after verified cleanup', async t => {
  const f = fixture(t);
  const record = JSON.parse(readFileSync(f.file, 'utf8'));
  f.lease.release();
  writeFileSync(f.file, JSON.stringify({ ...record, start: 'exited-owner' }), { mode: 0o600 });
  let recovered = false;
  const result = await openHarnessWithOwnership(f.options, {
    start: async () => { assert.ok(recovered); return f.start(); },
    recover: async (workspace, task, expected) => {
      assert.equal(workspace, f.options.workspace);
      assert.equal(task, f.options.task);
      assert.equal(expected.token, record.token);
      rmSync(f.file);
      recovered = true;
    },
    prompt: prompt(async () => 'recover'),
  });
  assert.equal(result, f.opened);
});

test('failed recovery stays closed and gives a specific safe next step', async t => {
  const f = fixture(t);
  const record = JSON.parse(readFileSync(f.file, 'utf8'));
  f.lease.release();
  writeFileSync(f.file, JSON.stringify({ ...record, start: 'exited-owner' }), { mode: 0o600 });
  let choices = 0;
  await openHarnessWithOwnership(f.options, {
    start: f.start,
    recover: async () => { throw new WorkspaceError('RECOVERY_DOCKER_UNAVAILABLE', 'untrusted private nonce'); },
    prompt: prompt(async screen => {
      if (++choices === 1) return 'recover';
      assert.match(screen.notice ?? '', /Docker/);
      assert.doesNotMatch(screen.notice ?? '', /nonce|untrusted/);
      return 'cancel';
    }),
  });
  assert.equal(f.starts(), 0);
  assert.equal(inspectMutationLease(f.file).status, 'stale');
});

test('unverifiable records expose only safe retry and cancel choices', async t => {
  const f = fixture(t);
  f.lease.release();
  writeFileSync(f.file, '{"token":"private-sentinel"}', { mode: 0o600 });
  await openHarnessWithOwnership(f.options, { start: f.start, prompt: prompt(async screen => {
    assert.equal(screen.status, 'unverifiable'); assert.equal(screen.canStop, false);
    assert.doesNotMatch(ownershipScreenLines(screen).join(' '), /private-sentinel|Stop the previous/);
    return 'cancel';
  }) });
});

test('non-ownership startup failures retain the existing error path', async t => {
  const f = fixture(t);
  f.lease.release();
  await assert.rejects(openHarnessWithOwnership(f.options, {
    start: async () => { throw new Error('invalid pin'); },
    prompt: prompt(async () => { throw new Error('must not prompt'); }),
  }), /invalid pin/);
});

test('ownership changing during confirmation is revalidated by the real stop boundary', async t => {
  const f = fixture(t);
  const record = JSON.parse(readFileSync(f.file, 'utf8'));
  let choices = 0;
  await openHarnessWithOwnership(f.options, { start: f.start,
    prompt: prompt(async screen => {
      if (++choices === 1) return 'stop';
      assert.match(screen.notice ?? '', /ownership changed/);
      return 'cancel';
    }, async () => {
      writeFileSync(f.file, JSON.stringify({ ...record, token: 'replacement-owner' }));
      return true;
    }),
  });
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).token, 'replacement-owner');
  assert.equal(f.starts(), 0);
});

test('preopen session decisions run only after ownership has been released', async t => {
  const f = fixture(t);
  let preparations = 0;
  const result = await openHarnessWithOwnership(f.options, { start: f.start,
    beforeOpen: async options => {
      preparations++;
      assert.equal(inspectMutationLease(f.file).status, 'absent');
      return options;
    },
    prompt: prompt(async () => {
      assert.equal(preparations, 0);
      f.lease.release();
      return 'retry';
    }),
  });
  assert.equal(result, f.opened);
  assert.equal(preparations, 1);
});

test('a cancelled preopen session decision does not create a runtime', async t => {
  const f = fixture(t);
  f.lease.release();
  assert.equal(await openHarnessWithOwnership(f.options, {
    start: f.start, beforeOpen: async () => undefined,
  }), undefined);
  assert.equal(f.starts(), 0);
});

test('acquisition races still enter ownership choices after an absent preflight', async t => {
  const f = fixture(t);
  f.lease.release();
  let competing: MutationLease | undefined;
  await openHarnessWithOwnership(f.options, {
    start: async () => {
      competing = acquireMutationLease(f.file);
      throw new WorkspaceError('LEASE_BUSY', 'private owner token');
    },
    prompt: prompt(async screen => { assert.equal(screen.status, 'live'); return 'cancel'; }),
  });
  competing?.release();
});

test('shared startup choices sanitize context and default to cancellation', () => {
  const module = new URL('../src/ownership.ts', import.meta.url).href;
  const source = `
    import { chooseLocalAction } from ${JSON.stringify(module)};
    const choice = await chooseLocalAction('Saved session\\x1b]2;hidden-title\\x07', [
      {value:'continue',label:'Continue saved session'}, {value:'new',label:'New session'}
    ]);
    console.log('RESULT=' + String(choice));
  `;
  for (const [input, expected] of [['1\n', 'continue'], ['\n', 'undefined']] as const) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source],
      { encoding: 'utf8', input, timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, new RegExp(`RESULT=${expected}`));
    assert.doesNotMatch(child.stdout, /\x1b|hidden-title/);
  }
});
