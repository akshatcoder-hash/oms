/** Compatibility facts from pinned MIT/Apache-2.0 documentation; not inferred from CLI major versions. */
const corpus =
  'https://github.com/solana-foundation/solana-dev-skill/blob/c9da2624cc6baca5c8c2123ea50d92ef19f1c917/skills/solana-dev/references/';
const anchor = 'https://github.com/otter-sec/anchor/blob/8d9d1488d9b8af41b266d7513eea2e668adf15a2/docs/content/docs/';
export const RULES_VERSION = 'oms.toolchain/1';
export const RULES = {
  anchor: {
    source: corpus + 'compatibility-matrix.md#anchor-cli--anchor-lang-crate-compatibility',
    date: '2026-11-08',
  },
  pins: { source: anchor + 'references/anchor-toml.md', date: '2026-11-08' },
  crates: {
    source: corpus + 'compatibility-matrix.md#anchor--solana-crate-versions',
    date: '2026-11-08',
    minimumV4Anchor: '1.2.1',
  },
  duplicates: { source: corpus + 'compatibility-matrix.md#litesvm-rust-crate--version-selection', date: '2026-11-08' },
  client: {
    source: anchor + 'updates/release-notes/1-0-0.md',
    date: '2026-11-08',
    package: '@anchor-lang/core',
    legacyPackage: '@coral-xyz/anchor',
  },
  transaction: {
    source: corpus + 'compatibility-matrix.md#transaction-v1-simd-0385-minimum-versions',
    date: '2026-11-08',
    minimumKit: '8.0.0',
    recommendedWeb3: '3.1.1',
  },
  arch: { source: 'https://solana.com/upgrades/sbpfv3-programs', date: '2026-11-08', pinnedDefault: 'v3' },
  advisory: {
    source: 'https://github.com/otter-sec/anchor/security/advisories/GHSA-c6rc-8jpp-2fgc',
    date: '2026-11-08',
    affected: ['1.0.0', '1.0.1'],
    status: 'CONFIRMED',
  },
} as const;
export type RuleId = keyof typeof RULES;
export const PINNED = {
  anchor: '1.2.2',
  solana: '4.4.1',
  platformTools: '1.58',
  packageManager: 'npm',
  arch: RULES.arch.pinnedDefault,
} as const;
