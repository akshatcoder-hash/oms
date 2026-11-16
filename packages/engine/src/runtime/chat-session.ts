import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createBudgetLedger, type BudgetCaps, type BudgetLedgerEvent, type ExecutionMode } from '@oms/core';
import { acquireMutationLease, inspectMutationLease, type MutationLease } from '../workspace/index.ts';
import { assertPrivate, WorkspaceError } from '../workspace/storage.ts';
import type { ChatFolder } from './chat-folder.ts';
import { backendFor } from './execution-backend.ts';
import { recoverSession } from './recovery.ts';
import { createCoreApi } from './session-api.ts';
import { assembleSession, startSession } from './session-assembly.ts';
import {
  claimRuntime,
  openConversation,
  planMounts,
  startSurfnet,
  warnAboutBackend,
  type RuntimeEnvironment,
} from './session-environment.ts';
import { chatRoot, chatStateDir, type SessionRoot } from './session-root.ts';
import type { ChatSession, ChatSessionOptions } from './session-types.ts';

/** Another window already has this folder open. */
export class ChatBusyError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`OMS is already open in this folder (process ${pid}). Close that window, or run oms in another folder.`);
    this.name = 'ChatBusyError';
    this.pid = pid;
  }
}

/** The agent may commit, but a hook or a changed config would run later outside the sandbox. */
const PROTECTED_GIT_FILES = ['.git/hooks', '.git/config'];

/** A stale owner's recorded processes are stopped first, so a crashed window never blocks its folder. */
async function acquireChatLease(root: SessionRoot): Promise<MutationLease> {
  try {
    return acquireMutationLease(root.leaseFile);
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    const found = inspectMutationLease(root.leaseFile);
    if (found.status === 'live') throw new ChatBusyError(found.owner.pid);
    if (found.status !== 'stale') throw error;
    await recoverSession(root, found.owner, 'host');
    return acquireMutationLease(root.leaseFile);
  }
}

export async function createChatSession(options: ChatSessionOptions): Promise<ChatSession> {
  const { folder, stateRoot } = options;
  if (backendFor(options.environment).requiresDocker)
    throw new Error('Docker chats need a pinned task: use oms task create and oms run.');
  const root = chatRoot(folder, stateRoot);
  warnAboutBackend(options.environment, stateRoot);
  return startSession(await acquireChatLease(root), async (life) => {
    const { execution, processes } = claimRuntime(options, root, life);
    const conversation = openConversation(options, root, life);
    const surfnetPort = await startSurfnet(options, root, life, processes);
    const env: RuntimeEnvironment = {
      root,
      ...conversation,
      surfnetPort,
      // A bind can only name what exists; the protected paths still cover a repository created later.
      ...planMounts(
        options,
        root,
        execution,
        PROTECTED_GIT_FILES.filter((file) => existsSync(join(root.codeRoot, file))),
      ),
      protectedFiles: PROTECTED_GIT_FILES,
    };
    const parts = await assembleSession(options, life, env, { owner: 'this folder' });
    return { ...createCoreApi(parts), kind: 'chat', folder };
  });
}

/** The newest saved conversation of a folder, with the budget journal that goes with it. */
export function latestChatSession(
  folder: ChatFolder,
  stateRoot: string,
): { sessionId: string; journal: string } | undefined {
  const sessions = join(chatStateDir(stateRoot, folder.key), 'sessions');
  if (!existsSync(sessions)) return undefined;
  const recent = SessionManager.continueRecent(folder.path, sessions);
  const file = recent.getSessionFile();
  if (!file || !existsSync(file)) return undefined;
  const sessionId = recent.getSessionId();
  return { sessionId, journal: join(sessions, `${sessionId}.budget.jsonl`) };
}

/** Whether a saved conversation's budget can still admit work, without changing it. */
export function savedBudgetUsable(
  journal: string,
  caps: BudgetCaps,
  executionMode: ExecutionMode | undefined,
  now = Date.now(),
): boolean {
  if (!existsSync(journal)) return false;
  try {
    assertPrivate(journal, false);
    const contents = readFileSync(journal, 'utf8');
    if (!contents.endsWith('\n') || contents.length === 0) return false;
    const events = contents
      .slice(0, -1)
      .split('\n')
      .map((line) => JSON.parse(line)) as BudgetLedgerEvent[];
    const ledger = createBudgetLedger({
      caps,
      clock: () => now,
      events,
      persist() {
        throw new Error('Read-only budget inspection');
      },
    });
    const snapshot = ledger.snapshot();
    if (snapshot.accounting !== 'known' || snapshot.pendingDispatchIds.length !== 0) return false;
    // Runtime migrates known legacy journals; paid dispatch admission still checks retained spend.
    return executionMode === 'interactive' || !snapshot.admissionBlocked;
  } catch {
    return false;
  }
}
