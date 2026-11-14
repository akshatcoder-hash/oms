import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { findFreePortPair, releasePorts, type PortPair } from './ports.ts';
import { spawnSurfpool, type SurfnetProcess } from './process.ts';
import { createRpcClient, SurfnetRpcError, type RpcClient } from './rpc.ts';
import { createStateQueue, isReadMethod, type StateQueue } from './queue.ts';

/** How this surfnet sources its state. The evaluator labels evidence with it. */
export type SurfnetMode = 'offline-snapshot' | 'forked';

export interface SurfnetOptions {
  /** Path to the surfpool binary. Default `~/.local/bin/surfpool`. */
  binary?: string;
  /**
   * true: run with no remote datasource (fixture-only, reproducible).
   * false: fork the configured network at tip (needs a reachable RPC).
   * Default true.
   */
  offline?: boolean;
  /** Snapshot file to preload at start (`--snapshot`). */
  snapshot?: string;
  /** Directory for checkpoints and logs. Created if missing. */
  workDir: string;
  /** Log file for the child's output. Default `<workDir>/surfnet.log`. */
  logFile?: string;
  /** Readiness timeout in ms. Default 30_000. */
  startTimeoutMs?: number;
  /** Cancellation stops startup or the live child; an aborted manager cannot restart. */
  signal?: AbortSignal;
  /** Host-only durable child identity registration; failure stops startup. */
  onSpawn?: (pid: number, cwd: string) => void;
  /** Called when the surfnet dies unexpectedly (not from stop()). */
  onExit?: (info: { code: number | null; signal: string | null }) => void;
}

export interface AccountImage {
  address: string;
  lamports?: number;
  /** Program owner, base58. Default the system program. */
  owner?: string;
  /** Account data as a hex string. Default empty. */
  data?: string;
  executable?: boolean;
  rentEpoch?: number;
}

export interface CheckpointInfo {
  path: string;
  /** sha256 hex digest of the checkpoint file. */
  digest: string;
}

export interface HealthReport {
  ok: boolean;
  detail?: string;
}

export interface Surfnet {
  readonly mode: SurfnetMode;
  /** RPC url, e.g. http://127.0.0.1:8899. Set after start(). */
  rpcUrl(): string | undefined;
  /** Child pid, or undefined when not running. */
  pid(): number | undefined;
  ports(): PortPair | undefined;
  /** Spawn the surfpool child and wait until healthy. */
  start(): Promise<void>;
  /** Stop the child gracefully (SIGTERM, then SIGKILL). */
  stop(): Promise<void>;
  /**
   * JSON-RPC access. Reads run immediately; state-changing calls (sendTransaction,
   * setAccount-style cheats, snapshot ops) are serialized through the write queue.
   */
  rpc: RpcClient;
  /** Export a snapshot checkpoint; returns its path and sha256. */
  checkpoint(name: string): Promise<CheckpointInfo>;
  /**
   * Primary rewind (eng-review finding 2): stop the process and start a fresh
   * one from the named checkpoint on the same ports. Restores everything a
   * setAccount fast path cannot: deletions, slot, blockhashes, programs.
   */
  rewind(name: string): Promise<void>;
  /**
   * Rewind to how this surfnet started: stop the process and start it again on the
   * same ports from the original startup snapshot (or empty, when it had none).
   * Everything done since start() is lost, including deployed programs.
   */
  rewindToStart(): Promise<void>;
  /**
   * Fast path: re-apply named accounts on the live surfnet via
   * surfnet_setAccount. Does not rewind slot, blockhashes, programs,
   * history, or remove accounts created after the checkpoint.
   */
  restoreAccounts(accounts: AccountImage[]): Promise<void>;
  /** Cheap liveness probe: getHealth over RPC. */
  health(): Promise<HealthReport>;
  /**
   * If the child died, restart from the latest verified checkpoint, or the
   * verified original startup snapshot before any checkpoint exists.
   */
  ensureAlive(): Promise<{ restarted: boolean; fromCheckpoint: string | undefined }>;
  /** Latest checkpoint name set by checkpoint() (used by ensureAlive). */
  latestCheckpoint(): CheckpointInfo | undefined;
  /** Last log lines from the child (for diagnostics). */
  logs(lines?: number): string[];
}

const DEFAULT_BINARY = '~/.local/bin/surfpool';

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return join(process.env.HOME ?? '', p.slice(1));
  }
  return p;
}

/** True when the error means "the surfnet process is not answering". */
function isUnreachable(error: unknown): boolean {
  return (
    error instanceof SurfnetRpcError &&
    (error.normalized.code === 'unreachable' || error.normalized.code === 'process-died')
  );
}

export function createSurfnet(options: SurfnetOptions): Surfnet {
  const binary = expandHome(options.binary ?? DEFAULT_BINARY);
  const offline = options.offline ?? true;
  const mode: SurfnetMode = offline ? 'offline-snapshot' : 'forked';
  const workDir = resolve(options.workDir);
  const logFile = resolve(options.logFile ?? join(workDir, 'surfnet.log'));
  const startTimeoutMs = options.startTimeoutMs;
  const queue: StateQueue = createStateQueue();
  const rpcAt = (url: string): RpcClient => createRpcClient(url);

  let process_: SurfnetProcess | undefined;
  let ports: PortPair | undefined;
  let latest: CheckpointInfo | undefined;
  let original: CheckpointInfo | undefined;
  const checkpoints = new Map<string, CheckpointInfo>();
  let lifecycle: Promise<unknown> = Promise.resolve();

  function changeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const next = lifecycle.then(operation);
    lifecycle = next.catch(() => {});
    return next;
  }

  async function inspectSnapshot(path: string): Promise<CheckpointInfo> {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error('snapshot must be a regular file');
    return { path: canonical, digest: createHash('sha256').update(await readFile(canonical)).digest('hex') };
  }

  async function validateSnapshot(snapshot: CheckpointInfo | undefined): Promise<void> {
    if (snapshot && (await inspectSnapshot(snapshot.path)).digest !== snapshot.digest) {
      throw new Error('surfnet snapshot bytes changed since verification');
    }
  }

  async function stopCurrent(): Promise<void> {
    if (process_) await process_.stop();
    process_ = undefined;
    if (ports) releasePorts(ports);
    ports = undefined;
  }

  async function restart(snapshot: CheckpointInfo | undefined): Promise<void> {
    if (!ports) throw new Error('surfnet was never started; start() first');
    const pair = ports;
    if (process_) await process_.stop();
    process_ = undefined;
    try {
      process_ = await spawnOn(pair, snapshot);
    } catch (error) {
      releasePorts(pair);
      ports = undefined;
      throw error;
    }
  }

  async function spawnOn(pair: PortPair, snapshot?: CheckpointInfo): Promise<SurfnetProcess> {
    options.signal?.throwIfAborted();
    await validateSnapshot(snapshot);
    const binaryPath = await realpath(binary);
    if (!(await stat(binaryPath)).isFile()) throw new Error('surfpool binary must be a regular file');
    await access(binaryPath, constants.X_OK);
    await mkdir(workDir, { recursive: true });
    await mkdir(dirname(logFile), { recursive: true });
    const cwd = await realpath(workDir);
    const child = spawnSurfpool({
      binary: binaryPath,
      rpcPort: pair.rpc,
      wsPort: pair.ws,
      snapshot: snapshot?.path,
      offline,
      logFile,
      cwd,
      signal: options.signal,
      ...(startTimeoutMs !== undefined ? { startTimeoutMs } : {}),
      onUnexpectedExit: options.onExit,
    });
    try {
      if (child.pid !== undefined) options.onSpawn?.(child.pid, cwd);
      await child.waitUntilHealthy();
      options.signal?.throwIfAborted();
      await validateSnapshot(snapshot);
    } catch (error) {
      // A port collision from a concurrent manager lands here as an early
      // exit; surface the child's own log lines.
      await child.stop();
      throw error;
    }
    return child;
  }

  return {
    mode,
    rpcUrl: () => process_?.rpcUrl,
    pid: () => process_?.pid,
    ports: () => ports,

    start() {
      return changeLifecycle(async () => {
        options.signal?.throwIfAborted();
        if (process_ && !process_.exited()) {
          throw new Error('surfnet already running; stop() it first');
        }
        // Validate caller paths before reserving ports or starting any process.
        const binaryPath = await realpath(binary);
        if (!(await stat(binaryPath)).isFile()) throw new Error('surfpool binary must be a regular file');
        await access(binaryPath, constants.X_OK);
        const snapshot = options.snapshot ? await inspectSnapshot(options.snapshot) : undefined;
        await stopCurrent();
        const pair = await findFreePortPair();
        try {
          process_ = await spawnOn(pair, snapshot);
          ports = pair;
          original = snapshot;
          latest = undefined;
          checkpoints.clear();
        } catch (error) {
          releasePorts(pair);
          throw error;
        }
      });
    },

    stop() {
      return changeLifecycle(stopCurrent);
    },

    rpc: {
      get url() {
        if (!process_) throw new Error('surfnet not started');
        return process_.rpcUrl;
      },
      call(method, params = [], callOptions = {}) {
        const target = () => {
          if (!process_) {
            throw new SurfnetRpcError({
              code: 'process-died',
              summary: 'surfnet is not running',
              hint: 'call start() or ensureAlive() first',
              raw: 'surfnet is not running',
            });
          }
          return rpcAt(process_.rpcUrl);
        };
        if (isReadMethod(method)) {
          return target().call(method, params, callOptions);
        }
        return queue.enqueueWrite(() => target().call(method, params, callOptions));
      },
    },

    async checkpoint(name) {
      // Name guard: the value lands in a file path.
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`invalid checkpoint name: ${JSON.stringify(name)}`);
      }
      const dir = join(workDir, 'checkpoints');
      const path = join(dir, `${name}.json`);
      // exportSnapshot's result is {context, value}; the --snapshot loader
      // consumes the bare account map (verified against 1.7.0).
      const result = (await this.rpc.call('surfnet_exportSnapshot', [
        { scope: 'network', filter: { includeProgramAccounts: true, excludeSysvars: true, excludeFeatureGates: true } },
      ], { preserveIntegers: true })) as { value?: object };
      if (!result || typeof result.value !== 'object' || result.value === null) {
        throw new Error('surfnet_exportSnapshot returned an unexpected shape (no value map)');
      }
      await mkdir(dir, { recursive: true });
      const json = JSON.stringify(result.value, null, 2);
      await writeFile(path, json);
      const digest = createHash('sha256').update(json).digest('hex');
      latest = { path, digest };
      checkpoints.set(name, latest);
      return latest;
    },

    rewind(name) {
      return changeLifecycle(async () => {
        const checkpoint = checkpoints.get(name);
        if (!checkpoint) throw new Error(`unknown checkpoint: ${JSON.stringify(name)}`);
        await restart(checkpoint);
      });
    },

    rewindToStart() {
      return changeLifecycle(() => restart(original));
    },

    async restoreAccounts(accounts) {
      await queue.enqueueWrite(async () => {
        const client = (() => {
          if (!process_) {
            throw new SurfnetRpcError({
              code: 'process-died',
              summary: 'surfnet is not running',
              hint: 'call start() or ensureAlive() first',
              raw: 'surfnet is not running',
            });
          }
          return rpcAt(process_.rpcUrl);
        })();
        for (const account of accounts) {
          await client.call('surfnet_setAccount', [
            account.address,
            {
              ...(account.lamports !== undefined ? { lamports: account.lamports } : {}),
              ...(account.owner !== undefined ? { owner: account.owner } : {}),
              ...(account.data !== undefined ? { data: account.data } : {}),
              ...(account.executable !== undefined ? { executable: account.executable } : {}),
              ...(account.rentEpoch !== undefined ? { rentEpoch: account.rentEpoch } : {}),
            },
          ]);
        }
      });
    },

    async health() {
      if (!process_ || process_.exited()) {
        return { ok: false, detail: 'process not running' };
      }
      try {
        const result = await rpcAt(process_.rpcUrl).call('getHealth', [], { timeoutMs: 5_000 });
        return result === 'ok' ? { ok: true } : { ok: false, detail: `getHealth returned ${JSON.stringify(result)}` };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof SurfnetRpcError ? error.normalized.summary : String(error),
        };
      }
    },

    ensureAlive() {
      return changeLifecycle(async () => {
        const health = await this.health();
        if (health.ok) return { restarted: false, fromCheckpoint: undefined };
        await restart(latest ?? original);
        return { restarted: true, fromCheckpoint: latest?.path };
      });
    },

    latestCheckpoint: () => latest,
    logs: (lines = 20) => process_?.lastLogs(lines) ?? [],
  };
}
