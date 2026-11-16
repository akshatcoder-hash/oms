/** Captured, cancellable execution on the host or in Docker. Overlapping host sources are serialized
 * through confirmed teardown. This is not a terminal/PTY or persistent-service
 * interface: those lifetimes must explicitly preserve the same source control.
 */
import { runOnHost } from './host.ts';
import { randomUUID } from 'node:crypto';
import { SandboxError } from './errors.ts';
import { buildRunArgs, sandboxUser, type BuildRunArgsOptions, type Limits } from './args.ts';
import type { MountPlan } from './mounts.ts';
import { sandboxDocker, type DockerClient } from './docker.ts';
import { requirePinnedImage } from './resources.ts';
import { validateBindSources } from './bind-sources.ts';
import {
  acquireExclusion,
  cappedChunks,
  closeEnvironment,
  DEFAULT_OUTPUT_LIMIT,
  openEnvironment,
  validateRunOptions,
  type Environment,
} from './execution.ts';

export type SandboxPhase = 'install' | 'run';

/** What every backend takes: the command, its mounts, and how it is bounded and observed. */
interface RunOptionsBase {
  onSpawn?: (pid: number, cwd: string) => void;
  taskName: string;
  phase: SandboxPhase;
  /** Command argv. Shell strings may appear only inside the argv. */
  argv: string[];
  mounts: MountPlan;
  /** Includes lease/setup and execution; cleanup is bounded separately and always awaited. */
  timeoutMs: number;
  /** Same trusted directory used by contract capture for this codeRoot. */
  sourceControlDir?: string;
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  /** Trusted host stream sink, before the ordinary head-only evidence limits. */
  onOutput?: (chunk: Buffer) => void;
}

/** A command on the user's machine: Seatbelt-confined on macOS, unconfined elsewhere. Takes no image, lease or egress settings. */
export interface HostRunOptions extends RunOptionsBase {
  backend: 'host';
  /** Files and trees a command may never write (pinned verifier files, git control). */
  protectedPaths?: string[];
  /** The one loopback port the command may reach. */
  surfnet?: { port: number };
  /** The user turned Seatbelt off (YOLO): the command runs as the user, with their HOME, network and writes. */
  unsandboxed?: boolean;
}

/** A command in a container with its own egress network. */
export interface DockerRunOptions extends RunOptionsBase {
  backend: 'docker';
  /** Approved local immutable sha256 image ID or repository@sha256 digest. Never pulled. */
  image: string;
  forwarderImage: string;
  /** Shared, private host directory, outside every sandbox bind; never placed in agent-controlled code. */
  leaseDir: string;
  limits?: Limits;
  installAllowlist?: string[];
  surfnet?: { port: number; targetHost?: string; targetPort?: number };
}

export type RunInSandboxOptions = HostRunOptions | DockerRunOptions;

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** Engine-owned per-session command log, never a host path. */
  logId?: string;
}

export async function runInSandbox(
  o: RunInSandboxOptions,
  docker: DockerClient = sandboxDocker,
): Promise<SandboxResult> {
  if (o.backend === 'host') return runOnHost(o);
  validateRunOptions(o);
  requirePinnedImage(o.image, 'image');
  requirePinnedImage(o.forwarderImage, 'forwarderImage');
  sandboxUser();
  const out = cappedChunks(o.stdoutLimitBytes ?? DEFAULT_OUTPUT_LIMIT);
  const err = cappedChunks(o.stderrLimitBytes ?? DEFAULT_OUTPUT_LIMIT);
  if (o.phase === 'run' && !o.surfnet) throw new SandboxError('E_BAD_ARGUMENT', 'run phase requires surfnet: { port }');

  const name = `oms-${o.taskName}-${o.phase}-${randomUUID()}`;
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const cancel = () => {
    if (!controller.signal.aborted) {
      cancelled = true;
      controller.abort(o.signal?.reason);
    }
  };
  o.signal?.addEventListener('abort', cancel, { once: true });
  if (o.signal?.aborted) cancel();
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      timedOut = true;
      controller.abort(new Error('sandbox timeout'));
    }
  }, o.timeoutMs);
  const signal = controller.signal;
  let environment: Environment | undefined;
  let release: (() => void) | undefined;
  let containerAttempted = false;
  let exitCode = 127;
  let failure: unknown;
  let cleanupFailed = false;
  try {
    signal.throwIfAborted();
    release = acquireExclusion(o);
    environment = await openEnvironment(o, docker, signal);
    const argsOptions: BuildRunArgsOptions = {
      image: o.image,
      name,
      argv: o.argv,
      cwd: o.cwd ?? '/work',
      env: environment.env,
      mounts: environment.mounts,
      network: environment.egress.networkName,
      labels: environment.egress.labels,
      limits: o.limits,
    };
    if (o.phase === 'run')
      argsOptions.addHosts = [{ host: 'host.docker.internal', ip: environment.egress.forwarderIP }];
    const args = buildRunArgs(argsOptions);
    // Separate creation from attach so cancellation cannot race a daemon-side
    // docker-run creation and leave a command executing after client shutdown.
    args[0] = 'create';
    signal.throwIfAborted();
    validateBindSources(o.mounts);
    containerAttempted = true;
    const id = (await docker.out(args)).trim();
    signal.throwIfAborted();
    exitCode = await docker.capture(['start', '--attach', id], {
      signal,
      stdout: (chunk) => {
        o.onOutput?.(chunk);
        out.push(chunk);
      },
      stderr: (chunk) => {
        o.onOutput?.(chunk);
        err.push(chunk);
      },
    });
  } catch (error) {
    // An aggregate from setup records cleanup failure, not a clean cancellation.
    cleanupFailed = error instanceof AggregateError;
    if (!signal.aborted || cleanupFailed) failure = error;
  } finally {
    const failures: unknown[] = [];
    if (environment) {
      try {
        await closeEnvironment(environment, docker, containerAttempted ? name : undefined);
      } catch (error) {
        failures.push(...(error as AggregateError).errors);
      }
    }
    // Never release mutation exclusion while a process might still be alive.
    if (!cleanupFailed && failures.length === 0 && release) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', cancel);
    if (failures.length)
      failure = new AggregateError(
        failure ? [failure, ...failures] : failures,
        'sandbox cleanup failed; retained source/volume leases require host recovery',
      );
  }
  if (failure) throw failure;
  return {
    exitCode: timedOut ? 124 : cancelled ? 130 : exitCode,
    stdout: out.toString(),
    stderr: err.toString(),
    truncated: out.isTruncated() || err.isTruncated(),
    timedOut,
    cancelled,
  };
}
