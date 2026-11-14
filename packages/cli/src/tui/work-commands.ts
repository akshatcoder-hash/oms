import { formatDuration, formatInteger, formatMicroUsd } from '@oms/core';
import { readWorktreeText, taskDiff, type HarnessSession } from '@oms/engine';
import { refuse, type Prepared } from './solana-commands.ts';

/** Diff text shown in the conversation; a longer one opens in the workbench. */
export const DIFF_SHOWN_CHARS = 8_000;
/** The workbench editor holds 64 KiB; keep the preview under it. */
const REPORT_BYTES = 60 * 1024;
export const TEST_OUTPUT_CHARS = 8_000;

function previewBytes(text: string, limit: number): string {
  let bytes = 0; let preview = '';
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) return preview + '\n[Preview truncated.]';
    preview += character;
  }
  return preview;
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

/** Tokens, spend and time from the budget ledger; `remaining` is the same line /status shows. */
export function prepareUsage(argument: string, harness: HarnessSession, remaining: string): Prepared {
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
      `Left: ${remaining}`,
    ].join('\n') };
  } };
}

/** The command /test runs, from what the worktree contains. Anchor first, then an npm test script, then Cargo. */
export function testCommand(codeRoot: string): string | undefined {
  if (readWorktreeText(codeRoot, 'Anchor.toml') !== undefined) {
    // The task's Surfpool is already running; the sandbox exports its URL.
    return 'anchor test --skip-local-validator --provider.cluster "$SURFNET_RPC_URL"';
  }
  const manifest = readWorktreeText(codeRoot, 'package.json');
  if (manifest !== undefined) {
    try {
      const scripts = (JSON.parse(manifest) as { scripts?: { test?: unknown } }).scripts;
      if (typeof scripts?.test === 'string' && scripts.test.trim()) return 'npm test';
    } catch { /* an unreadable manifest falls through to Cargo */ }
  }
  if (readWorktreeText(codeRoot, 'Cargo.toml') !== undefined) return 'cargo test';
  return undefined;
}

export function prepareTest(argument: string, harness: HarnessSession): Prepared {
  if (argument) return refuse('Usage: /test (no arguments; use /run for another command)');
  const command = testCommand(harness.task.codeRoot);
  if (!command) return refuse('No tests found: expected Anchor.toml, a package.json "test" script or Cargo.toml in the task.');
  return { ok: true, async run(signal) {
    const result = await harness.runCommand(command, signal);
    const output = `${result.stdout}${result.stdout && result.stderr ? '\n' : ''}${result.stderr}`.trim();
    const shown = output.length > TEST_OUTPUT_CHARS ? `[earlier output cut]\n${output.slice(-TEST_OUTPUT_CHARS)}` : output;
    const state = result.cancelled ? ' · cancelled' : result.timedOut ? ' · timed out' : '';
    return { title: 'tests', text: `$ ${command}\nExit: ${result.exitCode}${state}\n${shown}${result.truncated ? '\n[backend output truncated]' : ''}` };
  } };
}
