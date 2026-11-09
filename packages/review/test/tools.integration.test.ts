import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSastResult } from '../src/static/sast.ts';
import { parseAuditResult } from '../src/static/audit.ts';
import { runStaticPass } from '../src/static/run.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { configuredReviewToolsImage } from '../../engine/src/runtime/review-ports.ts';
import { reviewToolsSkip } from '../../sandbox/test-support/infrastructure.ts';

const image = configuredReviewToolsImage();
const skip = reviewToolsSkip(image);

function run(args: string[], mount?: string) {
  assert.ok(image && /^(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}$/.test(image), 'review-tools image must be pinned');
  return execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '2048m', '--cpus', '2', '--pids-limit', '256',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    ...(mount ? ['--mount', `type=bind,src=${mount},dst=/work,readonly`] : []), image!, ...args,
  ], { encoding: 'utf8', timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
}

test('native deserialization signal survives host parsing with precise locations', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-deserialization-'));
  execFileSync('chmod', ['755', dir]);
  const source = [
    'fn unchecked(data: &[u8]) {',
    '  let state = State::try_from_slice(data)?;',
    '}',
    'fn guarded(data: &[u8]) {',
    '  if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); }',
    '  let state = State::try_from_slice(data)?;',
    '}',
  ].join('\n');
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    const result = parseSastResult({ exitCode: 0, stdout: run(['oms-sast', '--file', 'lib.rs'], dir), timedOut: false, truncated: false },
      'lib.rs', new Map([['lib.rs', source.split('\n').length]]));
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.ok(result.implementedRules.includes('type-cosplay/unchecked-deserialization'));
    assert.deepEqual(result.hits.filter(hit => hit.ruleId === 'type-cosplay/unchecked-deserialization').map(hit => hit.location),
      [{ file: 'lib.rs', line: 2, handler: 'unchecked' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('review tools print pinned versions offline and read-only', { skip }, () => {
  assert.match(run(['cargo-audit', '--version']), /cargo-audit 0\.22\.2\b/);
  assert.equal(run(['oms-sast', '--version']).trim(), 'oms-sast 0.1.0');
});

test('host parser accepts real scanner output and refuses failed scans', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-output-'));
  execFileSync('chmod', ['755', dir]);
  const source = "struct Withdraw<'info> { authority: UncheckedAccount<'info> }\npub fn withdraw() {}\n";
  const inventory = new Map([['lib.rs', source.split('\n').length], ['Cargo.toml', 2], ['Cargo.lock', 5]]);
  const parse = (stdout: string, file: string, exitCode: number | null = 0) =>
    parseSastResult({ exitCode, stdout, timedOut: false, truncated: false }, file, inventory);
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    writeFileSync(join(dir, 'Cargo.lock'), "version=4\n[[package]]\nname='anchor-lang'\nversion='1.0.1'\n");
    const result = parse(run(['oms-sast', '--file', 'lib.rs', '--lockfile', 'Cargo.lock'], dir), 'lib.rs');
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]!.ruleId, 'missing-signer/anchor-field');
    assert.ok(result.implementedRules.includes('anchor-cve-2026-45137/inline-instruction'));
    writeFileSync(join(dir, 'Cargo.toml'), '[profile.release]\noverflow-checks=false');
    const manifestResult = parse(run(['oms-sast', '--manifest', 'Cargo.toml'], dir), 'Cargo.toml');
    assert.equal(manifestResult.status, 'ok');
    assert.equal(manifestResult.hits[0]!.ruleId, 'arithmetic/release-overflow-checks');
    writeFileSync(join(dir, 'lib.rs'), 'struct {');
    assert.throws(() => run(['oms-sast', '--file', 'lib.rs'], dir), (error: unknown) => {
      const failure = error as { status: number | null; stdout: string };
      const result = parse(failure.stdout, 'lib.rs', failure.status);
      assert.equal(result.status, 'failed');
      assert.deepEqual(result.hits, []);
      assert.deepEqual(result.implementedRules, []);
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline advisory snapshot distinguishes anchor-lang 1.0.1 and 1.0.2', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-audit-'));
  // Docker uses an unprivileged uid; the disposable fixture contains no secrets.
  execFileSync('chmod', ['755', dir]);
  try {
    for (const version of ['1.0.1', '1.0.2']) {
      writeFileSync(join(dir, 'Cargo.lock'), `version = 3\n\n[[package]]\nname = "anchor-lang"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`);
      let stdout: string;
      let exitCode = 0;
      try {
        stdout = run(['cargo-audit', 'audit', '--no-fetch', '--db', '/opt/advisory-db', '--file', '/work/Cargo.lock', '--json'], dir);
      } catch (error) {
        const result = error as { status?: number; stdout?: string };
        assert.equal(result.status, 1, 'cargo-audit only exits 1 for vulnerable fixture');
        assert.equal(typeof result.stdout, 'string');
        stdout = result.stdout!;
        exitCode = result.status!;
      }
      const report = JSON.parse(stdout);
      const found = report.vulnerabilities.list.some((item: { advisory: { id: string } }) => item.advisory.id === 'RUSTSEC-2026-0144');
      assert.equal(found, version === '1.0.1');
      const parsed = parseAuditResult({ exitCode, stdout, timedOut: false, truncated: false },
        'Cargo.lock', new Map([['Cargo.lock', 7]]));
      assert.equal(parsed.status, 'ok');
      assert.equal(parsed.invalidOutputs, 0);
      assert.equal(parsed.hits.some(hit => hit.ruleId === 'RUSTSEC-2026-0144'), version === '1.0.1');
      assert.ok(parsed.hits.every(hit => hit.class === 'dependency-advisory' && hit.location.file === 'Cargo.lock'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('syntax-only analyzer reports its limited coverage and never executes source', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-sast-'));
  execFileSync('chmod', ['755', dir]);
  mkdirSync(join(dir, 'src'));
  try {
    writeFileSync(join(dir, 'src/lib.rs'), `compile_error!("This source must never be compiled");
// #[account(signer)] is only a comment.
struct Withdraw<'info> { authority: UncheckedAccount<'info> }
`);
    const analysis = JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir));
    assert.deepEqual(analysis.implementedRules, ['missing-signer/anchor-field', 'revival-reinit/init-if-needed', 'duplicate-mutable/anchor-dup', 'pda-bump/explicit-derivation', 'unchecked-sysvar-id/instruction-reader', 'arithmetic/field-operation', 'pda-bump/explicit-constraint', 'arithmetic/integer-cast', 'token2022/unchecked-transfer', 'token2022/legacy-rent-size', 'token2022/legacy-account-space', 'missing-constraint/account-authority', 'type-cosplay/literal-discriminator-prefix', 'signer-seeds/field-derived-cpi', 'missing-owner/unchecked-parameter-read', 'signer-seeds/anchor-cpi-context', 'arbitrary-cpi/unchecked-parameter-context', 'missing-signer/unchecked-parameter', 'unchecked-sysvar-id/account-reader', 'unchecked-sysvar-id/remaining-accounts', 'revival-reinit/manual-lamport-zero', 'duplicate-mutable/account-loader', 'token2022/interface-mint', 'token2022/amount-only-close', 'type-cosplay/unchecked-deserialization']);
    assert.equal(analysis.hits.length, 1);
    assert.equal(analysis.hits[0].class, 'missing-signer');
    assert.equal(analysis.hits[0].ruleId, 'missing-signer/anchor-field');
    assert.equal(analysis.hits[0].location.line, 3);
    writeFileSync(join(dir, 'src/lib.rs'), `fn close() { **account.try_borrow_mut_lamports()? = 0; }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string }) => hit.class), ['revival-reinit']);
    writeFileSync(join(dir, 'src/lib.rs'), `fn close() { account.close(destination)?; }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), `fn process() { consume(ctx.remaining_accounts); }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string }) => hit.class), ['unchecked-sysvar-id']);
    writeFileSync(join(dir, 'src/lib.rs'), `fn process() { consume(ctx.accounts.vault); }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);

    writeFileSync(join(dir, 'src/lib.rs'), `struct Withdraw<'info> { #[account(signer)] authority: UncheckedAccount<'info> }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), `struct Vault { authority: Pubkey }
struct Withdraw<'info> { vault: Account<'info, Vault>, authority: Signer<'info> }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string }) => hit.class), ['missing-constraint']);
    writeFileSync(join(dir, 'src/lib.rs'), `struct Vault { authority: Pubkey }
struct Withdraw<'info> { vault: Account<'info, Vault>, #[account(constraint = vault.authority == authority.key())] authority: Signer<'info> }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), `fn transfer(program: &UncheckedAccount<'_>) {
      CpiContext::new(program.to_account_info(), accounts);
    }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string; location: { line: number; handler: string } }) =>
      [hit.class, hit.location.line, hit.location.handler]), [['arbitrary-cpi', 2, 'transfer']]);
    writeFileSync(join(dir, 'src/lib.rs'), `fn transfer(program: Program<'_, Token>) {
      CpiContext::new(program.to_account_info(), accounts);
    }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), `struct Accounts<'info> {
      #[account(init_if_needed)] vault: Account<'info, Vault>,
      #[account(mut, dup)] other: Account<'info, Vault>,
    }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string }) => hit.class), ['revival-reinit', 'duplicate-mutable']);
    writeFileSync(join(dir, 'src/lib.rs'), `pub fn process() {
      let _ = Pubkey::create_program_address(seeds, id);
      let _ = load_instruction_at(0, data);
      vault.amount += deposit;
    }`);
    const expressions = JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir));
    assert.deepEqual(expressions.hits.map((hit: { class: string; location: { line: number; handler: string } }) =>
      [hit.class, hit.location.line, hit.location.handler]), [
      ['pda-bump', 2, 'process'], ['unchecked-sysvar-id', 3, 'process'], ['arithmetic', 4, 'process'],
    ]);
    assert.deepEqual(expressions.hits.map((hit: { ruleId: string }) => hit.ruleId), [
      'pda-bump/explicit-derivation', 'unchecked-sysvar-id/instruction-reader', 'arithmetic/field-operation',
    ]);
    writeFileSync(join(dir, 'src/lib.rs'), `pub fn process() {
      CpiContext::new_with_signer(program, accounts, args.seeds);
      anchor_lang::context::CpiContext::new_with_signer(program, accounts, &[&[state.seed.as_ref()]]);
    }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string; location: { line: number } }) =>
      [hit.class, hit.location.line]), [['signer-seeds', 2], ['signer-seeds', 3]]);
    writeFileSync(join(dir, 'src/lib.rs'), `pub fn process() {
      CpiContext::new_with_signer(program, accounts, &[&[b"vault", &[255]]]);
      CpiContext::new_with_signer(state.program, args.accounts, validated_seeds);
    }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), `struct Accounts<'info> {
      #[account(seeds = [b"vault"], bump = args.bump)] vault: Account<'info, Vault>,
    }
    pub fn process() { let narrowed = amount as u8; }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string }) => hit.class), ['pda-bump', 'arithmetic']);
    writeFileSync(join(dir, 'src/lib.rs'), `struct Accounts<'info> {
      #[account(seeds = [b"vault"], bump)] vault: Account<'info, Vault>,
    }
    pub fn process() { let narrowed = u8::try_from(amount); }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), `struct Accounts<'info> {
      #[account(space = 165)] vault: AccountInfo<'info>,
    }
    pub fn process() {
      token_2022::transfer(ctx, amount);
      rent.minimum_balance(165);
    }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string; location: { line: number } }) =>
      [hit.class, hit.location.line]), [['token2022', 2], ['token2022', 5], ['token2022', 6]]);
    writeFileSync(join(dir, 'src/lib.rs'), `#[account(discriminator = [1])] struct A {}
#[account(discriminator = [1, 2])] struct B {}`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string; location: { line: number } }) =>
      [hit.class, hit.location.line]), [['type-cosplay', 1], ['type-cosplay', 2]]);
    writeFileSync(join(dir, 'src/lib.rs'), `#[account(discriminator = [1, 3])] struct A {}
#[account(discriminator = [1, 2])] struct B {}`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), `fn process() { invoke_signed(&ix, accounts, args.seeds); }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string }) => hit.class), ['signer-seeds']);
    writeFileSync(join(dir, 'src/lib.rs'), `fn process() { invoke_signed(&ix, accounts, &[&[b"vault", &[255]]]); }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), `fn process(account: &AccountInfo) { account.try_borrow_data(); }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string }) => hit.class), ['missing-owner']);
    writeFileSync(join(dir, 'src/lib.rs'), `fn process(account: &AccountInfo) { if account.owner != expected { return Err(Error::Owner); } account.try_borrow_data(); }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), `fn withdraw(authority: &pinocchio::account_info::AccountInfo) { transfer(); }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string; location: { line: number; handler: string } }) =>
      [hit.class, hit.location.line, hit.location.handler]), [['missing-signer', 1, 'withdraw']]);
    writeFileSync(join(dir, 'src/lib.rs'), `fn withdraw(authority: &pinocchio::account_info::AccountInfo) { if !authority.is_signer() { return Err(Error::Signer); } transfer(); }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), `fn process() {
      Sysvar::from_account_info(account);
      <Clock as solana_program::sysvar::Sysvar>::from_account_info(account);
    }`);
    assert.deepEqual(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.map((hit: { class: string; location: { line: number } }) =>
      [hit.class, hit.location.line]), [['unchecked-sysvar-id', 2], ['unchecked-sysvar-id', 3]]);
    writeFileSync(join(dir, 'src/lib.rs'), `fn process() { Clock::get(); Rent::get(); Other::from_account_info(account); }`);
    assert.equal(JSON.parse(run(['oms-sast', '--file', 'src/lib.rs'], dir)).hits.length, 0);
    writeFileSync(join(dir, 'src/lib.rs'), 'struct {');
    assert.throws(() => run(['oms-sast', '--file', 'src/lib.rs'], dir));
    assert.throws(() => run(['oms-sast', '--file', '../outside.rs'], dir));
    symlinkSync('/etc/passwd', join(dir, 'src/link.rs'));
    assert.throws(() => run(['oms-sast', '--file', 'src/link.rs'], dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CVE signal requires affected lock and an account-derived inline CPI program id', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-cve-'));
  execFileSync('chmod', ['755', dir]);
  const source = (program: string) => `fn pay(system_program: Program<'_, System>) {
    invoke(&Instruction { program_id: ${program}, accounts: vec![], data: vec![] }, accounts);
  }`;
  const lock = (version: string) => `version = 4\n[[package]]\nname = 'anchor-lang'\nversion = '${version}'\n`;
  const scan = () => JSON.parse(run(['oms-sast', '--file', 'lib.rs', '--lockfile', 'Cargo.lock'], dir));
  try {
    for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.2.2']) {
      writeFileSync(join(dir, 'Cargo.lock'), lock(version));
      writeFileSync(join(dir, 'lib.rs'), source('system_program.key()'));
      const result = scan();
      assert.ok(result.implementedRules.includes('anchor-cve-2026-45137/inline-instruction'));
      assert.equal(result.hits.filter((hit: { class: string }) => hit.class === 'anchor-cve-2026-45137').length,
        ['1.0.0', '1.0.1'].includes(version) ? 1 : 0);
    }
    writeFileSync(join(dir, 'Cargo.lock'), lock('1.0.1'));
    writeFileSync(join(dir, 'lib.rs'), source('System::id()'));
    assert.equal(scan().hits.length, 0);
    writeFileSync(join(dir, 'lib.rs'), source('system_program.key()').replace('System>', 'Token>'));
    assert.equal(scan().hits.length, 0);
    writeFileSync(join(dir, 'Cargo.lock'), 'invalid lock');
    assert.throws(scan);
    rmSync(join(dir, 'Cargo.lock'));
    symlinkSync('/etc/passwd', join(dir, 'Cargo.lock'));
    assert.throws(scan);
    assert.throws(() => run(['oms-sast', '--file', 'lib.rs', '--lockfile', '../Cargo.lock'], dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manifest scanner reports missing release overflow checks without building', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-manifest-'));
  execFileSync('chmod', ['755', dir]);
  try {
    for (const [source, count] of [
      ['[package]\nname="vault"', 1],
      ['[profile.release]\noverflow-checks=false', 1],
      ['[profile.release]\noverflow-checks=true', 0],
      ['profile.release.overflow-checks=true', 0],
    ] as const) {
      writeFileSync(join(dir, 'Cargo.toml'), source);
      const result = JSON.parse(run(['oms-sast', '--manifest', 'Cargo.toml'], dir));
      assert.deepEqual(result.implementedRules, ['arithmetic/release-overflow-checks']);
      assert.equal(result.hits.length, count);
      if (count) assert.deepEqual(result.hits[0].location, { file: 'Cargo.toml', line: 1 });
    }
    writeFileSync(join(dir, 'Cargo.toml'), '[profile.release]\noverflow-checks="true"');
    assert.throws(() => run(['oms-sast', '--manifest', 'Cargo.toml'], dir), /must be boolean/);
    assert.throws(() => run(['oms-sast', '--manifest', '../Cargo.toml'], dir), /without traversal/);
    symlinkSync('Cargo.toml', join(dir, 'linked.toml'));
    assert.throws(() => run(['oms-sast', '--manifest', 'linked.toml'], dir), /symlinks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline analyzer identifies unconstrained mutable AccountLoader pairs', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-duplicates-'));
  execFileSync('chmod', ['755', dir]);
  try {
    for (const [constraint, expected] of [['', 2], [', constraint = a.key() != b.key()', 0], [', constraint = a.key() != b.key() || enabled', 2]] as const) {
      writeFileSync(join(dir, 'lib.rs'), `struct Accounts<'info> {
  #[account(mut)] a: AccountLoader<'info, Vault>,
  #[account(mut${constraint})] b: AccountLoader<'info, Vault>
}`);
      const analysis = JSON.parse(run(['oms-sast', '--file', 'lib.rs'], dir));
      assert.equal(analysis.hits.length, expected);
      for (const hit of analysis.hits) assert.equal(hit.class, 'duplicate-mutable');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interface mint extension review signal survives unrelated constraints', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-mint-'));
  execFileSync('chmod', ['755', dir]);
  try {
    for (const [type, expected] of [
      ["InterfaceAccount<'info, Mint>", 1],
      ["anchor_lang::prelude::InterfaceAccount<'info, token_interface::Mint>", 1],
      ["Account<'info, Mint>", 0],
      ["InterfaceAccount<'info, TokenAccount>", 0],
    ] as const) {
      writeFileSync(join(dir, 'lib.rs'), `struct Deposit<'info> {
 #[account(constraint = mint.decimals == 6)] mint: ${type}
}`);
      const report = JSON.parse(run(['oms-sast', '--file', 'lib.rs'], dir));
      assert.equal(report.hits.length, expected);
      if (expected) {
        assert.equal(report.hits[0].class, 'token2022');
        assert.equal(report.hits[0].location.line, 2);
        assert.match(report.hits[0].message, /extension allowlist/);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline analyzer inventories amount-only token close branches', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-token-close-'));
  execFileSync('chmod', ['755', dir]);
  try {
    for (const [condition, expected] of [
      ['vault.amount == 0', 1],
      ['0x0u64 == vault.amount', 1],
      ['can_close_with_extensions(&vault)', 0],
      ['vault.amount == 0 && extensions_ok', 0],
    ] as const) {
      writeFileSync(join(dir, 'lib.rs'), `fn close() { if ${condition} {
 token_interface::close_account(ctx)?;
} }`);
      const report = JSON.parse(run(['oms-sast', '--file', 'lib.rs'], dir));
      assert.equal(report.hits.length, expected);
      if (expected) {
        assert.equal(report.hits[0].ruleId, 'token2022/amount-only-close');
        assert.equal(report.hits[0].class, 'token2022');
        assert.deepEqual(report.hits[0].location, { file: 'lib.rs', line: 2, handler: 'close' });
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('static pass consumes captured inputs with real offline review tools', { skip }, async () => {
  const repo = mkdtempSync(join(tmpdir(), 'oms-review-pass-source-'));
  const materialized = mkdtempSync(join(tmpdir(), 'oms-review-pass-input-'));
  execFileSync('chmod', ['755', materialized]);
  try {
    writeFileSync(join(repo, 'lib.rs'), "struct Withdraw<'info> { authority: UncheckedAccount<'info> }\n");
    writeFileSync(join(repo, 'broken.rs'), 'struct {');
    writeFileSync(join(repo, 'Cargo.toml'), '[profile.release]\noverflow-checks=true');
    writeFileSync(join(repo, 'Cargo.lock'), 'version=3\n[[package]]\nname="anchor-lang"\nversion="1.0.1"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n');
    writeFileSync(join(repo, '.env'), 'excluded fixture');
    const captured = await captureSnapshot(repo);
    writeFileSync(join(repo, 'lib.rs'), 'changed live workspace after capture');
    const result = await runStaticPass(captured, { sources: ['lib.rs', 'broken.rs'], manifest: 'Cargo.toml', lockfile: 'Cargo.lock' }, {
      async run(request) {
        // A test adapter, not the production engine port: materialize only the
        // captured request files, then reuse the hardened Docker helper above.
        rmSync(materialized, { recursive: true, force: true });
        mkdirSync(materialized, { mode: 0o755 });
        for (const [file, text] of request.files) writeFileSync(join(materialized, file), text);
        try { return { exitCode: 0, stdout: run([...request.argv], materialized), timedOut: false, truncated: false }; }
        catch (error) {
          const failure = error as { status: number | null; stdout: string };
          return { exitCode: failure.status, stdout: failure.stdout, timedOut: false, truncated: false };
        }
      },
    });
    assert.deepEqual(result.scans.map(scan => scan.status), ['failed', 'ok', 'ok', 'ok']);
    assert.equal(result.invalidOutputs, 0);
    assert.ok(result.hits.some(hit => hit.ruleId === 'missing-signer/anchor-field' && hit.location.file === 'lib.rs'));
    assert.ok(result.hits.some(hit => hit.ruleId === 'RUSTSEC-2026-0144' && hit.location.file === 'Cargo.lock'));
    assert.equal(result.hits.some(hit => hit.ruleId === 'arithmetic/release-overflow-checks'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(materialized, { recursive: true, force: true });
  }
});

test('owner-method guards suppress only the immediately protected read in the pinned scanner', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-owner-method-'));
  execFileSync('chmod', ['755', dir]);
  try {
    const source = `
pub fn guarded(account: &AccountInfo) {
  if !account.is_owned_by(&expected) { return Err(Error::Owner); }
  account.try_borrow_data()?;
}
pub fn accessor(account: &AccountInfo) {
  if account.owner() != expected { return Err(Error::Owner); }
  account.borrow_data();
}
pub fn unrelated(account: &AccountInfo) {
  if !other.is_owned_by(&expected) { return Err(Error::Owner); }
  account.try_borrow_data()?;
}
pub fn non_rejecting(account: &AccountInfo) {
  if !account.is_owned_by(&expected) { log(); }
  account.borrow_data();
}
`;
    writeFileSync(join(dir, 'lib.rs'), source);
    const result = parseSastResult({ exitCode: 0, stdout: run(['oms-sast', '--file', 'lib.rs'], dir),
      timedOut: false, truncated: false }, 'lib.rs', new Map([['lib.rs', source.split('\n').length]]));
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.deepEqual(result.hits.map(hit => [hit.ruleId, hit.location.handler, hit.location.line]), [
      ['missing-owner/unchecked-parameter-read', 'unrelated', 12],
      ['missing-owner/unchecked-parameter-read', 'non_rejecting', 16],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('conditional signer and owner guards retain findings in the pinned scanner', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-conditional-guard-'));
  execFileSync('chmod', ['755', dir]);
  const source = [
    'fn signer(authority: &AccountInfo) {',
    '  #[cfg(any())] if !authority.is_signer { return Err(Error::Signer); }',
    '  transfer();',
    '}',
    'fn owner(account: &AccountInfo) {',
    '  if account.owner != expected { #[cfg(any())] return Err(Error::Owner); }',
    '  account.borrow_data();',
    '}',
  ].join('\n');
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    const result = parseSastResult({ exitCode: 0, stdout: run(['oms-sast', '--file', 'lib.rs'], dir), timedOut: false, truncated: false },
      'lib.rs', new Map([['lib.rs', source.split('\n').length]]));
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.deepEqual(result.hits.map(hit => [hit.ruleId, hit.location.handler, hit.location.line]), [
      ['missing-signer/unchecked-parameter', 'signer', 1],
      ['missing-owner/unchecked-parameter-read', 'owner', 7],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('method deserialization signals retain locations through the pinned scanner', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-methods-'));
  execFileSync('chmod', ['755', dir]);
  const source = [
    'impl Processor {',
    '  fn process(data: &[u8]) { State::try_from_slice(data)?; }',
    '  fn guarded(data: &[u8]) {',
    '    if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); }',
    '    State::try_from_slice(data)?;',
    '  }',
    '}',
    'trait Handler {',
    '  fn fallback(data: &[u8]) { borsh::try_from_slice_unchecked::<State>(data)?; }',
    '}',
  ].join('\n');
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    const result = parseSastResult({ exitCode: 0, stdout: run(['oms-sast', '--file', 'lib.rs'], dir), timedOut: false, truncated: false },
      'lib.rs', new Map([['lib.rs', source.split('\n').length]]));
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.deepEqual(result.hits.map(hit => [hit.ruleId, hit.location.handler, hit.location.line]), [
      ['type-cosplay/unchecked-deserialization', 'process', 2],
      ['type-cosplay/unchecked-deserialization', 'fallback', 9],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('qualified deserialization retains suspected signals in the pinned scanner', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-qualified-'));
  execFileSync('chmod', ['755', dir]);
  const source = [
    'fn process(data: &[u8]) {',
    '  <State as BorshDeserialize>::try_from_slice(data)?;',
    '}',
    'impl Processor { fn guarded(data: &[u8]) {',
    '  if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); }',
    '  <State>::try_from_slice(data)?;',
    '} }',
    'fn checked(data: &[u8]) { <State as Decode>::try_deserialize(data); }',
  ].join('\n');
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    const result = parseSastResult({ exitCode: 0, stdout: run(['oms-sast', '--file', 'lib.rs'], dir), timedOut: false, truncated: false },
      'lib.rs', new Map([['lib.rs', source.split('\n').length]]));
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.deepEqual(result.hits.map(hit => [hit.ruleId, hit.location.handler, hit.location.line]), [
      ['type-cosplay/unchecked-deserialization', 'process', 2],
      ['type-cosplay/unchecked-deserialization', 'guarded', 6],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('method account checks retain precise locations through the pinned scanner', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-account-methods-'));
  execFileSync('chmod', ['755', dir]);
  const source = [
    'impl Processor {',
    '  fn process(authority: &AccountInfo, account: &AccountInfo) {',
    '    account.borrow_data();',
    '  }',
    '  fn guarded(authority: &AccountInfo, account: &AccountInfo) {',
    '    if !authority.is_signer { return Err(Error); }',
    '    if account.owner != expected { return Err(Error); }',
    '    account.borrow_data();',
    '  }',
    '}',
    'trait Handler {',
    '  fn fallback(program: &AccountInfo) { CpiContext::new(program, accounts); }',
    '}',
  ].join('\n');
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    const result = parseSastResult({ exitCode: 0, stdout: run(['oms-sast', '--file', 'lib.rs'], dir), timedOut: false, truncated: false },
      'lib.rs', new Map([['lib.rs', source.split('\n').length]]));
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.deepEqual(result.hits.map(hit => [hit.ruleId, hit.location.handler, hit.location.line]), [
      ['missing-signer/unchecked-parameter', 'process', 2],
      ['missing-owner/unchecked-parameter-read', 'process', 3],
      ['arbitrary-cpi/unchecked-parameter-context', 'fallback', 12],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('raw authority names retain signer and link signals through the host parser', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-raw-names-'));
  execFileSync('chmod', ['755', dir]);
  const source = [
    'struct Unchecked { r#authority: AccountInfo }',
    'fn process(r#payer: AccountInfo) { work(); }',
    'struct Vault { r#owner: Pubkey }',
    'struct Accounts { vault: Account<Vault>, signer: Signer }',
    'fn guarded(r#admin: AccountInfo) { if !r#admin.is_signer { return Err(Error); } work(); }',
  ].join('\n');
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    const result = parseSastResult({ exitCode: 0, stdout: run(['oms-sast', '--file', 'lib.rs'], dir), timedOut: false, truncated: false },
      'lib.rs', new Map([['lib.rs', 5]]));
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.deepEqual(result.hits.map(hit => [hit.ruleId, hit.location.line]), [
      ['missing-signer/anchor-field', 1],
      ['missing-signer/unchecked-parameter', 2],
      ['missing-constraint/account-authority', 4],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mutable unchecked data borrows retain owner signals through the host parser', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-mutable-owner-'));
  execFileSync('chmod', ['755', dir]);
  const source = [
    'fn first(data: AccountInfo) { data.borrow_mut_data(); }',
    'fn second(data: &UncheckedAccount) { data.try_borrow_mut_data()?; }',
    'fn guarded(data: &AccountInfo) { if data.owner != expected { return Err(Error); } data.borrow_mut_data(); }',
  ].join('\n');
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    const result = parseSastResult({ exitCode: 0, stdout: run(['oms-sast', '--file', 'lib.rs'], dir), timedOut: false, truncated: false },
      'lib.rs', new Map([['lib.rs', 3]]));
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.deepEqual(result.hits.map(hit => [hit.ruleId, hit.location.line]), [
      ['missing-owner/unchecked-parameter-read', 1],
      ['missing-owner/unchecked-parameter-read', 2],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parenthesized account parameter types preserve scanner signals', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-parenthesized-'));
  execFileSync('chmod', ['755', dir]);
  const source = [
    'fn process(authority: &(AccountInfo), program: ((UncheckedAccount))) {',
    ' authority.borrow_data();',
    ' CpiContext::new(program, accounts);',
    '}',
  ].join('\n');
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    const result = parseSastResult({ exitCode: 0, stdout: run(['oms-sast', '--file', 'lib.rs'], dir), timedOut: false, truncated: false },
      'lib.rs', new Map([['lib.rs', 4]]));
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.deepEqual(result.hits.map(hit => [hit.ruleId, hit.location.line]), [
      ['missing-signer/unchecked-parameter', 1],
      ['missing-owner/unchecked-parameter-read', 2],
      ['arbitrary-cpi/unchecked-parameter-context', 3],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('direct signer builders preserve seed signals through the host parser', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-signer-builder-'));
  execFileSync('chmod', ['755', dir]);
  const source = [
    'fn transfer() {',
    ' CpiContext::new(program, accounts).with_signer(args.seeds);',
    ' (anchor_lang::context::CpiContext::new(program, accounts)).with_signer(&[&[state.seed.as_ref()]]);',
    ' CpiContext::new(program, accounts).with_signer(&[&[b"vault", &[255]]]);',
    ' CpiContext::new(program, accounts).with_signer(validated_seeds);',
    '}',
  ].join('\n');
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    const result = parseSastResult({ exitCode: 0, stdout: run(['oms-sast', '--file', 'lib.rs'], dir), timedOut: false, truncated: false },
      'lib.rs', new Map([['lib.rs', 6]]));
    assert.equal(result.status, 'ok');
    assert.equal(result.invalidOutputs, 0);
    assert.deepEqual(result.hits.map(hit => [hit.ruleId, hit.location.handler, hit.location.line]), [
      ['signer-seeds/anchor-cpi-context', 'transfer', 2],
      ['signer-seeds/anchor-cpi-context', 'transfer', 3],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CVE method and nested body signals survive host parsing', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-review-cve-bodies-'));
  execFileSync('chmod', ['755', dir]);
  const source = [
    'struct Pay { system: Program<System> }',
    'impl Processor { fn pay(ctx: Context<Pay>) {',
    ' invoke(&Instruction { program_id: ctx.accounts.system.key() }, accounts);',
    ' fn nested(system: &(Program<System>)) {',
    '  invoke_signed(&Instruction { program_id: system.key() }, accounts, seeds);',
    ' }',
    ' fn unrelated() { invoke(&Instruction { program_id: ctx.accounts.system.key() }, accounts); }',
    '} }',
  ].join('\n');
  try {
    writeFileSync(join(dir, 'lib.rs'), source);
    for (const version of ['1.0.1', '1.0.2']) {
      writeFileSync(join(dir, 'Cargo.lock'), `[[package]]\nname='anchor-lang'\nversion='${version}'\n`);
      const result = parseSastResult({ exitCode: 0,
        stdout: run(['oms-sast', '--file', 'lib.rs', '--lockfile', 'Cargo.lock'], dir), timedOut: false, truncated: false },
      'lib.rs', new Map([['lib.rs', 8]]));
      assert.equal(result.status, 'ok');
      assert.equal(result.invalidOutputs, 0);
      assert.deepEqual(result.hits.map(hit => [hit.ruleId, hit.location.handler, hit.location.line]),
        version === '1.0.1' ? [
          ['anchor-cve-2026-45137/inline-instruction', 'pay', 3],
          ['anchor-cve-2026-45137/inline-instruction', 'nested', 5],
        ] : []);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
