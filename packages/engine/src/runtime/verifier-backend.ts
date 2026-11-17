import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, cp, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { EMPTY_SNAPSHOT_DIGEST } from '@oms/contract';
import { removeTaskResources, runInSandbox, SURFPOOL_LIBS } from '@oms/sandbox';
import { createSurfnet, type Surfnet } from '@oms/surfnet';
import { dependencyFetchArgv, DEPENDENCY_ALLOWLIST } from './deps-fetch.ts';
import type { SurfnetSession, VerifierRunnerOptions } from '../verifier.ts';
import { BUILD_LIMITS, BUILD_TIMEOUT_MS } from './build-profile.ts';
import type { ExecutionBackend } from './execution-backend.ts';

export interface VerifierBackendOptions {
  backend: ExecutionBackend;
  /** Host backend only: the git control file whose digest is pinned. */
  gitControlPath?: string;
  taskName: string;
  /** Approved executable; its actual bytes are included in executionIdentity. */
  binary: string;
  buildProfile?: boolean;
  /** Developer toolchain verification only: install root npm locks into an isolated volume. */
  npmDependencies?: boolean;
  /** Locked host checkout supplying read-only dependencies to trusted visible checks. */
  dependencies?: string;
  /** Existing trusted directories outside the immutable code tree. */
  workDir: string;
  leaseDir: string;
  sourceControlDir?: string;
  signal?: AbortSignal;
  /** Current execution window, independent of backend ownership. */
  operationSignal?: () => AbortSignal | undefined;
  startTimeoutMs?: number;
  onSpawn?: (pid: number, cwd: string) => void;
}

/** Host-only process boundaries; production callers use the concrete defaults. */
export interface VerifierBackendDependencies {
  createSurfnet: typeof createSurfnet;
  runInSandbox: typeof runInSandbox;
}

export interface VerifierBackend extends VerifierRunnerOptions {
  /** Cancel and await every owned process/command before returning. */
  dispose(): Promise<void>;
  assertIntegrity(): Promise<void>;
}

export const TRUSTED_SURFPOOL = '/trusted/surfpool';

function overlaps(a: string, b: string): boolean {
  const rel = relative(a, b);
  const reverse = relative(b, a);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) ||
    (!isAbsolute(reverse) && reverse !== '..' && !reverse.startsWith(`..${sep}`))
  );
}

async function existingPath(path: string, kind: 'file' | 'directory'): Promise<string> {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) {
    throw new Error(`verifier path must be a ${kind === 'file' ? 'regular file' : 'directory'}: ${path}`);
  }
  return canonical;
}

/** The trusted Surfpool and the host libraries it needs, mounted where the pinned task scripts look for it. */
export const trustedSurfpoolMounts = (binary: string) => [
  { hostPath: binary, containerPath: TRUSTED_SURFPOOL, mode: 'ro' as const },
  ...SURFPOOL_LIBS.map((hostPath) => ({ hostPath, containerPath: hostPath, mode: 'ro' as const })),
];

export async function createVerifierBackend(
  options: VerifierBackendOptions,
  dependencies: VerifierBackendDependencies = { createSurfnet, runInSandbox },
): Promise<VerifierBackend> {
  options = Object.freeze({ ...options });
  options.signal?.throwIfAborted();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.taskName)) throw new Error('invalid verifier taskName');
  options.backend.requireImages();
  if (
    options.startTimeoutMs !== undefined &&
    (!Number.isInteger(options.startTimeoutMs) || options.startTimeoutMs <= 0 || options.startTimeoutMs > 2_147_483_647)
  ) {
    throw new Error('invalid verifier startTimeoutMs');
  }
  const binary = await existingPath(options.binary, 'file');
  await access(binary, constants.X_OK);
  const workDir = await existingPath(options.workDir, 'directory');
  const leaseDir = await existingPath(options.leaseDir, 'directory');
  const dependencyRoot =
    options.dependencies === undefined ? undefined : await existingPath(options.dependencies, 'directory');
  if (dependencyRoot && (overlaps(dependencyRoot, workDir) || overlaps(dependencyRoot, leaseDir))) {
    throw new Error('locked dependencies overlap trusted verifier runtime directories');
  }
  if (options.npmDependencies && (!options.buildProfile || dependencyRoot))
    throw new Error('npm preparation requires a program profile without host dependency mounts');
  const dependencyModules = dependencyRoot && (await existingPath(join(dependencyRoot, 'node_modules'), 'directory'));
  // npm never packs package-lock.json, so an installed OMS ships the same lock as npm-shrinkwrap.json.
  const dependencyLock =
    dependencyRoot &&
    (await existingPath(join(dependencyRoot, 'package-lock.json'), 'file').catch(() =>
      existingPath(join(dependencyRoot, 'npm-shrinkwrap.json'), 'file'),
    ));
  if (dependencyRoot && options.backend.mountsHostLibraries)
    await Promise.all(SURFPOOL_LIBS.map((path) => existingPath(path, 'file')));
  const digest = async (path: string) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const gitDigest = async (): Promise<string | null> => {
    if (!options.backend.pinsGitControl || !options.gitControlPath) return null;
    const file = await open(options.gitControlPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 4096) throw new Error('Invalid managed Git control file');
      const bytes = await file.readFile();
      if (bytes.length > 4096) throw new Error('Git control file changed while reading');
      return createHash('sha256').update(bytes).digest('hex');
    } finally {
      await file.close();
    }
  };
  const gitControlDigest = await gitDigest();
  const assertIntegrity = async () => {
    if ((await gitDigest()) !== gitControlDigest)
      throw new Error('Managed Git control file changed since task pinning');
  };
  const binaryDigest = await digest(binary);
  const executionIdentity = createHash('sha256')
    .update(
      JSON.stringify({
        policy: options.backend.verifierPolicy(options),
        binaryDigest,
        ...(gitControlDigest === null ? {} : { gitControlDigest }),
        dependenciesSha256: dependencyLock ? await digest(dependencyLock) : null,
        ...options.backend.pinnedImages(),
      }),
    )
    .digest('hex');
  const controller = new AbortController();
  const sessions = new Map<number, SurfnetSession>();
  const pending = new Set<Promise<unknown>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  function track<T>(operation: Promise<T>): Promise<T> {
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  }

  async function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposed = true;
    options.signal?.removeEventListener('abort', abort);
    controller.abort(options.signal?.reason ?? new Error('verifier backend disposed'));
    disposal = (async () => {
      // Aborted startup owns its own teardown; commands await sandbox cleanup.
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled([...sessions.values()].map((session) => session.stop()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'verifier backend cleanup failed',
        );
    })();
    return disposal;
  }

  const abort = () => {
    controller.abort(options.signal?.reason);
    // Retain the rejection on disposal so the owner observes cleanup failures.
    void dispose().catch(() => {});
  };
  options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();

  const backend: VerifierBackend = {
    executionIdentity,
    assertIntegrity,
    dispose,
    surfnets: {
      start(snapshotPath) {
        const operationSignal = options.operationSignal?.();
        const signal = operationSignal ? AbortSignal.any([controller.signal, operationSignal]) : controller.signal;
        return track(
          (async () => {
            signal.throwIfAborted();
            if (disposed) throw new Error('verifier backend disposed');
            const currentBinaryDigest = createHash('sha256')
              .update(await readFile(binary))
              .digest('hex');
            if (currentBinaryDigest !== binaryDigest)
              throw new Error('verifier binary bytes changed since execution identity was derived');
            let snapshotBytes: Buffer | undefined;
            if (snapshotPath !== undefined) {
              const canonical = await existingPath(snapshotPath, 'file');
              if (overlaps(canonical, workDir) || overlaps(canonical, leaseDir))
                throw new Error('snapshot input overlaps trusted runtime directories');
              snapshotBytes = await readFile(canonical);
            }
            const observedDigest =
              snapshotBytes === undefined
                ? EMPTY_SNAPSHOT_DIGEST
                : createHash('sha256').update(snapshotBytes).digest('hex');
            signal.throwIfAborted();
            const runDir = await mkdtemp(join(workDir, 'surfnet-'));
            let surf: Surfnet | undefined;
            try {
              const snapshot = snapshotBytes === undefined ? undefined : join(runDir, 'snapshot.json');
              if (snapshot !== undefined) {
                await writeFile(snapshot, snapshotBytes!, { flag: 'wx', mode: 0o400 });
                await chmod(snapshot, 0o400);
              }
              signal.throwIfAborted();
              surf = dependencies.createSurfnet({
                binary,
                snapshot,
                workDir: runDir,
                startTimeoutMs: options.startTimeoutMs,
                signal,
                onSpawn: options.onSpawn,
              });
              await surf.start();
              signal.throwIfAborted();
              if (
                snapshot !== undefined &&
                createHash('sha256')
                  .update(await readFile(snapshot))
                  .digest('hex') !== observedDigest
              ) {
                throw new Error('consumed snapshot bytes changed during startup');
              }
              const port = surf.ports()?.rpc;
              if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535 || sessions.has(port)) {
                throw new Error('surfnet did not acquire a unique valid RPC port');
              }
              const active = surf;
              let stopping: Promise<void> | undefined;
              const session: SurfnetSession = {
                port,
                mode: active.mode,
                snapshotDigest: observedDigest,
                call(method, params = []) {
                  return track(
                    (async () => {
                      signal.throwIfAborted();
                      if (stopping) throw new Error('verifier surfnet stopped');
                      let rejectAbort!: (reason: unknown) => void;
                      const cancelled = new Promise<never>((_, reject) => {
                        rejectAbort = reject;
                      });
                      const cancel = () => rejectAbort(signal.reason);
                      signal.addEventListener('abort', cancel, { once: true });
                      try {
                        const result = await Promise.race([
                          cancelled,
                          Promise.resolve().then(() => active.rpc.call(method, params, { timeoutMs: 30_000 })),
                        ]);
                        signal.throwIfAborted();
                        return result;
                      } finally {
                        signal.removeEventListener('abort', cancel);
                      }
                    })(),
                  );
                },
                stop() {
                  stopping ??= (async () => {
                    await active.stop();
                    sessions.delete(port);
                    await rm(runDir, { recursive: true, force: true });
                  })();
                  return stopping;
                },
              };
              sessions.set(port, session);
              return session;
            } catch (error) {
              // Do not erase diagnostic files if process cleanup itself fails.
              try {
                await surf?.stop();
              } catch (cleanup) {
                throw new AggregateError([error, cleanup], 'surfnet startup and cleanup failed');
              }
              await rm(runDir, { recursive: true, force: true });
              throw error;
            }
          })(),
        );
      },
    },
    sandbox: {
      run(argv, runOptions) {
        const operationSignal = options.operationSignal?.();
        const signal = operationSignal ? AbortSignal.any([controller.signal, operationSignal]) : controller.signal;
        return track(
          (async () => {
            signal.throwIfAborted();
            await assertIntegrity();
            if (!sessions.has(runOptions.surfnetPort))
              throw new Error('verifier requires an active owned surfnet port');
            const codeRoot = await existingPath(runOptions.codeRoot, 'directory');
            if (overlaps(codeRoot, workDir) || overlaps(codeRoot, leaseDir) || overlaps(codeRoot, binary)) {
              throw new Error('verifier input root overlaps trusted runtime paths');
            }
            signal.throwIfAborted();
            const rpcUrl = options.backend.rpcUrl(runOptions.surfnetPort);
            const output = await mkdtemp(join(workDir, 'output-'));
            const trustedMounts = dependencyModules
              ? [
                  { hostPath: dependencyModules, containerPath: '/work/node_modules', mode: 'ro' as const },
                  ...trustedSurfpoolMounts(binary),
                ]
              : [];
            const buildRoot = options.buildProfile ? await mkdtemp(join(workDir, 'build-')) : codeRoot;
            const buildStarted = Date.now();
            const buildTask = options.buildProfile ? `verify-${randomUUID()}` : options.taskName;
            let cleanupUncertain = false;
            try {
              if (options.buildProfile) {
                // Stage immutable inputs so Docker can attach nested cache mounts without
                // creating mountpoints through the read-only source bind. Never copy caches.
                await cp(codeRoot, buildRoot, {
                  recursive: true,
                  verbatimSymlinks: true,
                  filter: (source) => !['target', '.oms-cargo', 'node_modules'].includes(relative(codeRoot, source)),
                });
                for (const dir of [
                  'target',
                  '.oms-cargo',
                  ...(dependencyModules || options.npmDependencies ? ['node_modules'] : []),
                ]) {
                  await mkdir(join(buildRoot, dir), { recursive: true });
                }
              }
              signal.throwIfAborted();
              const mounts = options.backend.verifierMounts({
                codeRoot,
                buildRoot,
                buildTask,
                output,
                leaseDir,
                dependencyModules,
                trustedMounts,
                buildProfile: options.buildProfile,
                npmDependencies: options.npmDependencies,
              });
              const buildTimeout = options.buildProfile
                ? Math.min(runOptions.timeoutMs, BUILD_TIMEOUT_MS)
                : runOptions.timeoutMs;
              const fetchDependencies = async (
                kind: 'cargo' | 'npm',
                exhausted: string,
                failed: string,
              ): Promise<void> => {
                const fetchRemaining = buildTimeout - (Date.now() - buildStarted);
                if (fetchRemaining <= 0) throw new Error(exhausted);
                const fetched = await dependencies.runInSandbox({
                  backend: 'docker',
                  taskName: buildTask,
                  phase: 'install',
                  argv: dependencyFetchArgv(kind),
                  mounts,
                  image: options.backend.images.image,
                  forwarderImage: options.backend.images.forwarderImage,
                  leaseDir,
                  sourceControlDir: options.sourceControlDir,
                  signal,
                  timeoutMs: fetchRemaining,
                  cwd: '/work',
                  env: { HOME: '/tmp', TMPDIR: '/tmp', CARGO_HOME: '/work/.oms-cargo' },
                  limits: BUILD_LIMITS,
                  installAllowlist: DEPENDENCY_ALLOWLIST,
                });
                if (fetched.exitCode !== 0) throw new Error(failed);
              };
              if (
                options.buildProfile &&
                (await access(join(codeRoot, 'Cargo.toml')).then(
                  () => true,
                  () => false,
                ))
              ) {
                await fetchDependencies(
                  'cargo',
                  'verifier build timeout exhausted during source staging',
                  'E_DEPS_NOT_FETCHED: locked verifier dependency fetch failed',
                );
              }
              if (options.npmDependencies) {
                await fetchDependencies(
                  'npm',
                  'verifier build timeout exhausted before npm preparation',
                  'E_DEPS_NOT_FETCHED: locked npm preparation failed',
                );
              }
              const remaining = buildTimeout - (Date.now() - buildStarted);
              if (options.buildProfile && remaining <= 0)
                throw new Error('verifier build timeout exhausted during dependency fetch');
              const result = await dependencies.runInSandbox(
                options.backend.verifierRun({
                  onSpawn: options.onSpawn,
                  buildTask,
                  sourceControlDir: options.sourceControlDir,
                  leaseDir,
                  signal,
                  timeoutMs: options.buildProfile ? remaining : runOptions.timeoutMs,
                  surfnetPort: runOptions.surfnetPort,
                  argv,
                  mounts,
                  codeRoot,
                  output,
                  binary,
                  buildProfile: options.buildProfile,
                  rpcUrl,
                }),
              );
              signal.throwIfAborted();
              await assertIntegrity();
              if (result.cancelled) throw new Error('verifier sandbox cancelled');
              return result;
            } catch (error) {
              // Sandbox aggregates mean teardown was not confirmed; a live
              // container may still have this bind. Preserve it for host recovery.
              cleanupUncertain = error instanceof AggregateError;
              throw error;
            } finally {
              if (!cleanupUncertain) {
                if (options.buildProfile) await removeTaskResources(buildTask);
                await rm(output, { recursive: true, force: true });
                if (options.buildProfile) await rm(buildRoot, { recursive: true, force: true });
              }
            }
          })(),
        );
      },
    },
  };
  return Object.freeze(backend);
}
