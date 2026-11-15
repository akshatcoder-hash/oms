import { approveHostCommand, type HostApproval, type HostApprovalPolicy } from './host-approval.ts';
import { AsyncLocalStorage } from "node:async_hooks";
import { posix, relative, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createSandboxSession, hostSandbox, runInSandbox, type MountPlan, type SandboxResult, type RunInSandboxOptions } from "@oms/sandbox";
import { Type, type TSchema } from "typebox";
import { dependencyFetchArgv, DEPENDENCY_ALLOWLIST } from "./deps-fetch.ts";
import { CommandLogs, type LogPage } from "./command-logs.ts";
import { createTaskFileAccess, MAX_TASK_FILE_BYTES, type TaskFileAccess } from "./task-files.ts";
import { createTaskTerminal, type OwnedTaskTerminal, type TaskTerminal } from "./task-terminal.ts";
import { BUILD_LIMITS, BUILD_TIMEOUT_MS } from './build-profile.ts';

export interface SandboxToolsOptions {
  backend?: 'host' | 'docker';
  approvalPolicy?: HostApprovalPolicy;
  protectedPaths?: string[];
  onSpawn?: (pid: number, cwd: string) => void;
  taskName: string;
  mounts: MountPlan;
  image: string;
  forwarderImage: string;
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
  outputMode?: "head-tail";
}


function taskPath(path: string, root: string): string {
  const resolved = posix.resolve(root, path);
  if (resolved === root || !resolved.startsWith(root + "/")) {
    throw new Error("File operations are limited to the selected task under /work");
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
  if (options.outputMode !== undefined && options.outputMode !== "head-tail") throw new Error("Unknown command output mode");
  if (options.outputMode) {
    const temp = realpathSync(tmpdir());
    for (const mount of [options.mounts.projectMount, ...options.mounts.extraMounts, ...options.mounts.readOnlyMounts]) {
      const rel = relative(mount.hostPath, temp);
      if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Host command logs must be outside sandbox binds");
    }
  }
  let hostApproval: HostApproval | undefined;
  const root = options.backend === "host" ? realpathSync(options.mounts.projectMount.hostPath) : "/work";
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
    if (disposed || lifetimeSignal.aborted) return Promise.reject(new Error("Task sandbox is closed"));
    if (queued >= 64) return Promise.reject(new Error("Task sandbox operation queue is full; wait for current work"));
    queued++;
    const operation = queueTail.then(() => {
      lifetimeSignal.throwIfAborted();
      if (uncertainCleanup.length) throw new AggregateError(uncertainCleanup, "Sandbox cleanup requires host recovery");
      return action();
    });
    queueTail = operation.then(() => {}, error => {
      if (error instanceof AggregateError) uncertainCleanup.push(error);
    }).finally(() => { queued--; });
    return operation;
  };
  const rpcUrl = `http://${options.backend === "host" ? "127.0.0.1" : "host.docker.internal"}:${options.surfnetPort}`;
  const sharedRun = {
    onSpawn: options.onSpawn,
    taskName: options.taskName,
    phase: "run" as const,
    mounts: options.mounts,
    sourceControlDir: options.sourceControlDir,
    surfnet: { port: options.surfnetPort },
    cwd: root,
    env: { ...(options.backend === "host" ? {} : { HOME: "/tmp", TMPDIR: "/tmp" }), ...(options.buildProfile ? { CARGO_HOME: "/work/.oms-cargo", CARGO_NET_OFFLINE: "true" } : {}), SOLANA_RPC_URL: rpcUrl, SURFNET_RPC_URL: rpcUrl, ...(options.surfpool ? { SURFPOOL_BINARY: options.surfpool } : {}) },
    stdoutLimitBytes: MAX_TASK_FILE_BYTES * 2,
    stderrLimitBytes: MAX_TASK_FILE_BYTES,
  };
  const hostRun = { ...sharedRun, backend: "host" as const, protectedPaths: options.protectedPaths };
  const dockerRun = { ...sharedRun, backend: "docker" as const, image: options.image, forwarderImage: options.forwarderImage, leaseDir: options.leaseDir,
    ...(options.buildProfile ? { limits: BUILD_LIMITS } : {}) };
  const baseRun = options.backend === "host" ? hostRun : dockerRun;
  const runOptions = (argv: string[], signal: AbortSignal, timeoutMs: number): RunInSandboxOptions => ({ ...baseRun, argv, signal, timeoutMs });
  // One container serves every command and file operation of the task. Host mode runs processes directly.
  const session = options.backend === "host" ? undefined : createSandboxSession({ ...dockerRun, signal: lifetimeSignal });
  const run = (argv: string[], signal: AbortSignal | undefined, timeoutMs: number, capture: boolean) => enqueue(async () => {
    const operationSignal = signal ? AbortSignal.any([signal, lifetimeSignal]) : lifetimeSignal;
    operationSignal.throwIfAborted();
    const remaining = Math.floor(options.remainingWallClockMs?.() ?? Infinity);
    if (remaining <= 0) throw new Error("Task wall-clock budget exhausted");
    const timeout = Math.min(timeoutMs, remaining, options.buildProfile ? BUILD_TIMEOUT_MS : Infinity);
    const log = capture ? logs.start() : undefined;
    try {
      const result = terminal ? await terminal.execute(argv, operationSignal, timeout, log?.push)
        : session ? await session.exec(argv, { signal: operationSignal, timeoutMs: timeout, onOutput: log?.push })
        : await runInSandbox({ ...runOptions(argv, operationSignal, timeout), onOutput: log?.push });
      if (!log) return result;
      const preview = log.finish();
      return { ...result, stdout: preview.text, stderr: "", truncated: preview.truncated, logId: log.id };
    } finally { log?.finish(); }
  });
  const execute = (argv: string[], signal?: AbortSignal, timeoutMs = defaultTimeout) =>
    (async () => {
      if (options.backend === 'host') await approveHostCommand(argv[1] === '-c' ? argv[2]! : argv.join(' '), root, { policy: options.approvalPolicy, approve: hostApproval, signal });
      return run(argv, signal, timeoutMs, options.outputMode === "head-tail");
    })();
  const startTerminal = (columns: number, rows: number): Promise<TaskTerminal> => enqueue(async () => {
    if (terminal) return terminal;
    if (options.backend === 'host') await approveHostCommand('interactive host terminal (unrestricted shell)', root, { policy: options.approvalPolicy, approve: hostApproval, signal: lifetimeSignal });
    const remaining = Math.floor(options.remainingWallClockMs?.() ?? defaultTimeout);
    if (remaining <= 0) throw new Error("Task wall-clock budget exhausted");
    terminalStarting = true;
    try {
      const created = await createTaskTerminal({ columns, rows,
        run: runOptions(["/bin/sh", "-i"], lifetimeSignal, Math.min(remaining, 2_147_483_647)) });
      terminal = created;
      void created.exited.then(() => {
        if (terminal === created) terminal = undefined;
      }, error => {
        if (error instanceof AggregateError) uncertainCleanup.push(error);
        if (terminal === created) terminal = undefined;
      });
      return created;
    } finally { terminalStarting = false; }
  });
  const assertVerificationAllowed = () => {
    lifetimeSignal.throwIfAborted();
    if (terminal || terminalStarting) throw new Error("Stop terminal before verification; interactive writes cannot be captured safely");
  };
  const withVerification = <T>(action: () => Promise<T>): Promise<T> => enqueue(async () => {
    assertVerificationAllowed();
    // Verification runs model-written test code on the host.
    if (options.backend === 'host') await approveHostCommand('host verification (runs the task tests and verifier commands unsandboxed)', root, { policy: options.approvalPolicy, approve: hostApproval, signal: lifetimeSignal });
    return action();
  });
  function withCancellation<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>): ToolDefinition<P, D, S> {
    return {
      ...tool,
      execute: (callId, input, signal, onUpdate, context) => toolSignal.run(signal, () =>
        tool.execute(callId, input, signal, onUpdate, { ...context, cwd: root })),
    };
  }
  const files = createTaskFileAccess((argv, signal, timeoutMs = defaultTimeout) => run(argv, signal, timeoutMs, false), root, options.protectedPaths);
  const shell: BashOperations = {
    async exec(command, _cwd, request) {
      const timeout = request.timeout === undefined ? defaultTimeout : request.timeout * 1000;
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Command timeout must be positive");
      const result = await execute(["/bin/sh", "-c", command], request.signal, timeout);
      request.onData(Buffer.from(result.stdout + result.stderr));
      if (result.truncated) request.onData(Buffer.from("\n[output truncated at the task limit]\n"));
      return { exitCode: result.exitCode };
    },
  };
  const edits = new Map<string, string>();
  const read = createReadToolDefinition(root, { autoResizeImages: false, operations: {
    readFile: async path => (await files.read(path, toolSignal.getStore())).bytes,
    access: path => files.access(path, toolSignal.getStore()),
    detectImageMimeType: async () => null,
  } });
  read.description = "Read a regular UTF-8 text file inside the selected /work task sandbox. The entire file must be at most 64 KiB; host paths, private/control files and images are unavailable.";
  const edit = createEditToolDefinition(root, { operations: {
    async readFile(path) {
      const snapshot = await files.read(path, toolSignal.getStore());
      edits.set(taskPath(path, root), snapshot.revision);
      return snapshot.bytes;
    },
    async writeFile(path, content) {
      const key = taskPath(path, root);
      const expected = edits.get(key);
      if (!expected) throw new Error("An edit requires its current file revision");
      try { await files.write(path, Buffer.from(content, "utf8"), expected, toolSignal.getStore()); }
      finally { edits.delete(key); }
    },
    access: path => files.access(path, toolSignal.getStore()),
  } });
  edit.description = "Apply exact text edits to a regular UTF-8 task file inside /work, at most 64 KiB. A changed file revision is refused; read it again before retrying. Pinned verifier and private/control files are not writable.";
  const write = createWriteToolDefinition(root, { operations: {
    async writeFile(path, content) {
      await files.write(path, Buffer.from(content, "utf8"), undefined, toolSignal.getStore());
    },
    mkdir: path => files.makeDirectory(path, toolSignal.getStore()),
  } });
  write.description = "Create or replace a regular UTF-8 task file inside /work, at most 64 KiB, using an atomic save. Host paths, pinned verifier and private/control files are not writable.";
  const bash = createBashToolDefinition(root, { operations: shell, exposeSessionEnvironment: false });
  bash.description = "Execute a POSIX /bin/sh command inside the isolated task sandbox. No host shell, credentials or general network access. Bash-specific syntax is unavailable.";
  if (options.backend === 'host') {
    read.description = `Read a task file under ${root}; private/control files are unavailable.`;
    edit.description = `Edit a task file under ${root}; pinned verifier and private/control files are protected.`;
    write.description = `Write a task file under ${root}; pinned verifier and private/control files are protected.`;
    bash.description = hostSandbox() === 'seatbelt'
      ? `Run a command on the host in ${root} under Seatbelt: writes stay in the task and temp, network only to Surfnet, scrubbed environment. User approval is required.`
      : `Run a command on the host in ${root}, with unrestricted network and scrubbed environment. User approval is required.`;
  }
  bash.promptGuidelines = [`Commands run in ${root} using /bin/sh. ${options.backend !== "host" ? "Host paths and credentials are unavailable." : hostSandbox() === 'seatbelt' ? "Commands run under Seatbelt and require approval." : "Host mode has no sandbox; commands require approval."}`];
  if (options.outputMode === "head-tail") {
    // Pi's ordinary bash wrapper applies a second 50 KiB tail-only truncation.
    // Return our already-bounded preview directly, without a host temp-path leak.
    bash.execute = async (_callId, { command, timeout }, signal) => {
      const timeoutMs = timeout === undefined ? defaultTimeout : timeout * 1000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Command timeout must be positive");
      const started = Date.now();
      const result = await execute(["/bin/sh", "-c", command], signal, timeoutMs);
      return { content: [{ type: "text", text: result.stdout || "(no output)" }],
        details: {}, structuredContent: { output: result.stdout, truncated: result.truncated,
          exit_code: result.exitCode, wall_time_seconds: (Date.now() - started) / 1000 },
        isError: result.exitCode !== 0 };
    };
    bash.description += " Output retains 32 KiB head and 96 KiB tail; use read_log with the opaque id to page the bounded host stream.";
  }
  const depsParameters = Type.Object({ manager: Type.Union([Type.Literal("cargo"), Type.Literal("npm")]) });
  const depsFetch: ToolDefinition<typeof depsParameters> = {
    name: "deps_fetch", label: "Fetch locked dependencies",
    description: "Fetch Cargo or npm lockfile dependencies through the install allowlist. Git dependencies and Cargo source/network overrides are refused. npm lifecycle scripts are disabled.",
    parameters: depsParameters,
    async execute(_callId, input, signal) {
      return enqueue(async () => {
        assertVerificationAllowed();
        const remaining = Math.floor(options.remainingWallClockMs?.() ?? BUILD_TIMEOUT_MS);
        if (remaining <= 0) throw new Error("Task wall-clock budget exhausted");
        const fetchRun = runOptions(dependencyFetchArgv(input.manager),
          AbortSignal.any([lifetimeSignal, ...(signal ? [signal] : [])]), Math.min(BUILD_TIMEOUT_MS, remaining));
        const result = await runInSandbox({ ...fetchRun, phase: "install",
          ...(fetchRun.backend === "docker" ? { installAllowlist: DEPENDENCY_ALLOWLIST } : {}),
          env: { HOME: "/tmp", TMPDIR: "/tmp", CARGO_HOME: "/work/.oms-cargo" },
        });
        return { content: [{ type: "text" as const, text: result.stdout + result.stderr || "(no output)" }],
          details: {}, isError: result.exitCode !== 0 };
      });
    },
  };
  const readLogParameters = Type.Object({ id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })),
    max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) });
  const readLog: ToolDefinition<typeof readLogParameters> = {
    name: "read_log", label: "Read command log",
    description: "Read this session's host command log by opaque id. Returns base64 bytes (at most 16000) and byte offsets. No file paths. Host storage is capped at 16 MiB per session; truncated indicates missing host bytes.",
    parameters: readLogParameters,
    async execute(_callId, input) {
      const page = logs.read(input.id, input.offset, input.max_bytes);
      return { content: [{ type: "text", text: JSON.stringify(page) }], details: {} };
    },
  };
  return {
    setHostApproval(approve) { hostApproval = approve; },
    extension: pi => {
      pi.registerTool(withCancellation(read));
      pi.registerTool(withCancellation(edit));
      pi.registerTool(withCancellation(write));
      pi.registerTool(withCancellation(bash));
      pi.registerTool(withCancellation(depsFetch));
      if (options.outputMode === "head-tail") pi.registerTool(withCancellation(readLog));
      pi.on("user_bash", () => ({ operations: shell }));
    },
    execute,
    readLog: (...[id, offset, maxBytes]) => {
      if (disposed || lifetimeSignal.aborted) throw new Error("Task sandbox is closed");
      return logs.read(id, offset, maxBytes);
    },
    files,
    startTerminal,
    withVerification,
    assertVerificationAllowed,
    dispose() {
      return disposal ??= (async () => {
        disposed = true;
        lifetime.abort(new Error("Task sandbox closed"));
        await queueTail;
        try { await terminal?.close(); }
        catch (error) { uncertainCleanup.push(error); }
        try { await session?.close(); }
        catch (error) { uncertainCleanup.push(error); }
        finally { logs.dispose(); }
        if (uncertainCleanup.length) throw new AggregateError(uncertainCleanup, "Sandbox tool cleanup requires host recovery");
      })();
    },
  };
}
