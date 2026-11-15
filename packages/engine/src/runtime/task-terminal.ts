import { createHostTerminal } from './host-terminal.ts';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { runInSandbox, type RunInSandboxOptions, type SandboxResult, type DockerClient, SandboxError } from '@oms/sandbox';

export interface TaskTerminal {
  write(data: Uint8Array): void;
  resize(columns: number, rows: number): void;
  /** Awaited delivery bounds output parsing; keep subscribed while the view is hidden. */
  subscribe(listener: (data: Uint8Array) => void | Promise<void>): () => void;
  exited: Promise<SandboxResult>;
  close(): Promise<void>;
}

export interface TaskTerminalOptions {
  run: RunInSandboxOptions;
  columns: number;
  rows: number;
}

export interface OwnedTaskTerminal extends TaskTerminal {
  execute(argv: string[], signal?: AbortSignal, timeoutMs?: number, onOutput?: (chunk: Buffer) => void): Promise<SandboxResult>;
}

const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
const MAX_STARTUP_OUTPUT_BYTES = 256 * 1024;

/** Pipe readers await delivery, so hidden views cannot build an unbounded parse queue. */
export class TerminalOutput {
  private listener: ((data: Uint8Array) => void | Promise<void>) | undefined;
  private pending: Array<{ data: Uint8Array; resolve: () => void; reject: (error: unknown) => void }> = [];
  private bytes = 0;
  private draining = false;
  private closed = false;

  private readonly fail: (error: unknown) => void;
  constructor(fail: (error: unknown) => void) { this.fail = fail; }

  get subscribed(): boolean { return this.listener !== undefined; }
  write(data: Uint8Array): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.bytes + data.byteLength > MAX_STARTUP_OUTPUT_BYTES) return Promise.reject(new Error('terminal pending output limit exceeded'));
    // ES2023 is the declared library baseline; Promise.withResolvers requires ES2024.
    const promise = new Promise<void>((resolve, reject) => {
      this.bytes += data.byteLength;
      this.pending.push({ data, resolve, reject });
      // Before subscription retain a bounded prefix without making shell exit depend on a view.
      if (!this.listener) resolve();
      void this.drain();
    });
    return promise;
  }

  subscribe(listener: (data: Uint8Array) => void | Promise<void>): () => void {
    if (this.listener) throw new Error('terminal already has an output subscriber');
    if (this.closed) throw new Error('terminal output is closed');
    this.listener = listener;
    void this.drain();
    return () => { if (this.listener === listener) this.listener = undefined; };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.listener && this.pending.length) {
        const next = this.pending.shift()!;
        try { await this.listener(next.data); next.resolve(); }
        catch (error) { next.reject(error); this.close(); this.fail(error); }
        finally { this.bytes -= next.data.byteLength; }
      }
    } finally { this.draining = false; }
  }

  close(): void {
    this.closed = true;
    this.listener = undefined;
    for (const next of this.pending) { this.bytes -= next.data.byteLength; next.resolve(); }
    this.pending = [];
  }
}

type DockerOut = (args: string[], signal?: AbortSignal) => Promise<string>;
type Labels = Record<string, string>;
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_OUTPUT_BYTES = 1024 * 1024;

/** Resolve exactly the CLI's environment precedence; never silently target the default daemon. */
export async function resolveDockerSocket(out: DockerOut, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let endpoint = env.DOCKER_HOST;
  if (env.DOCKER_CONTEXT || !endpoint) {
    const context = env.DOCKER_CONTEXT || (await out(['context', 'show'])).trim();
    if (!context || /[\x00-\x1f]/.test(context)) throw new Error('invalid Docker context');
    endpoint = (await out(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'])).trim();
  }
  if (!endpoint?.startsWith('unix:///') || /[\x00-\x1f]/.test(endpoint)) throw new Error('unsupported Docker endpoint: terminal requires a local Unix socket context');
  const socket = endpoint.slice('unix://'.length);
  if (socket.includes('?') || socket.includes('#')) throw new Error('unsupported Docker Unix socket endpoint');
  return socket;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-destructive checks precede every private exec/resize operation. */
export function assertOwnedContainer(value: unknown, id: string, labels: Labels, requireRunning = true): void {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('immutable container identity required');
  if (!record(value) || value.Id !== id || !record(value.Config) || !record(value.Config.Labels)) throw new Error('container identity/ownership mismatch');
  for (const key of ['oms.component', 'oms.task', 'oms.execution', 'oms.phase']) {
    if (!labels[key] || value.Config.Labels[key] !== labels[key]) throw new Error('container ownership labels mismatch');
  }
  if (labels['oms.component'] !== 'sandbox') throw new Error('container ownership component mismatch');
  if (value.Config.Tty !== true || value.Config.OpenStdin !== true) throw new Error('container must have an interactive TTY');
  if (requireRunning && (!record(value.State) || value.State.Running !== true)) throw new Error('owned terminal container is not running');
}

/** A resize was not applied because the registered terminal has stopped. */
export class TerminalStoppedError extends Error {
  constructor() {
    super('terminal stopped; resize was not applied');
    this.name = 'TerminalStoppedError';
  }
}

class DockerResizeError extends Error {
  readonly status: number | undefined;
  constructor(status: number | undefined) {
    super(`Docker resize failed with HTTP ${status ?? 'unknown'}`);
    this.status = status;
  }
}

/** One in-flight request and one replacement slot, not one promise per layout event. */
export class LatestResizeQueue {
  private pending: [number, number] | undefined;
  private active: Promise<void> | undefined;
  private closed = false;
  private failure: unknown;
  private readonly send: (columns: number, rows: number) => Promise<void>;
  constructor(send: (columns: number, rows: number) => Promise<void>) {
    this.send = send;
  }

  resize(columns: number, rows: number): void {
    if (this.closed) throw new Error('terminal resize queue is closing');
    if (![columns, rows].every(value => Number.isInteger(value) && value > 0 && value <= 500)) throw new Error('invalid terminal dimensions');
    if (this.failure) throw this.failure;
    this.pending = [columns, rows];
    if (!this.active) this.start();
  }

  private start(): void {
    this.active = Promise.resolve().then(async () => {
      try {
        while (this.pending && !this.closed) {
          const dimensions = this.pending;
          this.pending = undefined;
          await this.send(...dimensions);
        }
      } catch (error) {
        this.failure = error;
        if (error instanceof TerminalStoppedError) this.closed = true;
        this.pending = undefined;
      } finally {
        this.active = undefined;
        if (this.pending && !this.closed) this.start();
      }
    });
  }

  async idle(): Promise<void> {
    while (this.active) await this.active;
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pending = undefined;
    while (this.active) await this.active;
    if (this.failure && !(this.failure instanceof TerminalStoppedError)) throw this.failure;
  }
}

function engineResize(socketPath: string, id: string, columns: number, rows: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: 'POST', path: `/containers/${id}/resize?h=${rows}&w=${columns}`, agent: false }, response => {
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024) request.destroy(new Error('Docker resize response exceeds limit'));
      });
      response.once('aborted', () => reject(new Error('Docker resize response aborted')));
      response.once('error', reject);
      response.once('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new DockerResizeError(response.statusCode));
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Docker resize timed out')), 5000);
    request.once('close', () => clearTimeout(deadline));
    request.once('error', reject);
    request.end();
  });
}


export async function createTaskTerminal(options: TaskTerminalOptions): Promise<OwnedTaskTerminal> {
  if (![options.columns, options.rows].every(value => Number.isInteger(value) && value > 0 && value <= 500)) throw new Error('invalid terminal dimensions');
  if (options.run.backend === 'host') return createHostTerminal({ ...options, run: options.run });
  const environment = { ...process.env };
  const out: DockerOut = (args, signal) => new Promise((resolve, reject) => {
    execFile('docker', args, { env: environment, signal, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        // Existing ownership cleanup needs the Docker stderr to distinguish absence.
        reject(new SandboxError('E_DOCKER', `docker ${args[0]} failed: ${(stderr || error.message).trim()}`, { args, stderr }));
      } else resolve(stdout);
    });
  });
  const socket = await resolveDockerSocket(out, environment);
  // Freeze the resolved daemon for every later CLI/HTTP operation, even if a
  // user's current-context configuration changes while the pane is alive.
  environment.DOCKER_HOST = `unix://${socket}`;
  delete environment.DOCKER_CONTEXT;
  const abort = new AbortController();
  const externalAbort = () => abort.abort(options.run.signal?.reason);
  options.run.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.run.signal?.aborted) externalAbort();
  let id: string | undefined;
  let labels: Labels = {};
  let attach: ChildProcessWithoutNullStreams | undefined;
  let closing = false;
  let captureDone = false;
  let transportFailure: unknown;
  const activeExecs = new Set<Promise<SandboxResult>>();
  const execCancellations = new Set<() => void>();
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let lifecycle: Promise<SandboxResult>;
  let identityConfirmed = false;
  const output = new TerminalOutput(error => { transportFailure = error; abort.abort(error); });

  async function inspect(requireRunning = true): Promise<Record<string, unknown>> {
    if (!id) throw new Error('terminal container identity is not ready');
    const value: unknown = JSON.parse(await out(['inspect', '--type', 'container', '--format', '{{json .}}', id]));
    assertOwnedContainer(value, id, labels, requireRunning);
    identityConfirmed = true;
    return value as Record<string, unknown>;
  }

  async function requireResizableContainer(): Promise<void> {
    let value: Record<string, unknown>;
    try { value = await inspect(false); }
    catch (error) {
      const stderr = error instanceof SandboxError ? error.details.stderr : undefined;
      const missing = typeof stderr === 'string'
        ? /^(?:Error(?: response from daemon)?:\s*)?No such (?:object|container):\s*([a-f0-9]{64})\s*$/i.exec(stderr.trim()) : null;
      if (identityConfirmed && id && missing?.[1] === id) {
        throw new TerminalStoppedError();
      }
      throw error;
    }
    if (!record(value.State) || typeof value.State.Running !== 'boolean') throw new Error('invalid owned terminal running state');
    if (!value.State.Running) throw new TerminalStoppedError();
  }

  const resizes = new LatestResizeQueue(async (columns, rows) => {
    try {
      await requireResizableContainer();
      try { await engineResize(socket, id!, columns, rows); }
      catch (error) {
        // Only explicit stopped/missing HTTP responses warrant another identity
        // check. Timeouts, daemon failures and ownership mismatches stay errors.
        if (error instanceof DockerResizeError && (error.status === 404 || error.status === 409)) await requireResizableContainer();
        throw error;
      }
    } catch (error) {
      if (error instanceof TerminalStoppedError) closing = true;
      throw error;
    }
  });

  const adapter: DockerClient = {
    async out(args, signal) {
      if (args[0] !== 'create' || !args.includes('--rm')) return out(args, signal);
      const interactive = [args[0], '--interactive', '--tty', '--env', 'TERM=xterm-256color', ...args.slice(1)];
      const registered: Labels = {};
      for (let index = 1; index < args.length; index++) {
        if (args[index] === '--label') {
          const label = args[++index]!;
          const separator = label.indexOf('=');
          registered[label.slice(0, separator)] = label.slice(separator + 1);
        }
      }
      const created = (await out(interactive, signal)).trim();
      if (!/^[a-f0-9]{64}$/.test(created)) throw new Error('Docker returned an invalid immutable container identity');
      id = created;
      labels = registered;
      return created;
    },
    async capture(args, capture) {
      if (!id || args.length !== 3 || args[0] !== 'start' || args[1] !== '--attach' || args[2] !== id) throw new Error('unexpected terminal attach identity');
      await inspect(false);
      if (capture.signal.aborted) return 130;
      attach = spawn('docker', ['start', '--attach', '--interactive', id], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
      const child = attach;
      let childClosed = false;
      let childError: unknown;
      const childExit = new Promise<number>(resolve => {
        child.once('error', error => { childError = error; });
        child.once('close', code => {
          childClosed = true;
          closing = true;
          void resizes.close().catch(() => {});
          resolve(code ?? 127);
        });
      });
      const stop = () => {
        closing = true;
        output.close();
        void resizes.close().catch(() => {});
        for (const cancel of execCancellations) cancel();
        child.kill('SIGKILL');
      };
      capture.signal.addEventListener('abort', stop, { once: true });
      if (capture.signal.aborted) stop();
      child.stdin.on('error', error => {
        if (!closing && (error as NodeJS.ErrnoException).code !== 'EPIPE') { transportFailure = error; stop(); }
      });
      // Async iteration supplies real pipe backpressure through the subscriber.
      const stdout = (async () => {
        for await (const chunk of child.stdout) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          capture.stdout(bytes);
          await output.write(bytes);
        }
      })();
      const stderr = (async () => {
        for await (const chunk of child.stderr) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          capture.stderr(bytes);
          await output.write(bytes);
        }
      })();
      const streams = Promise.all([stdout, stderr]);
      void streams.catch(error => { transportFailure = error; stop(); });
      try {
        const deadline = Date.now() + 10_000;
        for (;;) {
          capture.signal.throwIfAborted();
          if (childClosed) throw childError ?? new Error('terminal exited before confirmed startup');
          const value = await inspect(false);
          if (record(value.State) && value.State.Running === true) break;
          if (Date.now() >= deadline) throw new Error('terminal startup timed out');
          await delay(25, undefined, { signal: capture.signal });
        }
        resizes.resize(options.columns, options.rows);
        await resizes.idle();
        if (closing || childClosed) throw new TerminalStoppedError();
        await inspect();
        readyResolve();
        const code = await childExit;
        if (childError) throw childError;
        return capture.signal.aborted ? 130 : code;
      } finally {
        closing = true;
        if (capture.signal.aborted || !output.subscribed) output.close();
        for (const cancel of execCancellations) cancel();
        child.kill('SIGKILL');
        await childExit;
        captureDone = true;
        capture.signal.removeEventListener('abort', stop);
        const settled = await Promise.allSettled([streams, resizes.close(), ...activeExecs]);
        output.close();
        const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (transportFailure) failures.push(transportFailure);
        if (failures.length) {
          // Only runInSandbox's owned-resource teardown decides cleanup
          // uncertainty. Report transport errors after that teardown completes.
          transportFailure ??= new Error('terminal transport settlement failed', { cause: new AggregateError(failures) });
          throw transportFailure;
        }
      }
    },
  };

  lifecycle = runInSandbox({ ...options.run, signal: abort.signal }, adapter).then(result => {
    if (transportFailure) throw transportFailure;
    return result;
  }).finally(() => {
    closing = true;
    output.close();
    options.run.signal?.removeEventListener('abort', externalAbort);
  });
  void lifecycle.then(() => readyReject(new Error('terminal exited before confirmed startup')), readyReject);
  try { await ready; } catch (error) {
    abort.abort(error);
    try { await lifecycle; } catch (cleanup) { throw new AggregateError([error, cleanup], 'terminal startup or cleanup failed'); }
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    write(data) {
      if (closing || !attach || attach.stdin.destroyed) throw new Error('terminal is closing or exited');
      if (attach.stdin.writableLength + data.byteLength > MAX_TERMINAL_INPUT_BYTES) {
        transportFailure = new Error('terminal pending input limit exceeded');
        abort.abort(transportFailure);
        throw transportFailure;
      }
      attach.stdin.write(data);
    },
    resize(columns, rows) {
      if (closing) throw new TerminalStoppedError();
      resizes.resize(columns, rows);
    },
    subscribe: listener => output.subscribe(listener),
    exited: lifecycle,
    execute(argv, signal, timeoutMs = EXEC_TIMEOUT_MS, onOutput) {
      if (closing || captureDone) return Promise.reject(new Error('terminal is closing or exited'));
      if (!argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || Buffer.byteLength(JSON.stringify(argv)) > 256 * 1024) return Promise.reject(new Error('invalid terminal exec argv'));
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return Promise.reject(new Error('invalid terminal exec timeout'));
      if (activeExecs.size >= 1) return Promise.reject(new Error('terminal exec already active'));
      if (signal?.aborted) return Promise.reject(new Error('terminal exec cancelled before startup'));
      let cancelled = false;
      let timedOut = false;
      let child: ChildProcessWithoutNullStreams | undefined;
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        abort.abort(new Error(timedOut ? 'terminal exec timed out' : 'terminal exec cancelled'));
        child?.kill('SIGKILL');
      };
      execCancellations.add(cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      const operation = (async (): Promise<SandboxResult> => {
        try {
          await resizes.idle();
          if (!cancelled) await inspect();
          if (closing || signal?.aborted) cancel();
          if (cancelled) return { exitCode: 130, stdout: '', stderr: '', truncated: false, timedOut, cancelled };
          return await new Promise<SandboxResult>((resolve, reject) => {
            child = spawn('docker', ['exec', id!, ...argv], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
            child.stdin.end();
            const stdout: Buffer[] = [], stderr: Buffer[] = [];
            let outBytes = 0, errBytes = 0, truncated = false;
            let spawnError: unknown;
            const deliver = (chunk: Buffer) => {
              try { onOutput?.(chunk); }
              catch (error) { spawnError = error; cancel(); }
            };
            child.stdout.on('data', (chunk: Buffer) => {
              deliver(chunk);
              const take = Math.min(chunk.length, EXEC_OUTPUT_BYTES - outBytes);
              if (take) stdout.push(Buffer.from(chunk.subarray(0, take)));
              outBytes += take;
              truncated ||= take !== chunk.length;
            });
            child.stderr.on('data', (chunk: Buffer) => {
              deliver(chunk);
              const take = Math.min(chunk.length, EXEC_OUTPUT_BYTES - errBytes);
              if (take) stderr.push(Buffer.from(chunk.subarray(0, take)));
              errBytes += take;
              truncated ||= take !== chunk.length;
            });
            const watchdog = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
            child.once('error', error => { spawnError = error; });
            child.once('close', code => {
              clearTimeout(watchdog);
              if (spawnError && !cancelled) { reject(spawnError); return; }
              resolve({ exitCode: timedOut ? 124 : cancelled ? 130 : code ?? 127, stdout: Buffer.concat(stdout, outBytes).toString('utf8'), stderr: Buffer.concat(stderr, errBytes).toString('utf8'), truncated, timedOut, cancelled });
            });
          });
        } catch (error) {
          if (cancelled) return { exitCode: timedOut ? 124 : 130, stdout: '', stderr: '', truncated: false, timedOut, cancelled };
          throw error;
        } finally {
          signal?.removeEventListener('abort', cancel);
          execCancellations.delete(cancel);
        }
      })();
      activeExecs.add(operation);
      void operation.finally(() => activeExecs.delete(operation)).catch(() => {});
      // The internal transport joins capture before teardown. The public caller
      // waits for that teardown too: killing an exec client is never completion.
      return operation.then(async result => {
        if (result.cancelled || result.timedOut) {
          await lifecycle;
          throw new Error(result.timedOut ? 'terminal exec timed out; entire terminal closed' : 'terminal exec cancelled; entire terminal closed');
        }
        return result;
      });
    },
    close() {
      if (!closePromise) {
        closing = true;
        output.close();
        abort.abort(new Error('terminal closed'));
        closePromise = lifecycle.then(() => {});
      }
      return closePromise;
    },
  };
}
