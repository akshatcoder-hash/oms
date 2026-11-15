import { formatDuration, formatInteger, formatMicroUsd } from '@oms/core';
import { taskDiff, type HarnessSession } from '@oms/engine';
import { claudeChatStatus } from './claude-chat.ts';
import { previewBytes, refuse, REPORT_BYTES, type Prepared } from './prepared.ts';
import { singleLine } from './transcript.ts';
import type { CommandContext } from './commands.ts';

/** Diff text shown in the conversation; a longer one opens in the workbench. */
export const DIFF_SHOWN_CHARS = 8_000;

/** What is left of the token, spend and time allowance, on one line. */
export function budgetLine(harness: HarnessSession): string {
  const budget = harness.budget.snapshot();
  const microUsd = budget.remaining.spendMicroUsd;
  const dollars = `${Math.trunc(microUsd / 1_000_000)}.${String(microUsd % 1_000_000).padStart(6, '0')}`;
  const scope = budget.executionMode === 'interactive' ? 'this turn' : 'run';
  return `${scope}: ${budget.remaining.tokens}t · ${Math.ceil(budget.remaining.wallClockMs / 1000)}s · API $${dollars} left · ${singleLine(budget.accounting, 80)}${budget.exhausted ? ' EXHAUSTED' : ''}`;
}

/** Calls, tokens and spend recorded against the worker role. */
function roleLines(harness: HarnessSession): string {
  const reservations = harness.budget.reservations();
  const receipts = new Map(harness.budget.receipts().map(receipt => [receipt.dispatchId, receipt]));
  return (['worker'] as const).map(role => {
    const admitted = reservations.filter(item => (item.provenance?.role ?? 'worker') === role);
    if (admitted.length === 0) return '';
    let tokens = 0, cost = 0, cacheRead = 0, cacheWrite = 0, missing = false, unknown = 0;
    for (const item of admitted) {
      const receipt = receipts.get(item.dispatchId);
      if (!receipt || receipt.outcome === 'uncertain') { unknown++; continue; }
      if (receipt.outcome !== 'known') continue;
      tokens += receipt.tokens ?? 0; cost += receipt.spendMicroUsd ?? 0;
      if (receipt.usage) { cacheRead += receipt.usage.cacheReadTokens; cacheWrite += receipt.usage.cacheWriteTokens; }
      else missing = true;
    }
    return `${role}: ${admitted.length} calls · ${tokens} known tokens · $${(cost / 1e6).toFixed(6)} known spend · ${unknown} pending/unknown · ${missing ? 'historical cache counts unavailable' : `cache read ${cacheRead} / write ${cacheWrite}`}`;
  }).filter(Boolean).join('\n');
}

export function prepareDiff(argument: string, harness: HarnessSession): Prepared {
  const path = argument.trim() || undefined;
  return { ok: true, async run() {
    const { codeRoot, baseOid, branch } = harness.task;
    const diff = await taskDiff(codeRoot, baseOid, path);
    const head = `Against base ${baseOid.slice(0, 12)} · ${branch}${path ? ` · ${path}` : ''}`;
    const untracked = diff.untracked.length ? `Untracked (${diff.untracked.length}):\n${diff.untracked.slice(0, 30).map(file => '  ' + file).join('\n')}${diff.untracked.length > 30 ? `\n  [${diff.untracked.length - 30} more]` : ''}` : '';
    if (!diff.patch && !untracked) return { title: 'diff', text: `${head}\nNo changes.` };
    const summary = [head, diff.stat, untracked].filter(Boolean).join('\n');
    if (diff.patch.length <= DIFF_SHOWN_CHARS && !diff.truncated) return { title: 'diff', text: `${summary}\n\n${diff.patch}` };
    return { title: 'diff', text: `${summary}\n\n${diff.patch.slice(0, DIFF_SHOWN_CHARS)}\n[Full diff opened in the workbench as a read-only report.]`,
      report: { id: `diff-${Date.now()}`, text: previewBytes(`${summary}\n\n${diff.patch}${diff.truncated ? '\n[Diff cut at 256 KiB.]' : ''}`, REPORT_BYTES) } };
  } };
}

/** Tokens, spend and time from the budget ledger, then what is left. */
export function prepareUsage(argument: string, harness: HarnessSession): Prepared {
  if (argument) return refuse('Usage: /usage');
  return { ok: true, async run() {
    const snapshot = harness.budget.snapshot();
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, known = 0, unbroken = 0;
    for (const receipt of harness.budget.receipts()) {
      if (receipt.outcome !== 'known') continue;
      if (receipt.usage) { input += receipt.usage.inputTokens; output += receipt.usage.outputTokens; cacheRead += receipt.usage.cacheReadTokens; cacheWrite += receipt.usage.cacheWriteTokens; known++; }
      else unbroken++;
    }
    const { used, caps } = snapshot;
    return { title: 'usage', text: [
      `Tokens: input ${formatInteger(input)} · cached ${formatInteger(cacheRead)} read / ${formatInteger(cacheWrite)} written · output ${formatInteger(output)}` +
        `${unbroken ? ` · ${unbroken} earlier calls have no breakdown` : ''}${known + unbroken === 0 ? ' · no model calls yet' : ''}`,
      `Spend: ${formatMicroUsd(used.spendMicroUsd)} of ${formatMicroUsd(caps.spendMicroUsd)} API cap`,
      `Time: ${formatDuration(used.wallClockMs)} of ${formatDuration(caps.wallClockMs)}`,
      `Tokens against cap: ${formatInteger(used.tokens)} of ${formatInteger(caps.tokens)}`,
      `Accounting: ${snapshot.accounting}${snapshot.exhausted ? ' · budget EXHAUSTED' : ''}`,
      `Left: ${budgetLine(harness)}`,
    ].join('\n') };
  } };
}

/** Requirements, proof state, model and the full budget. The requirements are re-read when the command runs. */
export function prepareStatus(ctx: CommandContext): Prepared {
  return { ok: true, async run() {
    const { harness } = ctx;
    const requirements = ctx.checkRequirements();
    return { title: 'task status', clearNotice: true, text: `Task: ${singleLine(harness.task.id, 120)}\nProof: ${requirements.proofAvailable ? 'last checked ' + requirements.checkedAt : 'unavailable; prior context retained'}\n` +
      requirements.items.slice(0, 12).map(item => `${singleLine(item.id, 80)}  ${singleLine(item.status, 80)}  ${singleLine(item.title, 160)}`).join('\n') +
      `\nModel: ${ctx.modelDetail() ?? 'Use /model to review connected providers and selection.'}\nToken allowance / spend / time: ${budgetLine(harness)}\n${roleLines(harness)}` };
  } };
}

export function prepareSession(harness: HarnessSession): Prepared {
  return { ok: true, async run() {
    return { title: 'session', clearNotice: true, text: `OMS session: ${harness.session.sessionManager.getSessionId()}\nRepository: ${harness.workspace.root}\nTask: ${harness.task.id}\nWorktree: ${harness.task.codeRoot}\nBranch: ${harness.task.branch}\nChanging focus does not dispatch work.` +
      (harness.nativeChat ? `\n${claudeChatStatus(harness)}` : '') };
  } };
}
