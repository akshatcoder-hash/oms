# Security policy

OMS is a coding agent for Solana, so it runs code, reads files and works next to wallets. We take reports seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

We aim to acknowledge reports within 3 working days and to agree a fix and disclosure date with you.

## What we especially want to hear about

- Any way for the model, a task repository, a dependency, an IDL, program logs or a web page to make OMS read, print or send key material (for example `~/.config/solana`, `~/.ssh`, provider credentials or the OMS account token).
- Any way to get OMS to sign or send a transaction the user did not approve, or to act on devnet or mainnet when it should only use the local chain.
- Escapes from the macOS Seatbelt sandbox or the Docker sandbox, including network access beyond what they allow.
- Ways to make the independent verifier pass a task it should fail.

## What OMS does to protect you

The design is described in the documentation and the code: a separate verifier closes tasks, file and shell guards block key folders, and on macOS a Seatbelt profile limits writes and network. On Linux, the default host mode has **no operating-system sandbox**; use `--sandbox docker` for isolation.

## Supported versions

Security fixes go into the latest release.
