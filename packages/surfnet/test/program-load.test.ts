import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { address, getAddressEncoder, getBase58Decoder, getProgramDerivedAddress } from '@solana/kit';
import { buildMounts, buildRunArgs } from '../../sandbox/src/index.ts';
import { skipUnavailable, skipUnavailableToolchain } from '../../sandbox/test-support/infrastructure.ts';
import { configuredToolchainImage } from '../../engine/src/runtime/environment.ts';
import { createVerifierBackend } from '../../engine/src/runtime/verifier-backend.ts';
import { createSurfnet } from '../src/manager.ts';
import { exportSnapshot } from '../test-support/snapshot.ts';

const execute = promisify(execFile);
const binary = process.env.SURFPOOL_BINARY ?? join(process.env.HOME ?? '', '.local/bin/surfpool');
const image = configuredToolchainImage();
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE;
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
const encode = (value: string) => Buffer.from(getAddressEncoder().encode(address(value)));
const decode = (value: Uint8Array) => getBase58Decoder().decode(value);
function signer() {
  const pair = generateKeyPairSync('ed25519');
  const bytes = Buffer.from((pair.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  return { bytes, pubkey: decode(bytes), sign: (message: Buffer) => sign(null, message, pair.privateKey) };
}
type Rpc = (method: string, params?: unknown[]) => Promise<unknown>;
async function account(rpc: Rpc, pubkey: string) {
  const result = await rpc('getAccountInfo', [pubkey, { encoding: 'base64' }]) as {
    value: { executable: boolean; owner: string; data: [string, string] } | null };
  assert.ok(result.value, `account ${pubkey} exists`);
  return { ...result.value, bytes: Buffer.from(result.value.data[0], 'base64') };
}
async function invoke(rpc: Rpc, program: string, nonce: number) {
  const payer = signer();
  await rpc('surfnet_setAccount', [payer.pubkey, { lamports: 100_000_000 }]);
  const { value } = await rpc('getLatestBlockhash') as { value: { blockhash: string } };
  const message = Buffer.concat([Buffer.from([1, 0, 1, 2]), payer.bytes, encode(program), encode(value.blockhash),
    Buffer.from([1, 1, 0, 1, nonce])]);
  const wire = Buffer.concat([Buffer.from([1]), payer.sign(message), message]).toString('base64');
  const simulation = await rpc('simulateTransaction', [wire, { encoding: 'base64', sigVerify: true }]) as { value: { err: unknown; logs: string[] } };
  assert.equal(simulation.value.err, null, JSON.stringify(simulation.value));
  assert.ok(simulation.value.logs.some(line => line.includes(`Program ${program} success`)));
  const signature = await rpc('sendTransaction', [wire, { encoding: 'base64' }]) as string;
  for (let attempt = 0; attempt < 30; attempt++) {
    const statuses = await rpc('getSignatureStatuses', [[signature]]) as { value: Array<{ err: unknown } | null> };
    if (statuses.value[0]) { assert.equal(statuses.value[0].err, null); return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('noop transaction did not settle');
}

for (const arch of ['default', 'v3'] as const) {
  test(`surfnet_writeProgram wins over loader-v3 setAccount for a single-write load: ${arch} program survives a snapshot export and an independent verifier`, { timeout: 300_000 }, async t => {
    if (skipUnavailableToolchain(t, image)) return;
    if (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary }) || !image || !forwarderImage) return;
    const root = await mkdtemp(join(tmpdir(), 'oms-program-load-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ['output', 'work', 'leases']) await mkdir(join(root, name), { mode: 0o700 });
    const mounts = buildMounts({ projectRoot: fileURLToPath(new URL('./fixtures/pinocchio-noop', import.meta.url)),
      projectMode: 'ro', taskName: `program-${arch}`, heavyDirs: [],
      extra: [{ hostPath: join(root, 'output'), containerPath: '/output' }], forbidden: { signerDir: join(root, 'leases') } });
    const args = buildRunArgs({ image, name: `oms-program-build-${arch}-${process.pid}`, mounts,
      argv: ['cargo', 'build-sbf', '--offline', '--locked', '--sbf-out-dir', '/output', ...(arch === 'v3' ? ['--arch', 'v3'] : [])],
      network: 'none', cwd: '/work', env: { HOME: '/tmp', CARGO_HOME: '/tmp/cargo', CARGO_TARGET_DIR: '/tmp/target' },
      limits: { memoryMb: 6144, cpus: 4, pidsLimit: 1024 } });
    const build = await execute('docker', args, { timeout: 240_000, maxBuffer: 1024 * 1024 });
    t.diagnostic(build.stderr);
    const elf = await readFile(join(root, 'output/oms_pinocchio_noop.so'));
    assert.ok(elf.length >= 400 * 1024, `real ELF has ${elf.length} bytes`);
    assert.equal(elf.subarray(0, 4).toString('hex'), '7f454c46');
    const surf = createSurfnet({ binary, workDir: join(root, 'exploration') });
    await surf.start();
    t.after(() => surf.stop());
    const rpc: Rpc = (method, params) => surf.rpc.call(method, params);
    for (const method of ['surfnet_writeProgram', 'surfnet_setAccount']) {
      const program = signer().pubkey;
      const [programData] = await getProgramDerivedAddress({ programAddress: address(loader), seeds: [encode(program)] });
      if (method === 'surfnet_writeProgram') await rpc(method, [program, elf.toString('hex'), 0]);
      else {
        const dataHeader = Buffer.alloc(45); dataHeader.writeUInt32LE(3);
        const programHeader = Buffer.concat([Buffer.from([2, 0, 0, 0]), encode(programData)]);
        await rpc(method, [programData, { owner: loader, lamports: 10_000_000_000, data: Buffer.concat([dataHeader, elf]).toString('hex') }]);
        await rpc(method, [program, { owner: loader, executable: true, lamports: 1_000_000, data: programHeader.toString('hex') }]);
      }
      assert.equal((await account(rpc, program)).executable, true);
      assert.deepEqual((await account(rpc, programData)).bytes.subarray(45), elf);
      await invoke(rpc, program, 1);
      const snapshotPath = join(root, `${arch}-${method}.json`);
      await writeFile(snapshotPath, await exportSnapshot(surf.rpcUrl()!));
      const verifier = await createVerifierBackend({ taskName: `spike-${arch}`, binary, image, forwarderImage,
        workDir: join(root, 'work'), leaseDir: join(root, 'leases') });
      try {
        const chain = await verifier.surfnets.start(snapshotPath);
        const verifyRpc: Rpc = (method, params) => chain.call(method, params);
        assert.equal((await account(verifyRpc, program)).executable, true);
        assert.deepEqual((await account(verifyRpc, programData)).bytes.subarray(45), elf);
        await invoke(verifyRpc, program, 2);
      } finally { await verifier.dispose(); }
      t.diagnostic(`${method}: ${elf.length} bytes verified and invoked in exploration and the independent verifier`);
    }
  });
}
