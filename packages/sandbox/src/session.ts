/** One long-lived container per task session. Setup (egress network, forwarder,
 * container) is paid once; each command is a `docker exec`.
 *
 * What a per-command container guaranteed, and how the session keeps it:
 *  - nothing survives a command: the exec wrapper kills every process but PID 1
 *    when the command exits, and a timeout or cancellation sweeps the same way;
 *  - host mutation exclusion exists only while a command runs, so host captures
 *    and the verifier are never blocked by an idle session;
 *  - a container that died, or whose sweep failed, is removed and rebuilt from
 *    the same trusted configuration before the next command.
 */
import { randomUUID } from 'node:crypto';
import { SandboxError } from './errors.ts';
import { buildRunArgs, sandboxUser, type Limits } from './args.ts';
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
import type { SandboxResult } from './exec.ts';

export interface SandboxSessionOptions {
  taskName: string;
  mounts: MountPlan;
  image: string;
  forwarderImage: string;
  leaseDir: string;
  sourceControlDir?: string;
  surfnet: { port: number; targetHost?: string; targetPort?: number };
  cwd?: string;
  env?: Record<string, string>;
  limits?: Limits;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  /** Session lifetime: aborting it closes the session. */
  signal?: AbortSignal;
}

export interface SandboxExecOptions {
  signal?: AbortSignal;
  /** Covers exclusion, any container (re)creation and the command. */
  timeoutMs: number;
  onOutput?: (chunk: Buffer) => void;
}

export interface SandboxSession {
  /** One command at a time; a second concurrent call is refused. */
  exec(argv: string[], options: SandboxExecOptions): Promise<SandboxResult>;
  /** Idempotent. Removes the container and egress; failures are an AggregateError. */
  close(): Promise<void>;
}

const IDLE_ARGV = ['sleep', 'infinity'];
/** Kills every process except PID 1 (the init), the idle process and this shell, until none is left.
 * `kill -9 -1` would also kill the idle process and stop the container. Builtins only: no fork, no
 * parsing the agent can spoof (the state is read after the last ") " of /proc/PID/stat). */
const SWEEP =
  'n=0; while [ $n -lt 8 ]; do left=; for p in /proc/[0-9]*; do p=${p#/proc/}; ' +
  'case $p in 1|"$idle"|$$) continue;; esac; read -r line < /proc/$p/stat 2>/dev/null || continue; ' +
  'state=${line##*) }; case $state in Z*) ;; *) left="$left $p";; esac; done; ' +
  '[ -z "$left" ] && break; kill -9 $left 2>/dev/null; n=$((n+1)); done; [ -z "$left" ]';
/** The sweep runs after every command, so no process outlives it; a sweep that cannot finish reports a signal-range exit. */
const EXEC_WRAPPER = `idle=$1; shift; "$@"; code=$?; ${SWEEP} || code=137; exit $code`;
const SWEEP_ONLY = `idle=$1; ${SWEEP}`;
/** Before any command runs, the only process named sleep is the idle one. */
const FIND_IDLE =
  'for p in /proc/[0-9]*; do read -r name < $p/comm 2>/dev/null; [ "$name" = sleep ] && echo ${p#/proc/} && exit 0; done; exit 1';
/** Exit codes at or above this are signal deaths, where the wrapper may not have swept. */
const SIGNALLED = 128;

interface Live {
  environment: Environment;
  name: string;
  id: string;
  /** In-container PID of the idle process; the sweep spares it. */
  idle: string;
}

const gone = (error: unknown) =>
  error instanceof SandboxError && /No such (?:container|object)/i.test(String(error.details.stderr ?? ''));

export function createSandboxSession(o: SandboxSessionOptions, docker: DockerClient = sandboxDocker): SandboxSession {
  const validate = (timeoutMs: number) => {
    validateRunOptions({ ...o, phase: 'run', timeoutMs });
    requirePinnedImage(o.image, 'image');
    requirePinnedImage(o.forwarderImage, 'forwarderImage');
    sandboxUser();
  };
  const exclusion = {
    taskName: o.taskName,
    phase: 'run' as const,
    mounts: o.mounts,
    leaseDir: o.leaseDir,
    sourceControlDir: o.sourceControlDir,
  };
  const lifetime = new AbortController();
  let live: Live | undefined;
  let active: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;

  const healthy = async (current: Live): Promise<boolean> => {
    try {
      const states = (
        await docker.out(['inspect', '-f', '{{.State.Running}}', current.id, current.environment.egress.forwarderName])
      )
        .trim()
        .split('\n');
      return states.length === 2 && states.every((state) => state.trim() === 'true');
    } catch (error) {
      if (gone(error)) return false;
      throw error;
    }
  };

  const destroy = async (): Promise<void> => {
    const current = live;
    if (!current) return;
    await closeEnvironment(current.environment, docker, current.name);
    live = undefined;
  };

  const create = async (signal: AbortSignal): Promise<Live> => {
    const environment = await openEnvironment(
      { ...exclusion, image: o.image, forwarderImage: o.forwarderImage, env: o.env, surfnet: o.surfnet },
      docker,
      signal,
    );
    const name = `oms-${o.taskName}-run-${randomUUID()}`;
    let attempted = false;
    try {
      const args = buildRunArgs({
        image: o.image,
        name,
        argv: IDLE_ARGV,
        cwd: o.cwd ?? '/work',
        env: environment.env,
        mounts: environment.mounts,
        network: environment.egress.networkName,
        labels: environment.egress.labels,
        limits: o.limits,
        init: true,
        autoRemove: false,
        addHosts: [{ host: 'host.docker.internal', ip: environment.egress.forwarderIP }],
      });
      args[0] = 'create';
      signal.throwIfAborted();
      validateBindSources(o.mounts);
      attempted = true;
      const id = (await docker.out(args)).trim();
      await docker.out(['start', id]);
      const idle = (await docker.out(['exec', id, '/bin/sh', '-c', FIND_IDLE])).trim();
      return { environment, name, id, idle };
    } catch (error) {
      try {
        await closeEnvironment(environment, docker, attempted ? name : undefined);
      } catch (cleanup) {
        throw new AggregateError([error, ...(cleanup as AggregateError).errors], 'sandbox setup cleanup failed');
      }
      throw error;
    }
  };

  const run = async (argv: string[], options: SandboxExecOptions): Promise<SandboxResult> => {
    const out = cappedChunks(o.stdoutLimitBytes ?? DEFAULT_OUTPUT_LIMIT);
    const err = cappedChunks(o.stderrLimitBytes ?? DEFAULT_OUTPUT_LIMIT);
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const cancel = (reason: unknown) => {
      if (!controller.signal.aborted) {
        cancelled = true;
        controller.abort(reason);
      }
    };
    const external = [options.signal, lifetime.signal];
    const listeners = external.map((signal) => {
      const listener = () => cancel(signal?.reason);
      signal?.addEventListener('abort', listener, { once: true });
      return listener;
    });
    external.forEach((signal, index) => {
      if (signal?.aborted) listeners[index]!();
    });
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        timedOut = true;
        controller.abort(new Error('sandbox timeout'));
      }
    }, options.timeoutMs);
    const signal = controller.signal;
    let release: (() => void) | undefined;
    let started = false;
    let exitCode = 127;
    let failure: unknown;
    let cleanupFailed = false;
    try {
      signal.throwIfAborted();
      release = acquireExclusion(exclusion);
      if (live && !(await healthy(live))) await destroy();
      signal.throwIfAborted();
      live ??= await create(signal);
      signal.throwIfAborted();
      started = true;
      exitCode = await docker.capture(
        ['exec', live.id, '/bin/sh', '-c', EXEC_WRAPPER, 'oms-exec', live.idle, ...argv],
        {
          signal,
          stdout: (chunk) => {
            options.onOutput?.(chunk);
            out.push(chunk);
          },
          stderr: (chunk) => {
            options.onOutput?.(chunk);
            err.push(chunk);
          },
        },
      );
    } catch (error) {
      cleanupFailed = error instanceof AggregateError;
      if (!signal.aborted || cleanupFailed) failure = error;
    } finally {
      const failures: unknown[] = [];
      if (live && started && (signal.aborted || exitCode >= SIGNALLED)) {
        // Killing the exec client leaves its process tree running; sweep it
        // without touching the container. If the sweep cannot be confirmed,
        // the container is removed so nothing can outlive this command.
        try {
          await docker.out(['exec', live.id, '/bin/sh', '-c', SWEEP_ONLY, 'oms-sweep', live.idle]);
        } catch {
          try {
            await destroy();
          } catch (error) {
            failures.push(...(error as AggregateError).errors);
          }
        }
      }
      if (!cleanupFailed && failures.length === 0 && release) {
        try {
          release();
        } catch (error) {
          failures.push(error);
        }
      }
      clearTimeout(timer);
      external.forEach((signal, index) => signal?.removeEventListener('abort', listeners[index]!));
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
  };

  o.signal?.addEventListener(
    'abort',
    () => {
      void session.close().catch(() => {});
    },
    { once: true },
  );
  const session: SandboxSession = {
    exec(argv, options) {
      if (!argv.length || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
        return Promise.reject(new SandboxError('E_BAD_ARGUMENT', 'invalid sandbox argv'));
      }
      try {
        validate(options.timeoutMs);
      } catch (error) {
        return Promise.reject(error);
      }
      if (closing || lifetime.signal.aborted)
        return Promise.reject(new SandboxError('E_BAD_ARGUMENT', 'sandbox session is closed'));
      if (active)
        return Promise.reject(new SandboxError('E_RESOURCE_BUSY', 'sandbox session runs one command at a time'));
      active = run(argv, options);
      return (active as Promise<SandboxResult>).finally(() => {
        active = undefined;
      });
    },
    close() {
      return (closing ??= (async () => {
        lifetime.abort(new Error('sandbox session closed'));
        await active?.catch(() => {});
        await destroy();
      })());
    },
  };
  if (o.signal?.aborted) void session.close().catch(() => {});
  return session;
}
