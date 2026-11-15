# @oms/surfnet

Surfpool lifecycle for OMS: spawn, rewind to start, cancellation and error normalization. The Harness owns an exploratory instance; independent verification starts a fresh instance against saved inputs rather than reusing mutable exploration state. Uses the Surfpool 1.7.0 binary over JSON-RPC; no MCP or new npm dependencies.

## Usage

```ts
import { createSurfnet } from '@oms/surfnet';

const surf = createSurfnet({
  binary: '~/.local/bin/surfpool',   // default
  snapshot: 'fixtures/base.json',    // optional --snapshot preload
  workDir: '/abs/path/task-work',    // the log file lands here
  logFile: '/abs/path/surfnet.log',  // optional, default <workDir>/surfnet.log
  signal: controller.signal,        // cancellation covers startup and the live child
  onExit: (info) => { /* the surfnet died; engine reacts */ },
});

await surf.start();
surf.mode;                 // always 'offline-snapshot'

await surf.rpc.call('getAccountInfo', [addr]);         // reads run immediately
await surf.rpc.call('sendTransaction', [wire, {        // writes are serialized
  encoding: 'base64',
  preflightCommitment: 'confirmed',                    // REQUIRED (see quirks)
}]);

await surf.rewindToStart();                  // restart from the startup snapshot, same ports
await surf.health();                          // {ok: true}
await surf.stop();                            // SIGTERM, then SIGKILL after 2s
```

## Model

- **Rewind is restart**: `rewindToStart()` stops the child and starts a fresh
  one on the same ports from the original startup snapshot (or empty, when
  there was none). This restores everything `surfnet_setAccount` cannot:
  account deletions, slot/chain height, blockhashes, deployed programs,
  history. Everything done since `start()` is lost.
- **One writer** : state-changing calls —
  `sendTransaction`, every mutating `surfnet_*` cheatcode — are serialized
  through a FIFO queue per surfnet. Reads never queue. Unknown `surfnet_*`
  methods are treated as writes (fail safe).
- **Owned shutdown:** normal stop/cancellation waits for the child, with bounded SIGTERM/SIGKILL escalation. A process-exit hook is a best-effort additional guard, not proof that arbitrary host crashes or SIGKILL cannot orphan a child.
- **Ports**: `findFreePortPair` bind-tests an even/odd pair on 127.0.0.1 and
  reserves it in-process so concurrent managers do not collide.
- **`mode`** is exposed so the evaluator can label evidence. A surfnet is
  always `'offline-snapshot'` (reproducible).
- The child runs `surfpool start --ci --no-tui --offline --port <rpc>
  --ws-port <ws> --airdrop-amount 0 [--snapshot <file>]` with `NO_DNA=1`.
  `--airdrop-amount 0` keeps surfpool away from the default
  `~/.config/solana/id.json`; oms never reads real keypairs. Readiness is
  polled `getHealth` → `"ok"` (30s timeout); on failure the child's last
  stderr/stdout lines are included in the error.

Lifecycle changes are queued. A rewind checks the startup snapshot's bytes against their recorded digest before restarting; it refuses a changed snapshot instead of silently loading new state. Missing/non-executable binaries are refused before a healthy instance is returned. Failed startup releases allocated ports; an aborted manager cannot restart.

## Verified against Surfpool 1.7.0 (by probing a real offline surfnet)

- Start command, `getHealth` → `"ok"`, `--snapshot` reload from a snapshot
  file, `surfnet_exportSnapshot`, `surfnet_setAccount`.
- **Snapshot file format**: write the bare account map (`result.value` of
  `surfnet_exportSnapshot`), not the full `{context, value}` envelope.
- **`sendTransaction` requires `preflightCommitment: "confirmed"`** on an
  offline surfnet. Without it, surfpool rejects with a bogus
  `BlockhashNotFound` even for a valid, freshly fetched blockhash. With it,
  a hand-rolled signed transfer lands with the exact lamport delta.
- `surfnet_setAccount` `data` is **hex** (`"0102"` → bytes `0x01 0x02`), and a
  missing `data`/`owner` is silently defaulted (not an error) on 1.7.0.
- Error fixtures (unit-tested in `test/normalize.test.ts`):
  `AccountNotFound` ("no record of a prior credit", unfunded fee payer),
  `BlockhashNotFound`, `InsufficientFundsForRent` (object-form `err`),
  `InvalidProgramForExecution` (program not deployed), `-32602` invalid
  pubkey/params, `-32601` method not found, serde `missing field \`scope\``
  (triggered by `surfnet_exportSnapshot` with missing params).

## UNVERIFIED

- **`missing field data` trigger.** Issue #350's `missing field data` panic is
  fixed on 1.7.0: `surfnet_setAccount` accepts a missing `data` and defaults it
  (verified by probing). The mapping is kept in `normalize.ts` by string match
  for the serde `missing field *` family; the exact 1.7.0 call that emits the
  literal `missing field \`data\`` text could not be reproduced. The family is
  proven reachable via `missing field \`scope\``.
- **WebSocket port.** The ws port is allocated and passed to the child but
  unused by this package; subscription flows are out of scope for v1 manager.
- **Cross-process port race.** Two managers in different processes could
  bind-test free and then race to spawn; the loser's child exits with a bind
  error and `start()` throws with the child's log tail. Retrying `start()` on
  failure is the caller's escape hatch (ports are re-probed).

## Tests

```
npm test         # unit (no surfpool needed) + integration (skips if binary missing)
npm run typecheck
```

Integration tests spawn real offline surfnets on random ports, use only
throwaway in-memory keys, and end with a `ps` assertion that no surfpool
process remains.
