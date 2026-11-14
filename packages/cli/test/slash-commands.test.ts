import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession } from '@oms/engine';
import { OMS_COMMANDS, commandHelp } from '../src/tui/commands.ts';
import { READ_ONLY_COMMANDS, prepareSlash } from '../src/tui/slash-commands.ts';
import {
  base58Decode, base58Encode, describeTokenData, describeTransactionError, isBase58Bytes, type CommandOutput, type Prepared,
} from '../src/tui/solana-commands.ts';
import { testCommand } from '../src/tui/work-commands.ts';
import {
  failurePrompt, newGoal, parseGoalArguments, runGoalCheck, runGoalLoop, taskVerifierItem, type CheckResult, type Goal,
} from '../src/tui/goal.ts';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SIGNATURE = base58Encode(new Uint8Array(64).fill(7));
const WALLET = base58Encode(new Uint8Array(32).fill(9));

function chainFake(url = 'http://127.0.0.1:20000') {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let balance = 5;
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    getSlot: () => 321, getVersion: () => ({ 'solana-core': '2.3.1' }),
    getBalance: () => ({ value: balance }),
    requestAirdrop: params => { balance += Number(params[1]); return 'airdrop-signature'; },
  };
  let rewinds = 0;
  return { calls, handlers, rewinds: () => rewinds, chain: {
    rpcUrl: () => url, mode: 'offline-snapshot' as const, uptimeMs: () => 125_000,
    health: async () => ({ ok: true }),
    async call(method: string, params: unknown[] = []) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected ${method}`);
      return handler(params);
    },
    async rewind() { rewinds++; },
  } };
}

function harnessFake(extra: Record<string, unknown> = {}): HarnessSession {
  return { task: { id: 't', codeRoot: '/nonexistent', baseOid: 'a'.repeat(40), branch: 'oms/t' },
    budget: { snapshot: () => ({ caps: { tokens: 1000, spendMicroUsd: 5_000_000, wallClockMs: 600_000 },
      used: { tokens: 120, spendMicroUsd: 2500, wallClockMs: 61_000 }, remaining: { tokens: 880, spendMicroUsd: 4_997_500, wallClockMs: 539_000 },
      accounting: 'known', exhausted: false, reasons: [] }),
    receipts: () => [{ outcome: 'known', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5 } }, { outcome: 'known' }] },
    ...extra } as unknown as HarnessSession;
}

async function run(prepared: Prepared | undefined, signal = new AbortController().signal): Promise<CommandOutput> {
  assert.ok(prepared?.ok, prepared && !prepared.ok ? prepared.message : 'not a command');
  return prepared.run(signal);
}
const refusal = (prepared: Prepared | undefined): string => {
  assert.ok(prepared && !prepared.ok, 'expected a refusal');
  return prepared.message;
};

// ------------------------------------------------------------------ the command list

test('the menu and help list every new command, with Solana after Work, and no planned ones', () => {
  const names: string[] = OMS_COMMANDS.map(command => command.name);
  for (const name of ['goal', 'clear', 'diff', 'usage', 'test', 'chain', 'rewind', 'airdrop', 'account', 'tx', 'program', 'error']) {
    assert.ok(names.includes(name), name);
  }
  for (const name of ['deploy', 'undo', 'compact', 'resume']) assert.equal(names.includes(name), false, name);
  assert.equal(new Set(names).size, names.length, 'no duplicate command names');
  const help = commandHelp();
  assert.ok(help.indexOf('\nWork\n') < help.indexOf('\nSolana\n'));
  assert.match(help, /\/airdrop <address> \[sol\]/);
  assert.match(help, /\/account <address>/);
  assert.equal(OMS_COMMANDS.find(command => command.name === 'goal')?.group, 'Work');
  assert.equal(OMS_COMMANDS.find(command => command.name === 'diff')?.group, 'Inspect');
  assert.equal(prepareSlash('unknown', '', harnessFake(), ''), undefined);
});

// ------------------------------------------------------------------ /goal parsing and loop

test('/goal arguments: show, clear, text, quoted and bare checks, and bad input', () => {
  assert.deepEqual(parseGoalArguments(''), { kind: 'show' });
  assert.deepEqual(parseGoalArguments(' clear '), { kind: 'clear' });
  assert.deepEqual(parseGoalArguments('make tests pass'), { kind: 'set', text: 'make tests pass', check: undefined });
  assert.deepEqual(parseGoalArguments('make tests pass --check "npm test -- --grep \\"x\\""'),
    { kind: 'set', text: 'make tests pass', check: 'npm test -- --grep "x"' });
  assert.deepEqual(parseGoalArguments("fix it --check 'cargo test'"), { kind: 'set', text: 'fix it', check: 'cargo test' });
  assert.deepEqual(parseGoalArguments('fix it --check npm test'), { kind: 'set', text: 'fix it', check: 'npm test' });
  assert.equal(parseGoalArguments('fix it --check').kind, 'error');
  assert.equal(parseGoalArguments('--check "npm test"').kind, 'error');
  assert.equal(parseGoalArguments('x'.repeat(5000)).kind, 'error');
  assert.deepEqual(parseGoalArguments('fix --checkout main'), { kind: 'set', text: 'fix --checkout main', check: undefined });
});

function loopFixture(results: CheckResult[], options: { exhaustAfter?: number; abortAfterTurn?: number } = {}) {
  const goal = newGoal('make it pass', 'npm test');
  const prompts: string[] = [];
  const said: string[] = [];
  const controller = new AbortController();
  let checks = 0;
  const snapshot = () => ({ caps: { tokens: 1, spendMicroUsd: 1, wallClockMs: 1 }, used: { tokens: 0, spendMicroUsd: 0, wallClockMs: 0 },
    remaining: { tokens: 1, spendMicroUsd: 1, wallClockMs: 1 }, exhausted: options.exhaustAfter !== undefined && checks >= options.exhaustAfter,
    reasons: ['tokens' as const] });
  return { goal, prompts, said, controller, loop: {
    goal, signal: controller.signal, budget: snapshot, say: (text: string) => { said.push(text); },
    async turn(prompt: string) { prompts.push(prompt); if (options.abortAfterTurn === prompts.length) controller.abort(); },
    async check() { return results[Math.min(checks++, results.length - 1)]!; },
  } };
}
const fail = (output: string): CheckResult => ({ status: 'fail', output, summary: 'check failed (exit 1)' });
const pass: CheckResult = { status: 'pass', output: '', summary: 'check passed (exit 0)' };

test('/goal loop: a failing check feeds its output back, then a passing check reaches the goal', async () => {
  const f = loopFixture([fail('expected 2, got 3'), pass]);
  await runGoalLoop(f.loop);
  assert.equal(f.goal.status, 'reached');
  assert.equal(f.goal.attempts, 2);
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[0]!, /Goal: make it pass/);
  assert.match(f.prompts[0]!, /Your own claim that it is done is never enough/);
  assert.match(f.prompts[1]!, /expected 2, got 3/);
  assert.match(f.prompts[1]!, /1 of 5/);
  assert.ok(f.said.some(line => line.startsWith('Goal reached')));
});

test('/goal loop: the retry cap stops it visibly after five checks', async () => {
  let n = 0;
  const f = loopFixture([]);
  f.loop.check = async () => fail(`different failure ${n++}`);
  await runGoalLoop(f.loop);
  assert.equal(f.goal.status, 'stopped');
  assert.equal(f.goal.attempts, 5);
  assert.equal(f.prompts.length, 5);
  assert.ok(f.said.some(line => /Goal stopped: retry cap reached/.test(line)), f.said.join('\n'));
});

test('/goal loop: the same failure twice, an exhausted budget and an unavailable check each stop it', async () => {
  const repeated = loopFixture([fail('same'), fail('same')]);
  await runGoalLoop(repeated.loop);
  assert.equal(repeated.goal.status, 'stopped');
  assert.match(repeated.goal.summary, /same failure twice/);
  assert.equal(repeated.prompts.length, 2);

  const broke = loopFixture([fail('a'), fail('b')], { exhaustAfter: 1 });
  await runGoalLoop(broke.loop);
  assert.match(broke.goal.summary, /budget exhausted/);
  assert.equal(broke.prompts.length, 1);

  const unavailable = loopFixture([{ status: 'unavailable', output: '', summary: 'verifier could not run' }]);
  await runGoalLoop(unavailable.loop);
  assert.equal(unavailable.goal.status, 'stopped');
  assert.match(unavailable.goal.summary, /unavailable/);
});

test('/goal loop: cancelling ends it at the next boundary without running the check', async () => {
  const f = loopFixture([pass], { abortAfterTurn: 1 });
  let checked = false;
  f.loop.check = async () => { checked = true; return pass; };
  await runGoalLoop(f.loop);
  assert.equal(f.goal.status, 'cancelled');
  assert.equal(checked, false);
});

test('/goal loop: a failed agent turn marks the goal stopped and rethrows', async () => {
  const f = loopFixture([pass]);
  f.loop.turn = async () => { throw new Error('provider failed'); };
  await assert.rejects(runGoalLoop(f.loop), /provider failed/);
  assert.equal(f.goal.status, 'stopped');
  assert.equal(f.goal.summary, 'provider failed');
});

test('failure feedback is bounded to the tail of the output', () => {
  const goal: Goal = newGoal('g', 'c');
  const prompt = failurePrompt(goal, fail('x'.repeat(20_000) + 'THE-END'));
  assert.ok(prompt.length < 5_000);
  assert.match(prompt, /THE-END/);
});

test('/goal check: a sandbox command decides by exit code; the task verifier decides when there is no command', async () => {
  const goal = { check: 'npm test' };
  const commands: string[] = [];
  const result = (exitCode: number, extra = {}) => harnessFake({ async runCommand(command: string) {
    commands.push(command); return { exitCode, stdout: 'out', stderr: 'err', timedOut: false, cancelled: false, truncated: false, ...extra };
  } });
  assert.equal((await runGoalCheck(result(0), goal, new AbortController().signal)).status, 'pass');
  const failed = await runGoalCheck(result(2), goal, new AbortController().signal);
  assert.deepEqual([failed.status, failed.output], ['fail', 'out\nerr']);
  assert.equal((await runGoalCheck(result(0, { timedOut: true }), goal, new AbortController().signal)).status, 'fail');
  assert.equal((await runGoalCheck(result(1, { cancelled: true }), goal, new AbortController().signal)).status, 'unavailable');
  assert.deepEqual(commands, ['npm test', 'npm test', 'npm test', 'npm test']);

  const verified: Array<string | undefined> = [];
  let outcome: unknown = { closed: true, reason: 'verified' };
  const withTask = (items: Array<{ id: string; status: string }>) => harnessFake({
    evaluator: { read: () => ({ ok: true, value: { items } }) },
    async verify(id?: string) { verified.push(id); return { itemId: id, result: outcome }; } });
  const open = withTask([{ id: 'R1', status: 'active' }]);
  assert.equal(taskVerifierItem(open), 'R1');
  assert.equal((await runGoalCheck(open, { check: undefined }, new AbortController().signal)).status, 'pass');
  outcome = { closed: false, reason: 'failed', detail: 'test X failed' };
  const verdict = await runGoalCheck(open, { check: undefined }, new AbortController().signal);
  assert.deepEqual([verdict.status, verdict.output], ['fail', 'test X failed']);
  outcome = { closed: false, reason: 'reopen-cap', detail: 'cap' };
  assert.equal((await runGoalCheck(open, { check: undefined }, new AbortController().signal)).status, 'unavailable');
  assert.deepEqual(verified, ['R1', 'R1', 'R1']);
  const closed = withTask([{ id: 'R1', status: 'closed' }]);
  assert.equal(taskVerifierItem(closed), undefined);
  assert.equal((await runGoalCheck(closed, { check: undefined }, new AbortController().signal)).status, 'pass');
  assert.equal((await runGoalCheck(withTask([]), { check: undefined }, new AbortController().signal)).status, 'unavailable');
});

// ------------------------------------------------------------------ Solana commands

test('base58 helpers round-trip and validate lengths', () => {
  assert.equal(base58Decode(SYSTEM)?.length, 32);
  assert.deepEqual(base58Decode(base58Encode(Uint8Array.from([0, 0, 1, 2, 255]))), Uint8Array.from([0, 0, 1, 2, 255]));
  assert.ok(isBase58Bytes(TOKEN, 32));
  assert.ok(isBase58Bytes(SIGNATURE, 64));
  assert.equal(isBase58Bytes('not an address!', 32), false);
  assert.equal(isBase58Bytes('0OIl', 32), false);
  assert.equal(isBase58Bytes('', 32), false);
  assert.equal(isBase58Bytes('abc', 32), false);
});

test('/chain reports RPC, health, slot, fork state and uptime from the local chain only', async () => {
  const fake = chainFake();
  const out = await run(prepareSlash('chain', '', harnessFake({ chain: fake.chain }), ''));
  assert.match(out.text, /RPC: http:\/\/127\.0\.0\.1:20000/);
  assert.match(out.text, /Health: ok/);
  assert.match(out.text, /Slot: 321/);
  assert.match(out.text, /not a mainnet fork/);
  assert.match(out.text, /Uptime: 2m5s/);
  assert.match(refusal(prepareSlash('chain', 'now', harnessFake(), '')), /Usage/);
  await assert.rejects(run(prepareSlash('chain', '', harnessFake(), '')), /no local chain/);
});

test('/rewind explains itself, restores only on confirm, and rejects other arguments', async () => {
  const fake = chainFake();
  const harness = harnessFake({ chain: fake.chain });
  assert.match((await run(prepareSlash('rewind', '', harness, ''))).text, /\/rewind confirm/);
  assert.equal(fake.rewinds(), 0);
  assert.match((await run(prepareSlash('rewind', 'confirm', harness, ''))).text, /starting state/);
  assert.equal(fake.rewinds(), 1);
  assert.match(refusal(prepareSlash('rewind', 'yes', harness, '')), /confirm/);
});

test('/airdrop validates the address and amount, caps at 100 SOL, and shows the new balance', async () => {
  const fake = chainFake();
  const harness = harnessFake({ chain: fake.chain });
  assert.match(refusal(prepareSlash('airdrop', '', harness, '')), /Usage/);
  assert.match(refusal(prepareSlash('airdrop', 'nope', harness, '')), /valid Solana address/);
  assert.match(refusal(prepareSlash('airdrop', `${WALLET} 0`, harness, '')), /positive/);
  assert.match(refusal(prepareSlash('airdrop', `${WALLET} -1`, harness, '')), /positive/);
  assert.match(refusal(prepareSlash('airdrop', `${WALLET} 1.2.3`, harness, '')), /positive/);
  assert.match(refusal(prepareSlash('airdrop', `${WALLET} 100.000000001`, harness, '')), /capped at 100/);
  assert.match(refusal(prepareSlash('airdrop', `${WALLET} 1 2`, harness, '')), /Usage/);
  assert.equal(fake.calls.length, 0);
  const out = await run(prepareSlash('airdrop', WALLET, harness, ''));
  assert.match(out.text, /Airdropped 1 SOL to /);
  assert.match(out.text, /Balance: 1\.000000005 SOL/);
  assert.deepEqual(fake.calls.find(call => call.method === 'requestAirdrop')?.params, [WALLET, 1_000_000_000]);
  const big = await run(prepareSlash('airdrop', `${WALLET} 100`, harness, ''));
  assert.match(big.text, /Airdropped 100 SOL/);
});

test('/airdrop and every chain command refuse an RPC that is not the task loopback Surfpool', async () => {
  for (const url of ['https://api.devnet.solana.com', 'https://api.mainnet-beta.solana.com', 'http://10.0.0.5:8899',
    'http://127.0.0.1.evil.example:8899', 'http://user:pw@127.0.0.1:8899', 'ftp://127.0.0.1:8899', 'not a url']) {
    const fake = chainFake(url);
    const harness = harnessFake({ chain: fake.chain });
    for (const [name, argument] of [['airdrop', WALLET], ['account', WALLET], ['tx', SIGNATURE], ['chain', '']] as const) {
      await assert.rejects(run(prepareSlash(name, argument, harness, '')), /Refusing/, `${name} ${url}`);
    }
    assert.equal(fake.calls.length, 0, url);
  }
  const down = chainFake(); down.chain.rpcUrl = () => undefined as unknown as string;
  await assert.rejects(run(prepareSlash('airdrop', WALLET, harnessFake({ chain: down.chain }), '')), /not running/);
});

test('/account shows owner with its program name, lamports in SOL, data length, executable and a hex preview', async () => {
  const fake = chainFake();
  fake.handlers.getAccountInfo = () => ({ value: { lamports: 1_500_000_000, owner: SYSTEM, executable: false, data: [Buffer.from('hello').toString('base64'), 'base64'] } });
  const harness = harnessFake({ chain: fake.chain });
  assert.match(refusal(prepareSlash('account', 'bad', harness, '')), /Usage/);
  const out = await run(prepareSlash('account', WALLET, harness, ''));
  assert.match(out.text, new RegExp(`Owner: ${SYSTEM} \\(System\\)`));
  assert.match(out.text, /Lamports: 1500000000 \(1\.5 SOL\)/);
  assert.match(out.text, /Data: 5 bytes/);
  assert.match(out.text, /Executable: false/);
  assert.match(out.text, /Preview: 68656c6c6f/);
  fake.handlers.getAccountInfo = () => ({ value: null });
  assert.match((await run(prepareSlash('account', WALLET, harness, ''))).text, /No account/);
});

test('/account decodes a token mint and a token account owned by the Token program', async () => {
  const mint = Buffer.alloc(82);
  mint.writeUInt32LE(1, 0); Buffer.from(new Uint8Array(32).fill(4)).copy(mint, 4);
  mint.writeBigUInt64LE(1_000_000n, 36); mint[44] = 6; mint[45] = 1;
  const account = Buffer.alloc(165);
  Buffer.from(new Uint8Array(32).fill(1)).copy(account, 0); Buffer.from(new Uint8Array(32).fill(2)).copy(account, 32);
  account.writeBigUInt64LE(42n, 64); account[108] = 1;
  const fake = chainFake();
  const harness = harnessFake({ chain: fake.chain });
  fake.handlers.getAccountInfo = () => ({ value: { lamports: 1, owner: TOKEN, executable: false, data: [mint.toString('base64'), 'base64'] } });
  const minted = (await run(prepareSlash('account', WALLET, harness, ''))).text;
  assert.match(minted, /Owner: Tokenkeg\S+ \(SPL Token\)/);
  assert.match(minted, /Token mint:/); assert.match(minted, /decimals: 6/); assert.match(minted, /supply: 1000000/);
  assert.match(minted, new RegExp(`mint authority: ${base58Encode(new Uint8Array(32).fill(4))}`));
  fake.handlers.getAccountInfo = () => ({ value: { lamports: 1, owner: TOKEN, executable: false, data: [account.toString('base64'), 'base64'] } });
  const held = (await run(prepareSlash('account', WALLET, harness, ''))).text;
  assert.match(held, /Token account:/); assert.match(held, /amount: 42/); assert.match(held, /state: initialized/);
  assert.match(held, new RegExp(`owner: ${base58Encode(new Uint8Array(32).fill(2))}`));
  assert.deepEqual(describeTokenData(new Uint8Array(10)), []);
  const extended = Buffer.alloc(170); extended[165] = 2;
  assert.equal(describeTokenData(extended)[0], 'Token account:');
});

test('/tx shows status, decoded error, compute units, fee and bounded logs', async () => {
  const fake = chainFake();
  const logs = Array.from({ length: 60 }, (_, i) => `Program log: line ${i}${'x'.repeat(i === 0 ? 400 : 0)}`);
  fake.handlers.getTransaction = () => ({ slot: 77, transaction: { message: { accountKeys: [WALLET, TOKEN], instructions: [{ programIdIndex: 1 }] } },
    meta: { err: { InstructionError: [0, { Custom: 1 }] }, fee: 5000, computeUnitsConsumed: 4321, logMessages: logs } });
  const harness = harnessFake({ chain: fake.chain });
  assert.match(refusal(prepareSlash('tx', 'abc', harness, '')), /Usage/);
  const out = (await run(prepareSlash('tx', SIGNATURE, harness, ''))).text;
  assert.match(out, /Status: failed/);
  assert.match(out, /SPL Token: InsufficientFunds/);
  assert.match(out, /Compute units: 4321/);
  assert.match(out, /Fee: 5000 lamports \(0\.000005 SOL\)/);
  assert.match(out, /Slot: 77/);
  assert.match(out, /\[20 more lines\]/);
  assert.equal(out.includes('x'.repeat(400)), false);
  fake.handlers.getTransaction = () => ({ slot: 1, transaction: { message: { accountKeys: [WALLET], instructions: [] } }, meta: { err: null, fee: 0, logMessages: [] } });
  assert.match((await run(prepareSlash('tx', SIGNATURE, harness, ''))).text, /Status: success/);
  fake.handlers.getTransaction = () => null;
  assert.match((await run(prepareSlash('tx', SIGNATURE, harness, ''))).text, /No transaction/);
  assert.match(describeTransactionError('AccountNotFound', [], [], []), /AccountNotFound/);
  assert.match(describeTransactionError({ InstructionError: [0, { Custom: 3012 }] }, [WALLET], [0], []), /AccountNotInitialized/);
});

test('/program prints the program reference text without a network or chain', async () => {
  const out = await run(prepareSlash('program', 'system transfer', harnessFake(), ''));
  assert.match(out.text, /System/);
  assert.match(out.text, /ransfer/);
  assert.match((await run(prepareSlash('program', 'no-such-program-zzz', harnessFake(), ''))).text, /No program matches/);
  assert.match(refusal(prepareSlash('program', '  ', harnessFake(), '')), /Usage/);
});

test('/error decodes locally across Anchor, System and Token tables, local IDLs, and says when nothing answers', async () => {
  const harness = harnessFake();
  const text = async (argument: string, h: HarnessSession = harness) => (await run(prepareSlash('error', argument, h, ''))).text;
  assert.match(await text('3012'), /Anchor framework: AccountNotInitialized/);
  assert.match(await text('0xbc4'), /AccountNotInitialized/);
  assert.match(await text('custom program error: 0x1 token'), /SPL Token: InsufficientFunds/);
  assert.match(await text('0 system'), /System: AccountAlreadyInUse/);
  assert.match(await text('0 ata'), /Associated Token: InvalidOwner/);
  assert.match(await text('1'), /InsufficientFunds/);
  assert.match(await text('6001'), /defined by the program itself/);
  const missing = await text('4242');
  assert.match(missing, /not in the built-in tables or local IDLs/);
  assert.match(missing, /IDL or source/);
  assert.doesNotMatch(missing, /knowledge|configured|enabled/i);
  assert.match(refusal(prepareSlash('error', 'abc', harness, '')), /Usage/);
  assert.match(refusal(prepareSlash('error', '', harness, '')), /Usage/);
  assert.match(refusal(prepareSlash('error', '1 2 3', harness, '')), /Usage/);
  assert.match(refusal(prepareSlash('error', '-5', harness, '')), /Usage/);

  const asked: string[][] = [];
  const served = harnessFake({ knowledge: { config: () => undefined, async decodeError(code: string, program?: string) { asked.push([code, program ?? '']); return 'ProgramX: BadThing'; } } });
  assert.match(await text('4242 ProgramX', served), /BadThing/);
  assert.deepEqual(asked, [['4242', 'ProgramX']]);
  await text('3012', served);
  assert.equal(asked.length, 1, 'a locally known code never calls the service');
  const broken = harnessFake({ knowledge: { config: () => undefined, async decodeError() { throw new Error('service down'); } } });
  const failed = await text('4242', broken);
  assert.match(failed, /not in the built-in tables or local IDLs/);
  assert.doesNotMatch(failed, /service down|knowledge/i, 'a failed lookup shows no service text');
});

test('/error reads the task IDLs for program-defined codes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-error-'));
  try {
    mkdirSync(join(root, 'target', 'idl'), { recursive: true });
    writeFileSync(join(root, 'target', 'idl', 'vault.json'), JSON.stringify({ address: WALLET, metadata: { name: 'vault' },
      errors: [{ code: 6001, name: 'Locked', msg: 'Vault is locked' }] }));
    const harness = harnessFake({ task: { id: 't', codeRoot: root, baseOid: 'a'.repeat(40), branch: 'b' } });
    const out = (await run(prepareSlash('error', '6001', harness, ''))).text;
    assert.match(out, /vault: Locked — Vault is locked \[local IDL\]/);
    assert.match((await run(prepareSlash('error', `6001 ${WALLET}`, harness, ''))).text, /Locked/);
    assert.match((await run(prepareSlash('error', '3012 vault', harness, ''))).text, /Anchor framework: AccountNotInitialized/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ work commands

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'oms-diff-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); writeFileSync(join(root, 'a.txt'), 'one\n'); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'b.txt'), 'two\n'); git('add', '.'); git('commit', '-qm', 'base');
  return { root, git, base: git('rev-parse', 'HEAD') };
}

test('/diff shows staged, unstaged and untracked changes against the base, scoped by path, with bounded output', async () => {
  const repo = gitRepo();
  try {
    const harness = harnessFake({ task: { id: 't', codeRoot: repo.root, baseOid: repo.base, branch: 'oms/t' } });
    assert.match((await run(prepareSlash('diff', '', harness, ''))).text, /No changes/);
    writeFileSync(join(repo.root, 'a.txt'), 'one\nchanged\n'); repo.git('add', 'a.txt');
    writeFileSync(join(repo.root, 'src', 'b.txt'), 'two\nmore\n');
    writeFileSync(join(repo.root, 'new.txt'), 'fresh\n');
    const all = await run(prepareSlash('diff', '', harness, ''));
    assert.match(all.text, /\+changed/); assert.match(all.text, /\+more/);
    assert.match(all.text, /Untracked \(1\):\n  new\.txt/);
    assert.match(all.text, new RegExp(`Against base ${repo.base.slice(0, 12)}`));
    assert.equal(all.report, undefined);
    const scoped = (await run(prepareSlash('diff', 'src', harness, ''))).text;
    assert.match(scoped, /\+more/); assert.equal(scoped.includes('+changed'), false);
    for (const bad of ['../outside', '/etc/passwd', '.git/config', 'a\nb']) {
      await assert.rejects(run(prepareSlash('diff', bad, harness, '')), /inside the task worktree/, bad);
    }
    writeFileSync(join(repo.root, 'big.txt'), 'line\n'.repeat(20_000)); repo.git('add', 'big.txt');
    const long = await run(prepareSlash('diff', '', harness, ''));
    assert.ok(long.text.length < 9_500);
    assert.match(long.text, /opened in the workbench/);
    assert.ok(long.report && long.report.text.includes('+line') && long.report.id.startsWith('diff-'));
    assert.ok(Buffer.byteLength(long.report.text) <= 61 * 1024);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test('/usage reports token breakdown, spend, time, caps and the remaining line', async () => {
  const out = await run(prepareSlash('usage', '', harnessFake(), 'REMAINING-LINE'));
  assert.match(out.text, /input 100 · cached 50 read \/ 5 written · output 20 · 1 earlier calls have no breakdown/);
  assert.match(out.text, /Spend: \$0\.0025 of \$5 API cap/);
  assert.match(out.text, /Time: 1m1s of 10m0s/);
  assert.match(out.text, /Tokens against cap: 120 of 1,000/);
  assert.match(out.text, /Left: REMAINING-LINE/);
  assert.match(refusal(prepareSlash('usage', 'x', harnessFake(), '')), /Usage/);
});

test('/test picks Anchor, then an npm test script, then Cargo, and refuses when none exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-test-'));
  try {
    assert.equal(testCommand(root), undefined);
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="x"\n');
    assert.equal(testCommand(root), 'cargo test');
    writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"x"}}');
    assert.equal(testCommand(root), 'cargo test');
    writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
    assert.equal(testCommand(root), 'npm test');
    writeFileSync(join(root, 'package.json'), '{not json');
    assert.equal(testCommand(root), 'cargo test');
    writeFileSync(join(root, 'Anchor.toml'), '[provider]\n');
    assert.match(testCommand(root)!, /^anchor test --skip-local-validator --provider\.cluster "\$SURFNET_RPC_URL"$/);

    const ran: string[] = [];
    const harness = harnessFake({ task: { id: 't', codeRoot: root, baseOid: 'a'.repeat(40), branch: 'b' },
      async runCommand(command: string) { ran.push(command); return { exitCode: 3, stdout: 'x'.repeat(20_000) + 'END', stderr: 'boom', timedOut: false, cancelled: false, truncated: true }; } });
    const out = await run(prepareSlash('test', '', harness, ''));
    assert.match(out.text, /^\$ anchor test/);
    assert.match(out.text, /Exit: 3/);
    assert.match(out.text, /END\nboom/);
    assert.match(out.text, /backend output truncated/);
    assert.ok(out.text.length < 8_400);
    assert.equal(ran.length, 1);
    assert.match(refusal(prepareSlash('test', 'extra', harness, '')), /Usage/);
    rmSync(join(root, 'Anchor.toml')); rmSync(join(root, 'package.json')); rmSync(join(root, 'Cargo.toml'));
    assert.match(refusal(prepareSlash('test', '', harness, '')), /No tests found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only the read-only commands may run while work is busy', () => {
  for (const name of ['usage', 'diff', 'chain', 'account', 'tx', 'program', 'error', 'status', 'session']) assert.ok(READ_ONLY_COMMANDS.has(name), name);
  for (const name of ['airdrop', 'rewind', 'test', 'goal', 'clear', 'run', 'verify']) assert.equal(READ_ONLY_COMMANDS.has(name), false, name);
});
