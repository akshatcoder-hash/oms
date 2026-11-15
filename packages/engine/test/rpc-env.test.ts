import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pinContract, readPin, verifyPin } from '@oms/contract';
import { buildMounts, SURFPOOL_LIBS, type RunInSandboxOptions } from '@oms/sandbox';
import type { Surfnet } from '@oms/surfnet';
import { dockerBackend, hostBackend } from '../src/runtime/execution-backend.ts';
import { createSandboxTools } from '../src/runtime/sandbox-tools.ts';
import { createVerifierBackend, trustedSurfpoolMounts } from '../src/runtime/verifier-backend.ts';
import { createHarnessSession, type HarnessSession } from '../src/runtime/session.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const IMAGE = process.env.OMS_SANDBOX_IMAGE;
const FORWARDER = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? IMAGE;
const BINARY = process.env.SURFPOOL_BINARY;
const OLD_POLICY = 'oms.verifier-backend/2:offline:no-airdrop:ro-work:fresh-output:no-volumes:run-egress:nonroot:source-exclusion:checked-binds';
const PORT = 18899;
const RPC_URL = `http://host.docker.internal:${PORT}`;
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

test('verifier sandbox env carries SOLANA_RPC_URL and SURFNET_RPC_URL with the same value', async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'oms-rpc-env-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'surfpool');
  writeFileSync(binary, '#!/bin/sh\nexit 1\n');
  chmodSync(binary, 0o700);
  for (const name of ['work', 'leases', 'code']) mkdirSync(path.join(root, name), { mode: 0o700 });
  const image = `node@sha256:${'1'.repeat(64)}`;
  const runs: RunInSandboxOptions[] = [];
  const backend = await createVerifierBackend({
    backend: dockerBackend({ image, forwarderImage: image }), taskName: 'rpc-env', binary,
    workDir: path.join(root, 'work'), leaseDir: path.join(root, 'leases'), sourceControlDir: path.join(root, 'source-control'),
  }, {
    createSurfnet: () => {
      let running = false;
      return {
        mode: 'offline-snapshot', start: async () => { running = true; }, stop: async () => { running = false; },
        ports: () => running ? { rpc: PORT, ws: PORT + 1 } : undefined,
        rpc: { url: `http://127.0.0.1:${PORT}`, call: async () => ({}) },
      } as unknown as Surfnet;
    },
    async runInSandbox(options) {
      runs.push(options);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, truncated: false };
    },
  });
  try {
    const session = await backend.surfnets.start(undefined);
    await backend.sandbox.run(['true'], { codeRoot: path.join(root, 'code'), surfnetPort: session.port, timeoutMs: 1000 });
  } finally { await backend.dispose(); }
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.env?.SOLANA_RPC_URL, RPC_URL);
  assert.equal(runs[0]!.env?.SURFNET_RPC_URL, RPC_URL);
});

test('the trusted Surfpool mounts read-only at the path the task scripts probe, with its libraries', () => {
  const mounts = trustedSurfpoolMounts('/opt/oms/surfpool');
  assert.deepEqual(mounts[0], { hostPath: '/opt/oms/surfpool', containerPath: '/trusted/surfpool', mode: 'ro' });
  assert.deepEqual(mounts.slice(1).map(mount => mount.hostPath), [...SURFPOOL_LIBS]);
  assert.ok(mounts.every(mount => mount.mode === 'ro'));
});

test('a host verifier command names the trusted Surfpool in SURFPOOL_BINARY, as the Docker one finds it at /trusted/surfpool', async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'oms-surfpool-env-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'surfpool');
  writeFileSync(binary, '#!/bin/sh\nexit 1\n');
  chmodSync(binary, 0o700);
  for (const name of ['work', 'leases', 'code']) mkdirSync(path.join(root, name), { mode: 0o700 });
  const runs: RunInSandboxOptions[] = [];
  const backend = await createVerifierBackend({
    backend: hostBackend(), taskName: 'surfpool-env', binary,
    workDir: path.join(root, 'work'), leaseDir: path.join(root, 'leases'),
  }, {
    createSurfnet: () => ({
      mode: 'offline-snapshot', start: async () => {}, stop: async () => {},
      ports: () => ({ rpc: PORT, ws: PORT + 1 }), rpc: { url: `http://127.0.0.1:${PORT}`, call: async () => ({}) },
    }) as unknown as Surfnet,
    async runInSandbox(options) {
      runs.push(options);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, truncated: false };
    },
  });
  try {
    const session = await backend.surfnets.start(undefined);
    await backend.sandbox.run(['true'], { codeRoot: path.join(root, 'code'), surfnetPort: session.port, timeoutMs: 1000 });
  } finally { await backend.dispose(); }
  assert.equal(runs[0]!.env?.SURFPOOL_BINARY, realpathSync(binary));
});

test('a real Docker command through createSandboxTools sees both RPC names with the same value', { timeout: 120_000 }, async t => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER] }) || !IMAGE || !FORWARDER) return;
  const scratch = path.resolve(import.meta.dirname, '../.tmp');
  mkdirSync(scratch, { recursive: true });
  const base = mkdtempSync(path.join(scratch, 'rpc-env-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const state = path.join(base, 'state');
  const signer = path.join(base, 'signer');
  for (const dir of [project, state, signer]) mkdirSync(dir);
  const taskName = `rpc-env-${process.pid}`;
  const controller = new AbortController();
  const tools = createSandboxTools({
    taskName, backend: dockerBackend({ image: IMAGE, forwarderImage: FORWARDER }),
    mounts: buildMounts({ projectRoot: project, taskName, forbidden: { signerDir: signer, stateDir: state } }),
    leaseDir: path.join(base, 'leases'), sourceControlDir: path.join(base, 'source-control'),
    surfnetPort: PORT, signal: controller.signal,
  });
  try {
    const result = await tools.execute(['/bin/sh', '-c',
      'printf "%s\\n%s\\n" "$SOLANA_RPC_URL" "$SURFNET_RPC_URL"; [ -n "$SOLANA_RPC_URL" ] && [ "$SOLANA_RPC_URL" = "$SURFNET_RPC_URL" ] && echo ok']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, `${RPC_URL}\n${RPC_URL}\nok\n`);
  } finally {
    await tools.dispose();
    controller.abort();
  }
});

test('the agent runs commands where the trusted Surfpool exists, as the verifier does', { timeout: 120_000 }, async t => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER], surfpool: BINARY }) || !BINARY || !IMAGE || !FORWARDER) return;
  const f = await createHarnessFixture({ binary: BINARY, image: IMAGE, forwarderImage: FORWARDER });
  let harness: HarnessSession | undefined;
  try {
    harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
    const result = await harness.runCommand('[ -x /trusted/surfpool ] && printf "%s" "$SURFPOOL_BINARY"');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, '/trusted/surfpool');
  } finally {
    await harness?.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('a task pinned under the previous verifier policy is refused by the production session', { timeout: 120_000 }, async t => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER], surfpool: BINARY }) || !BINARY || !IMAGE || !FORWARDER) return;
  const f = await createHarnessFixture({ binary: BINARY, image: IMAGE, forwarderImage: FORWARDER });
  let harness: HarnessSession | undefined;
  try {
    const pin = readPin(f.task.pinFile);
    assert.ok(pin.ok);
    const oldIdentity = sha256(JSON.stringify({
      policy: OLD_POLICY, binaryDigest: sha256(readFileSync(realpathSync(BINARY))), image: IMAGE, forwarderImage: FORWARDER,
    }));
    const config = pin.value.evaluatorConfig as { executionIdentity: string };
    assert.notEqual(config.executionIdentity, oldIdentity, 'the adapter policy must change the execution identity');
    const repinned = pinContract({
      ...pin.value.roots, contractPath: pin.value.contract.path, pinFile: f.task.pinFile,
      verifierPaths: pin.value.verifier.files.map(file => file.path),
      evaluatorConfig: { ...config, executionIdentity: oldIdentity },
    });
    assert.ok(repinned.ok);
    assert.equal(verifyPin(f.task.pinFile, pin.value.roots).ok, true, 'the old-policy pin itself is intact');
    await assert.rejects(async () => {
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
    }, /differs from this task's pinned runtime/);
  } finally {
    await harness?.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});
