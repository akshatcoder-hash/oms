import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { generateSignerKeypair } from '../src/init.ts';
import { DEVNET_GENESIS_HASH } from '../src/profile.ts';
import { buildTransferTx, connectClient, createConfig, makeTempDir, randomAddress } from '../test-support/helpers.ts';
import { controlledRpc } from '../test-support/rpc.ts';

async function launch(configPath: string, signal: AbortSignal) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // ES2023 compiler baseline: register event callbacks in the Promise executor.
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const abort = () => {
      child.kill('SIGKILL');
      reject(new Error('signer test aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline >= 0) {
        const value = JSON.parse(stdout.slice(0, newline));
        if (value.status === 'ready') resolve(value);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', () => {
      signal.removeEventListener('abort', abort);
      reject(new Error(`signer exited before ready: ${stderr}`));
    });
  });
  return { child, ready: await ready };
}

test(
  'SIGKILL after returned signature preserves unknown charge and idempotency after CLI restart',
  { timeout: 30_000 },
  async (t) => {
    const rpc = await controlledRpc();
    t.after(() => rpc.close());
    const dir = makeTempDir();
    const signerDir = join(dir, 'keys');
    const socketDir = join(dir, 'sockets');
    const issued = generateSignerKeypair({
      signerDir,
      alias: 'dev',
      profile: {
        kind: 'devnet',
        endpoint: rpc.endpoint,
        genesisHash: DEVNET_GENESIS_HASH,
        authorization: 'user-approved',
      },
    });
    const destination = randomAddress();
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ signerDir, alias: 'dev', socketDir, config: createConfig({ accountIds: [destination] }) }),
      { mode: 0o600 },
    );
    const first = await launch(configPath, t.signal);
    t.after(() => {
      if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill('SIGKILL');
    });
    const token = readFileSync(join(socketDir, 'engine.token'), 'utf8').trim();
    const client = await connectClient(String(first.ready.engineSocket), token);
    const transaction = buildTransferTx({ from: issued.address, to: destination, lamports: 1000 });
    const signed = await client.send({ type: 'sign', transaction });
    assert.equal(signed.status, 'signed', JSON.stringify(signed));
    const exited = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await exited;
    await client.close();
    const second = await launch(configPath, t.signal);
    t.after(() => {
      if (second.child.exitCode === null && second.child.signalCode === null) second.child.kill('SIGKILL');
    });
    const next = await connectClient(
      String(second.ready.engineSocket),
      readFileSync(join(socketDir, 'engine.token'), 'utf8').trim(),
    );
    const replay = await next.send({ type: 'sign', transaction });
    assert.equal(replay.signature, signed.signature);
    assert.equal(replay.reservationId, signed.reservationId);
    assert.ok(replay.spend && typeof replay.spend === 'object' && 'usedLamports' in replay.spend);
    assert.equal(replay.spend.usedLamports, 6000);
    rpc.state.signatureStatus = { confirmationStatus: 'finalized', err: null };
    const settled = await next.send({ type: 'reconcile', reservationId: signed.reservationId });
    assert.equal(settled.outcome, 'confirmed');
    assert.ok(settled.spend && typeof settled.spend === 'object' && 'usedLamports' in settled.spend);
    assert.equal(settled.spend.usedLamports, 6000);
    await next.close();
    const stopped = once(second.child, 'exit');
    second.child.kill('SIGTERM');
    await stopped;
  },
);

function ledgerProcess(path: string, mode: string) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../test-support/ledger-worker.ts', import.meta.url)), path, mode],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  return {
    child,
    next: () =>
      new Promise<string>((resolve) => {
        const line = lines.shift();
        if (line !== undefined) resolve(line);
        else waiters.push(resolve);
      }),
  };
}

test(
  'two-process stale recovery is serialized and crash-era unknown spend stays charged',
  { timeout: 30_000 },
  async (t) => {
    const path = join(makeTempDir(), 'spend.journal');
    const workers: ChildProcessWithoutNullStreams[] = [];
    const worker = (mode: string) => {
      const result = ledgerProcess(path, mode);
      workers.push(result.child);
      return result;
    };
    t.after(() => {
      for (const child of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const seed = worker('seed');
    assert.equal(await seed.next(), 'ready:6000');
    const killed = once(seed.child, 'exit');
    seed.child.kill('SIGKILL');
    await killed;
    const a = worker('barrier');
    assert.equal(await a.next(), 'recovering');
    const b = worker('open');
    assert.equal(await b.next(), 'denied');
    a.child.stdin.write('x');
    assert.equal(await a.next(), 'ready:6000');
    const c = worker('open');
    assert.equal(await c.next(), 'denied');
    const stopped = once(a.child, 'exit');
    a.child.stdin.write('x');
    await stopped;
    const d = worker('open');
    assert.equal(await d.next(), 'ready:6000');
    const closed = once(d.child, 'exit');
    d.child.stdin.write('x');
    await closed;
  },
);

test('crashed recovery gate fails closed rather than stealing a replacement lock', { timeout: 30_000 }, async (t) => {
  const path = join(makeTempDir(), 'spend.journal');
  const seed = ledgerProcess(path, 'seed');
  t.after(() => seed.child.kill('SIGKILL'));
  assert.equal(await seed.next(), 'ready:6000');
  const killed = once(seed.child, 'exit');
  seed.child.kill('SIGKILL');
  await killed;
  const recovering = ledgerProcess(path, 'barrier');
  t.after(() => recovering.child.kill('SIGKILL'));
  assert.equal(await recovering.next(), 'recovering');
  const crashed = once(recovering.child, 'exit');
  recovering.child.kill('SIGKILL');
  await crashed;
  const contender = ledgerProcess(path, 'open');
  t.after(() => contender.child.kill('SIGKILL'));
  assert.equal(await contender.next(), 'denied');
  assert.equal(existsSync(`${path}.lock.gate`), true);
});

test(
  'CLI second-socket startup rejection exits and leaves no signing listener or ledger lock',
  { timeout: 30_000 },
  async (t) => {
    const rpc = await controlledRpc();
    t.after(() => rpc.close());
    const dir = makeTempDir();
    const signerDir = join(dir, 'keys');
    const socketDir = join(dir, 'sockets');
    generateSignerKeypair({
      signerDir,
      alias: 'dev',
      profile: {
        kind: 'devnet',
        endpoint: rpc.endpoint,
        genesisHash: DEVNET_GENESIS_HASH,
        authorization: 'user-approved',
      },
    });
    mkdirSync(socketDir, { mode: 0o700 });
    mkdirSync(join(socketDir, 'tui.sock'));
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ signerDir, alias: 'dev', socketDir, config: createConfig({ accountIds: [] }) }),
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), configPath], {
      stdio: 'ignore',
    });
    t.after(() => child.kill('SIGKILL'));
    const [code] = await once(child, 'exit', { signal: t.signal });
    assert.equal(code, 1);
    assert.equal(existsSync(join(socketDir, 'engine.sock')), false);
    assert.equal(existsSync(join(socketDir, 'engine.token')), false);
    assert.equal(existsSync(join(socketDir, 'tui.sock')), true);
    assert.equal(existsSync(join(signerDir, 'dev.spend.journal.lock')), false);
  },
);
