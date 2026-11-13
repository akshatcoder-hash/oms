# @oms/engine — task runtime

The engine assembles persistent agent sessions, guarded tools, offline verification, accounting and task ownership. The CLI selects a registered repository/task and owns its OMS-specific interface. UI layout changes consume the same live runtime; they do not create a second model/session or change its authority.

## Module boundaries

| Surface | Owner |
| --- | --- |
| `src/workspace/` | Repository/common-dir identity, ignore disposition, managed Git worktrees, external registry and mutation leases |
| `src/runtime/session.ts` | One live task/session owner, fixed capabilities, persistence, verifier composition and authoritative shutdown |
| `../cli/src/interactive.ts` / `../cli/src/tui/` | OMS-owned product interface and application lifetime |
| `src/runtime/provider-controls.ts` / `settings-controls.ts` | Operator controls over canonical model/auth/session settings; private persistence and immutable execution policy |
| `src/runtime/sandbox-tools.ts` | Sandbox-backed model read/edit/write/bash operations |
| `src/runtime/task-files.ts` | Shared fixed `/work` file helper, exact UTF-8 bytes and revision-checked saves |
| `src/runtime/verifier-backend.ts` | Fresh immutable input execution, private output, observed offline Surfpool identity and teardown |
| `src/runtime/usage.ts` | Before-dispatch admission, conservative provider normalization and fsynced budget journal |
| `src/runtime/environment.ts` | Checked runtime-manifest selection; no implicit downloads |
| `src/runtime/knowledge.ts` | Compact version-pinned static Solana/Helius reference prefix, not an executable loader |
| `src/oms-extension.ts` and adjacent factories | Protected-path guard, `propose_done`, trace/settle behavior and composition |
| `src/verifier.ts` | Contract runner adapter: actual commands/account observations, snapshot and runtime identities |

## Repository, task and session are different objects

- `openWorkspace(repository, { stateRoot?, initialize? })` discovers a canonical Git repository and common directory. Initial creation requires explicit `gitignore`, `exclude` or `require-existing` disposition. A copied identity or moved repository is not silently adopted.
- `createTask(workspace, { baseOid, id? })` requires a full local immutable commit OID. It records creation before mutating Git and creates an OMS-owned branch/worktree without changing the primary checkout. Failed or uncertain creation is retained for inspection, not force-cleaned.
- `prepareHarnessTask` writes explicit user requirements once and pins their verifier/config/runtime authority outside the repository. The model has no requirements-replacement primitive.
- `createHarnessSession` holds the task mutation lease for its full lifetime. Resume selects an exact session belonging to that task, restores its conversation and reopens its original accounting; it does not reset the budget.

Repository storage:

```text
<repository>/.oms/
  workspace.json
  tasks/<task>/record.json
  tasks/<task>/task.json
  worktrees/<task>/
```

Trusted user storage, defaulting to `~/.oms` and always outside repository/worktrees:

```text
<state-root>/agent/auth.json
<state-root>/agent/settings.json
<state-root>/workspaces/<workspace>/workspace.json
<state-root>/workspaces/<workspace>/source-control/
<state-root>/workspaces/<workspace>/tasks/<task>/
  pin.json
  mutation.lease
  verifier-cache.json
  runtime/
  sandbox-leases/
<state-root>/workspaces/<workspace>/sessions/<task>/
  <conversation JSONL>
  <session-id>.budget.jsonl
  <session-id>.trace.jsonl
```

Provider discovery and interactive authentication delegate to the installed runtime's `ModelRuntime`; model changes use `AgentSession.setModel(..., { persist: true })`. `SettingsManager.fromStorage` retains its schema and write queue while enforcing private OMS storage. Project/global host settings are not imported. Thinking, queue and HTTP-idle controls apply to the same session; compaction, warming, retries, executable discovery and other unmetered paths remain policy-disabled. Optional fusion must compose above these controls rather than replace their provider/auth/settings implementation.

Optional `.oms/.env.agent` and `.oms/.keys` have reserved product meanings but are **not exposed by this preview**. Their future broker/key-creation UI needs the separate C01/C02 gates. Worktree cleanup is not implemented or run automatically.

## Tool and filesystem boundary

The active model tools are sandbox-backed `read`, `edit`, `write`, `bash`, plus `propose_done` and read-only `task_status`. The upstream SDK's unsandboxed built-in tools are disabled. File operations and shell commands use `/work`, not host project paths. User `!`/`!!` shell escapes are intercepted by the same sandbox operations.

File operations accept bounded regular UTF-8 text (64 KiB), enforce containment and reject lexical private/control paths. A canonical directory-alias bypass of the private-name policy is a known open limitation. This does not establish access to unmounted host credentials. Edits use ordinary revision checks and atomic writes, not a universal hostile-writer CAS. The Harness shell is captured POSIX `/bin/sh`; the separate no-model workbench experiment supplies a real PTY.

Only the selected task worktree is writable. Pinned verifier files and the worktree's `.git` control file are read-only; the host Git common directory is not mounted. The control file can contain a host pathname, but that does not make its target accessible inside the container. Signer directories, user state and optional agent environment data are excluded/shadowed by mount policy. No host environment is inherited.

Capture and managed writers share one private source-control directory. Approved bind identity is revalidated; capture uses the original canonical admitted root and cannot silently follow a replacement root/ancestor. Ownership remains until teardown is confirmed. Overlapping captured commands are refused rather than racing over shared inputs.

## Verification boundary

`createVerifierBackend` binds execution identity to actual Surfpool binary bytes, immutable images and policy. It loads a private verified snapshot copy into a fresh offline Surfpool and runs tests against the saved code tree mounted read-only. A separate private `/output` is writable. Test environments expose `SOLANA_RPC_URL`, `SURFNET_RPC_URL` (the same URL, as in agent commands) and `OMS_OUTPUT_DIR`.

Evidence/cache identity includes the immutable item specification and evaluator configuration as well as code/verifier/snapshot digests. Complete code membership participates, not just a hand-maintained import list. Source changes after closure expose `stale`; changes during verification refuse closure. Tests failing, unreadable state, missing snapshots and runtime mismatches remain failures. This establishes input binding, not that arbitrary user-authored tests cannot be cheated or are a complete product specification.

## Provider and budget boundary

Default model authentication/catalog availability is initialized locally before selection/resume, with network catalog access disabled. The Harness uses its own private auth file and supported environment keys; it does not import another assistant's credential store. Opening the UI sends no model request.

`createProviderControls()` owns local non-secret catalog metadata and operator model/auth mutations. Eligibility shares `modelReservationBound()` with metered admission; catalog support does not guarantee a model fits the remaining cap. `selectModel()` uses the existing session setter. `connectProvider()` accepts a validated literal; `loginProvider()` drives a supported SDK `AuthInteraction` with combined cancellation. Credential objects/error causes never enter the transcript.

Provider setup distinguishes API keys from Codex OAuth, masks callback codes and leaves browser opening/consent to the user. Claude subscription login is refused under Anthropic's third-party policy; no other CLI's credentials are imported. Setup persists through the locked private store, with explicit uncertainty on partial failure. Saving a key sends no inference or online-validation request; OAuth sign-in necessarily contacts its provider. Supported flows and restrictions are in [README](../../README.md#one-application-two-views).

The actual stream function is wrapped **before dispatch**. Extension-hook errors can be swallowed, so hooks are not the accounting authority. The wrapper reserves full context capacity at conservative catalog rates plus the explicit output cap. Large-context models can be refused even for a short prompt under a small budget. Unknown prices/APIs are refused; this is not an invoice guarantee.

Supported metered APIs: `anthropic-messages`, `openai-completions`, `openai-responses` and `openai-codex-responses`. SSE, zero hidden retries and one HTTP request per dispatch constrain the path. Codex's adapter ignores a local output cap, so admission reserves full catalog output capacity; catalog-equivalent spend is not subscription billing. Warming, compaction, summaries and unsupported hosted/premium/fallback paths are disabled or refused. Missing/error/abort/lost usage stays charged/unknown across restart.

No live-provider cost/cache-rate measurement has been made. Input/cache partitions are normalized without counting reasoning/cache subfields twice; synthetic responses do not establish provider caching. Cache-hit metrics remain unknown without the required producer semantics.

## Resource loading and lifecycle

Only fixed OMS extensions are loaded. Executable/context/prompt discovery is disabled, settings are untrusted and append sources are empty. A repository symlink must not cause host prompt reads.

The reviewed `OMS_REFERENCE_PREFIX` is composed once from static application data. Its upstream source revisions and MIT notices are retained; examples are curated against the task's actual pinned API/transaction format, not used as an automatic dependency migration. No MCP/account/trading/setup capability is granted. This is ordinary provider prompt context within existing metering, not a free/unmetered model call. It stays identical across UI changes and reload within a release; a changed pack/app version may change provider prefix-cache identity.

The controller owns `files`, `startTerminal()`, `verify()` and `runCommand()` alongside the live agent. A bounded queue serializes fixed file/helper execution; when a terminal runs, those operations use its existing container rather than obtaining competing source binds. The raw `TaskTerminal` contract exposes write/resize/awaited output subscription/exit/close; no UI or xterm code lives in engine.

An interactive terminal holds source exclusion until confirmed teardown. Full verification and model proposals fail with a stop-terminal instruction before pin mutation; the public evaluator is guarded too. Verification never pauses or kills the user's shell implicitly. The terminal deadline follows the remaining session wall budget, not the old experiment timeout. Agent and `/run` commands keep the 60-second default when no timeout is requested, forward a requested timeout as given, and clamp it only to the remaining wall budget, refusing an exhausted budget before execution. Hidden views retain output parsing with bounded backpressure.

Runtime disposal remains authoritative and idempotent. It aborts/joins terminal, helpers, agent and backend cleanup before releasing ownership; uncertainty retains the lease. Harness and Workbench are presentation states of this same runtime. The CLI owns dirty-confirmation, focus, buffers and signal-driven application shutdown; neither view launches another agent.

The CLI's ownership gate inspects exact task-lease identity before creating a runtime. Duplicate launches offer cancel/retry and a separately confirmed graceful stop. The stop helper revalidates nonce, PID, UID, host, boot and start identity, sends only SIGTERM and waits boundedly for the owner to release its lease. It never interprets process exit alone as verified cleanup or force-removes a stale record.

The local entrypoint (bare `oms`, or `npm start` in a checkout) owns a persistent starter repository and separate private state under `~/.oms/starter`. Atomic ready metadata points to a real SDK session header and a real budget journal. Repeat launch resumes usable accounting; missing, pending, exhausted or unreadable accounting requires explicit new-session consent, leaving previous history and journals intact. Starter Git initialization/commit reuse the existing ambient-configuration isolation.

Known post-exit output limitation: control-bearing admitted paths are shell-quoted but not terminal-encoded in the printed resume command (`OMS-UI-SEC-02`). Both new findings are report-only pending separate user authorization.

## Verification

```sh
# Use the approved locally cached image for both command and forwarder.
export SURFPOOL_BINARY="$PWD/.tmp/tools/surfpool"
export OMS_SANDBOX_IMAGE='node@sha256:fd4a97c1630a4a0a70117dd7b393e322db316d0489bdf36a0e776e7b235341b0'
export OMS_SANDBOX_FORWARDER_IMAGE="$OMS_SANDBOX_IMAGE"
npm run test --workspace @oms/engine
npm run typecheck --workspace @oms/engine
```

The digest above is the reviewed arm64 image; consult the manifest for x64. Integration uses real Git, Docker, Surfpool and the actual session API with controlled provider responses. It proves sandbox edits, offline closure, primary-checkout isolation, resource-discovery refusal, state/accounting resume and owned cleanup. It does not establish live-model quality, cost or latency.

Existing extension-contract tests remain useful. Continuation requires real feedback plus a bounded gate. Adapters use the pinned SDK's public types and observed behavior rather than guessed hooks.

Remaining gates: user walkthrough, advanced editor features, workflow/port management, optional workspace credential/signing UI, Rust/Anchor image, platform receipts, mandatory integration CI and bounded user-load cohorts.
