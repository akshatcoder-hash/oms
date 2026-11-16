import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Task, Workspace } from '../workspace/index.ts';
import { privateDirectory, writePrivateJson } from '../workspace/storage.ts';
import type { ChatFolder } from './chat-folder.ts';
import type { TaskContext } from './task-context.ts';

/** Where one session works and keeps its state; the startup stages read this instead of a task and its workspace. */
export interface SessionRoot {
  /** The folder the agent edits. */
  codeRoot: string;
  leaseFile: string;
  /** Holds the runtime-backend record, and the runtime-processes the lease owner tracks. */
  stateDir: string;
  workDir: string;
  /** Sandbox leases; Docker only. */
  leaseDir: string;
  sourceControlDir: string;
  taskName: string;
  /** Conversation files with their budget journals and traces. */
  sessionsDir: string;
  agentRoot: string;
  /** Trees a recovering process may treat as this session's own when it reclaims source exclusions. */
  ownedRoots: string[];
  forbidden: { signerDir: string; stateDir: string; extra: string[] };
  /** The user's own folder, where other processes of theirs also run, instead of a worktree only this session uses. */
  sharedCodeRoot: boolean;
  /** `.env` files are unreadable to the agent. */
  denyEnv: boolean;
}

export function taskRoot(workspace: Workspace, task: Task, context: TaskContext): SessionRoot {
  return {
    codeRoot: task.codeRoot,
    leaseFile: task.leaseFile,
    stateDir: context.stateDir,
    workDir: context.workDir,
    leaseDir: context.leaseDir,
    sourceControlDir: context.sourceControlDir,
    taskName: context.taskName,
    sessionsDir: join(workspace.stateDir, 'sessions', task.id),
    agentRoot: join(dirname(dirname(workspace.stateDir)), 'agent'),
    ownedRoots: [task.codeRoot, context.stateDir, dirname(task.taskFile)],
    forbidden: {
      signerDir: join(workspace.omsDir, '.keys'),
      stateDir: workspace.stateDir,
      extra: [join(workspace.omsDir, '.env.agent')],
    },
    sharedCodeRoot: false,
    denyEnv: false,
  };
}

/** Everything OMS keeps for a chat folder; nothing is written into the folder itself. */
export function chatStateDir(stateRoot: string, key: string): string {
  return join(stateRoot, 'folders', key);
}

export function chatRoot(folder: ChatFolder, stateRoot: string): SessionRoot {
  const stateDir = chatStateDir(stateRoot, folder.key);
  const workDir = join(stateDir, 'runtime');
  const leaseDir = join(stateDir, 'sandbox-leases');
  // Shared by every folder: the per-command source lease only sees roots that use the same directory.
  const sourceControlDir = join(stateRoot, 'source-control');
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (const dir of [join(stateRoot, 'folders'), stateDir, workDir, leaseDir, sourceControlDir]) privateDirectory(dir);
  const record = join(stateDir, 'folder.json');
  if (!existsSync(record)) writePrivateJson(record, { path: folder.requested, scratch: folder.scratch });
  return {
    codeRoot: folder.path,
    leaseFile: join(stateDir, 'session.lease'),
    stateDir,
    workDir,
    leaseDir,
    sourceControlDir,
    taskName: `c-${folder.key}`,
    sessionsDir: join(stateDir, 'sessions'),
    agentRoot: join(stateRoot, 'agent'),
    ownedRoots: [folder.path, stateDir],
    forbidden: { signerDir: join(stateDir, '.keys'), stateDir, extra: [] },
    sharedCodeRoot: true,
    denyEnv: true,
  };
}
