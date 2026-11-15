/** Resources shared by per-command runs and long-lived sessions: host exclusion,
 * data volumes and the per-execution egress network. Callers own the container.
 */
import { acquireSourceAccess, SourceAccessError, sourceControlDirectory } from '@oms/contract';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SandboxError } from './errors.ts';
import { installProxyEnv, sandboxUser } from './args.ts';
import type { MountPlan } from './mounts.ts';
import type { DockerClient } from './docker.ts';
import { setupInstallEgress, setupRunEgress, teardownEgress, type EgressSetup } from './egress.ts';
import { acquireVolumeLeases } from './leases.ts';
import { ensureLabeledVolume, removeOwnedResource } from './resources.ts';
import { validateBindSources } from './bind-sources.ts';
import { isWithinOrEqual } from './paths.ts';
import type { SandboxPhase } from './exec.ts';

export const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

export function cappedChunks(maxBytes: number) {
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      const take = Math.min(chunk.length, maxBytes - retained);
      if (take < chunk.length) truncated = true;
      if (take > 0) {
        chunks.push(take === chunk.length ? chunk : Buffer.from(chunk.subarray(0, take)));
        retained += take;
      }
    },
    toString: () => Buffer.concat(chunks, retained).toString('utf8'),
    isTruncated: () => truncated,
  };
}

/** Argument checks shared by per-command runs and sessions; only the identity of the work is validated here. */
export function validateRunOptions(
  o: Pick<ExclusionOptions, 'taskName' | 'phase'> & {
    timeoutMs?: number;
    stdoutLimitBytes?: number;
    stderrLimitBytes?: number;
  },
): void {
  if (
    o.timeoutMs !== undefined &&
    (!Number.isInteger(o.timeoutMs) || o.timeoutMs <= 0 || o.timeoutMs > 2_147_483_647)
  ) {
    throw new SandboxError('E_BAD_ARGUMENT', `invalid timeoutMs: ${o.timeoutMs}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.taskName) || !['install', 'run'].includes(o.phase)) {
    throw new SandboxError('E_BAD_ARGUMENT', 'invalid taskName or phase');
  }
  for (const limit of [o.stdoutLimitBytes ?? DEFAULT_OUTPUT_LIMIT, o.stderrLimitBytes ?? DEFAULT_OUTPUT_LIMIT]) {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new SandboxError('E_BAD_ARGUMENT', 'output limits must be nonnegative integers');
  }
}

export interface ExclusionOptions {
  taskName: string;
  phase: SandboxPhase;
  mounts: MountPlan;
  leaseDir: string;
  sourceControlDir?: string;
}

/** Host-side mutation exclusion: source ownership, then volume leases. The
 * returned release stops at its first failure and leaves the rest held. */
export function acquireExclusion(o: ExclusionOptions): () => void {
  const control = sourceControlDirectory(o);
  const binds = [o.mounts.projectMount, ...o.mounts.extraMounts, ...o.mounts.readOnlyMounts];
  if (binds.some((bind) => isWithinOrEqual(control, bind.hostPath))) {
    throw new SandboxError('E_BAD_ARGUMENT', 'sourceControlDir must not be exposed through any sandbox bind');
  }
  validateBindSources(o.mounts);
  const held: Array<() => void> = [];
  const release = () => {
    while (held.length) {
      held.at(-1)!();
      held.pop();
    }
  };
  try {
    try {
      // Extra writable binds participate too: a different managed project's
      // rw parent must not mutate an output source while its bind is resolved.
      for (const root of [
        ...new Set([
          o.mounts.projectMount.hostPath,
          ...o.mounts.extraMounts.filter((mount) => mount.mode === 'rw').map((mount) => mount.hostPath),
        ]),
      ].sort()) {
        held.push(acquireSourceAccess(root, { sourceControlDir: control, kind: 'sandbox' }));
      }
    } catch (error) {
      if (error instanceof SourceAccessError && error.code === 'E_SOURCE_BUSY')
        throw new SandboxError('E_RESOURCE_BUSY', error.message);
      throw error;
    }
    validateBindSources(o.mounts);
    held.push(acquireVolumeLeases(o.leaseDir, o.taskName, o.phase, o.mounts));
  } catch (error) {
    try {
      release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'sandbox exclusion cleanup failed');
    }
    throw error;
  }
  return release;
}

export interface EnvironmentOptions extends ExclusionOptions {
  image: string;
  forwarderImage: string;
  env?: Record<string, string>;
  installAllowlist?: string[];
  surfnet?: { port: number; targetHost?: string; targetPort?: number };
}

export interface Environment {
  egress: EgressSetup;
  /** Caller environment plus the install-phase proxy. */
  env: Record<string, string>;
  /** Run-phase dependency volumes are read-only. */
  mounts: MountPlan;
}

/** Call under exclusion. Cleans up after itself; a cleanup failure is an AggregateError. */
export async function openEnvironment(
  o: EnvironmentOptions,
  docker: DockerClient,
  signal: AbortSignal,
): Promise<Environment> {
  const user = sandboxUser();
  const initName = `oms-${o.taskName}-${o.phase}-${randomUUID()}-volumes`;
  const initLabels = {
    'oms.component': 'sandbox',
    'oms.task': o.taskName,
    'oms.execution': randomUUID(),
    'oms.phase': 'install',
  };
  let initAttempted = false;
  try {
    for (const volume of o.mounts.volumes) await ensureLabeledVolume(docker, volume.name, o.taskName, signal);
    signal.throwIfAborted();
    const writableVolumes = o.mounts.volumes.filter(
      (volume) =>
        !volume.readOnly && (o.phase === 'install' || path.posix.basename(volume.containerPath) !== 'node_modules'),
    );
    if (writableVolumes.length) {
      // Only the volume roots change owner, never dependency contents. This
      // helper has no project bind or network and holds the source/volume leases.
      initAttempted = true;
      const targets = writableVolumes.map((_, index) => `/volumes/${index}`);
      const initId = (
        await docker.out([
          'create',
          '--pull=never',
          '--name',
          initName,
          ...Object.entries(initLabels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
          '--network',
          'none',
          '--read-only',
          '--user',
          '0:0',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'CHOWN',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '16',
          '--memory',
          '64m',
          ...writableVolumes.flatMap((volume, index) => ['--volume', `${volume.name}:${targets[index]}`]),
          o.image,
          'chown',
          user,
          ...targets,
        ])
      ).trim();
      signal.throwIfAborted();
      await docker.out(['start', '--attach', initId]);
      signal.throwIfAborted();
      const initExit = (await docker.out(['inspect', '-f', '{{.State.ExitCode}}', initId], signal)).trim();
      if (initExit !== '0') throw new SandboxError('E_DOCKER', `volume initialization failed with exit ${initExit}`);
      await removeOwnedResource(docker, 'container', initName, initLabels);
      initAttempted = false;
    }
    const common = { taskName: o.taskName, forwarderImage: o.forwarderImage, signal };
    const egress =
      o.phase === 'install'
        ? await setupInstallEgress({ ...common, allowlist: o.installAllowlist ?? [] }, docker)
        : await setupRunEgress(
            {
              ...common,
              surfnetPort: o.surfnet!.port,
              surfnetTargetHost: o.surfnet!.targetHost,
              surfnetTargetPort: o.surfnet!.targetPort,
            },
            docker,
          );
    const env = { ...o.env };
    if (o.phase === 'install') Object.assign(env, installProxyEnv(`http://oms-fwd:${egress.forwarderPort}`));
    const mounts =
      o.phase === 'run'
        ? {
            ...o.mounts,
            volumes: o.mounts.volumes.map((volume) => ({
              ...volume,
              readOnly: volume.readOnly || path.posix.basename(volume.containerPath) === 'node_modules',
            })),
          }
        : o.mounts;
    return { egress, env, mounts };
  } catch (error) {
    if (!initAttempted) throw error;
    try {
      await removeOwnedResource(docker, 'container', initName, initLabels);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'sandbox setup cleanup failed');
    }
    throw error;
  }
}

/** Removes the optional container, then the egress. Failures are collected, never thrown early. */
export async function closeEnvironment(
  environment: Environment,
  docker: DockerClient,
  container?: string,
): Promise<void> {
  const failures: unknown[] = [];
  if (container) {
    try {
      await removeOwnedResource(docker, 'container', container, environment.egress.labels);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await teardownEgress(environment.egress, docker);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'sandbox cleanup failed');
}
