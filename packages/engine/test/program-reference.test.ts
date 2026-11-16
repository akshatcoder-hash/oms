import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  adaptAnchor,
  adaptCodama,
  adaptRustEnum,
  anchorDiscriminator,
} from '../../../scripts/program-reference/adapters.ts';
import { validateProgramReference } from '../../../scripts/program-reference/validate.ts';
import type { ProgramReferenceData } from '../src/runtime/program-reference-data.ts';
import {
  installedProgramClients,
  lookupProgramReference,
  PROGRAM_REFERENCE_RESULT_LIMIT,
  PROGRAM_REFERENCE_TOOL,
  programReference,
  programReferenceExtension,
  programReferenceIndex,
} from '../src/runtime/program-reference.ts';
import { omsSystemPrompt, sessionToolNames } from '../src/runtime/session.ts';

const data = programReference();
const program = (name: string) => data.programs.find((p) => p.name === name)!;

test('the generated file validates: ids, discriminator widths, unique names, facts-only entries', () => {
  assert.deepEqual(validateProgramReference(data), []);
  assert.ok(data.programs.length >= 40);
  for (const required of [
    'System',
    'Stake',
    'Vote',
    'Config',
    'Compute Budget',
    'Address Lookup Table',
    'BPF Loader Upgradeable',
    'SPL Token',
    'Token-2022',
    'Associated Token Account',
    'Memo',
    'Stake Pool',
    'Governance',
    'Name Service',
    'Feature Gate',
    'Ed25519 Precompile',
    'Secp256k1 Precompile',
    'Secp256r1 Precompile',
  ]) {
    assert.ok(
      data.programs.some((p) => p.name === required),
      `${required} is present`,
    );
  }
  assert.ok(
    program('Token-2022').instructions.some(
      (ix) => ix.name === 'initializeTransferFeeConfig' && ix.discriminator === '1a00',
    ),
    'Token-2022 extension instructions carry their sub-tag',
  );
});

test('the validator rejects a bad id, a duplicate name, a wrong width and a facts-only entry with flags', () => {
  const broken: ProgramReferenceData = structuredClone(data);
  const token = broken.programs.find((p) => p.name === 'SPL Token')!;
  token.id = 'not-base58-0OIl';
  token.instructions.push({ ...token.instructions[0]!, discriminator: '010203' });
  const orca = broken.programs.find((p) => p.name === 'Orca Whirlpools')!;
  orca.instructions[0]!.args = [{ name: 'copied', type: 'u64' }];
  const problems = validateProgramReference(broken).join('\n');
  assert.match(problems, /SPL Token: id .* is not base58 of 32 bytes/);
  assert.match(problems, /duplicate instruction/);
  assert.match(problems, /3-byte discriminator in a u8 program/);
  assert.match(problems, /Orca Whirlpools\..*factsOnly entry carries more than names/);
});

test('known tags come back from the lookup tool', () => {
  assert.match(lookupProgramReference('SPL Token', 'Transfer'), /starts with 03 \(bytes \[3\]\)/);
  assert.match(lookupProgramReference('SPL Token', 'TransferChecked'), /starts with 0c \(bytes \[12\]\)/);
  assert.match(
    lookupProgramReference('System', 'Transfer'),
    /System 1{32} \/ transferSol\nCreate accounts, transfer SOL, allocate and assign account data, durable nonces\nInstruction data starts with 02000000 \(bytes \[2,0,0,0\]\)/,
  );
  assert.match(lookupProgramReference('Associated Token Account', 'CreateIdempotent'), /starts with 01 /);
  assert.match(lookupProgramReference('Compute Budget', 'SetComputeUnitLimit'), /starts with 02 /);
  assert.match(lookupProgramReference('Jupiter Aggregator v6', 'route'), /e517cb977ae3ad2a/);
});

test('single-instruction lookups retain the program purpose and governance deployment discovery facts', () => {
  const text = lookupProgramReference('Governance', 'createRealm');
  assert.ok(text.includes(`\n${program('Governance').purpose}\n`));
  assert.match(text, /public Realms registry \(governance-ui public\/realms\/mainnet-beta.json, field programId\)/);
});

test('deployment notes appear in program and instruction lookups but never in the prompt index', () => {
  const orca = program('Orca Whirlpools');
  const previous = Object.getOwnPropertyDescriptor(orca, 'deploymentNote');
  const index = programReferenceIndex();
  const note = 'Fixture deployment guidance for the selected SDK version.';
  Object.assign(orca, { deploymentNote: note });
  try {
    for (const instruction of [undefined, '*', 'swap']) {
      assert.ok(lookupProgramReference('Orca Whirlpools', instruction).includes(`\nDeployment: ${note}\n`));
    }
    assert.equal(programReferenceIndex(), index);
    assert.doesNotMatch(index, /Fixture deployment guidance/);
  } finally {
    if (previous) Object.defineProperty(orca, 'deploymentNote', previous);
    else Reflect.deleteProperty(orca, 'deploymentNote');
  }
});

test('an instruction lists accounts in order with flags, and arguments with types', () => {
  const text = lookupProgramReference('system', 'transfersol');
  assert.match(text, /0\. source \(signer writable\)\n  1\. destination \(writable\)/);
  assert.match(text, /Arguments:\n  amount: u64/);
});

test('names may be partial, any case, or a program id; misses return the closest matches instead of failing', () => {
  assert.match(lookupProgramReference('token', 'transferchecked'), /^SPL Token Tokenkeg/);
  assert.match(lookupProgramReference('TOKEN-2022'), /^Token-2022 TokenzQd/);
  assert.match(lookupProgramReference('whirl', 'swap'), /^Orca Whirlpools /);
  assert.match(
    lookupProgramReference('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'create'),
    /^Associated Token Account /,
  );
  const missProgram = lookupProgramReference('Sistem Progrm');
  assert.match(missProgram, /^No program matches "Sistem Progrm"\. Closest: .*System/);
  const missInstruction = lookupProgramReference('SPL Token', 'transferr chekd');
  assert.match(missInstruction, /no instruction matching "transferr chekd"\. Closest: .*transferChecked/);
  assert.match(
    lookupProgramReference('SPL Token', 'transfer'),
    /starts with 03 /,
    'an exact name beats longer names that contain it',
  );
});

test('a facts-only source returns names, order and discriminators, never argument types or flags', () => {
  const text = lookupProgramReference('Orca Whirlpools', 'swap');
  assert.match(text, /facts only/);
  assert.match(text, /Arguments:\n  not recorded here \(source licence\)/);
  assert.doesNotMatch(text, /\((?:signer|writable)/);
});

test('a program without a tag says so, and its record layout is generated from the source', () => {
  assert.match(
    lookupProgramReference('Ed25519 Precompile', 'verify'),
    /no instruction tag[\s\S]*num_signatures: u8\n {2}padding: u8\n {2}offsets: \{signature_offset:u16/,
  );
});

test('each program records its official npm client where one is published, empty where none is', () => {
  const clients = (name: string) => program(name).clients ?? [];
  assert.deepEqual(clients('System'), ['@solana-program/system']);
  assert.deepEqual(clients('SPL Token'), ['@solana-program/token']);
  assert.deepEqual(clients('Orca Whirlpools'), ['@orca-so/whirlpools-client']);
  assert.deepEqual(clients('SPL Single Pool'), ['@solana/spl-single-pool', '@solana/spl-single-pool-classic']);
  for (const none of ['Vote', 'Config', 'Ed25519 Precompile', 'Jupiter Aggregator v6', 'Sanctum S Controller'])
    assert.deepEqual(clients(none), [], `${none} has no published client`);
  assert.match(lookupProgramReference('whirlpool'), /Official TypeScript client \(npm\): @orca-so\/whirlpools-client/);
  assert.match(
    lookupProgramReference('system', 'transfersol'),
    /Official TypeScript client \(npm\): @solana-program\/system/,
  );
  assert.doesNotMatch(lookupProgramReference('Vote'), /Official TypeScript client/);
});

test('the index names the client of a program and the count-prefixed shape of Secp256r1 and Config', () => {
  const index = programReferenceIndex();
  assert.match(index, /System 1{32} \[u32\] .* \| client: @solana-program\/system\n/);
  assert.match(index, /Orca Whirlpools \S+ \[a8\] .* \| client: @orca-so\/whirlpools-client\n/);
  assert.match(index, /Secp256r1 Precompile \S+ \[count\] verify \(first byte = number of signatures\)\n/);
  assert.match(index, /Config \S+ \[count\] store \(data starts with a short_vec count of keys\)\n/);
  assert.doesNotMatch(index, /Vote \S+ \[u32\] .*client:/);
  assert.match(index, /count = no tag, the leading field is a count that varies and each value is a distinct prefix/);
});

test('count-prefixed programs and Memo describe their input dimensions and payload-only variation', () => {
  assert.match(
    lookupProgramReference('Ed25519 Precompile'),
    /Input dimension: no discriminator; the leading field \(first byte = number of signatures\) varies, bounded by transaction size, and each distinct value is a distinct instruction prefix\./,
  );
  assert.match(
    lookupProgramReference('Config', 'store'),
    /The leading field is an input dimension: it varies, and each distinct value is a distinct instruction prefix\./,
  );
  assert.match(lookupProgramReference('Memo'), /accepts arbitrary data, so memo variations are payload-only/);
  assert.ok(Buffer.byteLength(programReferenceIndex()) < 17_500);
});

test('count-prefixed programs describe their data layout from the pinned source', () => {
  const r1 = lookupProgramReference('Secp256r1 Precompile');
  assert.match(
    r1,
    /Data layout \(first byte = number of signatures\): u8 num_signatures, u8 padding, then num_signatures records of 14 bytes \{signature_offset:u16/,
  );
  assert.match(
    r1,
    /Source: https:\/\/raw\.githubusercontent\.com\/anza-xyz\/solana-sdk\/[0-9a-f]{40}\/secp256r1-program/,
  );
  assert.match(
    lookupProgramReference('Secp256k1 Precompile', 'verify'),
    /no instruction tag: first byte = number of signatures\. Layout: u8 num_signatures, then num_signatures records of 11 bytes/,
  );
  const config = lookupProgramReference('Config', 'store');
  assert.match(
    config,
    /no instruction tag: data starts with a short_vec count of keys\. Layout: keys: short_vec length n, then n entries of \(pubkey, bool as u8\); then data: bytes/,
  );
  assert.equal(program('Config').style, 'count');
  assert.equal(program('Memo').style, 'none');
});

test('instruction "*" returns every instruction of a program in one response, and degrades for very large programs', () => {
  const system = lookupProgramReference('System', '*');
  for (const ix of program('System').instructions)
    assert.ok(
      system.includes(`\n  ${ix.name}${ix.alias ? ` (${ix.alias})` : ''} ${ix.discriminator} | accounts:`),
      `${ix.name} has a line`,
    );
  assert.match(system, /All 14 instructions, one per line/);
  assert.match(
    system,
    / transferSol 02000000 \| accounts: source\(signer\+writable\), destination\(writable\) \| args: amount:u64/,
  );
  const token = lookupProgramReference('SPL Token', '*');
  assert.match(
    token,
    /transferChecked 0c \| accounts: source\(writable\), mint, destination\(writable\), authority\(signer-or-not\) \| args: amount:u64, decimals:u8/,
  );
  const orca = lookupProgramReference('Orca Whirlpools', '*');
  assert.match(orca, / swap [0-9a-f]{16} \| accounts: .* \| args: not recorded/);
  const drift = lookupProgramReference('Drift v2', '*');
  assert.equal(drift.split('\n').filter((line) => /^ {2}\w+ [0-9a-f]{16}, \d+ accounts$/.test(line)).length, 249);
  assert.match(drift, /ask for one instruction, or a partial name/);
  for (const text of [system, token, orca, drift, lookupProgramReference('Token-2022', '*')])
    assert.ok(Buffer.byteLength(text) <= PROGRAM_REFERENCE_RESULT_LIMIT, 'bounded');
  assert.match(lookupProgramReference('System'), /or "\*" for all of them in one call/);
});

test('SPL Single Pool is present with its program id, tags, accounts and licence', () => {
  const pool = program('SPL Single Pool');
  assert.equal(pool.id, 'SVSPxpvHdN29nkVg9rPapPNDddN5DipNLRUFhyjFThE');
  assert.equal(pool.source.licence, 'Apache-2.0');
  assert.deepEqual(pool.instructions.map((ix) => [ix.name, ix.discriminator]).slice(0, 4), [
    ['initialize_pool', '00'],
    ['replenish_pool', '01'],
    ['deposit_stake', '02'],
    ['withdraw_stake', '03'],
  ]);
  assert.match(lookupProgramReference('single pool', 'deposit_sol'), /starts with 07 .*lamports: u64/s);
  assert.match(
    lookupProgramReference('SVSPxpvHdN29nkVg9rPapPNDddN5DipNLRUFhyjFThE', 'withdraw_stake'),
    /token_amount: u64/,
  );
});

test('the lookup tool is registered with the extension and answers without any network or token', async () => {
  const tools: Array<{
    name: string;
    execute: (
      id: string,
      params: { program: string; instruction?: string },
    ) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];
  programReferenceExtension({ registerTool: (tool: never) => tools.push(tool) } as never);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, PROGRAM_REFERENCE_TOOL);
  const result = await tools[0]!.execute('call', { program: 'memo' });
  assert.match(result.content[0]!.text, /^Memo MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr/);
  assert.ok(sessionToolNames(false, undefined).includes(PROGRAM_REFERENCE_TOOL));
  assert.ok(sessionToolNames(true, 'head-tail').includes(PROGRAM_REFERENCE_TOOL));
});

test('the index names every program, id and tag style, stays under 17,500 bytes, and is identical on every call', () => {
  const index = programReferenceIndex();
  for (const p of data.programs)
    assert.ok(
      index.split('\n').some((line) => line.startsWith(`${p.name} ${p.id} [`)),
      `${p.name} has an index line`,
    );
  assert.ok(Buffer.byteLength(index) < 17_500, `index is ${Buffer.byteLength(index)} bytes`);
  assert.equal(programReferenceIndex(), index);
  assert.match(index, /System 1{32} \[u32\] createAccount,assign,transferSol/);
  assert.match(index, /SPL Token Tokenkeg\S+ \[u8\] initializeMint,/);
  assert.match(index, /program_reference\(\{program, instruction\?\}\)/);
});

test('the system prompt carries the index without the knowledge service, identically across sessions, before any per-task text', () => {
  const first = omsSystemPrompt('/work/a', 'toolchain ok');
  const second = omsSystemPrompt('/work/b', 'toolchain differs', ' web tail');
  const index = programReferenceIndex();
  assert.ok(first.includes(index) && second.includes(index));
  assert.equal(first.indexOf(index), second.indexOf(index));
  assert.ok(first.indexOf(index) < first.indexOf('You are OMS'));
  assert.ok(first.indexOf(index) < first.indexOf('/work/a'));
  assert.equal(first.slice(0, first.indexOf('You are OMS')), second.slice(0, second.indexOf('You are OMS')));
  assert.doesNotMatch(first, /search_docs|OMS_KNOWLEDGE_TOKEN/);
});

test('Anchor discriminators are derived with the Anchor rule when an IDL omits them', () => {
  assert.equal(anchorDiscriminator('initialize'), 'afaf6d1f0d989bed');
  assert.equal(anchorDiscriminator('swapV2'), anchorDiscriminator('swap_v2'));
  const adapted = adaptAnchor({
    name: 'legacy',
    instructions: [
      {
        name: 'route',
        accounts: [
          { name: 'user', isMut: false, isSigner: true },
          { name: 'group', accounts: [{ name: 'inner', isMut: true, isSigner: false }] },
        ],
        args: [
          { name: 'amount', type: 'u64' },
          { name: 'owner', type: 'publicKey' },
        ],
      },
    ],
  });
  assert.equal(adapted.instructions[0]!.discriminator, 'e517cb977ae3ad2a');
  assert.deepEqual(
    adapted.instructions[0]!.accounts.map((a) => a.name),
    ['user', 'group.inner'],
  );
  assert.deepEqual(adapted.instructions[0]!.args, [
    { name: 'amount', type: 'u64' },
    { name: 'owner', type: 'pubkey' },
  ]);
  assert.equal(adapted.style, 'anchor8');
});

test('a Rust instruction enum is numbered by position and its doc account list is read, or dropped when ambiguous', () => {
  const source = `pub enum Ix {
    /// Create it
    ///
    /// Accounts expected by this instruction:
    ///   0. \`[writable, signer]\` Payer
    ///   1. '[]' Rent sysvar
    Create { size: u64 },
    #[deprecated]
    Gone,
    /// Either list applies
    ///   0. \`[w]\` A
    ///   0. \`[s]\` B
    Pick(u8, u32),
}`;
  const { instructions, style } = adaptRustEnum(source, 'Ix', 1);
  assert.equal(style, 'u8');
  assert.deepEqual(
    instructions.map((ix) => [ix.name, ix.discriminator]),
    [
      ['create', '00'],
      ['gone', '01'],
      ['pick', '02'],
    ],
  );
  assert.deepEqual(instructions[0]!.accounts, [
    { name: 'Payer', signer: true, writable: true },
    { name: 'Rent sysvar', signer: false, writable: false },
  ]);
  assert.deepEqual(instructions[2]!.accounts, []);
  assert.match(instructions[2]!.note!, /differ by case/);
  assert.deepEqual(
    instructions[2]!.args!.map((a) => a.type),
    ['u8', 'u32'],
  );
});

test('a Codama IDL contributes its constant discriminator bytes in offset order and leaves them out of the arguments', () => {
  const number = (format: string) => ({ kind: 'numberTypeNode', format, endian: 'le' });
  const adapted = adaptCodama({
    program: {
      publicKey: 'Tokenz',
      instructions: [
        {
          name: 'ext',
          accounts: [{ name: 'mint', isSigner: false, isWritable: true }],
          arguments: [
            { name: 'discriminator', type: number('u8'), defaultValue: { kind: 'numberValueNode', number: 26 } },
            { name: 'sub', type: number('u8'), defaultValue: { kind: 'numberValueNode', number: 3 } },
            { name: 'fee', type: number('u16') },
          ],
          discriminators: [
            { kind: 'fieldDiscriminatorNode', name: 'sub', offset: 1 },
            { kind: 'fieldDiscriminatorNode', name: 'discriminator', offset: 0 },
          ],
        },
      ],
    },
  });
  assert.deepEqual(adapted.instructions[0]!.args, [{ name: 'fee', type: 'u16' }]);
  assert.equal(adapted.instructions[0]!.discriminator, '1a03');
  assert.equal(adapted.address, 'Tokenz');
});

test('the checked-in file carries a pinned source, licence and ranking basis for every program', () => {
  const raw = readFileSync(new URL('../src/runtime/program-reference.json', import.meta.url), 'utf8');
  assert.match(raw, /"generator":"scripts\/gen-program-reference.ts"/);
  assert.match(data.ranking.source, /DefiLlama/);
  for (const p of data.programs) {
    assert.match(p.source.version, /@([0-9a-f]{40}|\d[\w.+-]*)$/, `${p.name} source is pinned to a commit or version`);
    assert.ok(p.source.licence.length > 0);
    if (p.category === 'application' && p.rank) assert.match(p.rank, /^DefiLlama Solana (DEX volume, 30d|TVL): #\d+ /);
  }
});

test('facts-only programs carry the names-only marker and the others do not', () => {
  const lines = programReferenceIndex().split('\n');
  for (const p of data.programs) {
    const line = lines.find((l) => l.startsWith(`${p.name} ${p.id} [`))!;
    assert.equal(line.includes(' (names only)'), Boolean(p.factsOnly), p.name);
  }
  assert.match(
    programReferenceIndex(),
    /\(names only\) = no argument types or account flags recorded: take arguments from the installed client or its bundled IDL/,
  );
});

test('a capped application list keeps the plain initialize and create instructions next to the trading ones', () => {
  const orca = programReferenceIndex()
    .split('\n')
    .find((l) => l.startsWith('Orca Whirlpools '))!;
  assert.match(orca, /initialize_pool/);
  assert.match(orca, /initialize_config/);
  assert.match(orca, /\bswap\b/);
  const pump = programReferenceIndex()
    .split('\n')
    .find((l) => l.startsWith('Pump '))!;
  assert.match(pump, /\binitialize\b/);
  assert.match(pump, /\bcreate\b/);
});

test('installed official program clients are listed with their versions, from the task or the mounted dependency set', () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-clients-'));
  const deps = mkdtempSync(join(tmpdir(), 'oms-deps-'));
  try {
    assert.deepEqual(installedProgramClients([root, deps]), []);
    mkdirSync(join(deps, 'node_modules/@orca-so/whirlpools-client'), { recursive: true });
    writeFileSync(
      join(deps, 'node_modules/@orca-so/whirlpools-client/package.json'),
      JSON.stringify({ name: '@orca-so/whirlpools-client', version: '1.2.3' }),
    );
    assert.deepEqual(installedProgramClients([root]), [], 'the task alone has none');
    assert.deepEqual(
      installedProgramClients([root, deps]),
      ['@orca-so/whirlpools-client 1.2.3'],
      'a read-only dependency set the sandbox mounts counts',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(deps, { recursive: true, force: true });
  }
});

test('a program lookup carries a source_fetch call built from the pinned source', () => {
  assert.match(
    lookupProgramReference('SPL Token'),
    /\nsource: source_fetch\(\{repo: "solana-program\/token", ref: "[0-9a-f]{40}", paths: \["idl\.json"\]\}\)/,
  );
  assert.match(
    lookupProgramReference('Orca Whirlpools', 'swap'),
    /\nsource: source_fetch\(\{npm: "@orca-so\/whirlpools-sdk", version: "0\.22\.0", paths: \["dist\/artifacts\/whirlpool\.json"\]\}\)/,
  );
});

test('names-only programs with an official client point at its generated instruction builders', () => {
  const core = lookupProgramReference('Metaplex Core');
  assert.match(
    core,
    /Full layouts: the official client's generated instruction builders give account order, signer\/writable flags and argument serializers: read them with source_fetch\(\{npm: "@metaplex-foundation\/mpl-core"\}\)/,
  );
  assert.match(
    lookupProgramReference('Metaplex Token Metadata', 'createMetadataAccountV3'),
    /not recorded here \(source licence\): take them from the @metaplex-foundation\/mpl-token-metadata instruction builder/,
  );
  assert.doesNotMatch(lookupProgramReference('SPL Token', 'transfer'), /Full layouts/);
});

test('the index says signature precompiles take several signatures per instruction and can share buffers', () => {
  const index = programReferenceIndex();
  assert.match(
    index,
    /verify several signatures per instruction, although common SDK helpers emit one: byte 0 is the count/,
  );
  assert.match(index, /in this or another instruction of the transaction, so one buffer serves many records/);
  assert.match(
    lookupProgramReference('Ed25519 Precompile', 'verify'),
    /sit wherever the offset records point, after the records or in another instruction/,
  );
});

test('programs whose lifecycle runs on accounts the wallet creates are marked standalone in the index', () => {
  const index = programReferenceIndex();
  assert.match(
    index,
    /\(standalone\) = the whole lifecycle runs on accounts your wallet creates; other applications need existing deployment state/,
  );
  for (const name of ['Metaplex Core', 'Metaplex Token Metadata', 'Squads v4', 'Governance'])
    assert.match(index, new RegExp(`\\n${name} \\S+ \\[[^\\]]+\\] [^\\n]*\\(standalone\\)`), name);
  assert.doesNotMatch(index, /\nOrca Whirlpools [^\n]*\(standalone\)/);
});
