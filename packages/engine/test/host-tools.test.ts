import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxTools } from '../src/runtime/sandbox-tools.ts';

test('real host tools use task paths, protect verifier/.git and gate shell commands', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'oms-host-tools-'));
  const root = join(fixtureRoot, '.oms/worktrees/task');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'verify.js'), 'pinned');
  mkdirSync(join(root, 'checks'));
  writeFileSync(join(root, 'checks/verify.js'), 'pinned');
  symlinkSync('checks', join(root, 'alias'));
  const options = { backend: 'host' as const, taskName: 'host-fixture',
    mounts: { projectMount: { hostPath: root, containerPath: '/work', mode: 'rw' as const }, extraMounts: [], readOnlyMounts: [], volumes: [], shadowMounts: [] },
    image: '', forwarderImage: '', leaseDir: root, sourceControlDir: root, surfnetPort: 8899,
    signal: new AbortController().signal, protectedPaths: [join(root, 'verify.js'), join(root, 'checks/verify.js')] };
  const control = mkdtempSync(join(tmpdir(), 'oms-host-control-'));
  options.sourceControlDir = control;
  const tools = createSandboxTools(options);
  try {
    await tools.files.write(join(root, 'hello.txt'), Buffer.from('hello'));
    assert.equal((await tools.files.read('hello.txt')).bytes.toString(), 'hello');
    await assert.rejects(tools.files.write('verify.js', Buffer.from('changed')), /pinned verifier/);
    await assert.rejects(tools.files.write('alias/verify.js', Buffer.from('changed')), /pinned verifier/);
    await assert.rejects(tools.files.write('.git/config', Buffer.from('changed')), /outside the admitted/);
    await assert.rejects(tools.execute(['/bin/sh', '-c', 'pwd']), /denied/);
  } finally { await tools.dispose(); }
  const allowed = createSandboxTools({ ...options, approvalPolicy: 'allow' });
  try {
    const result = await allowed.execute(['/bin/sh', '-c', 'printf "%s" "$SOLANA_RPC_URL"; pwd']);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `http://127.0.0.1:8899${root}\n`);
  } finally { await allowed.dispose(); rmSync(fixtureRoot, { recursive: true, force: true }); rmSync(control, { recursive: true, force: true }); }
});

test('a host command finds the trusted Surfpool through SURFPOOL_BINARY only when one is configured', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oms-host-surfpool-')));
  const control = mkdtempSync(join(tmpdir(), 'oms-host-surfpool-control-'));
  const options = { backend: 'host' as const, approvalPolicy: 'allow' as const, taskName: 'host-surfpool',
    mounts: { projectMount: { hostPath: root, containerPath: '/work', mode: 'rw' as const }, extraMounts: [], readOnlyMounts: [], volumes: [], shadowMounts: [] },
    image: '', forwarderImage: '', leaseDir: root, sourceControlDir: control, surfnetPort: 8899, signal: new AbortController().signal };
  const print = ['/bin/sh', '-c', 'printf "%s" "${SURFPOOL_BINARY-unset}"'];
  const configured = createSandboxTools({ ...options, surfpool: '/opt/oms/surfpool' });
  const bare = createSandboxTools(options);
  try {
    assert.equal((await configured.execute(print)).stdout, '/opt/oms/surfpool');
    assert.equal((await bare.execute(print)).stdout, 'unset');
  } finally { await configured.dispose(); await bare.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(control, { recursive: true, force: true }); }
});

test('host terminal runs a real interactive shell and closes before verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-host-terminal-'));
  const control = mkdtempSync(join(tmpdir(), 'oms-host-terminal-control-'));
  const tools = createSandboxTools({ backend: 'host', approvalPolicy: 'allow', taskName: 'terminal-fixture',
    mounts: { projectMount: { hostPath: root, containerPath: '/work', mode: 'rw' }, extraMounts: [], readOnlyMounts: [], volumes: [], shadowMounts: [] },
    image: '', forwarderImage: '', leaseDir: root, sourceControlDir: control, surfnetPort: 8899,
    signal: new AbortController().signal, timeoutMs: 5000 });
  try {
    const terminal = await tools.startTerminal(80, 24);
    let output = '';
    const received = new Promise<void>(resolve => {
      terminal.subscribe(data => { output += Buffer.from(data).toString(); if (output.includes('HOST-TERMINAL-OK')) resolve(); });
    });
    assert.throws(() => tools.assertVerificationAllowed(), /Stop terminal/);
    terminal.write(Buffer.from('printf "HOST-TERMINAL-%s\\n" OK\n'));
    await Promise.race([received, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('terminal output timeout')), 3000); timer.unref(); })]);
    terminal.resize(100, 40);
    const deadline = Date.now() + 3000;
    while (!/40\s+100/.test(output) && Date.now() < deadline) {
      terminal.write(Buffer.from('stty size\n'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(output, /40\s+100/);
    await terminal.close();
    await terminal.exited;
    await Promise.resolve();
    tools.assertVerificationAllowed();
  } finally { await tools.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(control, { recursive: true, force: true }); }
});

test('host terminal cleanup uncertainty reaches close and tool disposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-terminal-tamper-'));
  const control = mkdtempSync(join(tmpdir(), 'oms-terminal-control-'));
  const dependencies = mkdtempSync(join(tmpdir(), 'oms-terminal-deps-'));
  const tools = createSandboxTools({ backend: 'host', approvalPolicy: 'allow', taskName: 'terminal-tamper',
    mounts: { projectMount: { hostPath: root, containerPath: '/work', mode: 'rw' }, extraMounts: [],
      readOnlyMounts: [{ hostPath: dependencies, containerPath: '/work/node_modules', mode: 'ro' }], volumes: [], shadowMounts: [] },
    image: '', forwarderImage: '', leaseDir: root, sourceControlDir: control, surfnetPort: 8899,
    signal: new AbortController().signal, timeoutMs: 5000 });
  try {
    const terminal = await tools.startTerminal(80, 24);
    let text = '';
    const removed = new Promise<void>(resolve => terminal.subscribe(bytes => { text += Buffer.from(bytes).toString(); if (text.includes('REMOVED-LINK')) resolve(); }));
    terminal.write(Buffer.from("rm node_modules; printf 'REMOVED-%s\\n' LINK\n"));
    await Promise.race([removed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('terminal cleanup fixture timed out')), 3000); timer.unref(); })]);
    await assert.rejects(terminal.close(), AggregateError);
    await assert.rejects(tools.dispose(), AggregateError);
  } finally {
    await tools.dispose().catch(() => {});
    for (const directory of [root, control, dependencies]) rmSync(directory, { recursive: true, force: true });
  }
});

test('host verification asks approval once and honors deny', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-host-verify-approval-'));
  const control = mkdtempSync(join(tmpdir(), 'oms-host-verify-control-'));
  const options = { backend: 'host' as const, taskName: 'verify-approval',
    mounts: { projectMount: { hostPath: root, containerPath: '/work', mode: 'rw' as const }, extraMounts: [], readOnlyMounts: [], volumes: [], shadowMounts: [] },
    image: '', forwarderImage: '', leaseDir: root, sourceControlDir: control, surfnetPort: 8899, signal: new AbortController().signal };
  const denied = createSandboxTools(options);
  let ran = false;
  try {
    await assert.rejects(denied.withVerification(async () => { ran = true; }), /denied/);
    assert.equal(ran, false);
  } finally { await denied.dispose(); }
  let asked = 0;
  const approved = createSandboxTools(options);
  approved.setHostApproval(async () => { asked++; return true; });
  try {
    await approved.withVerification(async () => { ran = true; });
    assert.deepEqual({ ran, asked }, { ran: true, asked: 1 });
  } finally { await approved.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(control, { recursive: true, force: true }); }
});

test('host approval prompt shows the shell string, not JSON argv', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-host-prompt-'));
  const control = mkdtempSync(join(tmpdir(), 'oms-host-prompt-control-'));
  const tools = createSandboxTools({ backend: 'host', taskName: 'prompt',
    mounts: { projectMount: { hostPath: root, containerPath: '/work', mode: 'rw' }, extraMounts: [], readOnlyMounts: [], volumes: [], shadowMounts: [] },
    image: '', forwarderImage: '', leaseDir: root, sourceControlDir: control, surfnetPort: 8899, signal: new AbortController().signal });
  const shown: string[] = [];
  tools.setHostApproval(async request => { shown.push(request.command); return true; });
  try {
    await tools.execute(['/bin/sh', '-c', 'printf "a b"']);
    await tools.execute(['/bin/echo', 'x y']);
    assert.deepEqual(shown, ['printf "a b"', '/bin/echo x y']);
  } finally { await tools.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(control, { recursive: true, force: true }); }
});
