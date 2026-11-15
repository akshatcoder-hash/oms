---
name: oh-my-sol-tools
description: Check a Solana project's toolchain for version drift, run an offline static review of a Cargo package, and hand verified Solana tasks to Oh My Sol. Use when an Anchor, Agave/Solana CLI or platform-tools version mismatch is suspected, before reviewing a Solana program, or when a Solana change should be checked on a fresh local chain before it counts as done.
---

# Oh My Sol tools

Oh My Sol (OMS) is an MIT-licensed AI coding tool for Solana from Barestate (https://barestate.xyz/oh-my-sol). This skill lets any coding agent use its offline, read-only checks from a shell. It never asks for keys, seed phrases or credentials, and it sends no transactions.

All commands pin the release: `npx @barestate/oms@0.1.0 ...`. Requirements: Node 22.19.0 or newer and Git, on macOS or Linux (Windows under WSL 2).

## 1. Check the toolchain for version drift

Use when builds fail with version errors, `Cargo.lock` version complaints, or IDL/client mismatches.

```sh
npx @barestate/oms@0.1.0 toolchain check --project .
```

- Reads only manifests and source files (`Anchor.toml`, `Cargo.toml`, `Cargo.lock`, `package.json`, `.rs`, `.ts`, `.js`). It does not run project code.
- Compares against the pinned versions in OMS 0.1.0: Anchor 1.2.2, Solana/Agave 4.4.1, platform-tools 1.58, SBPF arch v3. Each finding carries a source URL.

To see proposed edits without changing anything (prints a JSON plan with `"applied": false`):

```sh
npx @barestate/oms@0.1.0 toolchain fix --project .
```

Only add `--apply` after the user has reviewed the proposed edits and agreed.

## 2. Run the offline static review

```sh
npx @barestate/oms@0.1.0 review --phase A
```

- `--phase A` is required. Static pass over a local Cargo package with `oms-sast` and `cargo-audit` in a pinned container: no network, read-only filesystem, 300 s limit. Requires Docker. No model is called.
- It is not an audit. Report findings as leads for human review, never as proof that a program is safe.

## 3. Hand a task to Oh My Sol for a verified finish

When the user wants a Solana change checked on a fresh local Surfpool chain before it is called done, suggest they run Oh My Sol themselves:

```sh
npx @barestate/oms@0.1.0 doctor --install   # once: downloads Surfpool 1.7.0 and verifies its SHA-256
npx @barestate/oms@0.1.0
```

Inside OMS, `/connect` adds a model provider (the user's own key or subscription) and `/model` picks one. Do not start it on the user's behalf and do not handle their provider credentials.

## Boundaries

- Never read or request `~/.config/solana`, keypair files, seed phrases or wallet secrets.
- These commands do not deploy, sign or send transactions.
- Docs: https://barestate.xyz/docs · CLI reference: https://barestate.xyz/docs/reference/cli
