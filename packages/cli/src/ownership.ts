import { createInterface } from 'node:readline/promises';
import { wrapTextWithAnsi } from '@earendil-works/pi-tui';
import {
  createHarnessSession, inspectMutationLease, stopMutationLeaseOwner, recoverHarnessWorkspace, WorkspaceError,
  type HarnessSession, type HarnessSessionOptions, type LeaseInspection,
} from '@oms/engine';
import { displayText } from './tui/transcript.ts';

export interface OwnershipScreen {
  workspace: string;
  task: string;
  status: LeaseInspection['status'];
  canStop: boolean;
  reason?: 'foreign-host' | 'recovery-in-progress' | 'recovery-abandoned' | 'invalid-owner';
  notice?: string;
}
export interface OwnershipPrompt {
  choose(screen: OwnershipScreen): Promise<'cancel' | 'retry' | 'stop' | 'recover'>;
  confirmStop(screen: OwnershipScreen): Promise<boolean>;
  close(): void;
}
interface OwnershipDependencies {
  start?: typeof createHarnessSession;
  inspect?: typeof inspectMutationLease;
  stop?: typeof stopMutationLeaseOwner;
  recover?: typeof recoverHarnessWorkspace;
  prompt?: OwnershipPrompt;
  beforeOpen?: (options: HarnessSessionOptions) => Promise<HarnessSessionOptions | undefined>;
}

const safeLine = (value: string): string => displayText(value, 300).replace(/\s+/g, ' ').trim();

/** No owner records or error text enter this presentation boundary. */
export function ownershipScreenLines(screen: OwnershipScreen): string[] {
  const lines = ['OMS | Open task', `Workspace: ${safeLine(screen.workspace)}`, `Task: ${safeLine(screen.task)}`, ''];
  if (screen.notice) lines.push(safeLine(screen.notice), '');
  if (screen.status === 'live') {
    lines.push('This task is already open in another OMS window.',
      'Return to the existing window to keep its unsaved edits and running work.');
  } else if (screen.status === 'stale') {
    lines.push('Previous run ended without verified cleanup; saved files/session retained.',
      'Recover saved workspace stops only verified task execution resources.',
      'Saved files, session history, authentication and persistent data volumes are kept.');
  } else if (screen.status === 'unverifiable') {
    const reason = screen.reason === 'foreign-host'
      ? 'This task is owned by a different host. Return to that host; local recovery will not change it.'
      : screen.reason === 'recovery-in-progress'
      ? 'Another recovery is in progress. Wait for it to finish, then refresh.'
      : screen.reason === 'recovery-abandoned'
      ? 'An interrupted recovery claim remains. Host inspection of the exact recovery owner is required before reopening.'
      : 'The private ownership record is unreadable or incomplete. Restore its ownership/permissions or inspect it on the original host; do not delete it blindly.';
    lines.push('Task ownership cannot be safely verified. No process or saved work has been changed.', reason);
  } else {
    lines.push('The previous window has released this task. Retry to open it here.');
  }
  lines.push('', screen.status === 'live' ? '1  Cancel - return to the existing window (default)' : '1  Cancel - keep saved work unchanged (default)',
    '2  Refresh and retry');
  if (screen.canStop) lines.push('3  Stop the previous window and open here', '   WARNING: unsaved edits and drafts will be lost.');
  if (screen.status === 'stale') lines.push('3  Recover saved workspace and open here');
  return lines;
}

function localPrompt() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  readline.once('close', () => abort.abort());
  readline.on('SIGINT', () => readline.close());
  const print = (lines: string[]) => {
    const width = Math.max(20, process.stdout.columns || 80);
    process.stdout.write('\n' + lines.flatMap(line => wrapTextWithAnsi(line, width)).join('\n') + '\n');
  };
  const ask = async (text: string): Promise<string> => {
    if (abort.signal.aborted) return '';
    try { return (await readline.question(text, { signal: abort.signal })).trim().toLowerCase(); }
    catch (error) { if (abort.signal.aborted) return ''; throw error; }
  };
  return { print, ask, close() { readline.close(); } };
}

/** Shared host-only startup choice; Enter and interruption always preserve the current state. */
export async function chooseLocalAction(
  message: string, choices: readonly { value: string; label: string }[],
): Promise<string | undefined> {
  const prompt = localPrompt();
  try {
    prompt.print([...displayText(message, 2_000).split('\n'), '',
      ...choices.map((choice, index) => `${index + 1}  ${safeLine(choice.label)}`), '0  Cancel (default)']);
    for (;;) {
      const answer = await prompt.ask('Choose an option [0]: ');
      if (!answer || answer === '0' || answer === 'cancel') return undefined;
      const choice = /^[1-9][0-9]*$/.test(answer) ? choices[Number(answer) - 1] : undefined;
      if (choice) return choice.value;
      prompt.print(['Choose a listed option, or press Enter to cancel.']);
    }
  } finally { prompt.close(); }
}

function terminalOwnershipPrompt(): OwnershipPrompt {
  const { print, ask, close } = localPrompt();
  return {
    async choose(screen) {
      print(ownershipScreenLines(screen));
      for (;;) {
        const choice = await ask(screen.canStop || screen.status === 'stale' ? 'Choose 1, 2 or 3 [1]: ' : 'Choose 1 or 2 [1]: ');
        if (!choice || choice === '1' || choice === 'cancel') return 'cancel';
        if (choice === '2' || choice === 'retry') return 'retry';
        if (screen.canStop && (choice === '3' || choice === 'stop')) return 'stop';
        if (screen.status === 'stale' && (choice === '3' || choice === 'recover')) return 'recover';
        print(['Choose a listed option, or press Enter to cancel.']);
      }
    },
    async confirmStop(screen) {
      print(['STOP PREVIOUS OMS WINDOW?', `Workspace: ${safeLine(screen.workspace)}`, `Task: ${safeLine(screen.task)}`,
        'UNSAVED EDITS AND DRAFTS WILL BE LOST. Running work will be interrupted.',
        'Saved files and session history remain. OMS will request graceful shutdown only,',
        'and will not force-kill or reopen if cleanup cannot be verified.']);
      return await ask('Type stop to discard unsaved state; Enter cancels: ') === 'stop';
    },
    close,
  };
}

const RECOVERY_NOTICES: Record<string, string> = {
  LEASE_OWNERSHIP_LOST: 'Task ownership changed. Refresh before recovering; no replacement owner was stopped.',
  LEASE_BUSY: 'Another OMS window or recovery now owns this task. Wait for it to finish, then refresh.',
  RECOVERY_DOCKER_UNAVAILABLE: 'Docker cleanup could not be verified. Start the local Docker daemon and retry Recover saved workspace. Saved work and data volumes remain.',
  RECOVERY_DOCKER_OWNERSHIP: 'Docker resources have foreign or incomplete ownership. Recovery is blocked; inspect this task’s Docker execution labels without pruning data volumes.',
  RECOVERY_PROCESS_UNTRACKED: 'An older untracked process still uses this task runtime. Stop it through its original owner, then retry recovery. No untracked process was signalled.',
  RECOVERY_PROCESS_UNVERIFIABLE: 'Runtime process identity or host process inspection is unavailable. Restore local process inspection or inspect the retained runtime-processes records, then retry.',
  RECOVERY_PROCESS_RUNNING: 'A task runtime did not stop gracefully. No force-kill was attempted. Wait for it to exit and retry recovery.',
  RECOVERY_SOURCE_UNVERIFIABLE: 'Source exclusion belongs to another or incomplete owner. Close the overlapping task or inspect its source-control ownership before retrying.',
  RECOVERY_VOLUME_UNVERIFIABLE: 'Volume exclusion has incomplete or foreign ownership. Inspect the retained sandbox-leases records; do not delete the data volumes.',
};

function recoveryNotice(error: unknown): string {
  return (error instanceof WorkspaceError ? RECOVERY_NOTICES[error.code] : undefined) ??
    'Recovery could not verify all resources. Saved work and ownership are retained; inspect the task’s host-only recovery records before retrying.';
}

/** The operator resolves ownership before a new task runtime or model session is created. */
export async function openHarnessWithOwnership(
  options: HarnessSessionOptions, dependencies: OwnershipDependencies = {},
): Promise<HarnessSession | undefined> {
  const start = dependencies.start ?? createHarnessSession;
  const inspect = dependencies.inspect ?? inspectMutationLease;
  const stop = dependencies.stop ?? stopMutationLeaseOwner;
  const recover = dependencies.recover ?? recoverHarnessWorkspace;
  let prompt = dependencies.prompt;
  let notice: string | undefined;
  let autoRecovered = false;
  try {
    for (;;) {
      if (inspect(options.task.leaseFile).status === 'absent') {
        try {
          if (dependencies.beforeOpen) {
            const prepared = await dependencies.beforeOpen(options);
            if (!prepared) return undefined;
            options = prepared;
          }
          return await start(options);
        } catch (error) {
          if (!(error instanceof WorkspaceError) || !['LEASE_BUSY', 'LEASE_STALE', 'LEASE_UNVERIFIABLE'].includes(error.code)) throw error;
        }
      }
      const found = inspect(options.task.leaseFile);
      if (found.status === 'stale' && !autoRecovered) {
        // A closed terminal leaves a stale owner. Recovery verifies and stops only that owner's task resources, so try it once
        // before asking; anything it cannot verify falls through to the explicit choices with its reason.
        autoRecovered = true;
        try { await recover(options.workspace, options.task, found.owner); continue; }
        catch (error) { notice = recoveryNotice(error); }
      }
      prompt ??= terminalOwnershipPrompt();
      for (;;) {
        const state = inspect(options.task.leaseFile);
        const screen: OwnershipScreen = {
          workspace: safeLine(options.workspace.root), task: safeLine(options.task.id),
          status: state.status, canStop: state.status === 'live', notice,
          ...('reason' in state ? { reason: state.reason } : {}),
        };
        const choice = await prompt.choose(screen);
        if (choice === 'cancel') return undefined;
        if (choice === 'retry') { notice = undefined; break; }
        if (choice === 'recover' && state.status === 'stale') {
          try {
            await recover(options.workspace, options.task, state.owner);
            notice = undefined;
            break;
          } catch (error) {
            notice = recoveryNotice(error);
          }
          continue;
        }
        if (state.status !== 'live') continue;
        if (!await prompt.confirmStop(screen)) { notice = 'Stop cancelled. The existing window remains unchanged.'; continue; }
        try {
          const result = await stop(options.task.leaseFile, state.owner);
          if (result === 'released') { notice = undefined; break; }
          notice = result === 'timed-out'
            ? 'The previous window is still running. No force-kill was attempted. Return to it, or retry later.'
            : 'Previous run ended without verified cleanup; saved files/session retained.';
        } catch (error) {
          notice = error instanceof WorkspaceError && error.code === 'LEASE_OWNERSHIP_LOST'
            ? 'Task ownership changed. No replacement owner was stopped. Review the current choices.'
            : 'OMS could not safely confirm shutdown. Ownership was not removed. Retry or cancel.';
        }
      }
      prompt.close();
      prompt = dependencies.prompt;
    }
  } finally { prompt?.close(); }
}
