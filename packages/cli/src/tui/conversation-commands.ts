import { goalSummary, parseGoalArguments } from './goal.ts';
import { budgetLine } from './inspect-commands.ts';
import { refuse, refuseWith, type Prepared } from './prepared.ts';
import { singleLine } from './transcript.ts';
import type { CommandContext } from './commands.ts';

/** /clear: a fresh conversation in the same task. A native Claude chat resets through its own controls, so it runs as work. */
export function clearConversation(ctx: CommandContext, argument: string, draft: string | undefined): Prepared | void {
  if (argument) return refuseWith('Usage: /clear; draft retained.');
  const { harness } = ctx;
  if (harness.session.model?.provider === 'claude-code') {
    const chat = harness.nativeChat;
    if (!chat) return refuseWith('Native Claude chat controls are unavailable; the conversation was not cleared.');
    return {
      ok: true,
      async run() {
        await chat.reset();
        harness.session.agent.reset();
        harness.session.sessionManager.resetLeaf();
        ctx.goal.set(undefined);
        ctx.conversation.clear();
        return {
          title: 'new native Claude conversation',
          inPlace: true,
          text: 'Fresh native chat boundary. Previous chat history is not replayed. Files, worktree and verification are retained.',
        };
      },
    };
  }
  try {
    harness.session.agent.reset();
    // The session file keeps its history; the next entry starts a new branch, so a resume sees only what follows.
    harness.session.sessionManager.resetLeaf();
  } catch (error) {
    return refuseWith(
      `Could not clear the conversation: ${singleLine(error instanceof Error ? error.message : 'unknown error', 200)}`,
    );
  }
  ctx.goal.set(undefined);
  ctx.conversation.clear();
  ctx.show(
    'new conversation',
    'Fresh conversation in the same task. Files, worktree and task state are unchanged.',
    draft,
  );
}

/** /goal [<text> [--check "<command>"] | clear]: show, clear, or start the loop that works until the check passes. */
export function goalCommand(ctx: CommandContext, argument: string, draft: string | undefined): Prepared | void {
  const request = parseGoalArguments(argument);
  if (request.kind === 'error') return refuse(request.message);
  if (request.kind === 'set') {
    ctx.startGoal(request.text, request.check, draft);
    return;
  }
  if (request.kind === 'clear') {
    ctx.goal.set(undefined);
    ctx.show('goal', 'Goal cleared.', draft);
  } else ctx.show('goal', goalSummary(ctx.goal.get(), budgetLine(ctx.harness)), draft);
}
