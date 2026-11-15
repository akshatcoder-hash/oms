/** The agent's workspace: the same GOAL.md, helper and visible check for every harness, plus this run's public wallet facts. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_FILES = ['GOAL.md', 'submit-tx', 'visible.test.ts'] as const;
export const WORKSPACE_SOURCE = fileURLToPath(new URL('../../solbench-harness/workspace/', import.meta.url));

export type Variant = 'basic' | 'swap';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYb';
export const SOL_LAMPORTS = 100_000_000_000;
/** Swap only: SPL token balances the wallet starts with (base units, 6 decimals each). */
export const SWAP_TOKENS = [
  { symbol: 'USDC', mint: USDC, amount: 10_000_000_000 },
  { symbol: 'USDT', mint: USDT, amount: 10_000_000_000 },
] as const;

export interface WalletFacts {
  publicKey: string;
  variant: Variant;
}

function walletJson(facts: WalletFacts) {
  return {
    publicKey: facts.publicKey,
    variant: facts.variant,
    sol: SOL_LAMPORTS / 1e9,
    tokens:
      facts.variant === 'swap'
        ? SWAP_TOKENS.map((t) => ({ symbol: t.symbol, mint: t.mint, amount: t.amount, decimals: 6 }))
        : [],
  };
}

/** A fresh committed repository (OMS works in a worktree of it; the other harnesses work in it directly). */
export function prepareWorkspace(repo: string, facts: WalletFacts): void {
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true, mode: 0o755 });
  for (const file of WORKSPACE_FILES) copyFileSync(join(WORKSPACE_SOURCE, file), join(repo, file));
  // F2 variant (labelled, not the frozen series): the visible check turns green only at this headline, so it cannot close the item after one pair.
  const visibleMin = Number(process.env.SOLBENCH_HARNESS_VISIBLE_MIN ?? 1);
  if (visibleMin !== 1) {
    const path = join(repo, 'visible.test.ts');
    writeFileSync(
      path,
      readFileSync(path, 'utf8')
        .replace(
          "headline >= 1, 'no pair counts yet'",
          `headline >= ${visibleMin}, 'fewer than ${visibleMin} pairs count yet'`,
        )
        .replace('at least one pair counts', `at least ${visibleMin} pairs count`),
    );
  }
  writeFileSync(join(repo, 'WALLET.json'), JSON.stringify(walletJson(facts), null, 2) + '\n');
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: repo, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-q');
  git('config', 'user.name', 'OMS solbench-harness');
  git('config', 'user.email', 'solbench@invalid.test');
  git('add', '.');
  git('commit', '-qm', 'solbench-harness workspace');
}
