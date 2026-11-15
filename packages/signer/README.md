# @oms/signer

A separate, development-only signing process. It signs transactions for an issued alias under a trusted devnet or live OMS-owned local profile. It does not import keys, choose a network from a request, broadcast transactions, or accept caller-reported settlement.

The local Harness preview does **not** expose this signer or workspace credential access.

## Supported authority

- `generateSignerKeypair({signerDir, alias, profile})` creates a dedicated identity and private issuance record. It returns alias, public address and profile ID, never private bytes.
- `startSignerServer({signerDir, alias, socketDir, config})` loads only an issued alias. A copied/replaced key, arbitrary keypair path, existing wallet import or legacy configuration is refused.
- Devnet profiles are user-approved endpoint/genesis records. The fixed devnet genesis is exported as `DEVNET_GENESIS_HASH`; RPC identity and recent transaction lifetime are checked before signing.
- Local profiles come from `launchLocalProfile({executable,args,endpoint,genesisHash})`, a trusted host supervisor. They require that actual child to remain live in the same process. A PID or serialized JSON record cannot recreate the capability.
- Mainnet, testnet, durable-nonce lifetimes and the old confirmation/stub-drift path are unsupported. There is no force-mainnet switch.

A Solana keypair is cluster-agnostic. These are restrictions on OMS use of a dedicated development identity, not a cryptographic property of the bytes or proof that a user can never fund the address elsewhere.

## CLI

Run from the repository root after installing the locked workspace dependencies:

```sh
node packages/signer/src/cli.ts init /absolute/private/signer-store development /absolute/private/devnet-profile.json
node packages/signer/src/cli.ts /absolute/private/signer-config.json
```

These are explicit user actions, not workspace-open side effects. The profile and startup JSON files must be owned private regular files; directories are private and symlink/ownership checks fail closed. JSON paths are actual paths, not shell-expanded `~` strings.

A standalone devnet profile has these fields:

```json
{
  "kind": "devnet",
  "endpoint": "https://api.devnet.solana.com",
  "genesisHash": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "authorization": "user-approved"
}
```

Use the startup shape in [config.example.json](config.example.json): `signerDir`, `alias`, `socketDir`, and policy under `config`. The CLI rejects host-only test hooks and old arbitrary-key configuration. It cannot reconstruct a live local process profile from JSON.

Profile/key files are local plaintext protected by filesystem permissions and process isolation. No encrypted-at-rest or protection-from-hostile-same-user-code claim is made. Do not place them in agent-controlled code or mounts.

## Protocol v2

The private Unix-socket channels use separate bearer tokens. Both expose the restricted development protocol; neither accepts mainnet confirmation or a claimed transaction outcome.

| Request | Fields beyond optional `reqId` | Result |
|---|---|---|
| `hello` / `status` | none | Public signer/profile/capability and spend metadata |
| `lifetime` | none | Recent lifetime obtained from the authorized endpoint |
| `sign` | `transaction` | Validated signature and durable reservation metadata |
| `reconcile` | `reservationId` | Outcome derived from the trusted RPC, never caller assertion |

Unknown fields, including caller cluster, endpoint, profile, confirmation or settlement claims, are refused. Requests do not carry signer authentication tokens as model-visible tool arguments; token files and sockets remain outside sandbox mounts.

Node does not expose kernel peer credentials for these sockets. Possession of the appropriate bearer token is the authority; hostile same-UID host code is outside this boundary. Returning a signature is a capability: a caller with unsigned bytes can attach and broadcast it. Endpoint/lifetime policy is therefore enforced before the signature exists, not delegated to normal engine behavior.

## Fees, identity and outcomes

The signer rejects pre-signed/unsupported multisigner and lookup-table forms. Programs/accounts must satisfy the configured allowlists. Exact message-byte SHA-256 is the reservation identity, including account privileges and lifetime. An identical retry reuses its existing reservation/signature instead of creating a second charge.

Priority-fee arithmetic uses integers. A full estimated or trusted quoted fee exceeding the ceiling is rejected, not clipped. Nonzero CU pricing requires an explicit supported CU limit. Base/priority fees participate in per-transaction and cumulative admission.

Outflow decoding is intentionally narrow: direct System transfers/account creation are understood. Allowed custom-program CPI effects are not a universal wallet-loss bound. Choose program/account allowlists accordingly; do not fund these identities for production.

The journal is fixed to `<signerDir>/<alias>.spend.journal`. Reservation metadata is fsynced before signing and signature/lifetime/profile metadata before the response leaves the process. Unknown outcomes remain charged across crashes and restart. There is no time-based refund or model-facing release/settle request.

Absence requires retained finalized history through a coherent endpoint whose observed block height is past expiry. Missing/pruned/inconsistent RPC responses remain unknown. Later trusted confirmation can restore a charge previously classified absent; this is recovery accounting, not permission to rely on inconsistent absence evidence.

## Ownership and startup recovery

Ledger acquisition, stale-owner recovery and release use one exclusive gate and a complete token/host/boot/PID/start owner record. Competing recovery cannot unlink another writer's replacement. A crashed or unverifiable `.lock.gate` is **not** automatically expired or stolen: inspect the owner and all processes before any manual recovery. Deleting a journal/lock to reset a cap is never an ordinary restart operation.

Socket startup is transactional. Dispatch is inactive until both listeners are ready. Listeners bind private owned paths and publish public hardlinks; cleanup checks exact artifact identities. A second-socket/token/startup failure unwinds acquired listeners, accepted connections and ledger ownership, preserving foreign replacements. Crash-recovery manifests are operational ownership records, not model authority.

## Verification

```sh
npm test --workspace @oms/signer
npm run typecheck --workspace @oms/signer
```

Tests use disposable generated identities, controlled loopback RPC, actual Unix sockets and subprocess crash/restart cases. They cover network/lifetime spoofing, copied keys/legacy imports, fee/header identity, replay, unknown outcomes, incoherent finalized history, concurrent stale recovery, foreign artifacts, partial startup and planted output leaks. No test result establishes live mainnet safety or power-loss durability on every filesystem.

The initial findings and later explicitly authorized remediation are recorded in the project `temp/` security report. Passing component tests do not replace the final integrated product and report-only security gates.
