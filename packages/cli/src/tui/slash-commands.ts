import type { HarnessSession } from '@oms/engine';
import {
  prepareAccount, prepareAirdrop, prepareChain, prepareError, prepareProgram, prepareRewind, prepareTransaction,
  type Prepared,
} from './solana-commands.ts';
import { prepareDiff, prepareTest, prepareUsage } from './work-commands.ts';

/** Commands that only read: they run while the agent works. Every other command refuses with the "Work is running" notice. */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(['status', 'session', 'usage', 'diff', 'chain', 'account', 'tx', 'program', 'error']);

/**
 * Parse one of the deterministic commands (no model call). Returns undefined for a name it does not own, a refusal for a bad
 * argument, or the work to run. `remaining` is the budget line /status shows.
 */
export function prepareSlash(command: string, argument: string, harness: HarnessSession, remaining: string): Prepared | undefined {
  switch (command) {
    case 'diff': return prepareDiff(argument, harness);
    case 'usage': return prepareUsage(argument, harness, remaining);
    case 'test': return prepareTest(argument, harness);
    case 'chain': return prepareChain(argument, harness);
    case 'rewind': return prepareRewind(argument, harness);
    case 'airdrop': return prepareAirdrop(argument, harness);
    case 'account': return prepareAccount(argument, harness);
    case 'tx': return prepareTransaction(argument, harness);
    case 'program': return prepareProgram(argument);
    case 'error': return prepareError(argument, harness);
    default: return undefined;
  }
}
