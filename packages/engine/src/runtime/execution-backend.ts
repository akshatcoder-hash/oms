/**
 * The two places a task's commands can run, and everything that differs between them.
 *
 * "host": tools run on the user's machine; macOS adds a Seatbelt sandbox, Linux has none.
 * "docker": tools run in containers with their own egress network, mounted at /work.
 *
 * Callers hold one `ExecutionBackend` and ask it, instead of testing a backend name.
 * Each implementation builds only the run options its sandbox backend takes.
 */
import {
  buildMounts,
  createSandboxSession,
  hostSandbox,
  recoverTaskExecutionResources,
  requirePinnedImage,
  type MountPlan,
  type RunInSandboxOptions,
  type SandboxSession,
} from '@oms/sandbox';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_LIMITS } from './build-profile.ts';
import { DEPENDENCY_ALLOWLIST } from './deps-fetch.ts';
import { trustedSurfpoolMounts, TRUSTED_SURFPOOL } from './verifier-backend.ts';
import type { HarnessEnvironment } from './session-types.ts';

export type BackendName = 'host' | 'docker';

export const isBackendName = (value: unknown): value is BackendName => value === 'host' || value === 'docker';

/** The pinned images a Docker backend runs in; a host backend carries them only for the one Docker dependency fetch. */
export interface BackendImages {
  image: string;
  forwarderImage: string;
}

/** What a task's tool commands need, in neutral terms; each backend picks the fields it uses. */
export interface ToolRunSpec {
  onSpawn?: (pid: number, cwd: string) => void;
  taskName: string;
  mounts: MountPlan;
  sourceControlDir: string;
  /** Docker only: the private lease directory outside every bind. */
  leaseDir: string;
  surfnetPort: number;
  cwd: string;
  env: Record<string, string>;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  /** Host only: files a command may never write. */
  protectedPaths?: string[];
  buildProfile?: boolean;
}

/** The per-command part of a run. */
export interface CommandTiming {
  argv: string[];
  signal: AbortSignal;
  timeoutMs: number;
}

/** What one verifier command needs; the backend builds the run options and mounts from it. */
export interface VerifierRunSpec {
  onSpawn?: (pid: number, cwd: string) => void;
  buildTask: string;
  sourceControlDir?: string;
  leaseDir: string;
  signal: AbortSignal;
  timeoutMs: number;
  surfnetPort: number;
  argv: string[];
  mounts: MountPlan;
  /** The immutable code tree, as a host path. */
  codeRoot: string;
  /** Per-run output directory on the host. */
  output: string;
  /** The approved Surfpool, as a host path. */
  binary: string;
  buildProfile?: boolean;
  rpcUrl: string;
}

export interface VerifierMountSpec {
  codeRoot: string;
  buildRoot: string;
  buildTask: string;
  output: string;
  leaseDir: string;
  dependencyModules?: string;
  /** Read-only mounts of the locked dependencies and Surfpool, for containers. */
  trustedMounts: Array<{ hostPath: string; containerPath: string; mode: 'ro' }>;
  buildProfile?: boolean;
  npmDependencies?: boolean;
}

export interface ExecutionBackend {
  readonly name: BackendName;
  readonly images: BackendImages;
  /** Commands, interactive terminals and verification need the user's approval (they run on the host). */
  readonly approvesCommands: boolean;
  /** Processes started in this task's runtime may sit in a captured proof snapshot under the temp directory. */
  readonly capturesProofRoots: boolean;
  /** The verifier pins the checkout's git control file, since host commands can reach it. */
  readonly pinsGitControl: boolean;
  /** Surfpool's host libraries must exist so they can be mounted into containers. */
  readonly mountsHostLibraries: boolean;
  /** Needs a running Docker daemon and the pinned image. */
  readonly requiresDocker: boolean;
  /** Whether doctor should probe that macOS Seatbelt really confines a process. */
  readonly probesSeatbelt: boolean;

  /** The task root as the agent and the guards see it: the real checkout on host, /work in a container. */
  taskRoot(codeRoot: string): string;
  /** The working root of tool commands for the mount plan's project. */
  commandRoot(projectHostPath: string): string;
  rpcUrl(port: number): string;
  /** Where commands find the trusted Surfpool, exported as SURFPOOL_BINARY. */
  surfpoolPath(environment: Pick<HarnessEnvironment, 'binary' | 'dependencies'>): string | undefined;
  /** The environment of tool commands. */
  commandEnv(spec: { rpcUrl: string; buildProfile?: boolean; surfpool?: string }): Record<string, string>;
  /** Roots, besides the work directory, whose processes belong to this task's runtime. */
  runtimeRoots(codeRoot: string): string[];
  /** The git control file to pin, when the verifier pins one. */
  gitControlPath(codeRoot: string): string | undefined;
  /** Extra read-only mounts a task's tool commands need. */
  taskMounts(spec: {
    binary: string;
    dependencies?: string;
    sourcesDir: string;
  }): { extra: Array<{ hostPath: string; containerPath: string; mode: 'ro' }> } | Record<never, never>;
  /** A once-per-workspace notice about what this backend does not isolate. */
  notice(): { key: string; text: string } | undefined;
  /** Tool descriptions this backend replaces (the defaults describe the container), and the closing sentence of the shell guideline. */
  toolText(root: string): {
    descriptions?: { read: string; edit: string; write: string; bash: string };
    guideline: string;
  };

  runOptions(spec: ToolRunSpec, run: CommandTiming): RunInSandboxOptions;
  /** The dependency-fetch run (install phase, allowlisted egress on Docker). */
  installOptions(spec: ToolRunSpec, run: CommandTiming): RunInSandboxOptions;
  /** One container serves every command of the task on Docker; the host runs processes directly. */
  openSession(spec: ToolRunSpec, signal: AbortSignal): SandboxSession | undefined;
  /** Removes what a crashed task's runtime left behind; recovery calls this after its process checks. */
  recoverResources(taskName: string, assertOwner: () => void): Promise<unknown>;

  /** Throws unless the images this backend runs in are pinned. */
  requireImages(): void;
  /** The images that identify this backend's execution policy; none on the host. */
  pinnedImages(): { image: string | null; forwarderImage: string | null };
  /** Identifies the verifier's execution policy; it participates in the pin and the evidence cache. */
  verifierPolicy(spec: { buildProfile?: boolean; npmDependencies?: boolean }): string;
  verifierMounts(spec: VerifierMountSpec): MountPlan;
  verifierRun(spec: VerifierRunSpec): RunInSandboxOptions;

  /** What doctor reports for the execution backend row. */
  doctorDetail(seatbelt: boolean): string;
}

// Bump when execution policy changes: this identity participates in the pin
// and evidence cache, not merely diagnostics. No untrusted cache is mounted.
const ADAPTER_POLICY =
  'oms.verifier-backend/4:offline:no-airdrop:ro-work:fresh-output:no-volumes:run-egress:nonroot:source-exclusion:checked-binds:rpc-env-both:host-loopback-relay:locked-deps:trusted-surfpool';

const HOST_WARNING = {
  seatbelt:
    'OMS host mode runs commands under macOS Seatbelt: writes stay in the worktree and temp, ~/.ssh, ~/.config/solana, keypairs and other repos are unreadable, and network is limited to the Surfnet port. Seatbelt is not a VM; use --sandbox docker for untrusted repositories.\n',
  none: 'OMS host mode has NO sandbox here (Linux in v0.1, or macOS without sandbox-exec). Commands can access your host files and unrestricted network. Environment scrubbing, approvals and file-tool protections reduce accidents; they do not isolate code. Use --sandbox docker for untrusted repositories.\n',
};

const NO_IMAGES: BackendImages = { image: '', forwarderImage: '' };

function hostBase(spec: ToolRunSpec) {
  return {
    onSpawn: spec.onSpawn,
    taskName: spec.taskName,
    phase: 'run' as const,
    mounts: spec.mounts,
    sourceControlDir: spec.sourceControlDir,
    surfnet: { port: spec.surfnetPort },
    cwd: spec.cwd,
    env: spec.env,
    stdoutLimitBytes: spec.stdoutLimitBytes,
    stderrLimitBytes: spec.stderrLimitBytes,
  };
}

export function hostBackend(images: BackendImages = NO_IMAGES): ExecutionBackend {
  const toolRun = (spec: ToolRunSpec) => ({
    ...hostBase(spec),
    backend: 'host' as const,
    protectedPaths: spec.protectedPaths,
  });
  return {
    name: 'host',
    images,
    approvesCommands: true,
    capturesProofRoots: true,
    pinsGitControl: true,
    mountsHostLibraries: false,
    requiresDocker: false,
    probesSeatbelt: true,

    taskRoot: (codeRoot) => codeRoot,
    commandRoot: (projectHostPath) => realpathSync(projectHostPath),
    rpcUrl: (port) => `http://127.0.0.1:${port}`,
    surfpoolPath: (environment) => environment.binary,
    commandEnv: ({ rpcUrl, buildProfile, surfpool }) => ({
      ...(buildProfile ? { CARGO_HOME: '/work/.oms-cargo', CARGO_NET_OFFLINE: 'true' } : {}),
      SOLANA_RPC_URL: rpcUrl,
      SURFNET_RPC_URL: rpcUrl,
      ...(surfpool ? { SURFPOOL_BINARY: surfpool } : {}),
    }),
    runtimeRoots: (codeRoot) => [codeRoot],
    gitControlPath: (codeRoot) => join(codeRoot, '.git'),
    // source_fetch's folder: host commands read it through the temp directory, so nothing is mounted.
    taskMounts: () => ({}),
    notice: () => {
      const sandbox = hostSandbox();
      return { key: sandbox, text: sandbox === 'seatbelt' ? HOST_WARNING.seatbelt : HOST_WARNING.none };
    },
    toolText: (root) => ({
      descriptions: {
        read: `Read a task file under ${root}; private/control files are unavailable.`,
        edit: `Edit a task file under ${root}; pinned verifier and private/control files are protected.`,
        write: `Write a task file under ${root}; pinned verifier and private/control files are protected.`,
        bash:
          hostSandbox() === 'seatbelt'
            ? `Run a command on the host in ${root} under Seatbelt: writes stay in the task and temp, network only to Surfnet, scrubbed environment. User approval is required.`
            : `Run a command on the host in ${root}, with unrestricted network and scrubbed environment. User approval is required.`,
      },
      guideline:
        hostSandbox() === 'seatbelt'
          ? 'Commands run under Seatbelt and require approval.'
          : 'Host mode has no sandbox; commands require approval.',
    }),

    runOptions: (spec, run) => ({ ...toolRun(spec), ...run }),
    installOptions: (spec, run) => ({
      ...toolRun(spec),
      ...run,
      phase: 'install',
      env: { HOME: '/tmp', TMPDIR: '/tmp', CARGO_HOME: '/work/.oms-cargo' },
    }),
    openSession: () => undefined,
    recoverResources: async () => {},

    requireImages: () => {},
    pinnedImages: () => ({ image: null, forwarderImage: null }),
    verifierPolicy: () => 'oms.verifier-host/2:unsandboxed:scrubbed:loopback:git-control-pin',
    verifierMounts: ({ codeRoot, dependencyModules }) => ({
      projectMount: { hostPath: codeRoot, containerPath: codeRoot, mode: 'ro' as const },
      extraMounts: [],
      readOnlyMounts: dependencyModules
        ? [{ hostPath: dependencyModules, containerPath: join(codeRoot, 'node_modules'), mode: 'ro' as const }]
        : [],
      volumes: [],
      shadowMounts: [],
    }),
    verifierRun: (spec) => ({
      onSpawn: spec.onSpawn,
      taskName: spec.buildTask,
      phase: 'run' as const,
      sourceControlDir: spec.sourceControlDir,
      signal: spec.signal,
      timeoutMs: spec.timeoutMs,
      surfnet: { port: spec.surfnetPort },
      mounts: spec.mounts,
      backend: 'host' as const,
      argv: spec.argv.map((arg) =>
        arg.replaceAll('/work/', spec.codeRoot + '/').replaceAll(TRUSTED_SURFPOOL, spec.binary),
      ),
      cwd: spec.codeRoot,
      env: {
        ...(spec.buildProfile ? { CARGO_HOME: '/work/.oms-cargo', CARGO_NET_OFFLINE: 'true' } : {}),
        OMS_OUTPUT_DIR: spec.output,
        SOLANA_RPC_URL: spec.rpcUrl,
        SURFNET_RPC_URL: spec.rpcUrl,
        SURFPOOL_BINARY: spec.binary,
      },
    }),

    doctorDetail: (seatbelt) =>
      seatbelt
        ? 'host (macOS Seatbelt: worktree writes, Surfnet-only network)'
        : 'host (no sandbox; unrestricted network)',
  };
}

export function dockerBackend(images: BackendImages = NO_IMAGES): ExecutionBackend {
  const toolRun = (spec: ToolRunSpec) => ({
    ...hostBase(spec),
    backend: 'docker' as const,
    image: images.image,
    forwarderImage: images.forwarderImage,
    leaseDir: spec.leaseDir,
    ...(spec.buildProfile ? { limits: BUILD_LIMITS } : {}),
  });
  return {
    name: 'docker',
    images,
    approvesCommands: false,
    capturesProofRoots: false,
    pinsGitControl: false,
    mountsHostLibraries: true,
    requiresDocker: true,
    probesSeatbelt: false,

    taskRoot: () => '/work',
    commandRoot: () => '/work',
    rpcUrl: (port) => `http://host.docker.internal:${port}`,
    surfpoolPath: (environment) => (environment.dependencies ? TRUSTED_SURFPOOL : undefined),
    commandEnv: ({ rpcUrl, buildProfile, surfpool }) => ({
      HOME: '/tmp',
      TMPDIR: '/tmp',
      ...(buildProfile ? { CARGO_HOME: '/work/.oms-cargo', CARGO_NET_OFFLINE: 'true' } : {}),
      SOLANA_RPC_URL: rpcUrl,
      SURFNET_RPC_URL: rpcUrl,
      ...(surfpool ? { SURFPOOL_BINARY: surfpool } : {}),
    }),
    runtimeRoots: () => [],
    gitControlPath: () => undefined,
    taskMounts: ({ binary, dependencies, sourcesDir }) => ({
      // The task's own tests start Surfpool, so the agent sees the same trusted binary the verifier does.
      // source_fetch's folder: a container needs it mounted at the same path.
      extra: [
        ...(dependencies ? trustedSurfpoolMounts(binary) : []),
        { hostPath: sourcesDir, containerPath: sourcesDir, mode: 'ro' as const },
      ],
    }),
    notice: () => undefined,
    toolText: () => ({ guideline: 'Host paths and credentials are unavailable.' }),

    runOptions: (spec, run) => ({ ...toolRun(spec), ...run }),
    installOptions: (spec, run) => ({
      ...toolRun(spec),
      ...run,
      phase: 'install',
      installAllowlist: DEPENDENCY_ALLOWLIST,
      env: { HOME: '/tmp', TMPDIR: '/tmp', CARGO_HOME: '/work/.oms-cargo' },
    }),
    openSession: (spec, signal) => createSandboxSession({ ...toolRun(spec), signal }),
    recoverResources: (taskName, assertOwner) => recoverTaskExecutionResources(taskName, assertOwner),

    requireImages: () => {
      requirePinnedImage(images.image, 'verifier image');
      requirePinnedImage(images.forwarderImage, 'verifier forwarderImage');
    },
    pinnedImages: () => ({ image: images.image, forwarderImage: images.forwarderImage }),
    verifierPolicy: ({ buildProfile, npmDependencies }) =>
      buildProfile
        ? `${ADAPTER_POLICY}:program-build/2:fresh-volumes:locked-install-fetch${npmDependencies ? ':npm-locked/1' : ''}`
        : ADAPTER_POLICY,
    verifierMounts: ({ buildRoot, buildTask, output, leaseDir, trustedMounts, buildProfile, npmDependencies }) =>
      buildMounts({
        projectRoot: buildRoot,
        projectMode: 'ro',
        taskName: buildTask,
        extra: [{ hostPath: output, containerPath: '/output' }, ...trustedMounts],
        heavyDirs: buildProfile ? ['target', '.oms-cargo', ...(npmDependencies ? ['node_modules'] : [])] : [],
        forbidden: { signerDir: leaseDir },
      }),
    verifierRun: (spec) => ({
      onSpawn: spec.onSpawn,
      taskName: spec.buildTask,
      phase: 'run' as const,
      sourceControlDir: spec.sourceControlDir,
      signal: spec.signal,
      timeoutMs: spec.timeoutMs,
      surfnet: { port: spec.surfnetPort },
      mounts: spec.mounts,
      backend: 'docker' as const,
      argv: spec.argv,
      image: images.image,
      forwarderImage: images.forwarderImage,
      leaseDir: spec.leaseDir,
      ...(spec.buildProfile ? { limits: BUILD_LIMITS } : {}),
      cwd: '/work',
      env: {
        ...(spec.buildProfile ? { CARGO_HOME: '/work/.oms-cargo', CARGO_NET_OFFLINE: 'true' } : {}),
        OMS_OUTPUT_DIR: '/output',
        SOLANA_RPC_URL: spec.rpcUrl,
        SURFNET_RPC_URL: spec.rpcUrl,
      },
    }),

    doctorDetail: () => 'docker (strict sandbox)',
  };
}

/** A missing name is Docker, as every recorded and legacy configuration meant. */
export function executionBackend(name: BackendName | undefined, images?: BackendImages): ExecutionBackend {
  return name === 'host' ? hostBackend(images) : dockerBackend(images);
}

/** The backend an environment selects, with the images it pins. */
export const backendFor = (
  environment: Pick<HarnessEnvironment, 'backend' | 'image' | 'forwarderImage'>,
): ExecutionBackend =>
  executionBackend(environment.backend, { image: environment.image, forwarderImage: environment.forwarderImage });
