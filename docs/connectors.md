# Connectors

Connectors let the agent use the tools your team already uses: GitHub, GitLab, Linear, Slack, Docker, AWS and read-only Solana RPC lookups. They are off until you turn one on. Open the list with `/connectors`. (`/connect` is different: it signs in to a model provider.)

## The list

`/connectors` shows every connector with a mark and what the agent may do with it:

- `●` working, `◐` needs a sign-in, `○` off or not installed, `✕` not working.
- Space turns one on or off. `A` steps the access level. Enter signs in. `R` checks again. Esc goes back. The mouse works too: click a row to select it, click its mark to switch it.
- OMS never stores a token. GitHub and GitLab sign in through their own `gh` and `glab` tools, and those keep the login. Hosted connectors (Linear, Slack, GitLab hosted) sign in with your browser; OMS keeps only that sign-in, in a private file under `~/.oms/agent`.
- The saved choices are in `~/.oms/connectors.json`: on or off, and the access level. If the file is damaged, connectors are turned off and the list says so.

## Access levels

| Level | What the agent can do |
| --- | --- |
| read | Look: pull requests, issues, CI, containers, AWS describe/list/get calls. |
| ask | Also change things, one approval at a time. Each change appears in the approval row. |
| allow | Change things without asking. YOLO does not turn this on. |

Docker changes (`compose_up`, `compose_down`, `run`) and every AWS call can be approved once only, never for the whole session. AWS is read-only in this version.

## Commands that use a connected service

- `/pr [number] [request]` has the agent review a pull request. `/issue <number|LIN-123> [request]` has it work on an issue. `/ci [request]` has it look at failing checks.
- OMS fetches the text with your own signed-in tool, labels it as outside data, and sends it to the agent with your request. The agent never sees your login.
- `/account <address> --cluster devnet|mainnet` and `/tx <signature> --cluster devnet|mainnet` look things up on a public network, read-only, when Solana RPC is on. Set `HELIUS_API_KEY` in your shell to use Helius.

## Safety

- Programs run on your machine with a fixed set of arguments; values you or the agent supply are checked first, and nothing goes through a shell.
- Text that comes back from a service is capped at 16 KB and framed so the agent treats it as data, not instructions.
- Secret-looking values are masked on screen.
