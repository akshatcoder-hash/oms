import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { buildMounts, buildRunArgs, removeTaskResources, runInSandbox, type RunInSandboxOptions } from '@oms/sandbox';
import { createSurfnet } from '@oms/surfnet';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';
import { createSandboxTools } from '../src/runtime/sandbox-tools.ts';
import { createVerifierBackend } from '../src/runtime/verifier-backend.ts';
import { toolchainEnvironment } from '../test-support/toolchain-environment.ts';

const execute = promisify(execFile);

test('host-local toolchain receipt matches offline hardened image; Anchor shim refuses version switching', async t => {
  const environment = toolchainEnvironment(t);
  if (!environment) return;
  if (await skipUnavailable(t, { docker: [environment.image] })) return;
  const manifest = JSON.parse(await readFile(new URL('../runtime-manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.schema, 'oms.runtime/2');
  assert.equal(manifest.toolchainImages.x64, null);
  const receipt = JSON.parse(await readFile(new URL('../../../.tmp/toolchain/image.json', import.meta.url), 'utf8').catch(() => '{}'));
  assert.equal(process.env.OMS_TOOLCHAIN_IMAGE || receipt[process.arch], environment.image);
  const inspected = await execute('docker', ['image', 'inspect', environment.image, '--format', '{{.Id}}']);
  if (environment.image.startsWith('sha256:')) assert.equal(inspected.stdout.trim(), environment.image);
  else {
    const digests = await execute('docker', ['image', 'inspect', environment.image, '--format', '{{json .RepoDigests}}']);
    assert.ok(JSON.parse(digests.stdout).includes(environment.image));
  }
  const root = await mkdtemp(join(tmpdir(), 'oms-toolchain-shim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project')); await mkdir(join(root, 'private'), {mode:0o700});
  const mounts = buildMounts({projectRoot:join(root,'project'),taskName:'shim-test',heavyDirs:[],forbidden:{signerDir:join(root,'private')}});
  const run = (argv: string[]) => execute('docker',buildRunArgs({image:environment.image,name:`oms-shim-${randomUUID()}`,argv,mounts,
    network:'none',cwd:'/work',env:{HOME:'/tmp'},limits:{memoryMb:6144,cpus:4,pidsLimit:1024}}),{timeout:30_000});
  assert.match((await run(['anchor','--version'])).stdout,/anchor-cli 1\.2\.2/);
  assert.match((await run(['solana','--version'])).stdout,/solana-cli 4\.4\.1/);
  assert.match((await run(['rustc','--version'])).stdout,/rustc 1\.98\.1/);
  await writeFile(join(root,'project/Anchor.toml'),'[toolchain]\nanchor_version="9.9.9"\n');
  await assert.rejects(run(['anchor','--version']), /E_ANCHOR_VERSION_UNSUPPORTED/);
  await writeFile(join(root,'project/Anchor.toml'),'[toolchain]\nsolana_version="4.4.1"\n');
  await assert.rejects(run(['anchor','--version']), /E_SOLANA_VERSION_UNSUPPORTED/);
  await run(['sh','-c','! command -v avm']);
});

test('cold Anchor build exceeds 60 seconds, cached rebuild compiles no dependencies, locked npm and TS test run offline', {timeout:1_200_000}, async t => {
  const environment = toolchainEnvironment(t);
  if (!environment) return;
  if (await skipUnavailable(t,{docker:[environment.image,environment.forwarderImage],surfpool:environment.binary})) return;
  const root = await mkdtemp(join(tmpdir(),'oms-anchor-build-'));
  const taskName = `anchor-${randomUUID()}`;
  await cp(fileURLToPath(new URL('../test-support/fixtures/anchor-counter', import.meta.url)),join(root,'project'),{recursive:true});
  await mkdir(join(root,'private'),{mode:0o700});
  const surf = createSurfnet({binary:environment.binary,offline:true,workDir:join(root,'surfnet')});
  await surf.start();
  const mounts = buildMounts({projectRoot:join(root,'project'),taskName,heavyDirs:['target','.oms-cargo'],forbidden:{signerDir:join(root,'private')}});
  const tools = createSandboxTools({taskName,mounts,...environment,buildProfile:true,leaseDir:join(root,'private'),surfnetPort:surf.ports()!.rpc,
    sourceControlDir:join(root,'private/source'),signal:new AbortController().signal,remainingWallClockMs:()=>1_100_000});
  t.after(async()=>{await tools.dispose();await surf.stop();await removeTaskResources(taskName);await rm(root,{recursive:true,force:true});});
  let deps: {execute(id:string,input:{manager:'cargo'|'npm'}):Promise<{isError?:boolean;content:unknown}>} | undefined;
  tools.extension({registerTool(tool: {name:string}){if(tool.name==='deps_fetch')deps=tool as unknown as typeof deps;},on(){}} as unknown as ExtensionAPI);
  assert.ok(deps);
  const missing = await tools.execute(['cargo','build-sbf']);
  assert.notEqual(missing.exitCode,0);
  assert.match(missing.stdout+missing.stderr,/E_DEPS_NOT_FETCHED/);
  const cargo = await deps.execute('cargo-fetch',{manager:'cargo'});
  assert.equal(cargo.isError,false,JSON.stringify(cargo.content));
  const npm = await deps.execute('npm-fetch',{manager:'npm'});
  assert.equal(npm.isError,false,JSON.stringify(npm.content));
  const started=Date.now();
  const cold = await tools.execute(['env','CARGO_BUILD_JOBS=1','anchor','build','--ignore-keys','--','-v']);
  const elapsed=Date.now()-started;
  assert.equal(cold.exitCode,0,cold.stdout+cold.stderr);
  assert.ok(elapsed>60_000,`cold build completed in ${elapsed}ms; >60s acceptance not demonstrated`);
  const warm = await tools.execute(['env','CARGO_BUILD_JOBS=1','anchor','build','--ignore-keys','--','-v']);
  assert.equal(warm.exitCode,0,warm.stdout+warm.stderr);
  assert.doesNotMatch(warm.stdout+warm.stderr,/Compiling\s/);
  for (const volume of mounts.volumes) await execute('docker',['volume','inspect',volume.name]);
  const ts = await tools.execute(['anchor','test','--skip-build','--skip-deploy','--skip-local-validator']);
  assert.equal(ts.exitCode,0,ts.stdout+ts.stderr);
  assert.match(ts.stdout,/offline Anchor counter executes increment/);
  t.diagnostic(`cold Anchor build ${elapsed}ms; warm rebuild compiles zero crates; both volumes exist; Anchor TS counter passes offline`);
});


test('verifier fetches locked dependencies into fresh isolated volumes and removes them after offline builds', {timeout:300_000}, async t => {
  const environment = toolchainEnvironment(t);
  if (!environment) return;
  if (await skipUnavailable(t,{docker:[environment.image,environment.forwarderImage],surfpool:environment.binary})) return;
  const root = await mkdtemp(join(tmpdir(),'oms-verifier-build-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await cp(fileURLToPath(new URL('../../surfnet/test/fixtures/pinocchio-noop', import.meta.url)),join(root,'project'),{recursive:true});
  await rm(join(root,'project/vendor'),{recursive:true});
  await rm(join(root,'project/.cargo'),{recursive:true});
  for (const name of ['work','private']) await mkdir(join(root,name),{mode:0o700});
  const runs: RunInSandboxOptions[] = [];
  const backend = await createVerifierBackend({...environment,taskName:'isolated-verifier',buildProfile:true,
    workDir:join(root,'work'),leaseDir:join(root,'private')}, {createSurfnet,runInSandbox: async options=>{runs.push(options);const result=await runInSandbox(options);if(result.exitCode!==0)t.diagnostic(result.stdout+result.stderr);return result;}});
  try {
    const chain=await backend.surfnets.start(undefined);
    for(let i=0;i<2;i++) {
      const result=await backend.sandbox.run(['sh','-c',
        'cargo build-sbf --sbf-out-dir /output && node -e "const fs=require(\'fs\'); if(fs.statSync(\'/output/oms_pinocchio_noop.so\').size<409600) process.exit(1)"'],
        {codeRoot:join(root,'project'),surfnetPort:chain.port,timeoutMs:120_000});
      assert.equal(result.exitCode,0,result.stdout+result.stderr);
    }
    assert.deepEqual(runs.map(run=>run.phase),['install','run','install','run']);
    const names=runs.filter(run=>run.phase==='run').map(run=>run.mounts.volumes.map(volume=>volume.name));
    assert.equal(names[0]!.length,2);
    assert.ok(names[0]!.every(name=>!names[1]!.includes(name)));
    assert.ok(names.flat().every(name=>name.startsWith('oms-verify-')));
    for (const name of names.flat()) {
      const listed=await execute('docker',['volume','ls','--filter',`name=^${name}$`,'--format','{{.Name}}']);
      assert.equal(listed.stdout.trim(),'');
    }
  } finally { await backend.dispose(); }
});
