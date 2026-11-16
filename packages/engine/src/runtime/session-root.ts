import { dirname, join } from 'node:path';
import type { Task, Workspace } from '../workspace/index.ts';
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
    denyEnv: false,
  };
}
