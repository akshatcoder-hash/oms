// Integration tests: require a real surfpool binary (default
// ~/.local/bin/surfpool, override with SURFPOOL_BINARY). They skip cleanly
// when it is missing. All surfnets run offline; no mainnet RPC, no real keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSurfnet, type Surfnet } from '../src/manager.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const BINARY = process.env.SURFPOOL_BINARY ?? join(process.env.HOME ?? '', '.local/bin/surfpool');
const HAS_BINARY = existsSync(BINARY);

// --- minimal base58 (test-only) ---
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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
    workDir,
    onExit: (info) => exits.push(info),
  });
  await surf.start();
});

after(async () => {
  if (surf) await surf.stop().catch(() => {});
  rmSync(workDir, { recursive: true, force: true });
});

test('start produces a healthy offline surfnet with labeled mode', async (t) => {
  if (await skipUnavailable(t, { surfpool: BINARY })) return;
  assert.equal(surf.mode, 'offline-snapshot');
  const health = await surf.health();
  assert.equal(health.ok, true);
  assert.ok(surf.rpcUrl()?.startsWith('http://127.0.0.1:'));
  assert.ok(typeof surf.pid() === 'number');
});

test('rewindToStart removes accounts created after start and keeps the surfnet healthy', async (t) => {
  if (await skipUnavailable(t, { surfpool: BINARY })) return;
  const extra = makeSigner();
  await surf.rpc.call('surfnet_setAccount', [extra.pubkey, { lamports: 42 }]);
  const created = (await surf.rpc.call('getAccountInfo', [extra.pubkey])) as { value: { lamports: number } | null };
  assert.equal(created.value?.lamports, 42);
  await surf.rewindToStart();
  assert.equal((await surf.health()).ok, true);
  const gone = (await surf.rpc.call('getAccountInfo', [extra.pubkey])) as { value: unknown };
  assert.equal(gone.value, null);
});

test('two surfnets run concurrently on different ports with isolated state', async (t) => {
  if (await skipUnavailable(t, { surfpool: BINARY })) return;
  const other = createSurfnet({ binary: BINARY, workDir });
  try {
    await other.start();
    assert.notEqual(other.rpcUrl(), surf.rpcUrl());
    assert.equal((await other.health()).ok, true);
    assert.equal((await surf.health()).ok, true);
    const a = makeSigner();
    const b = makeSigner();
    await surf.rpc.call('surfnet_setAccount', [a.pubkey, { lamports: 1 }]);
    await other.rpc.call('surfnet_setAccount', [b.pubkey, { lamports: 2 }]);
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
