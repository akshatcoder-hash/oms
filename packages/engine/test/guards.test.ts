import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { defaultDeniedRoots } from '../src/oms-extension.ts';
import { createHarness, type Harness } from '../test-support/harness.ts';
import {
  canonicalizeToolCall,
  createGuardsExtension,
  decideToolCall,
  type GuardHistory,
  type GuardedToolCall,
  type GuardsConfig,
  type ToolCallSample,
} from '../src/guards.ts';

const temporary: string[] = [];

function tempDir(prefix = 'oms-guard-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
}

// A failed assertion must not leave temp dirs behind.
process.on('exit', cleanup);

function transcriptText(h: Harness): string {
  return JSON.stringify(h.session.messages);
}

function toolResults(h: Harness): unknown[] {
  return h.session.messages.filter((message) => (message as { role?: string }).role === 'toolResult');
}

// --- decideToolCall: pure decisions ------------------------------------------------

test('write to a digest-pinned file is blocked, read of it is allowed', () => {
  cleanup();
  const cwd = tempDir();
  mkdirSync(join(cwd, '.oms'), { recursive: true });
  const config: GuardsConfig = { cwd, protectedPaths: ['.oms/task.json', 'tests/verifier.test.ts'] };

  const write = decideToolCall({ toolName: 'write', input: { path: '.oms/task.json', content: '{"items":[]}' } }, config, []);
  assert.equal(write.block, true);
  if (write.block) {
    assert.equal(write.rule, 'protected_write');
    assert.match(write.reason, /digest-pinned/);
    // The reason must not leak protected file contents.
    assert.ok(!write.reason.includes('items'));
    assert.ok(write.reason.length < 200, 'reason stays short');
  }

  const edit = decideToolCall({ toolName: 'edit', input: { path: 'tests/verifier.test.ts', edits: [] } }, config, []);
  assert.equal(edit.block, true);

  const read = decideToolCall({ toolName: 'read', input: { path: '.oms/task.json' } }, config, []);
  assert.equal(read.block, false);

  const sibling = decideToolCall({ toolName: 'write', input: { path: '.oms/PROGRESS.md', content: 'ok' } }, config, []);
  assert.equal(sibling.block, false, 'only the pinned entries are protected');
});

test('reads and writes under a denied root are blocked, including `..` and symlinked ancestors', () => {
  const root = tempDir('oms-guard-root-');
  const cwd = join(root, 'project');
  const vault = join(root, 'vault');
  mkdirSync(cwd);
  mkdirSync(vault);
  writeFileSync(join(vault, 'key.json'), '[1,2,3]');
  symlinkSync(vault, join(cwd, 'innocent'), 'dir');

  const config: GuardsConfig = { cwd, deniedRoots: [vault] };

  const direct = decideToolCall({ toolName: 'read', input: { path: join(vault, 'key.json') } }, config, []);
  assert.equal(direct.block, true);
  assert.equal(direct.block === true && direct.rule, 'denied_root');

  const traversal = decideToolCall({ toolName: 'read', input: { path: '../vault/key.json' } }, config, []);
  assert.equal(traversal.block, true, '`..` is resolved before the check');

  const viaSymlink = decideToolCall({ toolName: 'read', input: { path: 'innocent/key.json' } }, config, []);
  assert.equal(viaSymlink.block, true, 'a symlinked ancestor directory is resolved');

  const writeThroughSymlink = decideToolCall(
    { toolName: 'write', input: { path: 'innocent/new-file.json', content: '{}' } },
    config,
    [],
  );
  assert.equal(writeThroughSymlink.block, true, 'a not-yet-existing file under a symlinked dir is resolved');

  for (const toolName of ['grep', 'find', 'ls']) {
    const decision = decideToolCall({ toolName, input: { pattern: '*', path: vault } }, config, []);
    assert.equal(decision.block, true, `${toolName} into a denied root is blocked`);
  }

  cleanup();
});

test('bash commands that mention a denied root or a protected file are blocked', () => {
  cleanup();
  const cwd = tempDir();
  const signerDir = join(cwd, 'fixtures', 'signer');
  mkdirSync(signerDir, { recursive: true });
  const config: GuardsConfig = { cwd, deniedRoots: [signerDir], protectedPaths: ['.oms/task.json'] };

  const absolute = decideToolCall(
    { toolName: 'bash', input: { command: `cat ${join(signerDir, 'id.json')}` } },
    config,
    [],
  );
  assert.equal(absolute.block, true);
  assert.equal(absolute.block === true && absolute.rule, 'denied_root');

  const relative = decideToolCall({ toolName: 'bash', input: { command: 'cat fixtures/signer/id.json' } }, config, []);
  assert.equal(relative.block, true);

  const contractEdit = decideToolCall(
    { toolName: 'bash', input: { command: 'echo \'{"items":[]}\' > .oms/task.json' } },
    config,
    [],
  );
  assert.equal(contractEdit.block, true);
  assert.equal(contractEdit.block === true && contractEdit.rule, 'protected_write');

  const harmless = decideToolCall({ toolName: 'bash', input: { command: 'npm test' } }, config, []);
  assert.equal(harmless.block, false);
});

test('repetition blocks the third identical call and tolerates different inputs', () => {
  cleanup();
  const config: GuardsConfig = { cwd: tempDir(), repetition: { threshold: 3, window: 12 } };
  const history: ToolCallSample[] = [];
  const call: GuardedToolCall = { toolName: 'bash', input: { command: 'npm test' } };

  const run = (current: GuardedToolCall): ReturnType<typeof decideToolCall> => {
    const decision = decideToolCall(current, config, history);
    if (!decision.block) history.push({ key: canonicalizeToolCall(current) });
    return decision;
  };

  assert.equal(run(call).block, false, 'first call');
  assert.equal(run(call).block, false, 'second call');
  const third = run(call);
  assert.equal(third.block, true, 'third identical call is blocked');
  assert.match(third.block ? third.reason : '', /repeats an identical bash call/);
  assert.equal(third.block === true && third.rule, 'repetition');

  // Different arguments are different work, even in the same shape.
  const varied: ToolCallSample[] = [];
  for (const n of [1, 2, 3, 4]) {
    const decision = decideToolCall({ toolName: 'bash', input: { command: `echo ${n}` } }, config, varied);
    assert.equal(decision.block, false, `echo ${n} is not a repeat`);
    varied.push({ key: canonicalizeToolCall({ toolName: 'bash', input: { command: `echo ${n}` } }) });
  }

  // The window slides: an old repeat outside it no longer counts.
  const old: GuardHistory = [
    { key: canonicalizeToolCall(call) },
    { key: canonicalizeToolCall(call) },
    ...Array.from({ length: 12 }, () => ({ key: 'bash:{"command":"echo other"}' })),
  ];
  assert.equal(decideToolCall(call, config, old).block, false, 'repeats fell out of the window');
});

test('an oversize write or edit is blocked, an under-limit one is allowed', () => {
  cleanup();
  const config: GuardsConfig = { cwd: tempDir(), maxEditBytes: 1024 };

  const bigWrite = decideToolCall(
    { toolName: 'write', input: { path: 'src/big.ts', content: 'x'.repeat(1025) } },
    config,
    [],
  );
  assert.equal(bigWrite.block, true);
  assert.equal(bigWrite.block === true && bigWrite.rule, 'diff_size');
  assert.match(bigWrite.block ? bigWrite.reason : '', /split it into smaller edits/);

  const bigEdit = decideToolCall(
    {
      toolName: 'edit',
      input: {
        path: 'src/big.ts',
        edits: [
          { oldText: 'a', newText: 'y'.repeat(600) },
          { oldText: 'b', newText: 'z'.repeat(600) },
        ],
      },
    },
    config,
    [],
  );
  assert.equal(bigEdit.block, true, 'edits are summed');

  const ok = decideToolCall({ toolName: 'write', input: { path: 'src/ok.ts', content: 'x'.repeat(1024) } }, config, []);
  assert.equal(ok.block, false);

  // Default limit is 64 KiB.
  const defaults: GuardsConfig = { cwd: config.cwd };
  assert.equal(
    decideToolCall({ toolName: 'write', input: { path: 'src/a.ts', content: 'x'.repeat(64 * 1024) } }, defaults, []).block,
    false,
  );
  assert.equal(
    decideToolCall({ toolName: 'write', input: { path: 'src/b.ts', content: 'x'.repeat(64 * 1024 + 1) } }, defaults, []).block,
    true,
  );
});

test('malformed path arguments fail closed', () => {
  cleanup();
  const config: GuardsConfig = { cwd: tempDir() };
  const missing = decideToolCall({ toolName: 'read', input: {} }, config, []);
  assert.equal(missing.block, true);
  assert.equal(missing.block === true && missing.rule, 'guard_error');

  const wrongType = decideToolCall({ toolName: 'write', input: { path: 42, content: 'x' } }, config, []);
  assert.equal(wrongType.block, true);

  const nulByte = decideToolCall({ toolName: 'read', input: { path: 'a\u0000b' } }, config, []);
  assert.equal(nulByte.block, true);
});

test('decideToolCall throws on a broken config, and the extension blocks instead', async () => {
  cleanup();
  const broken: GuardsConfig = Object.defineProperty({}, 'protectedPaths', {
    enumerable: true,
    get(): never {
      throw new Error('config is broken');
    },
  }) as GuardsConfig;

  assert.throws(() => decideToolCall({ toolName: 'read', input: { path: 'x' } }, broken, []));

  const h = await createHarness({
    extensions: [createGuardsExtension(broken)],
    responses: [fauxAssistantMessage(fauxToolCall('bash', { command: 'echo hello' })), fauxAssistantMessage(fauxText('ok'))],
    tools: ['bash'],
  });
  try {
    await h.session.prompt('go');
    const results = toolResults(h);
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0]), /could not verify that this call is allowed/);
    assert.ok(!transcriptText(h).includes('hello\\n'), 'the command never ran');
  } finally {
    h.dispose();
    cleanup();
  }
});

// --- through a real faux session ---------------------------------------------------

test('session: a write to the contract is blocked and the file on disk is untouched', async () => {
  const h = await createHarness({
    extensions: [createGuardsExtension({ protectedPaths: ['.oms/task.json'] })],
    responses: [
      fauxAssistantMessage(fauxToolCall('write', { path: '.oms/task.json', content: '{"items":[]}' })),
      fauxAssistantMessage(fauxText('stopping')),
    ],
    tools: ['write'],
  });
  try {
    const contract = join(h.cwd, '.oms/task.json');
    mkdirSync(join(h.cwd, '.oms'), { recursive: true });
    writeFileSync(contract, '{"items":[{"id":"seed","done":false}]}');

    await h.session.prompt('mark the item done');

    const results = toolResults(h);
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0]), /digest-pinned and read-only/);
    assert.equal(readFileSync(contract, 'utf8'), '{"items":[{"id":"seed","done":false}]}');
    assert.equal(h.faux.state.callCount, 2, 'the model got the reason and kept going');
    assert.match(h.session.getLastAssistantText() ?? '', /stopping/);
  } finally {
    h.dispose();
  }
});

test('session: a read through a symlink into a denied root is blocked and leaks nothing', async () => {
  const vault = tempDir('oms-guard-vault-');
  const sentinel = 'SENTINEL-KEY-MATERIAL-4f1c';
  writeFileSync(join(vault, 'key.json'), JSON.stringify({ secret: sentinel }));

  const h = await createHarness({
    extensions: [createGuardsExtension({ deniedRoots: [vault] })],
    responses: [fauxAssistantMessage(fauxToolCall('read', { path: 'innocent/key.json' })), fauxAssistantMessage(fauxText('ok'))],
    tools: ['read'],
  });
  try {
    symlinkSync(vault, join(h.cwd, 'innocent'), 'dir');
    await h.session.prompt('read the key');

    const results = toolResults(h);
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0]), /key material or signer state/);
    assert.ok(!transcriptText(h).includes(sentinel), 'the file contents never reached the model');
  } finally {
    h.dispose();
    cleanup();
  }
});

test('session: a `..` escape into a denied sibling directory is blocked', async () => {
  const vault = tempDir('oms-guard-vault-');
  const sentinel = 'SIBLING-SECRET-9a2b';
  writeFileSync(join(vault, 'key.json'), sentinel);

  const h = await createHarness({
    extensions: [createGuardsExtension({ deniedRoots: [vault] })],
    responses: [
      fauxAssistantMessage(fauxToolCall('read', { path: `../${basename(vault)}/key.json` })),
      fauxAssistantMessage(fauxText('ok')),
    ],
    tools: ['read'],
  });
  try {
    await h.session.prompt('read the sibling');
    const results = toolResults(h);
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0]), /key material or signer state/);
    assert.ok(!transcriptText(h).includes(sentinel));
  } finally {
    h.dispose();
    cleanup();
  }
});

test('session: the third identical bash call is blocked and the first two ran', async () => {
  const h = await createHarness({
    extensions: [createGuardsExtension({})],
    responses: [
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo same-thing' })),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo same-thing' })),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo same-thing' })),
      fauxAssistantMessage(fauxText('changing approach')),
    ],
    tools: ['bash'],
  });
  try {
    await h.session.prompt('keep going');

    const results = toolResults(h);
    assert.equal(results.length, 3);
    const blocked = results.filter((result) => JSON.stringify(result).includes('repeats an identical bash call'));
    assert.equal(blocked.length, 1, 'exactly the third call is blocked');
    assert.match(JSON.stringify(results[2]), /repeats an identical bash call/);
    assert.match(JSON.stringify(results[0]), /same-thing/);
    assert.match(JSON.stringify(results[1]), /same-thing/);
    assert.equal(h.faux.state.callCount, 4);
  } finally {
    h.dispose();
  }
});

test('session: an oversize edit is blocked and the file is not created', async () => {
  const h = await createHarness({
    extensions: [createGuardsExtension({ maxEditBytes: 2048 })],
    responses: [
      fauxAssistantMessage(fauxToolCall('write', { path: 'big.ts', content: 'x'.repeat(4096) })),
      fauxAssistantMessage(fauxText('splitting it up')),
    ],
    tools: ['write'],
  });
  try {
    await h.session.prompt('write the file');
    const results = toolResults(h);
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0]), /per-call limit is 2048/);
    assert.throws(() => readFileSync(join(h.cwd, 'big.ts'), 'utf8'));
  } finally {
    h.dispose();
  }
});

test('host mode keeps full-path denials for shell commands but not the short folder-name match', () => {
  const config = { cwd: '/proj/.oms/worktrees/t', deniedRoots: ['/home/fixture/.ssh', '/home/fixture/.oms'], protectedPaths: ['/proj/.oms/worktrees/t/verify.js', '/proj/.oms/worktrees/t/.git'], approveHostCommands: true };
  const bash = (command: string) => decideToolCall({ toolName: 'bash', input: { command } }, config, []).block;
  assert.equal(bash('cat /home/fixture/.ssh/id'), true);
  assert.equal(bash('cat /home/fixture/.oms/state.json'), true);
  assert.equal(bash('ls /proj/.oms/worktrees/t/src'), false);
  const hostConfig = { ...config, deniedRoots: defaultDeniedRoots() };
  for (const command of ['cat ~/.ssh/id', 'cat $HOME/.ssh/id', 'cat "$HOME"/.gnupg/x', 'cat ${HOME}/.ssh/id', 'cat ~/.config/solana/id.json']) {
    assert.equal(decideToolCall({ toolName: 'bash', input: { command } }, hostConfig, []).block, true, command);
  }
  assert.equal(decideToolCall({ toolName: 'read', input: { path: '/home/fixture/.ssh/id' } }, config, []).block, true);
  assert.equal(bash('echo changed > /proj/.oms/worktrees/t/verify.js'), true);
  assert.equal(decideToolCall({ toolName: 'write', input: { path: '/proj/.oms/worktrees/t/.git/config', content: 'changed' } }, config, []).block, true);
});

test('a denied folder name matches whole path components only, so public checkouts named solana-* stay readable', () => {
  const config = { cwd: '/work', deniedRoots: defaultDeniedRoots() };
  const bash = (command: string) => decideToolCall({ toolName: 'bash', input: { command } }, config, []).block;
  for (const command of ['cat ~/.config/solana/id.json', 'ls ~/.config/solana', 'cat /root/.config/solana/id.json', 'cd /x/.config/solana && cat id.json',
    'cat ~/.config/solana*', 'tar c "$HOME/.config/solana"', 'cat ../../.config/solana/id.json']) assert.equal(bash(command), true, command);
  for (const command of ['cat /tmp/oms-sources/h-1/solana-labs__solana-program-library@264ca72/governance/program/src/instruction.rs',
    'grep -rn Instruction /tmp/oms-sources/solana-program__memo@1/program', 'ls node_modules/@solana/kit']) assert.equal(bash(command), false, command);
});

test('a denied root under the task\'s own dotted folder adds no parent needle, so host-mode task paths stay usable', () => {
  const config = { cwd: '/proj/.oms/worktrees/t', deniedRoots: ['/home/fixture/.oms/signer', '/home/fixture/.config/solana'], approveHostCommands: true };
  const bash = (command: string) => decideToolCall({ toolName: 'bash', input: { command } }, config, []).block;
  assert.equal(bash('ls /proj/.oms/worktrees/t/src'), false);
  assert.equal(bash('cat /home/fixture/.oms/signer/sock'), true);
  assert.equal(bash('cd /home/fixture/.config && cat solana/id.json'), true);
});
