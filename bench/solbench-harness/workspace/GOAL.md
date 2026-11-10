# Goal

Maximise the number of unique (program id, first instruction-data byte) pairs in successfully executed transactions.

## Environment

- A Solana mainnet fork (Surfpool 0.10.4). Programs and accounts that exist on mainnet exist here. Nothing you do here reaches mainnet.
- Read the fork with JSON-RPC at `$SOLANA_RPC_URL`: `get*` methods, `isBlockhashValid` and `simulateTransaction`. Nothing else is
  available there: no airdrops, no cheatcodes, no `sendTransaction`.
- Your wallet is in `./WALLET.json`: its public key, the variant of this run and what the wallet holds at the start.
  You do not have the wallet's private key, and you do not need it.
- Execute a transaction with `./submit-tx <base64 transaction>`. Build it with the wallet as fee payer and leave the wallet's
  signature empty. The environment signs for the wallet and executes the transaction on the fork. If the transaction needs another
  signer (for example a new account's keypair), sign for it yourself before you submit.
  It prints JSON: `ok`, `signature`, `error`, `logs`, `newPairs`, `score`, `submissionsLeft`, `secondsLeft`.
- `./submit-tx --status` prints the wallet, the score so far and the budget left. It does not use a submission.
- `node --test visible.test.ts` passes once at least one pair counts.
- `./node_modules` (read-only) has @solana/kit, @solana/web3.js (v1), @anchor-lang/core, @solana/spl-token, the @solana-program/*
  clients, and the DeFi SDKs @orca-so/whirlpools, @raydium-io/raydium-sdk-v2 and @meteora-ag/dlmm (this version of
  @meteora-ag/dlmm loads with `require`, not `import`). `node` and `bun` are installed. Do not add dependencies.

## Budget

At most 50 submissions and 30 minutes of wall clock, whichever comes first. Every `./submit-tx` call counts, also an invalid or
failing one. After that, `./submit-tx` refuses.

## Scoring

- A pair is the program id of a top-level instruction and the first byte of that instruction's data. Each pair counts once per run.
- Only transactions that executed successfully count. An instruction with empty data has no first byte and counts nothing.
- Memo (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) and Memo v1 (`Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`) never count.
- Instructions on programs that accept arbitrary instruction data are reported separately and are not in the headline score:
  SPL Noop (`noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV`), Metaplex Noop (`mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3`), and
  every program that your own transactions deploy or upgrade.
- The headline score is the count of the remaining pairs.
