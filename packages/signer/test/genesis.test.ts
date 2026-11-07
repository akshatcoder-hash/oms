import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { getBase58Codec } from '@solana/kit';
import { DEVNET_GENESIS_HASH, launchLocalProfile, ProfileRpc, validateProfile } from '../src/profile.ts';

// Captured from the public Solana RPCs (getGenesisHash) on 2026-11-07, independent of src/profile.ts.
// A shortened chain identifier once shipped in the gateway; real RPCs return the full 32-byte hash.
const REAL = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

test('captured real genesis hashes are full 32-byte values', () => {
  for (const hash of Object.values(REAL)) assert.equal(getBase58Codec().encode(hash).length, 32);
});

test('the devnet profile constant is the real devnet genesis, not a shortened identifier', () => {
  assert.equal(DEVNET_GENESIS_HASH, REAL.devnet);
});

test('a real devnet RPC passes the identity check and a real mainnet RPC does not', async t => {
  let genesis = REAL.devnet;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: genesis }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = new ProfileRpc(validateProfile({ kind: 'devnet', endpoint, genesisHash: REAL.devnet, authorization: 'user-approved' }));
  await rpc.assertIdentity();
  genesis = REAL.mainnet;
  await assert.rejects(rpc.assertIdentity(), /genesis differs/);
});

test('local development profiles refuse every real public cluster genesis before spawning', () => {
  for (const [cluster, genesisHash] of Object.entries(REAL)) {
    assert.throws(
      () => launchLocalProfile({ executable: process.execPath, args: ['-e', ''], endpoint: 'http://127.0.0.1:8899', genesisHash }),
      /isolated development genesis/,
      `${cluster} genesis must be refused`,
    );
  }
});
