# OMS (oh my sol)

OMS is a Solana coding harness that runs on your machine with the model access you already have.
Run `oms` in any folder to chat with a Solana coding agent that edits that folder in place. For work with pinned requirements, the model edits a task worktree and proposes completion, and an independent offline verifier decides whether the pinned checks pass.
Use the terminal chat or Workbench editor, with Solana references, toolchain repair, and saved history.

## Install and first run

Use Node **22.19.0 or newer** and Git. Then:

```sh
cd path/to/your/project
npx @barestate/oms
```

The first launch installs Surfpool 1.7.0 and verifies its SHA-256; `oms doctor --install` does the same on its own.

`oms --version` prints the version. To run a source checkout instead, use `npm ci --ignore-scripts`, run `node packages/cli/src/bin.ts doctor --install`, then `npm start`. See [quickstart](docs/quickstart.md) for the source setup commands.

In OMS, enter `/connect`, choose your access method, then `/model` to select a model or a native Claude Code chat. `/help` lists commands; `/exit` (or `/quit`, or Ctrl+D on an empty input) closes the session. `/yolo`, or `oms --yolo`, runs commands without asking and without the sandbox.

`oms` works in the folder you run it in, like any editor: the agent reads and edits your files there, including uncommitted ones, so keep the folder under Git and use `/diff` to review. OMS creates nothing inside the folder; its state for each folder lives under `~/.oms/folders/`. Run `oms` again in the same folder to resume the last conversation. In your home folder, `/`, or a folder that holds keys or OMS's own state, OMS opens a scratch folder instead and says so.

See [quickstart](docs/quickstart.md) for each access path and [release checklist](docs/release.md) for the installable archive and clean-machine smoke test.

## Model access

OMS uses the model access you already have. Provider credentials stay in private configuration and are never placed in chat or task files. Claude Code keeps its own login; OMS checks it through the installed CLI.

| Access you have | Connect in OMS |
| --- | --- |
| Codex / ChatGPT subscription | `/connect` → OpenAI Codex subscription; `/model` → Codex model |
| Claude Code subscription | Sign in with `claude auth login`, then `/connect` → local Claude Code login; `/model` → **Claude Code** → Sonnet, Opus or Haiku |
| MiMo Token Plan | `/connect` → your Xiaomi Token Plan region; `/model` → MiMo |
| OpenCode Go | `/connect` → OpenCode Go; `/model` → available model |
| OpenAI or Anthropic API key | `/connect` → the provider; arbitrary custom endpoints are not loaded by this cut |

OMS makes no claim of a higher pass rate than any single model.

Claude Code owns its native chat history, bound to the OMS conversation. `/session` shows its observed session ID and connection state. Running `oms` again in the folder and the standard OMS resume command restore that same identity; the next message resumes native history. With Claude Code selected, `/clear` starts a fresh native chat and clears the OMS conversation view, retaining your files and, in a task, its verification. Returning from another provider resumes Claude's separate history without importing that provider's messages. OMS still executes Claude's tools through its approvals and sandbox, and the independent verifier decides completion. See [native chat setup and resume](docs/quickstart.md#claude-code-subscription).

## What “done” means

A task pins its requirements and trusted verifier files before work begins. The model cannot replace those checks with its own success message. OMS captures the proposed source and runs the pinned checks independently against a fresh offline Surfpool chain. A failed or incomplete evaluation leaves the requirement open. `/verify` requests this check without a model turn; `/status` shows the result and accounting. `/goal` keeps the agent working until an independent check passes, and a failing check feeds its output back within the same retry and budget caps.

“Verified” means the specified checks passed for that captured source. It does not prove every possible behavior or security property. Stop an interactive terminal with `/terminal stop` before verification so it cannot change source during capture.

## Host mode and sandboxing

Docker is not needed to install or run OMS. Host mode is the default: tools run on your machine, in the folder you opened (or the task worktree).

- **macOS:** every command runs under a per-run Seatbelt (`sandbox-exec`) profile. Writes are limited to the worktree, a private HOME, temp and Cargo's download caches (`~/.cargo/registry`, `~/.cargo/git`). Pinned verifier files and `.git` stay read-only in a task; in a folder chat only `.git/hooks` and `.git/config` do, so the agent can `git add` and `git commit` but cannot plant a hook. With Seatbelt enabled, files named `.env` or `.env.*` are unreadable in both folder chats and tasks, including nested directories; the exact template names `.env.example`, `.env.sample` and `.env.template` remain readable wherever file access is otherwise allowed, with all these names matched case-insensitively. Seatbelt resolves symlinks, so a `.env` symlink to another file in an allowed tree leaves that target readable. Builds that need `.env` cannot read it inside the OMS sandbox; pass the values another way. Cargo's `credentials` and `credentials.toml` under `~/.cargo`, a custom `CARGO_HOME` and every reopened toolchain root are unreadable, as are case variants of `.npmrc` and `etc/npmrc` inside those toolchain roots; npm's builtin `npmrc` remains readable. `~/.ssh`, `~/.config/solana`, `~/.aws`, `~/Library`, `~/.config/gh`, `~/.docker`, `~/.netrc`, `~/.npmrc`, keypair files and other directories under your home are unreadable, and the keychain service is blocked. The only network destination is the local Surfnet port. Seatbelt is not a VM; it confines file and network access only.
- **Linux:** v0.1 has no sandbox. OMS prints a warning at startup. Network access is unrestricted and an approved command can read anything your user can. Use it only with code and commands you trust.

On both, agent shell, terminal and verifier processes start from an empty environment plus an allowlist (PATH, locale, temp dir, shell, terminal, Cargo/Rustup homes, RPC URLs) with a private per-run HOME. API keys such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` and `AWS_*` never reach them. File tools refuse writes to pinned verifier files and `.git`. Every model shell command needs approval in the TUI, with extra warnings for credential or wallet paths, recursive removal, paths outside the worktree, downloads piped to a shell and sudo. Headless runs default to `--host-approval deny`; a trusted operator can pass `--host-approval allow`.

Optional: `--sandbox docker` (or `OMS_SANDBOX=docker`) selects container execution for untrusted repositories. It needs a running daemon and the explicitly cached immutable image from [runtime-manifest.json](packages/engine/runtime-manifest.json); it never pulls an image during execution. Task creation and execution must use the same backend. Surfpool is local and offline in either mode. `oms doctor --sandbox host|docker` checks the selected backend.

## Solana tools

Solana reference lookups return bounded results that are treated as untrusted data. They supply context, not verification authority.

Anchor and Kit toolchain repair helps resolve version and build mismatches. It does not remove the need to install project dependencies or to review proposed changes.

Security review is report-only: **can make mistakes; get a professional audit**. Findings do not authorize automatic fixes or constitute an audit. 

Startup art shows one of four pictures when OMS opens. `/art off` turns it off. Appearance settings do not send model requests.

## Web access

Interactive sessions can look things up on the web. All of it runs in the OMS host process, never inside the sandbox; the sandbox network does not change. Every result is capped at 16,000 bytes and framed as untrusted reference text.

- **Solana MCP** (`solana_*` tools): the official keyless server at `https://mcp.solana.com/mcp`, for Solana docs. OMS does not expose its `program_autofixer` tool, because that tool uploads your program source.
- **`web_fetch`**: reads one public `https://` page as markdown, with a 20 s timeout and a 2 MB download limit. It refuses private, loopback and link-local addresses, both as literals and after DNS resolution. With `FIRECRAWL_API_KEY` set, OMS uses Firecrawl scrape first (it renders JavaScript pages) and falls back to a plain fetch.
- **`web_search`**: needs your own key. Set one or more of `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `TAVILY_API_KEY`, `PARALLEL_API_KEY` or `TINYFISH_API_KEY` in the environment you start OMS from. OMS tries them in that order. On HTTP 429 or 5xx it moves to the next backend, and skips the limited one until its `Retry-After` passes (60 s if the header is missing). OMS's hosted search, oms-search, goes first when you are signed in (`/login`) or when `OMS_SEARCH_URL` and `OMS_SEARCH_TOKEN` point at an oms-search service you run. Signing in enables hosted search only; it does not select a model or send inference. The hosted service also serves `web_fetch` first, and any failure there falls back to the path below. With no key there is no `web_search` tool. Exa's keyless hosted MCP is not used, because its terms do not clearly allow a distributed CLI to use it by default.

The system prompt tells the model to use the built-in Solana reference first, then the Solana MCP, then web search. For program and build errors it prefers Solana Stack Exchange and GitHub issues and releases. Queries go to the services named above.

To turn web access off, use one of these:
- for the current session: `/web off`, and `/web on` to turn it back on;
- for one launch: `--no-web`;
- for every launch: `{"web": "off"}` in `config.json` in the OMS state root. This is `~/.oms/config.json`.

Headless runs have no web tools unless you pass `--web`. Run records count `web_search`, `web_fetch` and Solana MCP calls, and name the backend that answered each search and fetch (an oms-search answer as the backends it reports, such as `oms:searxng+tinyfish`).

## Your repository

Initialize a Git repository, then create a task from an explicit requirements file. `--base` takes any revision Git can resolve and defaults to the repository's HEAD:

```sh
node packages/cli/src/bin.ts workspace init /path/to/repo --ignore exclude
node packages/cli/src/bin.ts task create --workspace /path/to/repo --requirements /path/to/requirements.json --id first
node packages/cli/src/bin.ts run --workspace /path/to/repo --task first
```

Requirements contain a `contract`, `verifierPaths`, `codePaths`, and `testTimeoutMs`. Pin verifier dependencies and controlling package scripts as trusted paths. See [engine notes](packages/engine/NOTES.md) for the format and storage model. Task code lives in a managed worktree; trusted state lives separately under `~/.oms`.

## Limits

- OMS never holds mainnet keys. Mainnet work is handed to the user as a transaction to review and sign. This TUI has no signer connection.
- Host mode has no sandbox on Linux in v0.1. Seatbelt on macOS and Docker isolation do not protect against a compromised kernel or hostile code you run outside OMS.
- Provider plans have their own limits. OMS retains uncertain usage and does not treat unknown charges as free.
- Custom `models.json` loading is disabled. Claude subscriptions use the installed Claude Code CLI and its own login; direct Anthropic access uses an API key.
- Verification covers pinned checks, not mainnet readiness, production capacity, or a professional security audit.

## Benchmark

The harness behind our published Solana Bench numbers is in this repository; see [docs/solana-bench.md](docs/solana-bench.md) to rerun a cell.

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). Built over Pi.
