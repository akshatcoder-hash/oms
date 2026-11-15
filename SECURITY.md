# Security policy

## Reporting a vulnerability

Email **hello@barestate.xyz** with "OMS security" in the subject. Please include the OMS version (`oms --version`), your platform and sandbox mode (macOS Seatbelt, Docker or Linux host mode), steps to reproduce, and what an attacker gains.

Please report privately and give us a reasonable chance to fix the issue before disclosing it. We will acknowledge your report, keep you updated, and credit you in the changelog if you want. There is no bug bounty.

## In scope

- Reads or writes that escape the task root through the model's file tools (see the file-read guards).
- A model shell command reading keypair files or folders such as `~/.config/solana` or `~/.ssh`, or reaching the network, despite the macOS Seatbelt sandbox or Docker mode.
- A model or task changing the pinned requirements or verifier, or closing a task without the independent offline check.
- Provider credentials or the OMS token leaking into chat, task files, tool results, logs or the sandbox.
- The `doctor --install` download being accepted without a matching SHA-256.

## Known limits, not vulnerabilities

These are documented in https://barestate.xyz/docs/security/overview:

- **Linux host mode has no operating system sandbox.** OMS asks you to approve every model shell command; use Docker mode for confinement.
- **The shell guard is best effort**, with four known gaps. The sandbox is the real control.
- **The signer is not connected to the shipped app.** OMS 0.1.0 does not sign or send transactions.
- **No red-team evaluation has been run**, so OMS makes no safety claim from one.
- "Verified" means the pinned checks passed for the captured source. It is not a security audit, and the offline review (`oms review --phase A`) is not one either.

## Supported versions

Only the latest published version of `@barestate/oms` receives fixes.
