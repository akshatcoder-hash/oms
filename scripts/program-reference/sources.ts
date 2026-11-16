// The program list and the pinned source of each interface. Changing a pin or adding a program here and re-running
// scripts/gen-program-reference.ts is the only way the checked-in data changes.
/** idl: a JSON IDL (Codama, Anchor or Shank, detected from the file); idl-js: an IDL exported as a JS object literal. */
/** idl-count: a Codama IDL whose only instruction starts with a count-prefixed list instead of a tag. */
export type SourceKind = 'idl' | 'idl-count' | 'idl-js' | 'rust-enum' | 'precompile';

/** An official TypeScript client: the generator checks the exact npm version's manifest carries `package` as its name, and that `evidence` (a pinned repo manifest or README) contains `needle`, the package name unless given. */
export interface ClientSpec { package: string; version: string; evidence: string; needle?: string }

export interface ProgramSpec {
  name: string;
  id: string;
  purpose: string;
  /** Deployment guidance verified from an installed SDK; excluded from the prompt index. */
  deploymentNote?: string;
  kind: SourceKind;
  /** Pinned: a commit-addressed raw GitHub URL or an exact-version npm CDN URL. */
  url: string;
  /** Commit or package@version the url is pinned to. */
  version: string;
  licence: string;
  /** Set when the licence is outside the allowlist (MIT, Apache-2.0, BSD, CC-BY-4.0, CC0) or unclear. */
  factsOnly?: true;
  /** Text appended to the program's line in the prompt index when its instruction list is capped. */
  indexHint?: string;
  /** The address the IDL itself declares when it is not the program's id (the Core BPF build of a loader). */
  idlAddress?: string;
  /** Other documents that must contain the program id, besides the IDL's own address. */
  idSources: string[];
  /** Official TypeScript clients of the program, when one is published on npm. */
  clients?: ClientSpec[];
  /** Entry in the pinned ranking snapshot that justifies the program's place on the list. */
  rank?: { list: 'dex' | 'tvl'; name: string };
  /** rust-enum: the enum to read and the instruction-tag width in bytes. precompile: the offsets struct. */
  rust?: { enumName?: string; width?: 1 | 4; offsetsStruct?: string };
}

const raw = (repo: string, sha: string, path: string): string => `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
const npm = (pkg: string, version: string, path: string): string => `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${path}`;
/** A client whose own npm manifest is the evidence: used where the generator already reads the program's IDL from that package. */
const npmClient = (pkg: string, version: string): ClientSpec[] => [{ package: pkg, version, evidence: npm(pkg, version, 'package.json') }];
/** A client whose source repo, pinned at `sha`, carries a package.json under `path` that names it. */
const repoClient = (pkg: string, version: string, repo: string, sha: string, path: string): ClientSpec[] => [{ package: pkg, version, evidence: raw(repo, sha, path) }];

const PROGRAM = 'solana-program';
const SDK_SHA = '617887a6f8a306a6ca94b5907eaa3772db43a54b';
const sdk = (path: string): string => raw('anza-xyz/solana-sdk', SDK_SHA, path);
const SDK_IDS = sdk('sdk-ids/src/lib.rs');
const SPL_SHA = '264ca72de06b0c2b45c0b15d298000fe3f82db2e';
const PYTH_SHA = '4d7e5ba3fa35f294706d41e1cc299b0b090eca7d';
const CARBON_SHA = 'c23cae8b6360da5cb57a22e17ca993872370293d';
const carbon = (decoder: string): string => raw('sevenlabs-hq/carbon', CARBON_SHA, `decoders/${decoder}-decoder/src/lib.rs`);

/** A solana-program/<repo> program described by the repo's idl.json, Apache-2.0. */
const programRepo = (repo: string, sha: string, spec: Pick<ProgramSpec, 'name' | 'id' | 'purpose' | 'idSources' | 'idlAddress' | 'indexHint'>, client?: [pkg: string, version: string]): ProgramSpec => ({
  ...spec, kind: 'idl', ...(client ? { clients: repoClient(client[0], client[1], `${PROGRAM}/${repo}`, sha, 'clients/js/package.json') } : {}), url: raw(`${PROGRAM}/${repo}`, sha, 'idl.json'), version: `${PROGRAM}/${repo}@${sha}`, licence: 'Apache-2.0' });

const APACHE = 'Apache-2.0';
const MIT = 'MIT';

export const NATIVE: ProgramSpec[] = [
  programRepo('system', '0e7dc5d918e2d404bbbe57542afdd56b242c3ce5', { name: 'System', id: '11111111111111111111111111111111',
    purpose: 'Create accounts, transfer SOL, allocate and assign account data, durable nonces', idSources: [SDK_IDS, carbon('system-program')] }, ['@solana-program/system', '0.16.0']),
  programRepo('stake', '05a735434d17431109c5f1a3458cf34481854b58', { name: 'Stake', id: 'Stake11111111111111111111111111111111111111',
    purpose: 'Native SOL staking: stake accounts, delegation, split, merge, withdraw', idSources: [SDK_IDS, carbon('stake-program')] }, ['@solana-program/stake', '0.11.0']),
  { name: 'Vote', id: 'Vote111111111111111111111111111111111111111', purpose: 'Validator vote accounts: authorize, withdraw, commission, vote state updates',
    kind: 'rust-enum', url: sdk('vote-interface/src/instruction.rs'), version: `anza-xyz/solana-sdk@${SDK_SHA}`, licence: APACHE, idSources: [SDK_IDS],
    rust: { enumName: 'VoteInstruction', width: 4 } },
  { ...programRepo('config', '933fd46edeffa0ac0a7e27d97848bdc9743e7468', { name: 'Config', id: 'Config1111111111111111111111111111111111111',
    purpose: 'Store configuration data in accounts controlled by a set of signers', idSources: [SDK_IDS] }), kind: 'idl-count' },
  programRepo('compute-budget', 'e189b8ca25ecc283354b96f12cdcd6d7f4246921', { name: 'Compute Budget', id: 'ComputeBudget111111111111111111111111111111',
    purpose: 'Set the compute unit limit and price, heap size and loaded-accounts limit of a transaction', idSources: [SDK_IDS] }, ['@solana-program/compute-budget', '0.20.0']),
  programRepo('address-lookup-table', 'b91a5532606c1d179418d41782312391cc08180c', { name: 'Address Lookup Table', id: 'AddressLookupTab1e1111111111111111111111111',
    purpose: 'On-chain address tables that let versioned transactions reference more accounts', idSources: [SDK_IDS, carbon('address-lookup-table')] }, ['@solana-program/address-lookup-table', '0.16.0']),
  programRepo('loader-v3', 'b9c8ab343229851ebaa1607ec64b1d9a9a3ffc41', { name: 'BPF Loader Upgradeable', id: 'BPFLoaderUpgradeab1e11111111111111111111111',
    purpose: 'Deploy, upgrade, close and set the authority of upgradeable programs', idSources: [SDK_IDS],
    idlAddress: 'CoreBPFLoaderUpgradeab1e1111111111111111111' }, ['@solana-program/loader-v3', '0.8.0']),
  { name: 'BPF Loader', id: 'BPFLoader2111111111111111111111111111111111', purpose: 'Legacy non-upgradeable loader: write program bytes and finalize',
    kind: 'rust-enum', url: sdk('loader-v2-interface/src/lib.rs'), version: `anza-xyz/solana-sdk@${SDK_SHA}`, licence: APACHE, idSources: [SDK_IDS],
    rust: { enumName: 'LoaderInstruction', width: 4 } },
  programRepo('loader-v4', '1ea51f3db973474d3963c732c34dd7820649ee2f', { name: 'Loader v4', id: 'LoaderV411111111111111111111111111111111111',
    purpose: 'Newer program loader: write, copy, deploy, retract and finalize programs', idSources: [SDK_IDS],
    idlAddress: 'CoreBPFLoaderV41111111111111111111111111111' }),
  programRepo('token', 'ef37669b93adc060f2524c37d3c4a264695b2eed', { name: 'SPL Token', id: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    purpose: 'Fungible token mints and accounts: mint, transfer, approve, burn, freeze', idSources: [carbon('token-program')] }, ['@solana-program/token', '0.18.0']),
  programRepo('token-2022', 'e8ca680ca8aeb12f9598524b003c776c6a4168f2', { name: 'Token-2022', id: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    purpose: 'SPL Token superset with mint and account extensions (transfer fees, hooks, metadata, confidential transfers)', idSources: [carbon('token-2022')],
    indexHint: 'extension instructions (each family has initialize/update calls): transfer fee, confidential transfer and mint/burn, default account state, memo transfer, CPI guard, interest bearing, permanent delegate, transfer hook, metadata and group pointers, token metadata, token group and member, pausable, scaled UI amount, permissioned burn' }, ['@solana-program/token-2022', '0.20.1']),
  { ...programRepo('associated-token-account', 'fbf5379e7398ac8b231c73ee8a9ff677b43dd0ec', { name: 'Associated Token Account', id: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    purpose: 'Create the canonical token account of a wallet and mint', idSources: [carbon('associated-token-account')] }),
    // The ATA repo publishes no client of its own; the Token client generates the associated-token instructions.
    clients: [{ package: '@solana-program/token', version: '0.18.0', evidence: npm('@solana-program/token', '0.18.0', 'dist/types/generated/instructions/createAssociatedToken.d.ts'), needle: 'CreateAssociatedTokenInstruction' }] },
  programRepo('memo', '4dbf35a66dbcc558684182e5f5fff48766a99a6b', { name: 'Memo', id: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    purpose: 'Attach a UTF-8 memo to a transaction, optionally checked against signers; accepts arbitrary data, so memo variations are payload-only (the installed memo client may target the legacy Memo program id, which also accepts arbitrary data)', idSources: [carbon('memo-program')],
    idlAddress: 'Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH' }, ['@solana-program/memo', '0.16.0']),
  { name: 'Stake Pool', id: 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy', purpose: 'SPL stake pools that issue liquid staking tokens (most SOL liquid staking runs on it)',
    kind: 'rust-enum', url: raw(`${PROGRAM}/stake-pool`, '394c20bef2e00a0015da0fc08a807e4ddf37afdc', 'program/src/instruction.rs'),
    version: `${PROGRAM}/stake-pool@394c20bef2e00a0015da0fc08a807e4ddf37afdc`, licence: APACHE,
    idSources: [raw(`${PROGRAM}/stake-pool`, '394c20bef2e00a0015da0fc08a807e4ddf37afdc', 'program/src/lib.rs')],
    rank: { list: 'tvl', name: 'Sanctum Validator LSTs' }, rust: { enumName: 'StakePoolInstruction', width: 1 },
    clients: repoClient('@solana/spl-stake-pool', '1.1.8', `${PROGRAM}/stake-pool`, '394c20bef2e00a0015da0fc08a807e4ddf37afdc', 'clients/js-legacy/package.json') },
  { name: 'SPL Single Pool', id: 'SVSPxpvHdN29nkVg9rPapPNDddN5DipNLRUFhyjFThE', purpose: 'Single-validator stake pools: one pool and liquid token per validator, deposit and withdraw stake or SOL',
    kind: 'rust-enum', url: raw(`${PROGRAM}/single-pool`, '0e77ea057db1219a7c8fdb2f551e913161f71100', 'program/src/instruction.rs'),
    version: `${PROGRAM}/single-pool@0e77ea057db1219a7c8fdb2f551e913161f71100`, licence: APACHE,
    idSources: [raw(`${PROGRAM}/single-pool`, '0e77ea057db1219a7c8fdb2f551e913161f71100', 'program/src/lib.rs'), raw(`${PROGRAM}/single-pool`, '0e77ea057db1219a7c8fdb2f551e913161f71100', 'program/program-id.md')],
    rust: { enumName: 'SinglePoolInstruction', width: 1 },
    clients: [...repoClient('@solana/spl-single-pool', '3.0.1', `${PROGRAM}/single-pool`, '0e77ea057db1219a7c8fdb2f551e913161f71100', 'clients/js/package.json'),
      ...repoClient('@solana/spl-single-pool-classic', '3.0.1', `${PROGRAM}/single-pool`, '0e77ea057db1219a7c8fdb2f551e913161f71100', 'clients/js-legacy/package.json')] },
  { name: 'Governance', id: 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', purpose: 'SPL Governance (Realms): realms, proposals, voting, treasuries; besides this shared instance, many DAOs run their own deployment of the same program under another id, listed with each realm in the public Realms registry (governance-ui public/realms/mainnet-beta.json, field programId)',
    kind: 'rust-enum', url: raw('solana-labs/solana-program-library', SPL_SHA, 'governance/program/src/instruction.rs'),
    version: `solana-labs/solana-program-library@${SPL_SHA}`, licence: APACHE, idSources: [raw('solana-labs/solana-program-library', SPL_SHA, 'governance/README.md')],
    rust: { enumName: 'GovernanceInstruction', width: 1 },
    clients: [{ package: '@solana/spl-governance', version: '0.3.28', evidence: raw('solana-labs/solana-program-library', SPL_SHA, 'governance/README.md') }] },
  { name: 'Name Service', id: 'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX', purpose: 'SPL Name Service: name records for domains (.sol) and other names',
    kind: 'rust-enum', url: raw('solana-labs/solana-program-library', SPL_SHA, 'name-service/program/src/instruction.rs'),
    version: `solana-labs/solana-program-library@${SPL_SHA}`, licence: APACHE, idSources: [raw('solana-labs/solana-program-library', SPL_SHA, 'name-service/program/src/lib.rs'), carbon('name-service')],
    rust: { enumName: 'NameRegistryInstruction', width: 1 },
    clients: repoClient('@solana/spl-name-service', '0.2.1', 'solana-labs/solana-program-library', SPL_SHA, 'name-service/js/package.json') },
  programRepo('feature-gate', '2d6b15528d8b6d73d3b3ca933e6e64352f2bc318', { name: 'Feature Gate', id: 'Feature111111111111111111111111111111111111',
    purpose: 'Runtime feature activation: revoke a pending activation', idSources: [SDK_IDS] }),
  { name: 'Ed25519 Precompile', id: 'Ed25519SigVerify111111111111111111111111111', purpose: 'Verify ed25519 signatures; the transaction fails if any is invalid',
    kind: 'precompile', url: sdk('ed25519-program/src/lib.rs'), version: `anza-xyz/solana-sdk@${SDK_SHA}`, licence: APACHE, idSources: [SDK_IDS],
    rust: { offsetsStruct: 'Ed25519SignatureOffsets' } },
  { name: 'Secp256k1 Precompile', id: 'KeccakSecp256k11111111111111111111111111111', purpose: 'Verify secp256k1 signatures (Ethereum-style address recovery check)',
    kind: 'precompile', url: sdk('secp256k1-program/src/lib.rs'), version: `anza-xyz/solana-sdk@${SDK_SHA}`, licence: APACHE, idSources: [SDK_IDS],
    rust: { offsetsStruct: 'SecpSignatureOffsets' } },
  { name: 'Secp256r1 Precompile', id: 'Secp256r1SigVerify1111111111111111111111111', purpose: 'Verify secp256r1 (P-256) signatures, e.g. passkeys',
    kind: 'precompile', url: sdk('secp256r1-program/src/lib.rs'), version: `anza-xyz/solana-sdk@${SDK_SHA}`, licence: APACHE, idSources: [SDK_IDS],
    rust: { offsetsStruct: 'Secp256r1SignatureOffsets' } },

];

// Ranked on DefiLlama's Solana tables (see ranking.json); infrastructure programs carry no rank.
export const APPLICATIONS: ProgramSpec[] = [
  { name: 'Pump', id: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', purpose: 'pump.fun bonding-curve token launches: create, buy, sell, migrate',
    kind: 'idl', url: npm('@pump-fun/pump-sdk', '4.3.1', 'src/idl/pump.json'), version: '@pump-fun/pump-sdk@4.3.1', licence: MIT,
    idSources: [carbon('pumpfun')], rank: { list: 'dex', name: 'pump.fun' }, clients: npmClient('@pump-fun/pump-sdk', '4.3.1') },
  { name: 'PumpSwap', id: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', purpose: 'Constant-product AMM where graduated pump.fun tokens trade',
    kind: 'idl', url: npm('@pump-fun/pump-sdk', '4.3.1', 'src/idl/pump_amm.json'), version: '@pump-fun/pump-sdk@4.3.1', licence: MIT,
    idSources: [carbon('pump-swap')], rank: { list: 'dex', name: 'PumpSwap' }, clients: npmClient('@pump-fun/pump-sdk', '4.3.1') },
  { name: 'Pump Fees', id: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', purpose: 'Fee configuration and sharing for pump.fun creators',
    kind: 'idl', url: npm('@pump-fun/pump-sdk', '4.3.1', 'src/idl/pump_fees.json'), version: '@pump-fun/pump-sdk@4.3.1', licence: MIT,
    idSources: [carbon('pump-fees')], clients: npmClient('@pump-fun/pump-sdk', '4.3.1') },
  { name: 'Orca Whirlpools', id: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', purpose: 'Concentrated-liquidity AMM: pools, positions, swaps, rewards',
    // @orca-so/whirlpools@8.0.1/dist/index.js.map sourcesContent: src/increaseLiquidity.ts,
    // decreaseLiquidity.ts, harvest.ts and swap.ts build the position-owner/swap flows;
    // createPool.ts uses initializePoolV2 with a funder and an existing config/fee tier;
    // pool.ts fetchWhirlpoolsByTokenPair returns initialized flags and reads the config.
    // @orca-so/whirlpools-client@7.0.0/dist/index.js.map sourcesContent:
    // src/generated/accounts/whirlpoolsConfig.ts exports fetchWhirlpoolsConfig;
    // src/generated/instructions/{initializeFeeTier,setFeeRate,collectProtocolFeesV2}.ts
    // require feeAuthority or collectProtocolFeesAuthority signers.
    deploymentNote: 'On existing pools, wallets can open their own positions (openConcentratedPosition), add (increasePosLiquidity), remove (decreaseLiquidity), collect fees (harvestPosition), close (closePosition) and swap (swap). createConcentratedLiquidityPool uses an existing config/fee tier with supported tokens. Find pools via fetchWhirlpoolsByTokenPair (initialized=true); fetchWhirlpoolsConfig reads the config. initializeFeeTier/setFeeRate require feeAuthority; collectProtocolFeesV2 requires collectProtocolFeesAuthority. Refusal there does not block wallet flows.',
    kind: 'idl', url: npm('@orca-so/whirlpools-sdk', '0.22.0', 'dist/artifacts/whirlpool.json'), version: '@orca-so/whirlpools-sdk@0.22.0',
    licence: 'Orca License (custom)', factsOnly: true, idSources: [carbon('orca-whirlpool')], rank: { list: 'dex', name: 'Orca DEX' },
    clients: [{ package: '@orca-so/whirlpools-client', version: '7.0.0', evidence: raw('orca-so/whirlpools', 'cc683ec92acb5e7606caa3d8e514d9383e9c7c11', 'README.md') }] },
  { name: 'Raydium AMM v4', id: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', purpose: 'Legacy constant-product AMM paired with an OpenBook market',
    // @raydium-io/raydium-sdk-v2@0.2.84-alpha/src/raydium/liquidity/liquidity.ts:
    // swap/addLiquidity/removeLiquidity use owner token accounts; createPoolV4 uses marketInfo;
    // getPoolInfoFromRpc returns pool keys. liquidity/instruction.ts builds these with a user
    // signer and exposes no admin/config-update builders (the package also ships no AMM v4 IDL),
    // so no unverified admin instruction names or authority constraints are asserted here.
    // src/api/api.ts implements fetchPoolByMints; src/raydium/raydium.ts exposes liquidity/api.
    deploymentNote: 'On active pools, wallets can swap and add/remove their own liquidity with raydium.liquidity.swap, addLiquidity and removeLiquidity. createPoolV4 creates a pool for an existing OpenBook market. Find pools via raydium.api.fetchPoolByMints; raydium.liquidity.getPoolInfoFromRpc loads pool keys. The SDK exposes no admin instruction builders, so admin permissions must be checked separately; these wallet flows use the user signer.',
    kind: 'rust-enum', url: raw('raydium-io/raydium-amm', '91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6', 'program/src/instruction.rs'),
    version: 'raydium-io/raydium-amm@91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6', licence: APACHE,
    idSources: [raw('raydium-io/raydium-amm', '91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6', 'program/src/lib.rs'), carbon('raydium-amm-v4')],
    rank: { list: 'dex', name: 'Raydium AMM' }, rust: { enumName: 'AmmInstruction', width: 1 }, clients: npmClient('@raydium-io/raydium-sdk-v2', '0.2.84-alpha') },
  ...[
    ['Raydium CLMM', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'Concentrated-liquidity AMM: pools, positions, swaps, rewards', 'raydium_clmm/raydium_clmm.json', 'raydium-clmm', 'Raydium AMM'],
    ['Raydium CPMM', 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'Constant-product AMM without an order book (CP-Swap)', 'raydium_cpmm/raydium_cp_swap.json', 'raydium-cpmm', 'Raydium AMM'],
    ['Raydium Launchpad', 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', 'LaunchLab bonding-curve token launches that graduate to Raydium pools', 'raydium_launchpad/raydium_launchpad.json', 'raydium-launchpad', 'LaunchLab'],
  ].map(([name, id, purpose, path, decoder, rank]): ProgramSpec => ({ name: name!, id: id!, purpose: purpose!, kind: 'idl',
    url: raw('raydium-io/raydium-idl', 'e7e0c96fe77bcf6a020b84a44c47a722aac8e359', path!), version: 'raydium-io/raydium-idl@e7e0c96fe77bcf6a020b84a44c47a722aac8e359',
    // @raydium-io/raydium-sdk-v2@0.2.84-alpha/src/raydium/clmm/clmm.ts:
    // the named position/swap methods use owner accounts, harvestAllRewards builds a zero-liquidity
    // decrease to collect fees/rewards, createPool passes ammConfig.id, getPoolInfoFromRpc loads it.
    // clmm/instrument.ts setRewardParamsInstruction requires an authority signer;
    // setReward calls it through setRewardInstructions. src/api/api.ts implements discovery.
    ...(name === 'Raydium CLMM' ? { deploymentNote: 'On active pools, raydium.clmm lets wallets manage their own positions with openPositionFromLiquidity, increasePositionFromLiquidity, decreaseLiquidity and closePosition, swap with swap, and collect fees/rewards with harvestAllRewards. createPool uses an existing config. Find pools via raydium.api.fetchPoolByMints and configs via raydium.api.getClmmConfigs; raydium.clmm.getPoolInfoFromRpc loads a pool. setReward uses the reward authority signer; refusal there does not block wallet flows.' } : {}),
    // @raydium-io/raydium-sdk-v2@0.2.84-alpha/src/raydium/cpmm/cpmm.ts:
    // swap/addLiquidity/withdrawLiquidity use owner accounts; createPool uses feeConfig.id;
    // getPoolInfoFromRpc loads pool/config state; createPoolWithPermission explicitly requires
    // wallet permissions. cpmm/instruction.ts initializeWithPermission includes permissionPda,
    // unlike makeCreateCpmmPoolInInstruction. src/api/api.ts exports the discovery methods.
    ...(name === 'Raydium CPMM' ? { deploymentNote: 'On active pools, wallets can use raydium.cpmm.swap, addLiquidity and withdrawLiquidity with their own tokens/LP tokens. raydium.cpmm.createPool uses an existing fee config. Find pools via raydium.api.fetchPoolByMints and configs via raydium.api.getCpmmConfigs; raydium.cpmm.getPoolInfoFromRpc loads a pool. createPoolWithPermission requires a permission account; refusal there does not block ordinary createPool or existing-pool flows.' } : {}),
    licence: 'none declared', factsOnly: true, idSources: [carbon(decoder!)], rank: { list: 'dex', name: rank! }, clients: npmClient('@raydium-io/raydium-sdk-v2', '0.2.84-alpha') })),
  { name: 'Meteora DLMM', id: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', purpose: 'Discrete-bin liquidity AMM with dynamic fees',
    // @meteora-ag/dlmm@1.9.14/dist/index.js.map sourcesContent: src/dlmm/index.ts
    // implements all named DLMM methods; position/swap builders use the user's accounts,
    // createLbPair2 reads presetParameter2, getLbPairs/getAllPresetParameters scan accounts,
    // and setActivationPoint/setPairStatus pass lbPair.creator as signer.
    // src/dlmm/idl/idl.json: initialize_lb_pair2 has only the funder signer;
    // initialize_position, claim_fee2, close_position2 and swap record wallet signers.
    deploymentNote: 'On active pools, DLMM instance methods let wallets open/fund their own positions (initializePositionAndAddLiquidityByStrategy), add (addLiquidityByStrategy), remove (removeLiquidity), collect fees (claimSwapFee), close empty positions (closePosition) and swap (swap). DLMM.createLbPair2 uses an existing preset. Find pools/presets with DLMM.getLbPairs/DLMM.getAllPresetParameters; DLMM.create loads a pool. setActivationPoint/setPairStatus use the pool creator; refusal there does not block wallet flows.',
    kind: 'idl', url: raw('MeteoraAg/dlmm-sdk', '1532e540db41ac405dbf4c5bb2ddfceaa1f98ff1', 'idls/dlmm.json'), version: 'MeteoraAg/dlmm-sdk@1532e540db41ac405dbf4c5bb2ddfceaa1f98ff1',
    licence: 'none declared (repo); ISC (npm)', factsOnly: true, idSources: [carbon('meteora-dlmm')], rank: { list: 'dex', name: 'Meteora DLMM' },
    clients: repoClient('@meteora-ag/dlmm', '1.9.14', 'MeteoraAg/dlmm-sdk', '1532e540db41ac405dbf4c5bb2ddfceaa1f98ff1', 'ts-client/package.json') },
  { name: 'Meteora Dynamic AMM', id: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', purpose: 'Dynamic AMM pools whose idle liquidity is lent out through Meteora vaults',
    kind: 'idl', url: npm('@meteora-ag/dynamic-amm-sdk', '2.0.0', 'dist/esm/src/amm/idl.json'), version: '@meteora-ag/dynamic-amm-sdk@2.0.0', licence: MIT,
    idSources: [carbon('meteora-pools')], rank: { list: 'dex', name: 'Meteora DAMM V1' }, clients: npmClient('@meteora-ag/dynamic-amm-sdk', '2.0.0') },
  { name: 'Phoenix', id: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', purpose: 'On-chain central limit order book for spot markets',
    kind: 'idl', url: raw('Ellipsis-Labs/phoenix-v1', '6ae54af5f07f4d0ae8430b08cbe81d10432cd34c', 'idl/phoenix_v1.json'), version: 'Ellipsis-Labs/phoenix-v1@6ae54af5f07f4d0ae8430b08cbe81d10432cd34c',
    licence: MIT, idSources: [carbon('phoenix-v1')], rank: { list: 'dex', name: 'Phoenix Spot' }, clients: npmClient('@ellipsis-labs/phoenix-sdk', '2.0.3') },
  { name: 'OpenBook v2', id: 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb', purpose: 'Community-run on-chain order book (successor of Serum)',
    kind: 'idl', url: raw('openbook-dex/openbook-v2', 'f3e17421e675b083b584867594bf3cf4f675d156', 'idl/openbook_v2.json'), version: 'openbook-dex/openbook-v2@f3e17421e675b083b584867594bf3cf4f675d156',
    licence: 'GPL-3.0 and other terms by directory', factsOnly: true, idSources: [carbon('openbook-v2'), raw('openbook-dex/openbook-v2', 'f3e17421e675b083b584867594bf3cf4f675d156', 'programs/openbook-v2/src/lib.rs')], rank: { list: 'tvl', name: 'OpenBook' },
    clients: npmClient('@openbook-dex/openbook-v2', '0.2.10') },
  { name: 'Jupiter Aggregator v6', id: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', purpose: 'Swap router: executes a route plan across many AMMs in one instruction',
    kind: 'idl', url: raw('jup-ag/jupiter-cpi', '12bc5f67b94a2c3edc74d6e721a19442124a0bad', 'idl.json'), version: 'jup-ag/jupiter-cpi@12bc5f67b94a2c3edc74d6e721a19442124a0bad',
    licence: 'none declared', factsOnly: true, idSources: [carbon('jupiter-swap')] },
  ...[
    ['Jupiter Lend Liquidity', 'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC', 'Shared liquidity layer under Jupiter Lend earn and borrow', 'liquidity'],
    ['Jupiter Lend Earn', 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9', 'Jupiter Lend supply side: deposit tokens for yield', 'lending'],
    ['Jupiter Lend Vaults', 'jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi', 'Jupiter Lend borrow side: collateral vault positions', 'vaults'],
  ].map(([name, id, purpose, file]): ProgramSpec => ({ name: name!, id: id!, purpose: purpose!, kind: 'idl',
    url: raw('jup-ag/jupiter-lend', '7960a14a5a760abc41db3ed1395dc5cb56a1f8db', `target/idl/${file}.json`), version: 'jup-ag/jupiter-lend@7960a14a5a760abc41db3ed1395dc5cb56a1f8db',
    licence: 'none declared', factsOnly: true, idSources: [], rank: { list: 'tvl', name: 'Jupiter Lend' },
    clients: [{ package: '@jup-ag/lend', version: '0.4.0', evidence: raw('jup-ag/jupiter-lend', '7960a14a5a760abc41db3ed1395dc5cb56a1f8db', 'README.md') }] })),
  { name: 'Kamino Lend', id: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', purpose: 'Money market: deposit, borrow, liquidate, flash loans',
    kind: 'idl', url: npm('@kamino-finance/klend-sdk', '13.1.0', 'dist/idl/klend.json'), version: '@kamino-finance/klend-sdk@13.1.0',
    licence: 'BUSL-1.1 (repo); MIT (npm)', factsOnly: true, idSources: [carbon('kamino-lending'), raw('Kamino-Finance/klend', '686913ee421e0c5f3dc44c4c8344461ee0e4fb89', 'README.md')], rank: { list: 'tvl', name: 'Kamino Lend' },
    clients: npmClient('@kamino-finance/klend-sdk', '13.1.0') },
  { name: 'Kamino Vaults', id: 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd', purpose: 'Lending vaults that allocate deposits across Kamino Lend reserves',
    kind: 'idl', url: npm('@kamino-finance/klend-sdk', '13.1.0', 'dist/idl/kvault.json'), version: '@kamino-finance/klend-sdk@13.1.0',
    licence: 'BUSL-1.1 (repo); MIT (npm)', factsOnly: true, idSources: [raw('Kamino-Finance/kvault', '3b53fa0b9bd2f8ce52b9b7eeaa3025155edc7b1c', 'programs/kvault/src/program_id.rs')], clients: npmClient('@kamino-finance/klend-sdk', '13.1.0') },
  { name: 'marginfi v2', id: 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA', purpose: 'Lending and borrowing with shared bank accounts and health-checked margin accounts',
    kind: 'idl', url: npm('@mrgnlabs/marginfi-client-v2', '6.4.2', 'dist/idl/marginfi_0.1.8.json'), version: '@mrgnlabs/marginfi-client-v2@6.4.2', licence: MIT,
    idSources: [carbon('marginfi-v2')], rank: { list: 'tvl', name: 'marginfi Lending' }, clients: npmClient('@mrgnlabs/marginfi-client-v2', '6.4.2') },
  { name: 'Marinade', id: 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD', purpose: 'Marinade liquid staking: deposit SOL for mSOL, delayed unstake, liquidity pool',
    kind: 'idl-js', url: npm('@marinade.finance/marinade-ts-sdk', '6.1.0', 'dist/src/programs/idl/types/marinade_finance.js'), version: '@marinade.finance/marinade-ts-sdk@6.1.0',
    licence: 'All rights reserved (repo); ISC (npm)', factsOnly: true, idSources: [carbon('marinade-finance')], rank: { list: 'tvl', name: 'Marinade Liquid Staking' },
    clients: npmClient('@marinade.finance/marinade-ts-sdk', '6.1.0') },
  { name: 'Sanctum S Controller', id: '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx', purpose: 'Sanctum Infinity: multi-LST pool with swaps between liquid staking tokens',
    kind: 'idl', url: raw('igneous-labs/S', '66de438b9e049aacc193b5795d26ac055d86d770', 'idl/s_controller.json'), version: 'igneous-labs/S@66de438b9e049aacc193b5795d26ac055d86d770',
    licence: 'none declared', factsOnly: true, idSources: [raw('igneous-labs/S', '66de438b9e049aacc193b5795d26ac055d86d770', 'libs/s-controller-lib/src/lib.rs')],
    rank: { list: 'tvl', name: 'Sanctum Infinity' } },
  { name: 'Drift v2', id: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', purpose: 'Perpetuals and spot margin exchange with cross-margined user accounts',
    kind: 'idl', url: raw('drift-labs/protocol-v2', '13e8e9b8d614f3b62e3a65a8c372c819e6529aeb', 'sdk/src/idl/drift.json'), version: 'drift-labs/protocol-v2@13e8e9b8d614f3b62e3a65a8c372c819e6529aeb',
    licence: APACHE, idSources: [raw('drift-labs/protocol-v2', '13e8e9b8d614f3b62e3a65a8c372c819e6529aeb', 'programs/drift/src/lib.rs'), carbon('drift-v2')],
    rank: { list: 'tvl', name: 'Drift Trade' },
    clients: repoClient('@drift-labs/sdk', '2.163.0-beta.13', 'drift-labs/protocol-v2', '13e8e9b8d614f3b62e3a65a8c372c819e6529aeb', 'sdk/package.json') },
  { name: 'Pyth Receiver', id: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ', purpose: 'Pyth pull oracle: post and update verified price feed accounts',
    kind: 'idl-js', url: npm('@pythnetwork/pyth-solana-receiver', '0.17.0', 'dist/esm/idl/pyth_solana_receiver.mjs'), version: '@pythnetwork/pyth-solana-receiver@0.17.0', licence: APACHE,
    idSources: [raw('pyth-network/pyth-crosschain', PYTH_SHA, 'target_chains/solana/pyth_solana_receiver_sdk/src/lib.rs')],
    clients: npmClient('@pythnetwork/pyth-solana-receiver', '0.17.0') },
  { name: 'Pyth Push Oracle', id: 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT', purpose: 'Pyth push oracle: sponsored price feed accounts updated by a pusher',
    kind: 'idl-js', url: npm('@pythnetwork/pyth-solana-receiver', '0.17.0', 'dist/esm/idl/pyth_push_oracle.mjs'), version: '@pythnetwork/pyth-solana-receiver@0.17.0', licence: APACHE,
    idSources: [raw('pyth-network/pyth-crosschain', PYTH_SHA, 'target_chains/solana/pyth_solana_receiver_sdk/src/lib.rs')],
    clients: npmClient('@pythnetwork/pyth-solana-receiver', '0.17.0') },
  { name: 'Squads v4', id: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', purpose: 'Multisig wallets with vaults, config and transaction proposals, time locks and spending limits',
    kind: 'idl', url: npm('@sqds/multisig', '2.1.4', 'idl/squads_multisig_program.json'), version: '@sqds/multisig@2.1.4',
    licence: 'AGPL-3.0 (repo); MIT (npm)', factsOnly: true, idSources: [raw('Squads-Protocol/v4', '3a39735d0c56249bf2ce4b16b3229d7be87ad55f', 'README.md')],
    clients: npmClient('@sqds/multisig', '2.1.4') },
  ...[
    ['Metaplex Token Metadata', 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', 'Metadata, editions, collections and programmable NFT rules for tokens', 'mpl-token-metadata', '7ce760f9e010cb9819ffd7dd86986a44691bd1f8', 'idls/token_metadata.json', 'mpl-token-metadata', '4.0.0'],
    ['Metaplex Core', 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', 'Single-account NFT assets with a plugin system', 'mpl-core', 'baa67cc0c77abbc90a9e1bf9656825f54aea05d1', 'idls/mpl_core.json', 'mpl-core', '1.10.0'],
    ['Metaplex Bubblegum', 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY', 'Compressed NFTs stored in concurrent Merkle trees', 'mpl-bubblegum', '97c7b2722a65c14933a27a0f2fdb4153d3828e00', 'idls/bubblegum.json', 'bubblegum', '6.0.0'],
  ].map(([name, id, purpose, repo, sha, path, decoder, clientVersion]): ProgramSpec => ({ name: name!, id: id!, purpose: purpose!, kind: 'idl',
    url: raw(`metaplex-foundation/${repo}`, sha!, path!), version: `metaplex-foundation/${repo}@${sha}`,
    licence: 'Metaplex NFT Open Source License 1.0 (repo); Apache-2.0 (npm)', factsOnly: true, idSources: [carbon(decoder!)],
    clients: repoClient(`@metaplex-foundation/${repo}`, clientVersion!, `metaplex-foundation/${repo}`, sha!, 'clients/js/package.json') })),
  { name: 'Tensor Marketplace', id: 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp', purpose: 'Tensor NFT marketplace: list, buy, bid',
    kind: 'idl', url: raw('tensor-foundation/marketplace', '8be7f2c3d60c18871e0913b5f837408eeb69047d', 'program/idl.json'), version: 'tensor-foundation/marketplace@8be7f2c3d60c18871e0913b5f837408eeb69047d',
    licence: APACHE, idSources: [raw('tensor-foundation/marketplace', '8be7f2c3d60c18871e0913b5f837408eeb69047d', 'README.md')], rank: { list: 'tvl', name: 'Tensor' },
    clients: repoClient('@tensor-foundation/marketplace', '1.0.0', 'tensor-foundation/marketplace', '8be7f2c3d60c18871e0913b5f837408eeb69047d', 'clients/js/package.json') },
];

/** Programs whose whole lifecycle runs on accounts a wallet creates itself (at most the program's own global config besides),
 * with no pool, market or admin state to find first. Marked (standalone) in the index. */
export const STANDALONE: ReadonlySet<string> = new Set(['Governance', 'Name Service', 'Squads v4', 'Metaplex Token Metadata', 'Metaplex Core', 'Metaplex Bubblegum']);
