// Integration tests: require a real surfpool binary (default
// ~/.local/bin/surfpool, override with SURFPOOL_BINARY). They skip cleanly
// when it is missing. All surfnets run offline; no mainnet RPC, no real keys.
// Transaction bytes are hand-rolled (base58 + node:crypto ed25519), so this
// package needs no external dependency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSurfnet, type Surfnet } from '../src/manager.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const BINARY = process.env.SURFPOOL_BINARY ?? join(process.env.HOME ?? '', '.local/bin/surfpool');
const HAS_BINARY = existsSync(BINARY);

// --- minimal base58 (test-only) ---
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(input: string, length: number): Uint8Array {
  let num = 0n;
  for (const c of input) {
    const idx = B58_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`bad base58 char ${JSON.stringify(c)}`);
    num = num * 58n + BigInt(idx);
  }
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  if (num !== 0n) throw new Error('base58 value overflows target length');
  return out;
}
function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) {
    out = B58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  const zeros = bytes.findIndex((b) => b !== 0);
  return '1'.repeat(zeros === -1 ? bytes.length : zeros) + out;
}

// --- raw ed25519 Solana keypair (throwaway, in memory) ---
interface TestSigner {
  pubkey: string;
  pubkeyBytes: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}
function makeSigner(): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const pubkeyBytes = Uint8Array.from(Buffer.from(jwk.x ?? '', 'base64url'));
  return {
    pubkeyBytes,
    pubkey: base58Encode(pubkeyBytes),
    sign: (message) => Uint8Array.from(cryptoSign(null, Buffer.from(message), privateKey)),
  };
}

// --- hand-rolled legacy system transfer ---
function buildTransferWire(signer: TestSigner, to: string, lamports: number, blockhash: string): string {
  const message = new Uint8Array(150);
  const view = new DataView(message.buffer);
  let o = 0;
  message.set([1, 0, 1], o); o += 3; // header
  message[o] = 3; o += 1; // 3 static accounts
  message.set(signer.pubkeyBytes, o); o += 32; // payer (writable signer)
  message.set(base58Decode(to, 32), o); o += 32; // destination
  o += 32; // system program: base58 "1"x32 -> 32 zero bytes
  message.set(base58Decode(blockhash, 32), o); o += 32; // recent blockhash
  message[o] = 1; o += 1; // 1 instruction
  message[o] = 2; o += 1; // programIdIndex
  message[o] = 2; o += 1; // 2 instruction accounts
  message.set([0, 1], o); o += 2;
  message[o] = 12; o += 1; // data length (12 < 128, single compact-u16 byte)
  message[o] = 2; // transfer discriminator
  view.setBigUint64(o + 4, BigInt(lamports), true);
  o += 12;
  assert.equal(o, 150);

  const signature = signer.sign(message);
  const wire = new Uint8Array(1 + 64 + message.length);
  wire[0] = 1; // 1 signature
  wire.set(signature, 1);
  wire.set(message, 65);
  return Buffer.from(wire).toString('base64');
}

// --- shared state ---
const workDir = mkdtempSync(join(tmpdir(), 'oms-surfnet-'));
let surf: Surfnet;
const exits: Array<{ code: number | null; signal: string | null }> = [];

// ps snapshot of surfpool processes before we start, to compare at the end.
function surfpoolProcesses(): string[] {
  const out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.stdout
    .split('\n')
    .filter((line) => line.includes('surfpool'))
    .map((line) => line.trim());
}

const psBefore = HAS_BINARY ? surfpoolProcesses() : [];

before(async () => {
  if (!HAS_BINARY) return;
  surf = createSurfnet({
    binary: BINARY,
    offline: true,
    workDir,
    onExit: (info) => exits.push(info),
  });
  await surf.start();
});

after(async () => {
  if (surf) await surf.stop().catch(() => {});
  rmSync(workDir, { recursive: true, force: true });
});

const SEED_ADDRESS = '9jpoP5z8H8u21sSS5etPxS63LL4WXsxVkKsqBBU3c8rL';

test('start produces a healthy offline surfnet with labeled mode', async (t) => {
  if (await skipUnavailable(t, { surfpool: BINARY })) return;
  assert.equal(surf.mode, 'offline-snapshot');
  const health = await surf.health();
  assert.equal(health.ok, true);
  assert.ok(surf.rpcUrl()?.startsWith('http://127.0.0.1:'));
  assert.ok(typeof surf.pid() === 'number');
});

test('checkpoint then mutate then rewind restores the original account value', async (t) => {
  if (await skipUnavailable(t, { surfpool: BINARY })) return;
  await surf.restoreAccounts([{ address: SEED_ADDRESS, lamports: 111 }]);
  const base = await surf.checkpoint('base');
  assert.ok(existsSync(base.path));
  assert.equal(base.digest, createHash('sha256').update(readFileSync(base.path)).digest('hex'));

  // Mutate through a real transaction (hand-rolled transfer, no deps).
  const { value: lifetime } = (await surf.rpc.call('getLatestBlockhash')) as {
    value: { blockhash: string; lastValidBlockHeight: number };
  };
  const payer = makeSigner();
  const dest = makeSigner();
  await surf.restoreAccounts([
    { address: payer.pubkey, lamports: 2_000_000_000, owner: '11111111111111111111111111111111' },
  ]);
  const wire = buildTransferWire(payer, dest.pubkey, 1_000_000, lifetime.blockhash);
  const signature = (await surf.rpc.call('sendTransaction', [
    wire,
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ])) as string;
  assert.ok(typeof signature === 'string' && signature.length > 30);
  const after = (await surf.rpc.call('getAccountInfo', [dest.pubkey])) as {
    value: { lamports: number } | null;
  };
  assert.equal(after.value?.lamports, 1_000_000);

  // Rewind to the checkpoint: the transfer destination and the transfer are
  // gone; the seeded value returns.
  await surf.rewind('base');
  assert.equal((await surf.health()).ok, true);
  const restored = (await surf.rpc.call('getAccountInfo', [SEED_ADDRESS])) as {
    value: { lamports: number } | null;
  };
  assert.equal(restored.value?.lamports, 111);
  const destGone = (await surf.rpc.call('getAccountInfo', [dest.pubkey])) as {
    value: unknown;
  };
  assert.equal(destGone.value, null);
});

test('rewind restores state setAccount cannot: post-checkpoint account deletion and slot', async (t) => {
  if (await skipUnavailable(t, { surfpool: BINARY })) return;
  // Fresh checkpoint, then create an account after it.
  await surf.checkpoint('no-extra');
  const extra = makeSigner();
  await surf.restoreAccounts([{ address: extra.pubkey, lamports: 42 }]);
  const created = (await surf.rpc.call('getAccountInfo', [extra.pubkey])) as {
    value: { lamports: number } | null;
  };
  assert.equal(created.value?.lamports, 42);
  // Let the surfnet advance past the checkpointed slot (~4 slots/s offline).
  let slotBefore = 0;
  for (let i = 0; i < 60; i++) {
    slotBefore = (await surf.rpc.call('getSlot')) as number;
    if (slotBefore > 10) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(slotBefore > 10, `slot should have advanced before rewind (got ${slotBefore})`);

  await surf.rewind('no-extra');

  // setAccount cannot delete accounts; a restart from the snapshot can.
  const gone = (await surf.rpc.call('getAccountInfo', [extra.pubkey])) as { value: unknown };
  assert.equal(gone.value, null);
  // Slot restarts from the snapshot's slot: setAccount can never rewind it.
  const slotAfter = (await surf.rpc.call('getSlot')) as number;
  assert.ok(slotAfter < slotBefore, `slot after rewind (${slotAfter}) should be < before (${slotBefore})`);
});

test('killing the child triggers onExit and ensureAlive restores from the checkpoint', async (t) => {
  if (await skipUnavailable(t, { surfpool: BINARY })) return;
  const rescue = await surf.checkpoint('rescue');
  await surf.restoreAccounts([{ address: SEED_ADDRESS, lamports: 777 }]); // after checkpoint

  const exited = new Promise<void>((resolve) => {
    const check = () => {
      if (exits.length > 0) resolve();
      else setTimeout(check, 25);
    };
    check();
  });
  const pid = surf.pid();
  assert.ok(typeof pid === 'number');
  process.kill(pid as number, 'SIGKILL');
  await exited;
  assert.equal((await surf.health()).ok, false);

  const result = await surf.ensureAlive();
  assert.equal(result.restarted, true);
  assert.equal(result.fromCheckpoint, rescue.path);
  assert.equal((await surf.health()).ok, true);
  // State comes from the checkpoint: the 777 write happened after it.
  const restored = (await surf.rpc.call('getAccountInfo', [SEED_ADDRESS])) as {
    value: { lamports: number } | null;
  };
  assert.equal(restored.value?.lamports, 111);
});

test('two surfnets run concurrently on different ports with isolated state', async (t) => {
  if (await skipUnavailable(t, { surfpool: BINARY })) return;
  const other = createSurfnet({ binary: BINARY, offline: true, workDir });
  try {
    await other.start();
    assert.notEqual(other.rpcUrl(), surf.rpcUrl());
    assert.equal((await other.health()).ok, true);
    assert.equal((await surf.health()).ok, true);
    const a = makeSigner();
    const b = makeSigner();
    await surf.restoreAccounts([{ address: a.pubkey, lamports: 1 }]);
    await other.restoreAccounts([{ address: b.pubkey, lamports: 2 }]);
    const onFirst = (await surf.rpc.call('getAccountInfo', [b.pubkey])) as { value: unknown };
    const onSecond = (await other.rpc.call('getAccountInfo', [a.pubkey])) as { value: unknown };
    assert.equal(onFirst.value, null);
    assert.equal(onSecond.value, null);
    assert.equal(
      ((await surf.rpc.call('getAccountInfo', [a.pubkey])) as { value: { lamports: number } }).value?.lamports,
      1,
    );
    assert.equal(
      ((await other.rpc.call('getAccountInfo', [b.pubkey])) as { value: { lamports: number } }).value?.lamports,
      2,
    );
  } finally {
    await other.stop();
  }
});

test('crash before any checkpoint recovers the original offline startup snapshot', async (t) => {
  if (await skipUnavailable(t, { surfpool: BINARY })) return;
  await surf.restoreAccounts([{ address: SEED_ADDRESS, lamports: 314 }]);
  const snapshot = await surf.checkpoint('original-recovery');
  let exited!: () => void;
  const exit = new Promise<void>((resolve) => { exited = resolve; });
  const recovering = createSurfnet({
    binary: BINARY, offline: true, snapshot: snapshot.path,
    workDir: join(workDir, 'original-recovery'), onExit: () => exited(),
  });
  try {
    await recovering.start();
    await recovering.restoreAccounts([{ address: SEED_ADDRESS, lamports: 999 }]);
    process.kill(recovering.pid()!, 'SIGKILL');
    await exit;
    const recovery = await recovering.ensureAlive();
    assert.deepEqual(recovery, { restarted: true, fromCheckpoint: undefined });
    const account = await recovering.rpc.call('getAccountInfo', [SEED_ADDRESS]) as { value: { lamports: number } };
    assert.equal(account.value.lamports, 314);
  } finally {
    await recovering.stop();
  }
});

test('no surfpool process remains after the tests', async (t) => {
  if (await skipUnavailable(t, { surfpool: BINARY })) return;
  // The main manager is still intentionally running; stop it, then verify.
  await surf.stop();
  const now = surfpoolProcesses();
  const beforeSet = new Set(psBefore);
  const newOnes = now.filter((line) => !beforeSet.has(line));
  assert.deepEqual(newOnes, [], `stray surfpool processes: ${newOnes.join(' | ')}`);
  assert.equal(surf.pid(), undefined, 'manager reports no live pid after stop');
});
