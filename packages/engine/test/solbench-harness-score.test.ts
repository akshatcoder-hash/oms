import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AccountRole, address, appendTransactionMessageInstructions, blockhash, compileTransaction, createTransactionMessage,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getTransactionDecoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { parseTransaction } from '../src/bench/solbench-harness/wire.ts';
import { ARBITRARY_DATA_PROGRAMS, MEMO_PROGRAMS, scoreRun, type Submission } from '../src/bench/solbench-harness/score.ts';

const PAYER = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** An unsigned v0 transaction with the given top-level instructions, encoded by @solana/kit (independent of our parser). */
function tx(instructions: Array<{ program: string; data: number[] }>, version: 0 | 'legacy' = 0): string {
  const message = pipe(createTransactionMessage({ version }),
    m => setTransactionMessageFeePayer(PAYER, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k'), lastValidBlockHeight: 1n }, m),
    m => appendTransactionMessageInstructions(instructions.map(i => ({ programAddress: address(i.program), data: new Uint8Array(i.data),
      accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }] })), m));
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

const submission = (base64: string, ok: boolean): Submission => ({ ok, instructions: parseTransaction(Buffer.from(base64, 'base64')).instructions });

test('the parser reads program ids and data from legacy and v0 transactions encoded by @solana/kit', () => {
  for (const version of [0, 'legacy'] as const) {
    const parsed = parseTransaction(Buffer.from(tx([{ program: SYSTEM, data: [2, 0, 0, 0] }, { program: TOKEN, data: [] }], version), 'base64'));
    assert.equal(parsed.version, version);
    assert.equal(parsed.signers[0], PAYER);
    assert.deepEqual(parsed.instructions.map(i => [i.programId, [...i.data]]), [[SYSTEM, [2, 0, 0, 0]], [TOKEN, []]]);
  }
});

test('the parser rejects truncated input and trailing bytes', () => {
  const bytes = Buffer.from(tx([{ program: SYSTEM, data: [2] }]), 'base64');
  assert.throws(() => parseTransaction(bytes.subarray(0, bytes.length - 1)));
  assert.throws(() => parseTransaction(Buffer.concat([bytes, Buffer.from([0])])));
});

test('score: unique (program, first byte) pairs over successful transactions only', () => {
  const score = scoreRun([
    submission(tx([{ program: SYSTEM, data: [2, 1] }, { program: SYSTEM, data: [2, 9] }]), true), // one pair, counted once
    submission(tx([{ program: SYSTEM, data: [0] }]), false), // failed: nothing
    submission(tx([{ program: TOKEN, data: [3] }, { program: SYSTEM, data: [2] }]), true), // one new pair
    submission(tx([{ program: TOKEN, data: [] }]), true), // empty data has no first byte: nothing
  ]);
  assert.deepEqual(score.pairs, [`${SYSTEM}:2`, `${TOKEN}:3`]);
  assert.equal(score.headline, 2);
  assert.equal(score.raw, 2);
  assert.equal(score.programs, 2);
  assert.equal(score.failed, 1);
  assert.equal(score.submissions, 4);
});

test('score: Memo is never counted; arbitrary-data programs are reported apart from the headline', () => {
  const [memo, memoV1] = MEMO_PROGRAMS;
  const noop = ARBITRARY_DATA_PROGRAMS.find(p => p.id.startsWith('noop'))!.id;
  const score = scoreRun([submission(tx([{ program: memo!, data: [1] }, { program: memoV1!, data: [2] },
    { program: noop, data: [1] }, { program: noop, data: [2] }, { program: SYSTEM, data: [2] }]), true)]);
  assert.equal(score.headline, 1);
  assert.equal(score.memo, 2);
  assert.equal(score.arbitrary, 2);
  assert.equal(score.raw, 5);
  assert.equal(score.programs, 1);
});

test('score: programs the run deployed itself count as arbitrary data, not headline', () => {
  const mine = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const score = scoreRun([submission(tx([{ program: mine, data: [7] }, { program: SYSTEM, data: [2] }]), true)], new Set([mine]));
  assert.equal(score.headline, 1);
  assert.equal(score.arbitrary, 1);
});

test('every arbitrary-data entry states its reason', () => {
  for (const entry of ARBITRARY_DATA_PROGRAMS) assert.match(entry.reason, /\S{10,}/);
});

test('synthetic transactions: our parser and score agree with @solana/kit decoding them independently', () => {
  const programs = [SYSTEM, TOKEN, 'ComputeBudget111111111111111111111111111111', ...MEMO_PROGRAMS, ARBITRARY_DATA_PROGRAMS[0]!.id];
  const lines = Array.from({ length: 12 }, (_, i) => ({ ok: i % 5 !== 4,
    transaction: tx([{ program: programs[i % programs.length]!, data: [i, 1] }, { program: programs[(i + 1) % programs.length]!, data: [(i * 7) % 256] }], i % 2 ? 'legacy' : 0) }));
  const expected = new Set<string>();
  for (const line of lines) {
    const decoded = getTransactionDecoder().decode(Buffer.from(line.transaction, 'base64'));
    const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
    if (message.version === 1) throw new Error('unexpected v1 message');
    for (const i of message.instructions) {
      const programId = message.staticAccounts[i.programAddressIndex]!;
      if (line.ok && i.data?.length && !(MEMO_PROGRAMS as readonly string[]).includes(programId) &&
        !ARBITRARY_DATA_PROGRAMS.some(p => p.id === programId)) expected.add(`${programId}:${i.data[0]}`);
    }
  }
  const score = scoreRun(lines.map(line => submission(line.transaction, line.ok)));
  assert.deepEqual(score.pairs, [...expected].sort());
  assert.equal(score.headline, expected.size);
});
