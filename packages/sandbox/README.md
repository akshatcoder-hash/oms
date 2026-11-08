# @oms/sandbox

Captured, cancellable Docker execution for model-issued commands. This package is not a PTY, persistent terminal, workflow supervisor or host-shell escape hatch. It uses Node built-ins and `@oms/contract`'s shared source-ownership protocol.

## Execution contract

`runInSandbox` requires:

- A mount plan returned by `buildMounts`. Raw, cloned or modified plans are refused.
- Explicit immutable `image` and `forwarderImage` references: a local `sha256` image ID or `repository@sha256:digest`. Execution uses `--pull=never`; it never downloads a replacement image.
- A private host `leaseDir` outside every sandbox bind.
- The same trusted `sourceControlDir` used by contract capture for the source tree.
- A bounded timeout and container argv. A shell string is allowed only as an argument to a shell **inside** the container.
- For the run phase, the selected local Surfpool port.

The engine provisions the private directories and approved runtime identity. The reviewed image references are in [`../engine/runtime-manifest.json`](../engine/runtime-manifest.json); the Node-only image remains the client default. The opt-in [program toolchain](../../docker/toolchain/README.md) uses a separately pinned local image and build profile.

```ts
import { buildMounts, runInSandbox } from '@oms/sandbox';

// These are host-approved canonical paths and immutable runtime references.
const mounts = buildMounts({
  projectRoot: task.codeRoot,
  taskName: task.id,
  forbidden: { signerDir, stateDir, extra: [agentEnvironmentFile] },
  readOnlyPaths: pinnedVerifierFiles,
  heavyDirs: [],
});

const result = await runInSandbox({
  taskName: task.id,
  phase: 'run',
  argv: ['node', 'verify.mjs'],
  mounts,
  image,
  forwarderImage,
  leaseDir,
  sourceControlDir,
  surfnet: { port: rpcPort },
  timeoutMs: 120_000,
  signal,
});
```

A normal nonzero program exit is returned in `exitCode`. Timeout is 124; cancellation is 130. `timedOut`, `cancelled` and `truncated` remain explicit. Setup, ownership and uncertain-cleanup failures throw; they are not converted to successful cancellation. Output is captured and byte-limited independently for stdout and stderr (1 MiB each by default). An optional trusted `onOutput` callback receives every stream chunk before those limits; a callback error stops the command and is thrown.

The engine uses `onOutput` only when a session opts in with `outputMode: 'head-tail'`. Model and user commands then return the first 32 KiB and last 96 KiB with an omitted-byte marker naming an opaque `read_log` id. The full stream is kept in an owner-only host temporary directory outside every bind, capped at 16 MiB per session, paged at most 16,000 bytes per read, and deleted when the session closes. File tools and verifier evidence keep the default head-only bytes.

## Mount and source authority

`buildMounts` rejects forbidden ancestors, descendants and symlink escapes, missing sources, unsafe read-only overlays and a project that would expose a forbidden host tree. A forbidden directory beneath the project can be shadowed with an empty tmpfs. Do not rely on host file modes alone to hide data exposed through a Docker bind.

The plan retains source and ancestor identities. Execution checks the approved plan before Docker setup, after acquiring source ownership and immediately before creating the command container. Extra writable binds must be disjoint from the project and each other, with private host-owned parents. Read-only verifier overlays may sit inside the project. `projectMode: 'ro'` supports independent verifier trees; a separate approved writable output directory can be mounted explicitly.

Source roots must be absolute normalized canonical admitted paths. They cannot be reauthorized by following a replacement root or ancestor symlink. Internal contained relative input symlinks are a separate contract-capture concern, not permission to mount outside trees.

`@oms/contract` coordinates capture and sandbox operations through a shared private control directory. A sandbox holds exclusive ownership of its project and extra writable sources through **confirmed teardown**. Overlapping ancestor/descendant roots conflict, including operations from another process or another managed project. Capture cannot run beside a managed writer and silently compare a moving tree.

This captured-command API therefore refuses overlapping commands on the same source tree. A future persistent-terminal implementation must define its lifetime and coordination explicitly; it cannot bypass the shared protocol to obtain concurrency.

## Container and network policy

Command containers use a read-only root filesystem, dropped capabilities, no-new-privileges, resource limits, a tmpfs temporary directory and the actual supported non-root host UID/GID. Root or unavailable host identity is refused. No Docker socket, host network, privileged mode or inherited host environment is supplied.

Each execution/phase owns its own internal network and forwarder:

- **Install:** an HTTP/CONNECT proxy permits only configured exact host/port pairs. Lifecycle scripts execute inside the sandbox when the caller explicitly runs them; the initial repository dependency bootstrap uses a separate scripts-disabled policy.
- **Run:** a single-port forwarder exposes the selected task Surfpool endpoint, not arbitrary host services or general internet egress.

On native Linux Docker, `host.docker.internal` resolves to the bridge gateway, which cannot reach services bound to `127.0.0.1`. There the forwarder reaches `host.docker.internal:<port>` targets (the run-phase Surfpool port and allowlisted install entries) through a trusted host relay: one Unix socket per approved port, under an owner-only temporary directory, bind-mounted read-only into that execution's forwarder only. The relay connects each socket to its fixed `127.0.0.1` port and is removed at teardown. No host listener is added beyond loopback. Other platforms keep the host-gateway route.

The forwarder also uses an explicitly pinned image. Docker does not provide a domain allowlist by itself; the forwarder is part of the boundary, not a performance optimization.

## Persistent volumes and cleanup

Heavy directories can use named volumes. Ownership is parsed from Docker's structured metadata and requires both the sandbox component and task labels. A matching name alone is not ownership. Existing owned data persists across calls; foreign resources and inspection uncertainty are refused.

Install takes an exclusive dependency-volume lease; run consumers take shared leases. Volume-root UID/GID initialization is a bounded owned helper, not recursive world-writable permissions. `node_modules` is read-only during run; writable build outputs remain an explicit policy choice.

Cancellation covers setup and execution. Teardown removes only resources owned by that execution. Setup rollback never dismantles another live execution's network. The command result is not returned until cleanup is confirmed. Any uncertainty retains the applicable source/volume leases and reports an error requiring operator recovery.

`removeTaskResources(taskName)` is an explicit host cleanup operation for resources carrying the required component/task ownership. It refuses foreign metadata and lookup failures rather than treating them as an empty successful cleanup. Do not remove lease records merely because their timestamps are old. Stop and inspect all possible writers before any manual recovery.

## Verification and limits

```sh
npm run test --workspace @oms/sandbox
npm run typecheck --workspace @oms/sandbox
```

The suite covers mount approval, source substitution, lease contention, partial setup, cancellation, volume persistence and real local Docker network/mount behavior. Real integration prerequisites and skipped cases must be reported; test names or mocked Docker responses do not establish a host-platform guarantee.

The current local integration work uses macOS arm64 and OrbStack Docker. Native Linux Docker 29 (Ubuntu 24.04 x64) passes the integration file with the host relay. IPv6 registry behavior, sustained concurrency and the later user-load cohorts have not been established by this preview. Public package registries are not stress-tested.

Excluded adversaries: a malicious Docker daemon/kernel or hostile same-UID host code. The protocol excludes **managed writers using the shared control directory**; it is not a native descriptor-relative filesystem sandbox or protection against arbitrary host code bypassing that protocol.
