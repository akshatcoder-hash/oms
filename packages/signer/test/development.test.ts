import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { getBase58Codec } from '@solana/kit';
import { generateSignerKeypair } from '../src/init.ts';
import { loadIssuedKeypair } from '../src/keypair.ts';
import { SpendLedger } from '../src/ledger.ts';
import { startSignerServer } from '../src/server.ts';
import { decodeUnsignedTransaction } from '../src/tx.ts';
import {
  buildTransferTx,
  buildUnsignedTransaction,
  computeUnitLimitData,
  computeUnitPriceData,
  COMPUTE_BUDGET_PROGRAM,
  connectClient,
  findLeak,
  makeTempDir,
  randomAddress,
  secretTextForms,
  startTestSigner,
  SYSTEM_PROGRAM,
  ZERO_BLOCKHASH,
} from '../test-support/helpers.ts';

async function setup(t: TestContext) {
  const destination = randomAddress();
  const signer = await startTestSigner({ destinations: [destination] });
  t.after(() => signer.close());
  const transaction = buildTransferTx({ from: signer.fixture.address, to: destination, lamports: 1000 });
  return {
    ...signer,
    destination,
    transaction,
    send: (msg: Record<string, unknown>) =>
      signer.running.service.handle('engine', JSON.stringify(msg)).then((r) => r.response),
  };
}

test('issued alias signs exact bytes; repeated message reserves once, including after restart', async (t) => {
  const f = await setup(t);
  const first = await f.send({ type: 'sign', transaction: f.transaction });
  assert.equal(first.status, 'signed', JSON.stringify(first));
  const second = await f.send({ type: 'sign', transaction: f.transaction });
  assert.equal(second.signature, first.signature);
  assert.equal(second.reservationId, first.reservationId);
  assert.equal(f.running.ledger.spent(), 6000);
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), f.fixture.keypairBytes.subarray(32)]),
    format: 'der',
    type: 'spki',
  });
  assert.equal(
    verify(
      null,
      decodeUnsignedTransaction(f.transaction).messageBytes,
      publicKey,
      Uint8Array.from(getBase58Codec().encode(String(first.signature))),
    ),
    true,
  );
  const record = f.running.ledger.reservation(String(first.reservationId));
  assert.equal(record?.signature, first.signature);
  assert.equal(
    record?.messageBase64,
    Buffer.from(decodeUnsignedTransaction(f.transaction).messageBytes).toString('base64'),
  );
  assert.equal(record?.lifetime.blockhash, ZERO_BLOCKHASH);
  assert.equal(record?.profileId, f.generated.profileId);
  await f.running.close();
  const restarted = await startSignerServer(f.serverOptions);
  t.after(() => restarted.close());
  const replay = (
    await restarted.service.handle('engine', JSON.stringify({ type: 'sign', transaction: f.transaction }))
  ).response;
  assert.equal(replay.signature, first.signature);
  assert.equal(restarted.ledger.spent(), 6000);
});

test('caller cluster/endpoint/profile authority and legacy key-path config are refused', async (t) => {
  const f = await setup(t);
  for (const extra of [
    { cluster: 'localnet' },
    { cluster: 'mainnet' },
    { endpoint: f.rpc.endpoint },
    { profile: f.profile },
  ]) {
    const response = await f.send({ type: 'sign', transaction: f.transaction, ...extra });
    assert.equal(response.code, 'E_BAD_REQUEST');
    assert.equal(response.signature, undefined);
  }
  await assert.rejects(
    startSignerServer({ ...f.serverOptions, keypairPath: f.fixture.path } as never),
    /legacy|unsupported/i,
  );
  await assert.rejects(
    startSignerServer({
      ...f.serverOptions,
      config: { ...f.config, clusters: { mainnet: { mode: 'confirm' } } },
    } as never),
    /legacy|unsupported/i,
  );
});

test('genesis spoof, foreign blockhash and nonce instructions cannot produce signatures', async (t) => {
  const f = await setup(t);
  f.rpc.state.genesis = randomAddress();
  assert.equal((await f.send({ type: 'sign', transaction: f.transaction })).code, 'E_PROFILE');
  f.rpc.state.genesis = f.profile.genesisHash;
  const foreign = buildTransferTx({
    from: f.fixture.address,
    to: f.destination,
    lamports: 1000,
    blockhash: randomAddress(),
  });
  assert.equal((await f.send({ type: 'sign', transaction: foreign })).code, 'E_LIFETIME');
  const nonce = buildUnsignedTransaction({
    feePayer: f.fixture.address,
    instructions: [{ programAddress: SYSTEM_PROGRAM, accounts: [], data: Uint8Array.of(4, 0, 0, 0) }],
  });
  assert.equal((await f.send({ type: 'sign', transaction: nonce })).code, 'E_LIFETIME');
  assert.equal(f.running.ledger.spent(), 0);
});

test('copied keys without issuance or with a different issued address are rejected', async (t) => {
  const f = await setup(t);
  copyFileSync(f.fixture.path, join(f.signerDir, 'copied.key.json'));
  assert.throws(() => loadIssuedKeypair({ signerDir: f.signerDir, alias: 'copied' }), /issuance/i);
  const other = generateSignerKeypair({ signerDir: f.signerDir, alias: 'other', profile: f.profile });
  copyFileSync(f.fixture.path, join(f.signerDir, 'other.key.json'));
  assert.throws(() => loadIssuedKeypair({ signerDir: f.signerDir, alias: other.alias }), /issuance/i);
  assert.throws(() => generateSignerKeypair({ signerDir: f.signerDir, alias: 'dev', profile: f.profile }), /exists/i);
  chmodSync(join(f.signerDir, 'dev.issuance.json'), 0o644);
  assert.throws(() => loadIssuedKeypair({ signerDir: f.signerDir, alias: 'dev' }), /private|permissions/i);
});

test('fees above cap are rejected rather than clipped and large u64 prices stay integer-safe', async (t) => {
  const f = await setup(t);
  for (const price of [10_000_000n, (1n << 64n) - 1n]) {
    const transaction = buildTransferTx({
      from: f.fixture.address,
      to: f.destination,
      lamports: 0,
      extraInstructions: [
        { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: computeUnitLimitData(200_000) },
        { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: computeUnitPriceData(price) },
      ],
    });
    const response = await f.send({ type: 'sign', transaction });
    assert.equal(response.code, 'E_SPEND_PER_TX', JSON.stringify(response));
  }
  assert.equal(f.running.ledger.spent(), 0);
});

test('byte-distinct privilege headers cannot reuse reservation identity', async (t) => {
  const f = await setup(t);
  const original = Buffer.from(f.transaction, 'base64');
  const changed = Buffer.from(original);
  changed[67] = 0; // legacy message: sig count + 64-byte slot + third header byte
  assert.notDeepEqual(changed, original);
  const a = decodeUnsignedTransaction(original.toString('base64'));
  const b = decodeUnsignedTransaction(changed.toString('base64'));
  assert.notEqual(a.digest, b.digest);
  assert.equal((await f.send({ type: 'sign', transaction: original.toString('base64') })).status, 'signed');
  assert.equal((await f.send({ type: 'sign', transaction: changed.toString('base64') })).status, 'signed');
  assert.equal(f.running.ledger.spent(), 12000);
});

test('model outcome claims never release; clock passage and unavailable history retain unknown spend', async (t) => {
  const f = await setup(t);
  const signed = await f.send({ type: 'sign', transaction: f.transaction });
  for (const channel of ['engine', 'tui'] as const) {
    for (const type of ['release', 'settle', 'confirm']) {
      assert.equal(
        (
          await f.running.service.handle(
            channel,
            JSON.stringify({ type, reservationId: signed.reservationId, reason: 'never_broadcast' }),
          )
        ).response.code,
        'E_BAD_REQUEST',
      );
    }
  }
  f.rpc.state.height = 10000;
  f.rpc.state.slot = 10001;
  f.rpc.state.historyAvailable = false;
  const result = await f.send({ type: 'reconcile', reservationId: signed.reservationId });
  assert.equal(result.outcome, 'unknown');
  assert.equal(f.running.ledger.spent(), 6000);
  assert.equal(
    (await f.send({ type: 'reconcile', reservationId: signed.reservationId, outcome: 'never-broadcast' })).code,
    'E_BAD_REQUEST',
  );
  f.rpc.state.signatureStatus = { confirmationStatus: 'finalized', err: null };
  assert.equal((await f.send({ type: 'reconcile', reservationId: signed.reservationId })).outcome, 'confirmed');
  assert.equal(f.running.ledger.spent(), 6000);
});

test('only complete finalized history proves expiry absence; landed signature stays charged', async (t) => {
  const f = await setup(t);
  const signed = await f.send({ type: 'sign', transaction: f.transaction });
  f.rpc.state.height = 1001;
  f.rpc.state.slot = 101;
  f.rpc.state.blockSignatures = [String(signed.signature)];
  assert.equal((await f.send({ type: 'reconcile', reservationId: signed.reservationId })).outcome, 'confirmed');
  assert.equal(f.running.ledger.spent(), 6000);
  const next = await f.send({
    type: 'sign',
    transaction: buildTransferTx({ from: f.fixture.address, to: f.destination, lamports: 2000 }),
  });
  assert.equal(next.code, 'E_LIFETIME');
});

test('expired proven absent releases once and cannot be replayed for a new signature', async (t) => {
  const f = await setup(t);
  const signed = await f.send({ type: 'sign', transaction: f.transaction });
  f.rpc.state.height = 1001;
  f.rpc.state.slot = 101;
  assert.equal(
    (await f.send({ type: 'reconcile', reservationId: signed.reservationId })).outcome,
    'expired-proven-absent',
  );
  assert.equal(f.running.ledger.spent(), 0);
  assert.equal((await f.send({ type: 'sign', transaction: f.transaction })).signature, undefined);
});

test('incoherent finalized RPC snapshots never refund unknown spend', async (t) => {
  for (const inconsistent of [
    { height: 1001, slot: 100 },
    { height: 1001, slot: 101, statusSlot: 100 },
    { height: 1002, slot: 101 },
    { height: 1001, slot: 101, blockHeights: { 100: 1000, 101: null } },
    { height: 1001, slot: 101, historySlots: [101] },
    { height: 1001, slot: 101, blockParents: { 100: 99, 101: 99 } },
    { height: 1001, slot: 101, historyAvailable: false },
  ]) {
    const f = await setup(t);
    const signed = await f.send({ type: 'sign', transaction: f.transaction });
    Object.assign(f.rpc.state, inconsistent);
    assert.equal(
      (await f.send({ type: 'reconcile', reservationId: signed.reservationId })).outcome,
      'unknown',
      JSON.stringify(inconsistent),
    );
    assert.equal(f.running.ledger.spent(), 6000);
  }
});

test('coherent post-expiry history tolerates skipped slots and a newer status context', async (t) => {
  const f = await setup(t);
  const signed = await f.send({ type: 'sign', transaction: f.transaction });
  Object.assign(f.rpc.state, {
    height: 1001,
    slot: 102,
    statusSlot: 103,
    historySlots: [100, 102],
    blockHeights: { 100: 1000, 102: 1001 },
    blockParents: { 100: 99, 102: 100 },
  });
  assert.equal(
    (await f.send({ type: 'reconcile', reservationId: signed.reservationId })).outcome,
    'expired-proven-absent',
  );
  assert.equal(f.running.ledger.spent(), 0);
});

test('ledger close never unlinks a later foreign lock and PID-only locks fail closed', () => {
  const journal = join(makeTempDir(), 'spend.journal');
  const ledger = new SpendLedger(6000, journal);
  const path = `${journal}.lock`;
  const owner = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  renameSync(path, `${path}.old`);
  writeFileSync(path, JSON.stringify({ ...owner, token: 'replacement-owner' }), { mode: 0o600 });
  assert.throws(() => ledger.close(), /ownership|owner/i);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'replacement-owner');
  unlinkSync(path);
  writeFileSync(path, String(process.pid), { mode: 0o600 });
  assert.throws(() => new SpendLedger(6000, journal), /ledger|journal|owner/i);
  assert.equal(readFileSync(path, 'utf8'), String(process.pid));
});

test('connections accepted before transactional readiness cannot authenticate or sign', async (t) => {
  const f = await setup(t);
  await f.running.close();
  let reachedEngine = false;
  await assert.rejects(
    startSignerServer({
      ...f.serverOptions,
      startupHooks: {
        afterChannelListen: async (channel, path) => {
          if (channel !== 'engine') return;
          reachedEngine = true;
          const client = await connectClient(path, null);
          t.after(() => client.close());
          assert.equal((await client.next()).code, 'E_SOCKET_CLOSED');
          throw new Error('injected second-stage startup failure');
        },
      },
    }),
    /injected second-stage/,
  );
  assert.equal(reachedEngine, true);
  assert.equal(existsSync(join(f.socketDir, 'engine.sock')), false);
  assert.equal(existsSync(join(f.socketDir, 'engine.token')), false);
  assert.equal(existsSync(`${f.running.journalPath}.lock`), false);
});

test('failure after both listeners exist still rolls back every signing resource', async (t) => {
  const f = await setup(t);
  await f.running.close();
  await assert.rejects(
    startSignerServer({
      ...f.serverOptions,
      alsoWrite: () => {
        throw new Error('startup output failed');
      },
    }),
    /startup output failed/,
  );
  for (const name of [
    'engine.sock',
    'tui.sock',
    'engine.token',
    'tui.token',
    '.signer.lock',
    '.signer-artifacts.json',
  ]) {
    assert.equal(existsSync(join(f.socketDir, name)), false, name);
  }
  assert.equal(existsSync(`${f.running.journalPath}.lock`), false);
});

test('second socket conflict rolls back listener, tokens and ledger without removing the conflict', async (t) => {
  const f = await setup(t);
  await f.running.close();
  mkdirSync(join(f.socketDir, 'tui.sock'));
  await assert.rejects(startSignerServer(f.serverOptions));
  assert.equal(existsSync(join(f.socketDir, 'tui.sock')), true);
  assert.equal(existsSync(join(f.socketDir, 'engine.sock')), false);
  assert.equal(existsSync(join(f.socketDir, 'engine.token')), false);
  assert.equal(existsSync(join(f.socketDir, 'tui.token')), false);
  assert.equal(existsSync(`${f.running.journalPath}.lock`), false);
  const ledger = new SpendLedger(f.config.spend.cumulativeLamports, f.running.journalPath);
  ledger.close();
});

test('token conflict preserves foreign artifact and rolls back earlier token and ledger', async (t) => {
  const f = await setup(t);
  await f.running.close();
  const token = join(f.socketDir, 'tui.token');
  writeFileSync(token, 'foreign-token', { mode: 0o600 });
  await assert.rejects(startSignerServer(f.serverOptions));
  assert.equal(readFileSync(token, 'utf8'), 'foreign-token');
  assert.equal(existsSync(join(f.socketDir, 'engine.token')), false);
  assert.equal(existsSync(`${f.running.journalPath}.lock`), false);
});

test('normal cleanup preserves later foreign token and socket replacements', async (t) => {
  const f = await setup(t);
  const token = f.running.tokenFiles.engine;
  unlinkSync(token);
  writeFileSync(token, 'replacement', { mode: 0o600 });
  renameSync(f.running.engineSocketPath, `${f.running.engineSocketPath}.old`);
  mkdirSync(f.running.engineSocketPath);
  await f.running.close();
  assert.equal(readFileSync(token, 'utf8'), 'replacement');
  assert.equal(existsSync(f.running.engineSocketPath), true);
});

test('crash after reservation is never-broadcast; crash after durable signature remains unknown across restart', async (t) => {
  for (const phase of ['beforeSign', 'afterSignaturePersisted'] as const) {
    const destination = randomAddress();
    const f = await startTestSigner({
      destinations: [destination],
      testHooks: {
        [phase]: () => {
          throw new Error('crash');
        },
      },
    });
    t.after(() => f.close());
    const tx = buildTransferTx({ from: f.fixture.address, to: destination, lamports: 1000 });
    assert.equal(
      (await f.running.service.handle('engine', JSON.stringify({ type: 'sign', transaction: tx }))).response.status,
      'error',
    );
    const id = f.running.ledger.reservations()[0]!.reservationId;
    await f.running.close();
    const restarted = await startSignerServer({ ...f.serverOptions, testHooks: undefined });
    t.after(() => restarted.close());
    assert.equal(restarted.ledger.spent(), 6000);
    const result = await restarted.service.reconcile(id);
    assert.equal(result.outcome, phase === 'beforeSign' ? 'never-broadcast' : 'unknown');
    assert.equal(restarted.ledger.spent(), phase === 'beforeSign' ? 0 : 6000);
  }
});

test('journal write failure produces no signature and torn journal fails closed', async (t) => {
  const f = await setup(t);
  await f.running.close();
  const running = await startSignerServer({
    ...f.serverOptions,
    ledgerHooks: {
      beforeJournalWrite: () => {
        throw new Error('disk full');
      },
    },
  });
  t.after(() => running.close());
  const result = await running.service.handle('engine', JSON.stringify({ type: 'sign', transaction: f.transaction }));
  assert.equal(result.response.code, 'E_LEDGER');
  assert.equal(result.response.signature, undefined);
  await running.close();
  writeFileSync(join(f.signerDir, 'dev.spend.journal'), '{"v":2');
  assert.throws(() => new SpendLedger(5_000_000, join(f.signerDir, 'dev.spend.journal')), /journal/i);
});

test('real socket authenticates, rejects outcome authority, and emits no generated key bytes', async (t) => {
  const f = await setup(t);
  const client = await connectClient(f.running.engineSocketPath, f.running.engineToken);
  t.after(() => client.close());
  const signed = await client.send({ type: 'sign', transaction: f.transaction });
  assert.equal(signed.status, 'signed');
  assert.equal((await client.send({ type: 'release', reservationId: signed.reservationId })).code, 'E_BAD_REQUEST');
  const forms = [f.fixture.seed, f.fixture.keypairBytes].flatMap(secretTextForms);
  for (const text of [
    ...client.lines,
    readFileSync(f.running.logPath!, 'utf8'),
    readFileSync(f.running.tracePath!, 'utf8'),
    readFileSync(f.running.journalPath, 'utf8'),
  ])
    assert.equal(findLeak(text, forms), null);
});

test('trusted RPC fee quote cannot exceed cap even when local instruction estimate is lower', async (t) => {
  const f = await setup(t);
  f.rpc.state.fee = 2_005_000;
  const response = await f.send({ type: 'sign', transaction: f.transaction });
  assert.equal(response.code, 'E_SPEND_PER_TX');
  assert.equal(f.running.ledger.spent(), 0);
});

test('late trusted confirmation overrides an earlier absence proof and restores the charge', async (t) => {
  const f = await setup(t);
  const signed = await f.send({ type: 'sign', transaction: f.transaction });
  f.rpc.state.height = 1001;
  f.rpc.state.slot = 101;
  assert.equal(
    (await f.send({ type: 'reconcile', reservationId: signed.reservationId })).outcome,
    'expired-proven-absent',
  );
  assert.equal(f.running.ledger.spent(), 0);
  f.rpc.state.signatureStatus = { confirmationStatus: 'finalized', err: null };
  assert.equal((await f.send({ type: 'reconcile', reservationId: signed.reservationId })).outcome, 'confirmed');
  assert.equal(f.running.ledger.spent(), 6000);
});

test('unauthorized development profiles cannot issue keys', async () => {
  const signerDir = join(makeTempDir(), 'keys');
  for (const profile of [
    { kind: 'mainnet', endpoint: 'https://api.mainnet-beta.solana.com' },
    { kind: 'testnet', endpoint: 'https://api.testnet.solana.com' },
    { kind: 'devnet', endpoint: 'https://api.devnet.solana.com', genesisHash: 'wrong', authorization: 'user-approved' },
    { kind: 'local', endpoint: 'http://127.0.0.1:8899', genesisHash: 'local', processId: 'claimed', pid: process.pid },
  ])
    assert.throws(() => generateSignerKeypair({ signerDir, alias: 'dev', profile } as never), /profile|development/i);
});

test('presigned messages, foreign fee payers and unlisted destinations are refused', async (t) => {
  const f = await setup(t);
  const presigned = Buffer.from(f.transaction, 'base64');
  presigned[1] = 1;
  assert.equal((await f.send({ type: 'sign', transaction: presigned.toString('base64') })).code, 'E_PRESIGNED');
  const foreign = buildTransferTx({ from: randomAddress(), to: f.destination, lamports: 1000 });
  assert.equal((await f.send({ type: 'sign', transaction: foreign })).code, 'E_ACCOUNT_NOT_ALLOWED');
  const unlisted = buildTransferTx({ from: f.fixture.address, to: randomAddress(), lamports: 1000 });
  assert.equal((await f.send({ type: 'sign', transaction: unlisted })).code, 'E_ACCOUNT_NOT_ALLOWED');
  assert.equal(f.running.ledger.spent(), 0);
});

test('socket tokens are not interchangeable or replaced by payload channel claims', async (t) => {
  const f = await setup(t);
  const client = await connectClient(f.running.engineSocketPath, null);
  t.after(() => client.close());
  assert.equal((await client.send({ type: 'hello', token: f.running.tuiToken, channel: 'engine' })).code, 'E_AUTH');
});

test('unknown failures suppress secret-bearing exception messages on every output boundary', async (t) => {
  const destination = randomAddress();
  let failureText = '';
  const f = await startTestSigner({
    destinations: [destination],
    testHooks: {
      beforeSign: () => {
        throw new Error(failureText);
      },
    },
  });
  t.after(() => f.close());
  const forms = [f.fixture.seed, f.fixture.keypairBytes].flatMap(secretTextForms);
  failureText = forms.join('\\n');
  assert.notEqual(findLeak(failureText, forms), null);
  const transaction = buildTransferTx({ from: f.fixture.address, to: destination, lamports: 1000 });
  const result = await f.running.service.handle('engine', JSON.stringify({ type: 'sign', transaction }));
  assert.equal(result.response.code, 'E_INTERNAL');
  for (const text of [
    result.line,
    readFileSync(f.running.logPath!, 'utf8'),
    readFileSync(f.running.tracePath!, 'utf8'),
    readFileSync(f.running.journalPath, 'utf8'),
  ])
    assert.equal(findLeak(text, forms), null);
  writeFileSync(f.fixture.path, failureText, { mode: 0o600 });
  assert.throws(
    () => loadIssuedKeypair({ signerDir: f.signerDir, alias: 'dev' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(findLeak(error.message, forms), null);
      return true;
    },
  );
});

test('concurrent distinct requests cannot exceed the durable cumulative cap', async (t) => {
  const destination = randomAddress();
  const f = await startTestSigner({
    destinations: [destination],
    configOverrides: { spend: { perTxLamports: 10000, cumulativeLamports: 6000 } },
  });
  t.after(() => f.close());
  const transactions = [1000, 999].map((lamports) =>
    buildTransferTx({ from: f.fixture.address, to: destination, lamports }),
  );
  const results = await Promise.all(
    transactions.map((transaction) =>
      f.running.service.handle('engine', JSON.stringify({ type: 'sign', transaction })),
    ),
  );
  assert.equal(results.filter((r) => r.response.status === 'signed').length, 1);
  assert.equal(results.filter((r) => r.response.code === 'E_SPEND_CUMULATIVE').length, 1);
  assert.equal(f.running.ledger.spent(), 6000);
});

test('signer-issued recent lifetime remains valid when the trusted latest blockhash advances', async (t) => {
  const f = await setup(t);
  assert.equal((await f.send({ type: 'lifetime' })).status, 'ok');
  f.rpc.state.blockhash = randomAddress();
  assert.equal((await f.send({ type: 'sign', transaction: f.transaction })).status, 'signed');
});
