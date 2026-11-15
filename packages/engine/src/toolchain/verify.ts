import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultHarnessEnvironment } from '../runtime/environment.ts';
import { backendFor } from '../runtime/execution-backend.ts';
import { createVerifierBackend } from '../runtime/verifier-backend.ts';
import { readProject } from './project.ts';
import { toolchainBuildCommand } from './build.ts';
import { BUILD_TIMEOUT_MS } from '../runtime/build-profile.ts';
export interface ToolchainVerification {
  status: 'build and tests passed' | 'proposed, not verified';
  image: string; buildExitCode?: number; testExitCode?: number; error?: string;
}
/** Advisory developer build evidence. Never changes task status or replaces the pinned offline verifier. */
export async function verifyToolchainProject(project: string, surfpoolBinary?: string): Promise<ToolchainVerification> {
  const snapshot=readProject(project);
  let environment: ReturnType<typeof defaultHarnessEnvironment>;
  try { environment=defaultHarnessEnvironment(surfpoolBinary,'docker',true); }
  catch (error) { return {status:'proposed, not verified',image:'',error:error instanceof Error ? error.message : 'Pinned toolchain configuration unavailable'}; }
  const anchor=snapshot.files.find(f=>f.path==='Anchor.toml');
  const npm=snapshot.files.find(f=>f.path==='package.json');
  if(anchor && typeof anchor.data?.scripts?.test!=='string') return {status:'proposed, not verified',image:environment.image,error:'Anchor.toml needs an explicit test script'};
  if(!anchor && !snapshot.files.some(f=>f.path==='Cargo.toml')) return {status:'proposed, not verified',image:environment.image,error:'Pinned build verification currently requires a root Cargo.toml or Anchor.toml'};
  const npmDependencies=!!npm && Object.keys({...npm.data?.dependencies,...npm.data?.devDependencies,...npm.data?.optionalDependencies,...npm.data?.peerDependencies}).length>0;
  const root=await mkdtemp(join(tmpdir(),'oms-toolchain-verify-'));
  let backend: Awaited<ReturnType<typeof createVerifierBackend>>|undefined;
  try {
    const workDir=join(root,'work'),leaseDir=join(root,'lease');
    await mkdir(workDir,{mode:0o700}); await mkdir(leaseDir,{mode:0o700});
    backend=await createVerifierBackend({backend:backendFor(environment),binary:environment.binary,taskName:`toolchain-${randomUUID()}`,workDir,leaseDir,buildProfile:true,npmDependencies,dependencies:undefined});
    const surf=await backend.surfnets.start(undefined);
    // One fresh isolated build sandbox keeps the .so available for the test command.
    const build=toolchainBuildCommand(snapshot,anchor?'anchor':'cargo');
    const tests=anchor?['anchor','test','--skip-build','--skip-deploy','--skip-local-validator']:['cargo','test','--locked','--offline'];
    const script=`const {spawnSync}=require('node:child_process'); const build=spawnSync(${JSON.stringify(build[0])},${JSON.stringify(build.slice(1))},{stdio:'inherit'}); if(build.status!==0) process.exit(41); const tests=spawnSync(${JSON.stringify(tests[0])},${JSON.stringify(tests.slice(1))},{stdio:'inherit'}); if(tests.status!==0) process.exit(42);`;
    const result=await backend.sandbox.run(['node','-e',script],{codeRoot:snapshot.root,surfnetPort:surf.port,timeoutMs:BUILD_TIMEOUT_MS});
    if(result.exitCode===0) return {status:'build and tests passed',image:environment.image,buildExitCode:0,testExitCode:0};
    return {status:'proposed, not verified',image:environment.image,...(result.exitCode===42?{buildExitCode:0}:{}) ,error:`Pinned sandbox build or test failed: ${(result.stdout+result.stderr).slice(-2000)}`};
  } catch(error) { return {status:'proposed, not verified',image:environment.image,error:`Pinned sandbox verification unavailable: ${(error as Error).message}`}; }
  finally { await backend?.dispose(); await rm(root,{recursive:true,force:true}); }
}
