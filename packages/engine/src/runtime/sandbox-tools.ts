import { approveHostCommand, type HostApproval, type HostApprovalPolicy, type HostTrust } from './host-approval.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { posix, relative, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  generateDiffString,
  type BashOperations,
  type ExtensionFactory,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { hostSandbox, runInSandbox, type MountPlan, type SandboxResult } from '@oms/sandbox';
import { Type, type TSchema } from 'typebox';
import { dependencyFetchArgv } from './deps-fetch.ts';
import type { ExecutionBackend, ToolRunSpec } from './execution-backend.ts';
import { CommandLogs, type LogPage } from './command-logs.ts';
import { createTaskFileAccess, MAX_TASK_FILE_BYTES, type TaskFileAccess } from './task-files.ts';
import { createTaskTerminal, type OwnedTaskTerminal, type TaskTerminal } from './task-terminal.ts';
import { BUILD_TIMEOUT_MS } from './build-profile.ts';

export interface SandboxToolsOptions {
  backend: ExecutionBackend;
  approvalPolicy?: HostApprovalPolicy;
  /** A chat's trust: where Seatbelt confines commands they run without asking, and YOLO turns the sandbox off. */
  hostTrust?: HostTrust;
  /** A chat shows what a write changed: the result carries a diff, or says the file is new. Pinned runs keep the plain result. */
  writeDetails?: boolean;
  protectedPaths?: string[];
  onSpawn?: (pid: number, cwd: string) => void;
  taskName: string;
  mounts: MountPlan;
  leaseDir: string;
  sourceControlDir: string;
  surfnetPort: number;
  /** Where commands find the trusted Surfpool, exported as SURFPOOL_BINARY. */
  surfpool?: string;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Trusted program-toolchain profile; never selected by a model command. */
  buildProfile?: boolean;
  remainingWallClockMs?: () => number;
  /** Opt in for commands only; raw file protocols and verifier evidence stay unchanged. */
  outputMode?: 'head-tail';
}

const NETWORK_BLOCK =
  /could not resolve host|couldn't connect|could not connect|network is unreachable|enotfound|eai_again|econnrefused|connection refused|unable to connect|failed to connect|getaddrinfo|temporary failure in name resolution/i;
const FILE_BLOCK = /operation not permitted|read-only file system/i;

/** What Seatbelt most likely refused, judged from a failed command's own output; undefined when it looks unrelated. */
export function sandboxBlock(output: string): 'network' | 'file access' | undefined {
  if (NETWORK_BLOCK.test(output)) return 'network';
  if (FILE_BLOCK.test(output)) return 'file access';
  return undefined;
}

function taskPath(path: string, root: string): string {
  const resolved = posix.resolve(root, path);
  if (resolved === root || !resolved.startsWith(root + '/')) {
    throw new Error('File operations are limited to the selected task under /work');
  }
  return resolved;
}

export interface SandboxTools {
  extension: ExtensionFactory;
  setHostApproval(approve: HostApproval | undefined): void;
  execute(argv: string[], signal?: AbortSignal, timeoutMs?: number): Promise<SandboxResult>;
  /** Untrusted (id, offset, maxBytes); validated by the session log store. */
  readLog(...request: readonly unknown[]): LogPage;
  files: TaskFileAccess;
  startTerminal(columns: number, rows: number): Promise<TaskTerminal>;
  withVerification<T>(action: () => Promise<T>): Promise<T>;
  assertVerificationAllowed(): void;
  dispose(): Promise<void>;
}

export function createSandboxTools(options: SandboxToolsOptions): SandboxTools {
  if (options.outputMode !== undefined && options.outputMode !== 'head-tail')
    throw new Error('Unknown command output mode');
  if (options.outputMode) {
    const temp = realpathSync(tmpdir());
    for (const mount of [
      options.mounts.projectMount,
      ...options.mounts.extraMounts,
      ...options.mounts.readOnlyMounts,
    ]) {
      const rel = relative(mount.hostPath, temp);
      if (!rel || (!rel.startsWith('..') && !isAbsolute(rel)))
        throw new Error('Host command logs must be outside sandbox binds');
    }
  }
  let hostApproval: HostApproval | undefined;
  const { backend } = options;
  const root = backend.commandRoot(options.mounts.projectMount.hostPath);
  const logs = new CommandLogs();
  const defaultTimeout = options.timeoutMs ?? (options.buildProfile ? BUILD_TIMEOUT_MS : 60_000);
  const toolSignal = new AsyncLocalStorage<AbortSignal | undefined>();
  const lifetime = new AbortController();
  const lifetimeSignal = AbortSignal.any([options.signal, lifetime.signal]);
  const uncertainCleanup: unknown[] = [];
  let terminal: OwnedTaskTerminal | undefined;
  let terminalStarting = false;
  let queueTail = Promise.resolve();
  let queued = 0;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    if (disposed || lifetimeSignal.aborted) return Promise.reject(new Error('Task sandbox is closed'));
    if (queued >= 64) return Promise.reject(new Error('Task sandbox operation queue is full; wait for current work'));
    queued++;
    const operation = queueTail.then(() => {
      lifetimeSignal.throwIfAborted();
      if (uncertainCleanup.length) throw new AggregateError(uncertainCleanup, 'Sandbox cleanup requires host recovery');
      return action();
    });
    queueTail = operation
      .then(
        () => {},
        (error) => {
          if (error instanceof AggregateError) uncertainCleanup.push(error);
        },
      )
      .finally(() => {
        queued--;
      });
    return operation;
  };
  const rpcUrl = backend.rpcUrl(options.surfnetPort);
  const runSpec: ToolRunSpec = {
    onSpawn: options.onSpawn,
    taskName: options.taskName,
    mounts: options.mounts,
    sourceControlDir: options.sourceControlDir,
    leaseDir: options.leaseDir,
    surfnetPort: options.surfnetPort,
    cwd: root,
    protectedPaths: options.protectedPaths,
    get unsandboxed() {
      return options.hostTrust?.yolo === true;
    },
    buildProfile: options.buildProfile,
    env: backend.commandEnv({ rpcUrl, buildProfile: options.buildProfile, surfpool: options.surfpool }),
    stdoutLimitBytes: MAX_TASK_FILE_BYTES * 2,
    stderrLimitBytes: MAX_TASK_FILE_BYTES,
  };
  const runOptions = (argv: string[], signal: AbortSignal, timeoutMs: number) =>
    backend.runOptions(runSpec, { argv, signal, timeoutMs });
  // One container serves every command and file operation of the task. Host mode runs processes directly.
  const session = backend.openSession(runSpec, lifetimeSignal);
  const run = (argv: string[], signal: AbortSignal | undefined, timeoutMs: number, capture: boolean) =>
    enqueue(async () => {
      const operationSignal = signal ? AbortSignal.any([signal, lifetimeSignal]) : lifetimeSignal;
      operationSignal.throwIfAborted();
      const remaining = Math.floor(options.remainingWallClockMs?.() ?? Infinity);
      if (remaining <= 0) throw new Error('Task wall-clock budget exhausted');
      const timeout = Math.min(timeoutMs, remaining, options.buildProfile ? BUILD_TIMEOUT_MS : Infinity);
      const log = capture ? logs.start() : undefined;
      try {
        const result = terminal
          ? await terminal.execute(argv, operationSignal, timeout, log?.push)
          : session
            ? await session.exec(argv, { signal: operationSignal, timeoutMs: timeout, onOutput: log?.push })
            : await runInSandbox({ ...runOptions(argv, operationSignal, timeout), onOutput: log?.push });
        if (!log) return result;
        const preview = log.finish();
        return { ...result, stdout: preview.text, stderr: '', truncated: preview.truncated, logId: log.id };
      } finally {
        log?.finish();
      }
    });
  const sandboxed = () => !options.hostTrust?.yolo && hostSandbox() === 'seatbelt';
  const approve = async (command: string, signal?: AbortSignal): Promise<void> => {
    if (!backend.approvesCommands) return;
    const { hostTrust } = options;
    if (hostTrust && (hostTrust.yolo || sandboxed())) return;
    await approveHostCommand(command, root, {
      policy: options.approvalPolicy,
      approve: hostApproval,
      signal,
      allowed: hostTrust?.allowed,
    });
  };
  const execute = (argv: string[], signal?: AbortSignal, timeoutMs = defaultTimeout) =>
    (async () => {
      await approve(argv[1] === '-c' ? argv[2]! : argv.join(' '), signal);
      return run(argv, signal, timeoutMs, options.outputMode === 'head-tail');
    })();
  const startTerminal = (columns: number, rows: number): Promise<TaskTerminal> =>
    enqueue(async () => {
      if (terminal) return terminal;
      await approve('interactive host terminal (unrestricted shell)', lifetimeSignal);
      const remaining = Math.floor(options.remainingWallClockMs?.() ?? defaultTimeout);
      if (remaining <= 0) throw new Error('Task wall-clock budget exhausted');
      terminalStarting = true;
      try {
        const created = await createTaskTerminal({
          columns,
          rows,
          run: runOptions(['/bin/sh', '-i'], lifetimeSignal, Math.min(remaining, 2_147_483_647)),
        });
        terminal = created;
        void created.exited.then(
          () => {
            if (terminal === created) terminal = undefined;
          },
          (error) => {
            if (error instanceof AggregateError) uncertainCleanup.push(error);
            if (terminal === created) terminal = undefined;
          },
        );
        return created;
      } finally {
        terminalStarting = false;
      }
    });
  const assertVerificationAllowed = () => {
    lifetimeSignal.throwIfAborted();
    if (terminal || terminalStarting)
      throw new Error('Stop terminal before verification; interactive writes cannot be captured safely');
  };
  const withVerification = <T>(action: () => Promise<T>): Promise<T> =>
    enqueue(async () => {
      assertVerificationAllowed();
      // Verification runs model-written test code on the host.
      await approve('host verification (runs the task tests and verifier commands unsandboxed)', lifetimeSignal);
      return action();
    });
  function withCancellation<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>): ToolDefinition<P, D, S> {
    return {
      ...tool,
      execute: (callId, input, signal, onUpdate, context) =>
        toolSignal.run(signal, () => tool.execute(callId, input, signal, onUpdate, { ...context, cwd: root })),
    };
  }
  const files = createTaskFileAccess(
    (argv, signal, timeoutMs = defaultTimeout) => run(argv, signal, timeoutMs, false),
    root,
    options.protectedPaths,
  );
  const shell: BashOperations = {
    async exec(command, _cwd, request) {
      const timeout = request.timeout === undefined ? defaultTimeout : request.timeout * 1000;
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Command timeout must be positive');
      const result = await execute(['/bin/sh', '-c', command], request.signal, timeout);
      request.onData(Buffer.from(result.stdout + result.stderr));
      const blocked = result.exitCode === 0 || !sandboxed() ? undefined : sandboxBlock(result.stdout + result.stderr);
      if (blocked) request.onData(Buffer.from(`\nBlocked by the sandbox (${blocked}). /yolo allows it.\n`));
      if (result.truncated) request.onData(Buffer.from('\n[output truncated at the task limit]\n'));
      return { exitCode: result.exitCode };
    },
  };
  const edits = new Map<string, string>();
  const read = createReadToolDefinition(root, {
    autoResizeImages: false,
    operations: {
      readFile: async (path) => (await files.read(path, toolSignal.getStore())).bytes,
      access: (path) => files.access(path, toolSignal.getStore()),
      detectImageMimeType: async () => null,
    },
  });
  read.description =
    'Read a regular UTF-8 text file inside the selected /work task sandbox. The entire file must be at most 64 KiB; host paths, private/control files and images are unavailable.';
  const edit = createEditToolDefinition(root, {
    operations: {
      async readFile(path) {
        const snapshot = await files.read(path, toolSignal.getStore());
        edits.set(taskPath(path, root), snapshot.revision);
        return snapshot.bytes;
      },
      async writeFile(path, content) {
        const key = taskPath(path, root);
        const expected = edits.get(key);
        if (!expected) throw new Error('An edit requires its current file revision');
        try {
          await files.write(path, Buffer.from(content, 'utf8'), expected, toolSignal.getStore());
        } finally {
          edits.delete(key);
        }
      },
      access: (path) => files.access(path, toolSignal.getStore()),
    },
  });
  edit.description =
    'Apply exact text edits to a regular UTF-8 task file inside /work, at most 64 KiB. A changed file revision is refused; read it again before retrying. Pinned verifier and private/control files are not writable.';
  const write = createWriteToolDefinition(root, {
    operations: {
      async writeFile(path, content) {
        await files.write(path, Buffer.from(content, 'utf8'), undefined, toolSignal.getStore());
      },
      mkdir: (path) => files.makeDirectory(path, toolSignal.getStore()),
    },
  });
  write.description =
    'Create or replace a regular UTF-8 task file inside /work, at most 64 KiB, using an atomic save. Host paths, pinned verifier and private/control files are not writable.';
  if (options.writeDetails) {
    const plainWrite = write.execute;
    write.execute = async (callId, input, signal, onUpdate, context) => {
      let before: string | undefined | null;
      try {
        before = (await files.read(input.path, toolSignal.getStore() ?? signal)).bytes.toString('utf8');
      } catch (error) {
        before = /ENOENT/.test(String(error)) ? undefined : null;
      }
      const result = await plainWrite(callId, input, signal, onUpdate, context);
      if (before === null) return result;
      const lines = input.content === '' ? 0 : input.content.replace(/\n$/, '').split('\n').length;
      return {
        ...result,
        details: {
          created: before === undefined,
          lines,
          ...(before === undefined ? {} : generateDiffString(before, input.content)),
        },
      } as never;
    };
  }
  const bash = createBashToolDefinition(root, { operations: shell, exposeSessionEnvironment: false });
  bash.description =
    'Execute a POSIX /bin/sh command inside the isolated task sandbox. No host shell, credentials or general network access. Bash-specific syntax is unavailable.';
  const text = backend.toolText(root);
  if (text.descriptions) {
    read.description = text.descriptions.read;
    edit.description = text.descriptions.edit;
    write.description = text.descriptions.write;
    bash.description = text.descriptions.bash;
  }
  bash.promptGuidelines = [`Commands run in ${root} using /bin/sh. ${text.guideline}`];
  if (options.outputMode === 'head-tail') {
    // Pi's ordinary bash wrapper applies a second 50 KiB tail-only truncation.
    // Return our already-bounded preview directly, without a host temp-path leak.
    bash.execute = async (_callId, { command, timeout }, signal) => {
      const timeoutMs = timeout === undefined ? defaultTimeout : timeout * 1000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Command timeout must be positive');
      const started = Date.now();
      const result = await execute(['/bin/sh', '-c', command], signal, timeoutMs);
      return {
        content: [{ type: 'text', text: result.stdout || '(no output)' }],
        details: {},
        structuredContent: {
          output: result.stdout,
          truncated: result.truncated,
          exit_code: result.exitCode,
          wall_time_seconds: (Date.now() - started) / 1000,
        },
        isError: result.exitCode !== 0,
      };
    };
    bash.description +=
      ' Output retains 32 KiB head and 96 KiB tail; use read_log with the opaque id to page the bounded host stream.';
  }
  const depsParameters = Type.Object({ manager: Type.Union([Type.Literal('cargo'), Type.Literal('npm')]) });
  const depsFetch: ToolDefinition<typeof depsParameters> = {
    name: 'deps_fetch',
    label: 'Fetch locked dependencies',
    description:
      'Fetch Cargo or npm lockfile dependencies through the install allowlist. Git dependencies and Cargo source/network overrides are refused. npm lifecycle scripts are disabled.',
    parameters: depsParameters,
    async execute(_callId, input, signal) {
      return enqueue(async () => {
        assertVerificationAllowed();
        const remaining = Math.floor(options.remainingWallClockMs?.() ?? BUILD_TIMEOUT_MS);
        if (remaining <= 0) throw new Error('Task wall-clock budget exhausted');
        const result = await runInSandbox(
          backend.installOptions(runSpec, {
            argv: dependencyFetchArgv(input.manager),
            signal: AbortSignal.any([lifetimeSignal, ...(signal ? [signal] : [])]),
            timeoutMs: Math.min(BUILD_TIMEOUT_MS, remaining),
          }),
        );
        return {
          content: [{ type: 'text' as const, text: result.stdout + result.stderr || '(no output)' }],
          details: {},
          isError: result.exitCode !== 0,
        };
      });
    },
  };
  const readLogParameters = Type.Object({
    id: Type.String(),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
  });
  const readLog: ToolDefinition<typeof readLogParameters> = {
    name: 'read_log',
    label: 'Read command log',
    description:
      "Read this session's host command log by opaque id. Returns base64 bytes (at most 16000) and byte offsets. No file paths. Host storage is capped at 16 MiB per session; truncated indicates missing host bytes.",
    parameters: readLogParameters,
    async execute(_callId, input) {
      const page = logs.read(input.id, input.offset, input.max_bytes);
      return { content: [{ type: 'text', text: JSON.stringify(page) }], details: {} };
    },
  };
  return {
    setHostApproval(approve) {
      hostApproval = approve;
    },
    extension: (pi) => {
      pi.registerTool(withCancellation(read));
      pi.registerTool(withCancellation(edit));
      pi.registerTool(withCancellation(write));
      pi.registerTool(withCancellation(bash));
      pi.registerTool(withCancellation(depsFetch));
      if (options.outputMode === 'head-tail') pi.registerTool(withCancellation(readLog));
      pi.on('user_bash', () => ({ operations: shell }));
    },
    execute,
    readLog: (...[id, offset, maxBytes]) => {
      if (disposed || lifetimeSignal.aborted) throw new Error('Task sandbox is closed');
      return logs.read(id, offset, maxBytes);
    },
    files,
    startTerminal,
    withVerification,
    assertVerificationAllowed,
    dispose() {
      return (disposal ??= (async () => {
        disposed = true;
        lifetime.abort(new Error('Task sandbox closed'));
        await queueTail;
        try {
          await terminal?.close();
        } catch (error) {
          uncertainCleanup.push(error);
        }
        try {
          await session?.close();
        } catch (error) {
          uncertainCleanup.push(error);
        } finally {
          logs.dispose();
        }
        if (uncertainCleanup.length)
          throw new AggregateError(uncertainCleanup, 'Sandbox tool cleanup requires host recovery');
      })());
    },
  };
}
