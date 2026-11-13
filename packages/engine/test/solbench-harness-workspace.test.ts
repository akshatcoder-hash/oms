import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createEnv, walletFromSeed } from '../src/bench/solbench-harness/service.ts';
import { base58 } from '../src/bench/solbench-harness/wire.ts';
import { prepareWorkspace, WORKSPACE_SOURCE } from '../src/bench/solbench-harness/workspace.ts';

const seed = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const wallet = walletFromSeed(seed);

/** Every form a Solana secret key is usually written in: seed or 64-byte keypair, hex, base64, base58, JSON byte array. */
function secretForms(): string[] {
  const pub = Buffer.from(BigInt([...wallet.publicKey].reduce((v, c) => v * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c)), 0n)).toString(16).padStart(64, '0'), 'hex');
  return [Buffer.from(seed), Buffer.concat([seed, pub])].flatMap(bytes =>
    [bytes.toString('hex'), bytes.toString('base64'), base58(bytes), JSON.stringify([...bytes]), [...bytes].join(', ')]);
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

test('the prepared workspace (including .git) holds the public key and no form of the secret key', () => {
  const repo = mkdtempSync(join(tmpdir(), 'solbh-ws-'));
  try {
    prepareWorkspace(repo, { publicKey: wallet.publicKey, variant: 'swap' });
    const all = files(repo);
    assert.ok(all.some(path => path.endsWith('/.git/HEAD')));
    const text = all.map(path => readFileSync(path).toString('latin1')).join('\n');
    for (const form of secretForms()) assert.ok(!text.includes(form), `secret leaked as ${form.slice(0, 12)}...`);
    assert.match(readFileSync(join(repo, 'WALLET.json'), 'utf8'), new RegExp(wallet.publicKey));
    assert.ok(statSync(join(repo, 'submit-tx')).mode & 0o100, 'submit-tx is executable');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('no env method returns the secret key: status, refusals and errors carry only public data', async () => {
  const env = createEnv({ upstream: 'http://127.0.0.1:9', wallet, deadlineMs: Date.now() + 60_000, record: () => {} });
  const answers = JSON.stringify(await env.handle(['solbench_status', 'solbench_secret', 'surfnet_getKeypair', 'getIdentity', 'solbench_submit']
    .map(method => ({ jsonrpc: '2.0', id: 1, method, params: method === 'solbench_submit' ? ['AAAA'] : [] }))));
  for (const form of secretForms()) assert.ok(!answers.includes(form));
  assert.match(answers, new RegExp(wallet.publicKey));
  assert.ok(!JSON.stringify(wallet).includes(Buffer.from(seed).toString('hex')));
});

test('the shared workspace files never mention a key file or a way to sign locally', () => {
  for (const file of ['GOAL.md', 'submit-tx', 'visible.test.ts']) {
    assert.doesNotMatch(readFileSync(join(WORKSPACE_SOURCE, file), 'utf8'), /id\.json|keypair\.json|SECRET|PRIVATE_KEY/i, file);
  }
});

test('SOLBENCH_HARNESS_VISIBLE_MIN raises the visible check threshold; the default keeps the frozen file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'solbh-visible-'));
  const facts = { publicKey: walletFromSeed(new Uint8Array(32).fill(7)).publicKey, variant: 'basic' as const };
  try {
    prepareWorkspace(join(dir, 'a'), facts);
    assert.equal(readFileSync(join(dir, 'a/visible.test.ts'), 'utf8'), readFileSync(join(WORKSPACE_SOURCE, 'visible.test.ts'), 'utf8'));
    process.env.SOLBENCH_HARNESS_VISIBLE_MIN = '50';
    prepareWorkspace(join(dir, 'b'), facts);
    assert.match(readFileSync(join(dir, 'b/visible.test.ts'), 'utf8'), /headline >= 50, 'fewer than 50 pairs count yet'/);
  } finally { delete process.env.SOLBENCH_HARNESS_VISIBLE_MIN; rmSync(dir, { recursive: true, force: true }); }
});
