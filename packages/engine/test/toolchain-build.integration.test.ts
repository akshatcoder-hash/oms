import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMounts, removeTaskResources } from '@oms/sandbox';
import { createSurfnet } from '@oms/surfnet';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';
import { toolchainEnvironment } from '../test-support/toolchain-environment.ts';
import { backendFor } from '../src/runtime/execution-backend.ts';
import { createSandboxTools } from '../src/runtime/sandbox-tools.ts';
import { readProject } from '../src/toolchain/project.ts';
import { checkToolchain } from '../src/toolchain/check.ts';
import { planToolchainFix, applyToolchainFix } from '../src/toolchain/fix.ts';

test('mechanical toolchain repairs build Anchor and run the on-chain counter test in the pinned image', {timeout:1_200_000}, async t=>{
 const environment = toolchainEnvironment(t);
 if (!environment) return;
 if(await skipUnavailable(t,{docker:[environment.image,environment.forwarderImage],surfpool:environment.binary})) return;
 const root=await mkdtemp(join(tmpdir(),'oms-fixer-build-'));
 const source=join(root,'source'),project=join(root,'task'),privateDir=join(root,'private');
 const taskName=`fixer-${randomUUID()}`;
 await cp(fileURLToPath(new URL('../test-support/fixtures/anchor-counter',import.meta.url)),source,{recursive:true});
 await writeFile(join(source,'rust-toolchain.toml'),'[toolchain]\nchannel="1.98.1"\n');
 await mkdir(privateDir,{mode:0o700});
 execFileSync('git',['init','-q',source]); execFileSync('git',['-C',source,'add','.']); execFileSync('git',['-C',source,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','baseline']);
 execFileSync('git',['-C',source,'worktree','add','-qb','task',project]);
 const surf=createSurfnet({binary:environment.binary,workDir:join(root,'surfnet')});
 await surf.start();
 const mounts=buildMounts({projectRoot:project,taskName,heavyDirs:['target','.oms-cargo'],forbidden:{signerDir:privateDir}});
 const tools=createSandboxTools({taskName,mounts,backend:backendFor(environment),buildProfile:true,leaseDir:privateDir,sourceControlDir:join(privateDir,'source'),surfnetPort:surf.ports()!.rpc,
   signal:new AbortController().signal,remainingWallClockMs:()=>1_100_000});
 t.after(async()=>{await tools.dispose();await surf.stop();await removeTaskResources(taskName);await rm(root,{recursive:true,force:true});});
 let fetchDeps: {execute(id:string,input:{manager:'cargo'|'npm'}):Promise<{isError?:boolean;content:unknown}>}|undefined;
 tools.extension({registerTool(tool:{name:string}) {if(tool.name==='deps_fetch') fetchDeps=tool as unknown as typeof fetchDeps;},on(){}} as unknown as ExtensionAPI);
 assert.ok(fetchDeps);
 assert.equal((await fetchDeps.execute('cargo',{manager:'cargo'})).isError,false);
 const baselineFindings=checkToolchain(readProject(project)).findings;
 assert.ok(baselineFindings.every(f=>f.rule==='duplicates'&&f.severity==='info'));
 const anchorPath=join(project,'Anchor.toml'),cargoPath=join(project,'programs/counter/Cargo.toml');
 const anchor=await readFile(anchorPath,'utf8'),cargo=await readFile(cargoPath,'utf8');
 const scenarios=[
   {name:'quoted Anchor toolchain table',mutate:()=>writeFile(anchorPath,anchor.replace('[toolchain]','["toolchain"]').replace('1.2.2','1.1.2'))},
   {name:'Anchor CLI pin',mutate:()=>writeFile(anchorPath,anchor.replace('1.2.2','1.1.2'))},
   {name:'Anchor 0.32 crate on 1.x image',mutate:()=>writeFile(cargoPath,cargo.replace('1.2.2','0.32.1'))},
   {name:'Solana switching pin',mutate:()=>writeFile(anchorPath,anchor.replace('[toolchain]','[toolchain]\nsolana_version="4.4.1"'))},
   {name:'quoted Solana switching key',mutate:()=>writeFile(anchorPath,anchor.replace('[toolchain]','[toolchain]\n"solana_version"="4.4.1"'))},
   {name:'target-specific Anchor alias',mutate:()=>writeFile(cargoPath,cargo.replace('anchor-lang/idl-build','anchor_lang/idl-build').replace('[dependencies]',`[target.'cfg(any(unix, target_os = "solana"))'.dependencies]`).replace('anchor-lang = "=1.2.2"','anchor_lang = { package = "anchor-lang", version = "=0.32.1" }'))},
   {name:'quoted Anchor dependency key',mutate:()=>writeFile(cargoPath,cargo.replace('anchor-lang = "=1.2.2"','"anchor-lang" = "=0.32.1"'))},
   {name:'table-form Anchor dependency',mutate:()=>writeFile(cargoPath,cargo.replace('[dependencies]\nanchor-lang = "=1.2.2"','[dependencies.anchor-lang]\nversion = "=0.32.1"'))},
 ];
 for(const scenario of scenarios) await t.test(scenario.name,async()=>{
   await scenario.mutate();
   const before=readProject(project);
   assert.ok(checkToolchain(before).findings.some(f=>f.severity!=='info'));
   const red=await tools.execute(['env','-u','RUSTUP_TOOLCHAIN','anchor','build','--ignore-keys']);
   assert.notEqual(red.exitCode,0,`broken fixture unexpectedly built: ${red.stdout}${red.stderr}`);
   const plan=planToolchainFix(before); applyToolchainFix(before,plan);
   assert.deepEqual(checkToolchain(readProject(project)).findings,baselineFindings);
   const build=await tools.execute(['env','-u','RUSTUP_TOOLCHAIN','CARGO_BUILD_JOBS=1','anchor','build','--ignore-keys']);
   assert.equal(build.exitCode,0,build.stdout+build.stderr);
   const checked=await tools.execute(['anchor','test','--skip-build','--skip-deploy','--skip-local-validator']);
   assert.equal(checked.exitCode,0,checked.stdout+checked.stderr);
   assert.match(checked.stdout,/offline Anchor counter executes increment/);
 });
});
