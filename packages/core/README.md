# @oms/core

Deterministic budget, settle, trace and redaction primitives. No agent-runtime SDK, network client or ambient clock. Trace writing uses an explicit host path; durable budget persistence is supplied by the caller. No npm dependencies.

```sh
npm run test --workspace @oms/core
npm run typecheck --workspace @oms/core
```

The workspace uses native TypeScript execution and requires Node >=22.19.0. Test counts are run receipts, not a stable API contract.

## Ownership

| Module | Responsibility |
| --- | --- |
| `src/budget/ledger.ts` | Durable-before-admission dispatch reservations, usage receipts and replay |
| `src/budget/meter.ts` | Budget caps, snapshots and formatters |
| `src/trace/trace.ts` | Redacted append-only JSONL, strict sequence validation and replay |
| `src/redact/secrets.ts` | Known-secret textual and structured-byte redaction |
| `src/settle/gate.ts` | Pure verifier/budget/repeated-failure continuation decision |

Exports are in `src/index.ts`. The production Harness is assembled by `@oms/engine`; these primitives do not launch providers, stop containers or grant signing authority.

## Durable dispatch accounting

`createBudgetLedger({ caps, clock, startedAt?, events?, persist })` owns a single-writer journal projection:

1. `budget_open` binds the original caps and start time.
2. `reserve({ dispatchId, logicalTurnId, attempt, tokens, spendMicroUsd })` requires trustworthy nonnegative integer bounds. Unknown bounds are refused.
3. `persist(event)` must synchronously append and fsync, or throw. Admission does not occur before persistence succeeds.
4. The provider adapter sends the request only after a fresh successful admission. A duplicate reservation is **not permission to dispatch again**.
5. `settle({ dispatchId, receiptId, outcome, tokens, spendMicroUsd })` applies an idempotent trusted receipt. `known` needs complete final usage; `not_dispatched` needs zero usage and evidence that no request was sent.
6. `uncertain` retains the reservation or greater observed amount and blocks further admission. Time passing, cancellation and process restart do not refund unknown usage.

Snapshots distinguish `known`, `pending` and `unknown` accounting and expose pending dispatch IDs. Replay restores reservations, settled receipts and elapsed wall time; it cannot reset caps/start time or silently forgive an unfinished dispatch. The caller must reject malformed or torn input journals and enforce one writer. The engine's task lease and private journal adapter provide those integration responsibilities.

Money is integer micro-USD; token counts are nonnegative safe integers. The reservation ledger is the only budget source. It does not guarantee a provider's future invoice: catalog pricing, unsupported billing features and external traffic remain outside this primitive.

## Trace continuity and redaction

The writer validates the existing sequence before appending and continues from the last complete valid record. An unterminated final record, corrupt data or inconsistent sequence refuses append without rewriting history. A failed or uncertain write poisons that writer; the next call does not pretend the previous event was durable. Sequence/type/time metadata cannot be overwritten by event payload fields.

Redaction runs before serialization. A throwing or invalid redactor writes nothing and returns an error. Known-secret matching covers textual encodings and structured forms: numeric arrays, `Uint8Array`, `Buffer`, serialized Buffer objects and numeric-key objects. Shared nonsecret object branches remain usable. This is known-corpus redaction, not general secret discovery or a substitute for keeping keys out of model/tool processes.

The reader can describe corrupt/torn records for operator inspection; that diagnostic capability is not permission for the writer to repair or truncate them automatically.

## Settle

The settle gate allows completion only on a passing verifier. Running/unavailable verification, repeated identical failures, exhausted budgets, attempt limits and malformed state stop continuation. The engine adapter supplies current verifier state, failure identities and budget snapshots. Feedback, custom-message content and errors pass through its injected redactor; redaction failure stops continuation without a raw fallback.

## Limits

- Default caps (2,000,000 tokens, $5, 30 minutes) are defaults, not measured capacity or cost guarantees.
- Controlled provider tests establish state transitions and accounting invariants, not external cache efficiency or billing accuracy.
- Performance and 100/1,000/10,000 simulated-user cohorts are separate pending gates.
