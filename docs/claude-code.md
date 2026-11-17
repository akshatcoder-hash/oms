# How to use Claude Code in OMS

Use your Claude subscription as the model in an OMS folder chat, and set how hard it thinks. Connection steps are in the [quickstart](quickstart.md#claude-code-subscription); this page is the short path.

## Prerequisites

- The [Claude Code CLI](https://code.claude.com/docs/en/setup), signed in with a Claude subscription.
- OMS 0.1.2 or newer.

## Steps

1. Sign in from your terminal and check it.

   ```sh
   claude auth login
   claude auth status
   ```

2. Open OMS in your project and connect.

   ```sh
   cd path/to/your/project
   oms
   ```

   ```text
   /connect
   /model
   ```

   In `/connect`, choose **Claude Code (Claude subscription)**. In `/model`, choose **Claude Code**, then Sonnet, Opus or Haiku. Selecting it sends nothing; your first message starts the native chat.

3. Optional: change the effort. Claude Code runs at `high` by default. Set `OMS_CLAUDE_EFFORT` in your shell before you start OMS:

   ```sh
   OMS_CLAUDE_EFFORT=max oms
   ```

   Allowed values are `low`, `medium`, `high`, `xhigh` and `max`. Any other value is an error that names these five.

## Verification

Run `/session`. It shows the native session state: `new` before your first message, `ready` once the chat has started.

## What differs from other models

- **No helpers.** Helper agents need a direct model. With Claude Code selected, the `agent` tool is off, `/team` is refused and `/agents` says why. Pick another model with `/model` to use them. See [How to use helper agents and teams](helpers.md).
- Claude keeps its own chat history. Switching to another model and back resumes Claude's thread without the messages exchanged elsewhere.
- Subscription limits apply. OMS does not fall back to an Anthropic API key.

## Troubleshooting

- **The effort error appears**: check the spelling and case of the value; only the five values above work.
- **`/connect` does not show you as signed in**: run `claude auth status`, sign in again, then reopen `/connect`.
- **A tool batch was interrupted**: see the end of the [quickstart section](quickstart.md#claude-code-subscription) for `/clear`.

## Related

- [Quickstart: Claude Code subscription](quickstart.md#claude-code-subscription)
- [Helper agents reference](helpers-reference.md)
