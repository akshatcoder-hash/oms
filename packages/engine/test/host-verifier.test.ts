import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { hostBackend } from '../src/runtime/execution-backend.ts';
import { createVerifierBackend } from '../src/runtime/verifier-backend.ts';

test('host verifier runs real command against owned offline Surfpool with loopback RPC', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-host-verifier-'));
  for (const name of ['work', 'leases', 'code']) mkdirSync(join(root, name));
  mkdirSync(join(root, 'code/node_modules'));
  const dependencies = join(root, 'deps');
  mkdirSync(join(dependencies, 'node_modules/host-fixture'), { recursive: true });
  writeFileSync(join(dependencies, 'package-lock.json'), '{}');
  writeFileSync(join(dependencies, 'node_modules/host-fixture/package.json'), JSON.stringify({ name: 'host-fixture', main: 'index.cjs' }));
  writeFileSync(join(dependencies, 'node_modules/host-fixture/index.cjs'), 'module.exports = 42;');
  writeFileSync(join(root, 'code', 'verify.cjs'), `
    if (require('host-fixture') !== 42) throw Error('dependency not resolved');
    if (process.env.SOLANA_RPC_URL !== process.env.SURFNET_RPC_URL) throw Error('RPC mismatch');
    if (!process.env.SOLANA_RPC_URL.startsWith('http://127.0.0.1:')) throw Error('not loopback');
    if (Object.keys(process.env).some(name=>/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE/i.test(name))) throw Error('credential inherited');
    fetch(process.env.SOLANA_RPC_URL, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getHealth'}) })
      .then(r=>r.json()).then(r=>{if(r.result!=='ok')throw Error('unhealthy');console.log('VERIFIED')}).catch(e=>{console.error(e);process.exitCode=1});
  `);
  const backend = await createVerifierBackend({ backend: hostBackend(), taskName: 'host-verifier',
    binary: process.env.SURFPOOL_BINARY ?? process.env.OMS_SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool'),
    dependencies, workDir: join(root, 'work'), leaseDir: join(root, 'leases') });
  try {
    const surf = await backend.surfnets.start(undefined);
    const result = await backend.sandbox.run([process.execPath, 'verify.cjs'], { codeRoot: join(root, 'code'), surfnetPort: surf.port, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /VERIFIED/);
    assert.equal(existsSync(join(root, 'code/node_modules')), true);
    await surf.stop();
  } finally { await backend.dispose(); rmSync(root, { recursive: true, force: true }); }
});
