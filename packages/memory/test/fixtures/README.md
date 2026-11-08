`normalization-real.json` contains exact diagnostic lines from existing dev-run tool results, not synthetic diagnostics or evidence of verifier closure. The task ids are `vault-pda-family` and `spl-multisig-ix`.

Each entry records the SHA-256 of the original run-record bytes, transcript bytes and exact extracted diagnostic string. `eventLine` is a one-based transcript JSONL line; `contentIndex` and `diagnosticLine` are zero-based indexes into `message.content` and its text lines. Each original record identifies its transcript. Tests check the committed excerpt hash offline. Source record/transcript hashes and locations were independently checked at capture time; tests do not depend on those external files remaining present.

The fixture intentionally excludes full transcripts, source/diffs, credentials and owner-specific absolute paths. Normalization coverage is separate from the capture authority tests: command output cannot establish a trusted failed-verifier history.
