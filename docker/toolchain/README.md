# Pinned program toolchain

Build on Linux x64 with `bash scripts/build-toolchain.sh`. Downloads are build-time only,
checked by SHA-256 in the Dockerfile. The resulting local image ID is written to
`packages/engine/runtime-manifest.json`; there is no registry push.

The Debian slim Node base, Agave 4.4.1, platform-tools v1.58, Rust 1.98.1 (Agave's
`rust-toolchain.toml`), rustup 1.28.2 and Anchor 1.2.2 are pinned. No avm is installed.
The Anchor shim parses TOML before native version switching, refuses all
`solana_version` settings and unsupported `anchor_version` values. The SBF wrapper
selects the installed platform tools and disables tool installation/rustup overrides.

Primary sources:
- https://github.com/anza-xyz/agave/releases/tag/v4.4.1
- https://raw.githubusercontent.com/anza-xyz/agave/v4.4.1/rust-toolchain.toml
- https://github.com/anza-xyz/platform-tools/releases/tag/v1.58
- https://github.com/otter-sec/anchor/releases/tag/v1.2.2
- https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init.sha256

`deps_fetch` uses the install-phase registry forwarder; run-phase Cargo sets
`CARGO_NET_OFFLINE=true`. The trusted build profile uses 6 GiB, 4 CPUs, 1024 PIDs,
a 15-minute default command timeout clamped to the remaining task budget, and
separate `target` and `.oms-cargo` volumes. Select it with `defaultHarnessEnvironment(binary, true)` in trusted host code.
Verifier commands use fresh disposable volumes and a separate locked install-phase
fetch before the offline command; exploration caches are never mounted there.
Verifier artifact binding and program task acceptance (M1.8–M1.10) remain separate.
