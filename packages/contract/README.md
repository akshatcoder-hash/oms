# @oms/contract

Task requirements, pinning, evidence, input capture and evaluator transitions. The generator can propose completion; trusted evaluation decides closure. The package uses Node built-ins and native TypeScript/ESM.

## Separate state and code roots

Every task interface receives explicit roots:

```ts
interface TaskRoots {
  workspaceRoot: string;
  stateRoot: string;
  codeRoot: string;
  sourceControlDir?: string;
}
```

Production places the contract at `<workspace>/.oms/tasks/<task-id>/task.json`, code in `<workspace>/.oms/worktrees/<task-id>`, and its pin/cache/trusted runtime state outside the repository. `contractPath` is relative to stateRoot; verifier/code/snapshot paths resolve inside codeRoot. The pin schema is `oms.pin/1` and records canonical roots. Switching roots or placing a pin inside workspace/state/code storage is refused.

`codeRoot` and source-access roots must already be absolute, normalized, canonical admitted paths. Workspace discovery provides them. Acquisition retains that original pathname, binds root/ancestor identities and rejects replacement symlinks; it never follows a new realpath destination as fresh authorization. Root/ancestor symlinks are refused, while contained relative symlinks *inside* a stable code root remain supported.

These are clean-cutover interfaces. There is no legacy `root` option or generator-controlled absolute state path.

## Public operations

- `pinContract({...roots, contractPath, verifierPaths, evaluatorConfig, pinFile})` records admitted authority.
- `verifyPin(pinFile, roots)` and `refreshPin(pinFile, roots)` validate/re-pin allowed host transitions.
- `createContractStore({...roots,pinFile})` is the trusted writer; `activate` chooses one item.
- `createProposer({...roots,pinFile})` exposes only `read` and `propose` to the generator.
- `createEvaluator({...roots,pinFile,runner,cache?,clock?,maxReopen?})` evaluates proposals and exposes user-level reopen.
- `createVerifierCache({path?,projectRoot?})` is memory-backed or file-backed outside the model's write surface.

Requirements/config parsing rejects unknown fields and invalid transitions. Raw account token expectations are unsigned integer **atoms**, not decimal display-token strings. Description-only transaction conditions are not machine proof; the engine runner refuses them.

Proposer/evaluator reads return a `ContractView`: historical closed evidence appears `stale` after relevant code/config/runtime changes. The persisted `TaskContract` is not silently rewritten by a read. Reverification requires an explicit reopen/proposal transition.

## Evidence identity

Evidence carries:

- item ID and `specificationDigest = digestJson({id, done, evaluatorConfig})`;
- actual code, verifier and snapshot digests;
- observed offline/forked mode, pass/fail, timestamp and human-readable details.

Cache identity uses the immutable specification plus code/verifier/snapshot identities. Mutable status/reopen fields are excluded, so legitimate same-requirement reuse works. A changed requirement, another item, changed runtime or new source file cannot reuse an unrelated pass. EvaluatorConfig requires `executionIdentity`; the real engine runner exposes actual adapter metadata, checked before cache lookup. `testTimeoutMs` is pinned configuration.

Details/stdout/model narration are not treated as proof. An injected library runner is trusted host code, not a cryptographic attestation. Real runner authenticity still depends on actual isolation, immutable runtime configuration, complete admitted verifier authority and appropriate user-authored checks.

The explicit `verifierPaths` list is authority: include the verification bootstrap and dependencies that the generator must not modify. For example, a package-script verifier needs its controlling manifest/script pinned as well as its test files. Complete code membership hashing detects revisions; it does not automatically turn arbitrary application files into trusted verifier authority or prove arbitrary test code is uncheatable.

## Input capture and source ownership

All code-root membership participates, including new/untracked files, manifests, directories, modes and contained relative symlinks. Root `.git` is excluded from saved execution inputs. `codePaths` validates required named inputs; it is not an exclusion list that hides added files. Snapshot identity is the actual raw-byte SHA-256, or the explicit `EMPTY_SNAPSHOT_DIGEST` for an empty offline ledger.

| Refusal limit | Bound |
|---|---:|
| Code bytes | 256 MiB |
| Input entries | 100,000 |
| Snapshot bytes | 64 MiB |

`saveCodeInputs`, `digestCodeInputs`, `snapshotDigest` and `digestFiles` accept source-access options. Every production controller and sandbox operation must use the same trusted sourceControlDir. `acquireSourceAccess(root,{kind,sourceControlDir?})` excludes overlapping managed source roots across processes. `withSourceAccess(root, callback, options?)` permits synchronous trusted nested capture only.

Reads use non-following/nonblocking descriptors, opened-object identity/type/size checks, bounded reads and directory identity checks. The primary concurrency guarantee is exclusion of managed sandbox writers during capture; this is not a claim of native descriptor-anchored traversal on macOS or protection from hostile same-UID host code. Linux/macOS trusted controllers must respect the shared source ownership protocol.

Saved inputs are copied independently, then executed read-only by the engine backend with fresh external writable output. Original/saved inputs and pins are checked again after awaited execution before accepting/cache-committing evidence. A pass from a fork cannot close an item.

## Failure and recovery

Failed runs reopen an item and eventually block at the configured cap; changed/unreadable/invalid/unbound state never closes. A stale or unreadable view cannot take the engine settle gate's ordinary-chat shortcut.

Source-control ownership survives uncertain/crashed writers. Published `<sourceControlDir>/<sha256(canonical-source)>.json` records are never time-expired or stolen automatically. Recover only after independently stopping and inspecting every relevant writer; `.pending-*` files are unpublished acquisition scratch, not evidence of an active writer. Cache corruption can cause a rerun but cannot reset requirements, spend or trust state.

The application owns the external task mutation lease and serializes contract/pin changes. Individual atomic files do not form a cross-file power-loss transaction. Do not treat these local filesystem guarantees as power-loss proof on every filesystem or a defense against arbitrary trusted host modifications.

## Verification

```sh
npm test --workspace @oms/contract
npm run typecheck --workspace @oms/contract
```

Regression cases exercise real temporary files/subprocess completion commands, cross-item and changed-requirement cache reuse, new/imported inputs, stale closures, runtime mismatch, snapshot substitution, bounded capture, symlink/FIFO replacement, root/ancestor substitution before capture and cross-process source exclusion. A deterministic evaluator barrier covers substitution after initial pin verification. Engine tests add actual Docker + offline Surfpool execution; unit fixtures alone do not establish chain or sandbox proof.
