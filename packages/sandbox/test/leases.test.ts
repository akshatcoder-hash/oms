import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeScratchDir, removeScratchDir } from '../src/docker.ts';
import { buildMounts } from '../src/mounts.ts';
import { acquireVolumeLeases } from '../src/leases.ts';

test('host volume leases exclude mutation across separate Node processes', async t => {
  const base = makeScratchDir('oms-volume-leases-');
  t.after(() => removeScratchDir(base));
  const project = path.join(base, 'project');
  mkdirSync(project);
  const mounts = buildMounts({ projectRoot: project, taskName: 'lease-test' });
  const leaseDir = path.join(base, 'leases');
  const release = acquireVolumeLeases(leaseDir, 'lease-test', 'run', mounts);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireVolumeLeases } from ${JSON.stringify(new URL('../src/leases.ts', import.meta.url).href)};
    try {
      const release = acquireVolumeLeases(${JSON.stringify(leaseDir)}, 'lease-test', 'install', ${JSON.stringify(mounts)});
      release();
      process.exitCode = 1;
    } catch (error) {
      if (error.code !== 'E_RESOURCE_BUSY') throw error;
      console.log('blocked');
    }
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  try {
    const [code] = await exited;
    assert.equal(code, 0);
    assert.match(output, /blocked/);
  } finally {
    release();
  }
  acquireVolumeLeases(leaseDir, 'lease-test', 'install', mounts)();
});

test('symlinked lease location cannot expose host lease records inside the project', t => {
  const base = makeScratchDir('oms-volume-leases-');
  t.after(() => removeScratchDir(base));
  const project = path.join(base, 'project');
  mkdirSync(project);
  const leases = path.join(project, 'private');
  mkdirSync(leases, { mode: 0o700 });
  const alias = path.join(base, 'lease-alias');
  symlinkSync(leases, alias);
  const mounts = buildMounts({ projectRoot: project, taskName: 'lease-test' });
  assert.throws(() => acquireVolumeLeases(alias, 'lease-test', 'run', mounts), { code: 'E_BAD_ARGUMENT' });
});
