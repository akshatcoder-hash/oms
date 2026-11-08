# Project toolchain checks

`oms toolchain check --project /path/to/project` reads manifests, Cargo locks and client source without running project code. JSON output includes the compatibility-table version, dated source URLs, resolved/direct crate inventory, and findings. Exit 1 means a warning was found; duplicate Solana versions are informational because healthy dependency graphs can legitimately contain them. No findings means no known mismatch, not a successful build.

`oms toolchain fix --project /path/to/task` prints exact before/after file proposals and command argument arrays. `--apply` writes those edits only in the selected linked Git worktree, after checking every preimage and refusing symlinked edit targets. Commands are proposed, not executed by `--apply`. Dependency updates and client import changes can require additional source migration. Lockfile entries are never deleted by hand; regenerate locks using the proposed package-manager commands in the pinned image, review them, and use the existing restricted `deps_fetch` path.

`oms toolchain fix --project /path/to/task --apply --verify` additionally attempts a fresh isolated build and test using the configured immutable toolchain image, the existing allowlisted locked Cargo fetch, and offline Surfpool. Configure the image with `OMS_TOOLCHAIN_IMAGE` or run `scripts/build-toolchain.sh`, which writes a host-local `.tmp/toolchain/image.json` receipt. The committed `runtime-manifest.json` records tool versions; it does not supply a host-local image ID. Verification never edits task requirements or closes work. A `build and tests passed` receipt identifies the image and both exit codes. Missing infrastructure, stale locks, test failure or unsupported setup yields `proposed, not verified` and exit 1. Current verification supports root Cargo/Anchor projects and root npm dependencies with a valid registry-only package-lock.json. npm preparation uses an isolated volume and disables install scripts. This is developer evidence; only the independently pinned task verifier authorizes completion.

Session startup includes rule identifiers before the first model turn in a one-line prompt summary; the `toolchain_check` tool returns the full advisory report. Project-derived text is untrusted. No compatibility report grants command or completion authority.

TOML uses Python >=3.11's standard parser in isolated mode with bounded input and timeout; no new npm package is required. The collector skips symlinks and caches, and fails on malformed or oversized inputs. Cargo dependency aliases, workspace inheritance, target tables and common numeric requirements are supported. Unsupported/ambiguous requirements are not evidence of a specific resolved version. Cargo.lock is needed to establish affected-version CVE exposure. Nonstandard manifests, arbitrary shell composition, every Cargo feature combination, and implicit external tool selection are not fully modeled.

The trusted JS dependency-fetch path supports npm only; Yarn is present in the image but is not supported by that locked preparation path.

The default execution target is the OMS image (Anchor 1.2.2, Agave 4.4.1, platform-tools 1.58, Rust 1.98.1), not arbitrary host installations. Build-script `--tools-version` overrides are reported. An explicit SBPF requirement can be declared in a program Cargo.toml:

```toml
[package.metadata.oms]
required-sbpf-arch = "v3"
```

The proposed Cargo/Anchor build commands and `--verify` explicitly select `--arch v3` for this metadata. This does not rewrite project build scripts or establish feature activation on any cluster. The checker uses the measured pinned image default (v3) when no project script selects an architecture. Explicit incompatible selections still warn at the declaring Cargo manifest. No automatic tool installation is proposed.

Compatibility sources are the pinned MIT solana-dev-skill corpus and Apache-2.0 Anchor docs, plus the maintainer's official CVE advisory and official SBPF guidance. Sources and observation dates are on every rule in `rules.ts`. These are compatibility diagnostics, not a blanket security proof.
