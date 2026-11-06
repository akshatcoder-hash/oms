import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { type TaskRoots } from '@oms/contract';
import { readTask, type Task, type Workspace } from '../workspace/index.ts';
import { privateDirectory } from '../workspace/storage.ts';

export interface TaskContext {
  stateDir: string;
  workDir: string;
  leaseDir: string;
  sourceControlDir: string;
  roots: TaskRoots;
  taskName: string;
}

export function taskContext(workspace: Workspace, task: Task): TaskContext {
  const owned = readTask(workspace, task.id);
  for (const key of ['workspaceId', 'codeRoot', 'taskFile', 'pinFile', 'leaseFile', 'branch', 'baseOid'] as const) {
    if (task[key] !== owned[key]) throw new Error('Task does not match its registered workspace ownership');
  }
  const stateDir = dirname(task.pinFile);
  const workDir = join(stateDir, 'runtime');
  const leaseDir = join(stateDir, 'sandbox-leases');
  const sourceControlDir = join(workspace.stateDir, 'source-control');
  for (const dir of [workDir, leaseDir, sourceControlDir]) privateDirectory(dir);
  const roots: TaskRoots = {
    workspaceRoot: workspace.root, stateRoot: dirname(task.taskFile), codeRoot: task.codeRoot, sourceControlDir,
  };
  const taskName = `h-${createHash('sha256').update(workspace.id + ':' + task.id).digest('hex').slice(0, 40)}`;
  return { stateDir, workDir, leaseDir, sourceControlDir, roots, taskName };
}
