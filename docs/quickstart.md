# Connect OMS

Install Node 22.19.0 or newer and Git, then:

```sh
npx @barestate/oms doctor --install   # downloads Surfpool 1.7.0 and checks its SHA-256
npx @barestate/oms
```

In a source checkout, run `npm ci --ignore-scripts`, then `node packages/cli/src/bin.ts doctor --install` and `npm start`.

Docker is not part of the install. `npm start` uses host mode: on macOS commands run under a Seatbelt profile (worktree-only writes, no access to keys or other repos, network only to Surfnet); on Linux v0.1 there is no sandbox and OMS warns at startup. Commands need your approval in both. Optional: `npm start -- --sandbox docker` selects Docker for untrusted repositories; it needs the daemon and the pinned cached image.

Enter the slash commands below inside OMS, not in your shell. Arrow keys select a row; Enter confirms; Esc returns. `/connect` configures access and `/model` selects a model. A row marked **Connected** means credentials are configured locally. Saving a key sends no validation request. Only a successful model response proves the live connection works, and that request can consume your plan allowance or paid usage. Never paste credentials into chat, source files or bug reports.

## Codex / ChatGPT subscription

```text
/connect
/model
```

In `/connect`, choose **OpenAI Codex** subscription sign-in. Open the displayed URL yourself and complete the browser flow. In `/model`, choose a direct `openai-codex` model, such as `gpt-6.1-sol` when listed. The row should say **Connected** and the selected provider/model should appear in the interface. A ChatGPT login does not configure OpenAI API billing or OMS routed profiles. Plan limits apply; catalog-equivalent spend is not your subscription invoice.

## Claude Code subscription

```text
/connect
```

Choose the Anthropic subscription entry to read its availability explanation. The current runtime explicitly rejects third-party Claude subscription login, so there is no successful TUI connection sequence for it.  Do not copy Claude tokens into OMS.

## MiMo Token Plan

```text
/connect
/model
```

Choose the **Xiaomi Token Plan** provider matching your plan region: `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, or `xiaomi-token-plan-ams`. Enter the plan credential in the private setup prompt. Do not choose the `xiaomi` PAYG provider for a Token Plan. In `/model`, choose the corresponding direct MiMo model. Success locally is a **Connected** row for that regional provider.

## OpenCode Go

```text
/connect
/model
```

Choose **OpenCode Go** in `/connect` and enter its credential in the private prompt. Select an available `opencode-go` direct model in `/model`. A **Connected** row confirms local configuration. Subscription limits apply, and provider extra-usage settings may allow additional billing. OMS's catalog-equivalent spend does not describe your plan invoice.

## OpenAI-compatible key

```text
/connect
/model
```

Choose a built-in provider that matches your endpoint, enter its key in the private prompt, then choose a direct model in `/model`. The model should show **Connected**. For OpenAI itself, choose the API-key entry rather than Codex subscription login. Arbitrary OpenAI-compatible endpoints are not supported by the current direct runtime: OMS disables custom `models.json` loading. Do not invent `--base-url` or `--api-key` flags; neither is an OMS launch option.

## Web access

Web tools are on by default in `npm start` and `oms run`. They run in the OMS process, not in the sandbox.

- `web_fetch` and the `solana_*` docs tools (from the official Solana MCP) need no key.
- `web_search` needs a key of your own, exported before you start OMS. For example:

  ```sh
  export FIRECRAWL_API_KEY=...   # or EXA_API_KEY, TAVILY_API_KEY, PARALLEL_API_KEY, TINYFISH_API_KEY
  npm start
  ```

  Firecrawl's free tier is 1,000 credits a month (a search costs 2 credits per 10 results) and 10 requests a minute. With several keys, OMS fails over between them on rate limits.

Hosted search: `/login` signs in to your OMS account through browser device authorization and enables the hosted oms-search backend; `/logout` removes it. Signing in does not select a model or send inference.

Turn web access off:
- with `/web off` in a session (`/web` alone shows the state and the call counts);
- with `npm start -- --no-web` for one launch;
- with `{"web": "off"}` in `~/.oms/starter/state/config.json` (or `~/.oms/config.json` for `oms run`).

Headless runs have no web access unless you pass `--web`.

## Diagnose a failed setup

```sh
node packages/cli/src/bin.ts doctor
node packages/cli/src/bin.ts doctor --json
node packages/cli/src/bin.ts doctor --surfpool-binary /absolute/path/to/surfpool
```

OMS uses `~/.oms/tools/surfpool-1.7.0/surfpool` (or `.tmp/tools/surfpool` in a source checkout that has one), not the executable on PATH. `doctor --surfpool-binary` checks a different binary for that doctor invocation only; it does not configure subsequent launches.

Doctor checks local tools without starting an agent. It does not validate provider login or make a model request. Open `/connect` and `/model` to inspect saved access. Install the pinned Surfpool release using the matching archive and checksum in [runtime-manifest.json](../packages/engine/runtime-manifest.json). `--programs` also requires the host Anchor toolchain.

Inside OMS, `/status` shows task state, `/verify` requests independent checking, `/help` lists implemented commands, and `/quit` exits after cleanup.

More commands, none of which call a model unless noted:

- Work: `/goal <text> [--check "<command>"]` keeps the agent working until an independent check passes (the command, run in the sandbox, or the task's pinned verifier when there is no `--check`), up to five checks and within the budget; `/goal` shows it and `/goal clear` drops it. `/test` runs the project's tests in the sandbox. `/clear` starts a fresh conversation in the same task. `/cancel` stops any of them.
- Inspect: `/diff [path]` shows task changes against the base (long diffs open read-only in the workbench) and `/usage` shows tokens, spend, time and the caps.
- Solana, on the task's local Surfpool only: `/chain` (RPC, slot, health), `/rewind confirm` (restart the chain from its starting state), `/airdrop <address> [sol]` (up to 100), `/account <address>`, `/tx <signature>`, `/program <name|id> [instruction]` and `/error <code> [program]`.

Commands that read (`/status`, `/usage`, `/diff`, `/chain`, `/account <address>`, `/tx`, `/program`, `/error`) work while the agent runs; the rest wait for it or `/cancel`. For a provider error, retain the error category and provider/model name, but omit credentials and sign-in URLs from reports.
