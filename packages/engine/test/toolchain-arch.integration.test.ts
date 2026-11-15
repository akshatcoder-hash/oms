import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolchainEnvironment } from '../test-support/toolchain-environment.ts';
import { verifyToolchainProject } from '../src/toolchain/verify.ts';
import { readProject } from '../src/toolchain/project.ts';
import { checkToolchain } from '../src/toolchain/check.ts';
import { applyToolchainFix, planToolchainFix } from '../src/toolchain/fix.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

test(
  'production toolchain verification builds explicit SBPFv3 ELF and executes its on-chain test',
  { timeout: 900_000 },
  async (t) => {
    const environment = toolchainEnvironment(t);
    if (!environment) return;
    if (
      await skipUnavailable(t, {
        docker: [environment.image, environment.forwarderImage],
        surfpool: environment.binary,
      })
    )
      return;
    const root = await mkdtemp(join(tmpdir(), 'oms-toolchain-v3-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(fileURLToPath(new URL('../test-support/fixtures/anchor-counter', import.meta.url)), root, {
      recursive: true,
    });
    const manifest = join(root, 'programs/counter/Cargo.toml');
    await writeFile(
      manifest,
      (await readFile(manifest, 'utf8')) + '\n[package.metadata.oms]\nrequired-sbpf-arch = "v3"\n',
    );
    const checks = join(root, 'checks/counter.ts');
    // Official cargo-build-sbf README documents ELF flags 0x3 for v3 (observed 2026-11-08):
    // https://github.com/anza-xyz/cargo-build-sbf#sbfpv3-migration
    await writeFile(
      checks,
      (await readFile(checks, 'utf8')) +
        `
  test('compiled ELF uses required SBPFv3 architecture', async () => {
    const elf = await readFile('target/deploy/oms_anchor_counter.so');
    assert.equal(elf.subarray(0, 4).toString('hex'), '7f454c46');
    assert.equal(elf[4], 2, 'ELF64');
    assert.equal(elf[5], 1, 'little endian');
    assert.equal(elf.readUInt32LE(48), 3, 'ELF e_flags must select SBPFv3');
  });
`,
    );
    assert.deepEqual(await verifyToolchainProject(root, environment.binary), {
      status: 'build and tests passed',
      image: environment.image,
      buildExitCode: 0,
      testExitCode: 0,
    });
  },
);

test(
  'repairing an Anchor script replaces a failing SBPFv2 build with a tested SBPFv3 program',
  { timeout: 1_800_000 },
  async (t) => {
    const environment = toolchainEnvironment(t);
    if (!environment) return;
    if (
      await skipUnavailable(t, {
        docker: [environment.image, environment.forwarderImage],
        surfpool: environment.binary,
      })
    )
      return;
    const root = await mkdtemp(join(tmpdir(), 'oms-toolchain-script-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'source');
    const project = join(root, 'task');
    await cp(fileURLToPath(new URL('../test-support/fixtures/anchor-counter', import.meta.url)), source, {
      recursive: true,
    });
    await writeFile(join(source, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.98.1"\n');
    const manifest = join(source, 'programs/counter/Cargo.toml');
    await writeFile(
      manifest,
      (await readFile(manifest, 'utf8')) + '\n[package.metadata.oms]\nrequired-sbpf-arch = "v3"\n',
    );
    const anchor = join(source, 'Anchor.toml');
    await writeFile(
      anchor,
      (await readFile(anchor, 'utf8')).replace(
        'test = "node --test checks/counter.ts"',
        'test = "anchor build --ignore-keys --arch v2 && node --test checks/counter.ts"',
      ),
    );
    const checks = join(source, 'checks/counter.ts');
    await writeFile(
      checks,
      (await readFile(checks, 'utf8')) +
        `
test('script-built ELF satisfies the declared SBPFv3 requirement', async () => {
  const elf = await readFile('target/deploy/oms_anchor_counter.so');
  assert.equal(elf.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(elf.readUInt32LE(48), 3, 'script must build SBPFv3');
});
`,
    );
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'broken SBPF script fixture',
    ]);
    execFileSync('git', ['-C', source, 'worktree', 'add', '-qb', 'task', project]);
    const before = readProject(project);
    assert.ok(checkToolchain(before).findings.some((f) => f.rule === 'arch'));
    const broken = await verifyToolchainProject(project, environment.binary);
    assert.equal(broken.status, 'proposed, not verified');
    assert.equal(broken.buildExitCode, 0, 'red must reach the project test script after a successful pinned build');
    const plan = planToolchainFix(before);
    assert.deepEqual(
      plan.edits.map((edit) => edit.path),
      ['Anchor.toml'],
    );
    applyToolchainFix(before, plan);
    assert.ok(!checkToolchain(readProject(project)).findings.some((f) => f.rule === 'arch'));
    assert.deepEqual(planToolchainFix(readProject(project)).edits, []);
    assert.deepEqual(await verifyToolchainProject(project, environment.binary), {
      status: 'build and tests passed',
      image: environment.image,
      buildExitCode: 0,
      testExitCode: 0,
    });
  },
);
