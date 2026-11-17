import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { createEnv, deployedPrograms, walletFromSeed, type SubmissionRecord } from '../src/solbench-harness/service.ts';
import { parseTransaction } from '../src/solbench-harness/wire.ts';

const SYSTEM = '11111111111111111111111111111111';
const wallet = walletFromSeed(new Uint8Array(32).fill(7));

function unsigned(data: number[], payer = wallet.publicKey): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(payer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash('EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k'), lastValidBlockHeight: 1n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          {
            programAddress: address(SYSTEM),
            data: new Uint8Array(data),
            accounts: [{ address: address(payer), role: AccountRole.WRITABLE_SIGNER }],
          },
        ],
        m,
      ),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/** A fork stand-in: every sent transaction lands; data byte 0 = 9 fails. Records every method it receives. */
async function fakeFork(): Promise<{ url: string; methods: string[]; sent: string[]; server: Server }> {
  const methods: string[] = [];
  const sent: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const { method, params } = JSON.parse(body);
      methods.push(method);
      let result: unknown = 'ok';
      if (method === 'sendTransaction') {
        sent.push(params[0]);
        result = `sig${sent.length}`;
      }
      if (method === 'getTransaction') {
        const tx = parseTransaction(Buffer.from(sent[Number(params[0].slice(3)) - 1]!, 'base64'));
        result = {
          meta: {
            err: tx.instructions[0]!.data[0] === 9 ? { InstructionError: [0, 'Custom'] } : null,
            logMessages: ['log'],
            loadedAddresses: { writable: [], readonly: [] },
          },
        };
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, methods, sent, server };
}

const rpc = (method: string, params: unknown[] = []) => ({ jsonrpc: '2.0', id: 1, method, params });

test('the 51st submission is refused, invalid ones count, and nothing past the cap reaches the fork', async () => {
  const fork = await fakeFork();
  const records: SubmissionRecord[] = [];
  const env = createEnv({
    upstream: fork.url,
    wallet,
    deadlineMs: Date.now() + 60_000,
    record: (entry) => records.push(entry),
    confirmMs: 1000,
  });
  try {
    const first = (await env.handle(rpc('solbench_submit', [unsigned([2, 0, 0, 0])]))) as any;
    assert.equal(first.result.ok, true);
    assert.deepEqual(first.result.newPairs, [`${SYSTEM}:2`]);
    assert.equal(((await env.handle(rpc('solbench_submit', ['not base64!']))) as any).result.ok, false);
    for (let i = 2; i < 50; i++) await env.handle(rpc('solbench_submit', [unsigned([i % 2 ? 9 : 3])]));
    const refused = (await env.handle(rpc('solbench_submit', [unsigned([4])]))) as any;
    assert.match(refused.error.message, /budget exhausted: all 50 submissions used/);
    assert.equal(records.length, 50);
    assert.equal(fork.sent.length, 49);
    const score = env.score();
    assert.deepEqual([score.headline, score.submissions, score.failed], [2, 50, 25]);
    assert.equal(env.status().submissionsLeft, 0);
  } finally {
    fork.server.close();
  }
});

test('submissions after the 30-minute deadline are refused without counting', async () => {
  const fork = await fakeFork();
  let clock = 0;
  const env = createEnv({
    upstream: fork.url,
    wallet,
    deadlineMs: 30 * 60_000,
    now: () => clock,
    record: () => {},
    confirmMs: 1000,
  });
  try {
    assert.equal(((await env.handle(rpc('solbench_submit', [unsigned([2])]))) as any).result.ok, true);
    clock = 30 * 60_000;
    assert.match(
      ((await env.handle(rpc('solbench_submit', [unsigned([2])]))) as any).error.message,
      /wall clock is over/,
    );
    assert.equal(env.status().submissionsLeft, 49);
  } finally {
    fork.server.close();
  }
});

test('reads are forwarded; cheatcodes, raw sends and airdrops never reach the fork, also inside a batch', async () => {
  const fork = await fakeFork();
  const env = createEnv({ upstream: fork.url, wallet, deadlineMs: Date.now() + 60_000, record: () => {} });
  try {
    const answers = (await env.handle([
      rpc('getAccountInfo', [SYSTEM]),
      rpc('surfnet_setAccount', [wallet.publicKey, { lamports: 1 }]),
      rpc('sendTransaction', ['AA==']),
      rpc('requestAirdrop', [wallet.publicKey, 1]),
      rpc('surfnet_setTokenAccount', []),
    ])) as any[];
    assert.equal(answers[0].result, 'ok');
    for (const answer of answers.slice(1)) assert.equal(answer.error.code, -32601);
    assert.deepEqual(fork.methods, ['getAccountInfo']);
  } finally {
    fork.server.close();
  }
});

test('the env signs the wallet slot over the exact message bytes', async () => {
  const fork = await fakeFork();
  const env = createEnv({
    upstream: fork.url,
    wallet,
    deadlineMs: Date.now() + 60_000,
    record: () => {},
    confirmMs: 1000,
  });
  try {
    await env.handle(rpc('solbench_submit', [unsigned([2])]));
    const bytes = Buffer.from(fork.sent[0]!, 'base64');
    const parsed = parseTransaction(bytes);
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(walletPublicBytes())]);
    assert.ok(
      verify(
        null,
        bytes.subarray(parsed.messageOffset),
        createPublicKey({ key: spki, format: 'der', type: 'spki' }),
        bytes.subarray(1, 65),
      ),
    );
  } finally {
    fork.server.close();
  }
});

test('deploys and upgrades through the loaders mark their program account', () => {
  const keys = ['payer', 'programdata', 'program', 'buffer'];
  const u32 = (n: number) => [n, 0, 0, 0];
  assert.deepEqual(
    deployedPrograms(
      [
        {
          programId: 'BPFLoaderUpgradeab1e11111111111111111111111',
          accounts: [0, 1, 2, 3],
          data: Uint8Array.from(u32(2)),
        },
        {
          programId: 'BPFLoaderUpgradeab1e11111111111111111111111',
          accounts: [1, 2, 3],
          data: Uint8Array.from(u32(3)),
        },
        {
          programId: 'BPFLoaderUpgradeab1e11111111111111111111111',
          accounts: [0, 1, 2],
          data: Uint8Array.from(u32(1)),
        },
        { programId: 'LoaderV411111111111111111111111111111111111', accounts: [3], data: Uint8Array.from(u32(3)) },
      ],
      keys,
    ),
    ['program', 'program', 'buffer'],
  );
});

function walletPublicBytes(): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const c of wallet.publicKey) value = value * 58n + BigInt(ALPHABET.indexOf(c));
  return Uint8Array.from(Buffer.from(value.toString(16).padStart(64, '0'), 'hex'));
}
