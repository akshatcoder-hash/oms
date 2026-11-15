import { readWorktreeText, type HarnessSession } from '@oms/engine';
import { REVIEW_DISCLAIMER } from '../../../review/src/disclaimer.ts';
import { previewBytes, refuse, refuseWith, REPORT_BYTES, type Prepared } from './prepared.ts';
import { singleLine } from './transcript.ts';
import type { ReviewPresentation } from '../review.ts';
import type { CommandContext } from './commands.ts';

const TEST_OUTPUT_CHARS = 8_000;

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

/** /run <command>: a sandbox command whose output is the note; a command that did not succeed fails the action. */
export function prepareRun(argument: string, harness: HarnessSession): Prepared {
  return { ok: true, async run(signal) {
    const result = await harness.runCommand(argument, signal);
    return { title: 'sandbox command', inPlace: true,
      text: `$ ${argument}\nExit: ${result.exitCode}${result.timedOut ? ' · timed out' : ''}${result.cancelled ? ' · cancelled' : ''}\n${result.stdout}\n${result.stderr}${result.truncated ? '\n[backend output truncated]' : ''}`,
      ...(result.exitCode !== 0 || result.timedOut || result.cancelled
        ? { failure: `Sandbox command did not succeed (exit ${result.exitCode}); draft retained.` } : {}) };
  } };
}

/** /verify [item]: independent verification of one requirement; it runs to its backend timeout. */
export function prepareVerify(ctx: CommandContext, argument: string): Prepared {
  const id = argument || ctx.selectedRequirement();
  return { ok: true, async run() {
    const verification = await ctx.harness.verify(id);
    const result = verification.result;
    return { title: 'verification', inPlace: true,
      text: `${verification.itemId}: ${result.closed ? 'closed by independent verification' : result.reason}` };
  } };
}

/** /review: offline Phase A security review of the task worktree; the full report opens read-only in the workbench. */
export function prepareReview(ctx: CommandContext): Prepared {
  if (ctx.workbench.dirty || ctx.shell.running) return refuseWith('Save or close unsaved files and stop the terminal before reviewing.');
  return { ok: true, async run() {
    ctx.conversation.note('security review', REVIEW_DISCLAIMER + '\nRunning offline Phase A static tools.');
    let report: ReviewPresentation | undefined;
    const code = await ctx.review([ctx.harness.task.codeRoot, '--phase', 'A'], {
      stdout() {}, stderr: text => { ctx.setNotice(singleLine(text, 500)); }, report: value => { report = value; },
    });
    const failed = code !== 0;
    if (!report) {
      if (failed) throw new Error('Review did not produce a report. See the review status.');
      return undefined;
    }
    const summary = `Confirmed ${report.confirmed} · Suspected ${report.suspected}`;
    // The editor has a 64 KiB document limit. Keep the full saved report; mark a bounded preview.
    const preview = previewBytes(report.markdown, REPORT_BYTES, '\n[Preview truncated; full report is saved in private review state.]');
    return { title: 'security review', text: summary + '\n' + REVIEW_DISCLAIMER, report: { id: report.reviewId, text: summary + '\n' + preview },
      ...(failed ? { failure: 'Partial review saved; one or more stages failed.' } : {}) };
  } };
}
