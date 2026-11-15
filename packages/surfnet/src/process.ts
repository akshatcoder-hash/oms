import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRpcClient, SurfnetRpcError } from './rpc.ts';

export interface SpawnOptions {
  binary: string;
  rpcPort: number;
  wsPort: number;
  /** Snapshot file passed as `--snapshot`. */
  snapshot?: string;
  /** Log file the child's stdout/stderr stream into. */
  logFile: string;
  /** Extra args appended to the command line (e.g. airdrop overrides). */
  extraArgs?: string[];
  /** Overall readiness timeout in ms. Default 30_000. */
  startTimeoutMs?: number;
  /** Poll interval for getHealth in ms. Default 250. */
  pollIntervalMs?: number;
  /** Grace period for SIGTERM before SIGKILL, in ms. Default 2_000. */
  stopGraceMs?: number;
  /** Trusted working directory for any process-local files. */
  cwd?: string;
  /** Cancels startup and stops an already-running child. */
  signal?: AbortSignal;
  /** Called when the child exits for any reason other than our own stop(). */
  onUnexpectedExit?: (info: { code: number | null; signal: string | null }) => void;
}

export interface SurfnetProcess {
  readonly pid: number | undefined;
  readonly rpcPort: number;
  readonly wsPort: number;
  readonly rpcUrl: string;
  readonly wsUrl: string;
  /** Resolves once getHealth answers "ok". Throws with the child's last stderr lines. */
  waitUntilHealthy(): Promise<void>;
  /** SIGTERM, then SIGKILL after the grace period. Resolves when the child is gone. */
  stop(): Promise<void>;
  /** True once the child has exited. */
  exited(): boolean;
  /** Last stderr/stdout lines captured (for error reporting). */
  lastLogs(lines?: number): string[];
  /** Kill the child without the graceful path (for tests simulating crashes). */
  kill(signal?: NodeJS.Signals): void;
  /** Resolves with exit info once the child exits (immediately if already exited). */
  waitExited(): Promise<{ code: number | null; signal: string | null }>;
}

/**
 * Registry of live children so a parent `process.on('exit')` kills them all
 * synchronously — no orphaned surfpool when the harness dies.
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of liveChildren) {
      try {
        child.kill('SIGKILL');
      } catch {
        // process already gone
      }
    }
  });
}

const LOG_TAIL_LINES = 80;

/**
 * Spawn one `surfpool start` child and wait for readiness (getHealth "ok").
 * Command: `<binary> start --ci --no-tui --offline --port <rpc> --ws-port <ws>`
 * plus `--snapshot <file>` when given. NO_DNA=1 is set for the child.
 */
export function spawnSurfpool(options: SpawnOptions): SurfnetProcess {
  options.signal?.throwIfAborted();
  installExitHook();

  const args = [
    'start',
    '--ci',
    '--no-tui',
    '--offline',
    '--port',
    String(options.rpcPort),
    '--ws-port',
    String(options.wsPort),
    '--airdrop-amount',
    '0',
    ...(options.snapshot ? ['--snapshot', options.snapshot] : []),
    ...(options.extraArgs ?? []),
  ];

  const child = spawn(options.binary, args, {
    env: { ...Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TERM'].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]])), NO_DNA: '1' },
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so a crash of our harness cannot leave the child
    // attached to a dead session prompt.
    detached: false,
  });

  // Stream output to the log file and keep a tail for error messages.
  let logStream: WriteStream | undefined;
  try {
    logStream = createWriteStream(options.logFile, { flags: 'a' });
    logStream.on('error', () => { logStream = undefined; });
  } catch {
    // A broken log sink must not kill the surfnet; keep the in-memory tail.
  }
  const tail: string[] = [];
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      tail.push(line);
      if (tail.length > LOG_TAIL_LINES) tail.shift();
    }
    logStream?.write(text);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  let exited = false;
  let expectedStop = false;
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  let exitWaiters: Array<(info: { code: number | null; signal: string | null }) => void> = [];

  const finish = (code: number | null, signal: string | null) => {
    if (exited) return;
    exited = true;
    exitInfo = { code, signal };
    options.signal?.removeEventListener('abort', abort);
    logStream?.end();
    liveChildren.delete(child);
    const waiters = exitWaiters;
    exitWaiters = [];
    for (const waiter of waiters) waiter(exitInfo);
    if (!expectedStop) options.onUnexpectedExit?.(exitInfo);
  };
  child.on('exit', finish);
  // ENOENT has no pid and emits error without exit. Always install this
  // handler, both to settle waiters and to prevent an uncaught spawn error.
  child.on('error', (error) => {
    tail.push(error.message);
    finish(-1, null);
  });

  const rpc = createRpcClient(`http://127.0.0.1:${options.rpcPort}`);
  liveChildren.add(child);

  const waitUntilHealthy = async (): Promise<void> => {
    const timeoutMs = options.startTimeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    let lastError: string | undefined;
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      if (exited || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `surfpool exited before becoming healthy (code=${exitInfo?.code ?? child.exitCode}, ` +
            `signal=${exitInfo?.signal ?? child.signalCode}); last logs:\n${tail.join('\n')}`,
        );
      }
      try {
        const health = await rpc.call('getHealth', [], { timeoutMs: Math.min(2_000, Math.max(1, deadline - Date.now())) });
        options.signal?.throwIfAborted();
        if (health === 'ok' && !exited) return;
        lastError = `getHealth returned ${JSON.stringify(health)}`;
      } catch (error) {
        lastError = error instanceof SurfnetRpcError ? error.normalized.summary : String(error);
      }
      options.signal?.throwIfAborted();
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal });
    }
    throw new Error(
      `surfpool not healthy after ${timeoutMs}ms${lastError ? `: ${lastError}` : ''}; ` +
        `last logs:\n${tail.join('\n')}`,
    );
  };

  const stop = async (): Promise<void> => {
    if (exited) return;
    expectedStop = true;
    const graceMs = options.stopGraceMs ?? 2_000;
    child.kill('SIGTERM');
    const deadline = Date.now() + graceMs;
    while (!exited && Date.now() < deadline) {
      await sleep(50);
    }
    if (!exited) child.kill('SIGKILL');
    while (!exited) {
      await sleep(20);
    }
  };

  const waitExited = (): Promise<{ code: number | null; signal: string | null }> => {
    if (exitInfo) return Promise.resolve(exitInfo);
    return new Promise((resolve) => {
      exitWaiters.push(resolve);
    });
  };

  const abort = () => { void stop(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    get pid() {
      return child.pid;
    },
    rpcPort: options.rpcPort,
    wsPort: options.wsPort,
    rpcUrl: `http://127.0.0.1:${options.rpcPort}`,
    wsUrl: `ws://127.0.0.1:${options.wsPort}`,
    waitUntilHealthy,
    stop,
    exited: () => exited,
    lastLogs: (lines = 20) => tail.slice(-lines),
    kill: (signal = 'SIGKILL') => {
      child.kill(signal);
    },
    waitExited,
  };
}
