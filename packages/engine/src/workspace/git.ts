import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { WorkspaceError } from './storage.ts';

const environment: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: '/nonexistent',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
};
const safeConfig = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.attributesFile=/dev/null',
  'credential.helper=',
  'diff.external=',
  'protocol.allow=never',
  'submodule.recurse=false',
  'core.sparseCheckout=false',
  'core.sparseCheckoutCone=false',
  'checkout.workers=1',
  'maintenance.auto=false',
  'gc.auto=0',
].flatMap((value) => ['-c', value]);

/** Only this module's fixed Git operations are exposed, not an agent-facing argv tool. */
function command(root: string, args: string[], extra: string[] = []): string {
  return execFileSync('/usr/bin/git', [...safeConfig, ...extra, '-C', root, ...args], {
    env: environment,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function repositoryPaths(path: string): { root: string; gitCommonDir: string; worktrees: string[] } {
  const cwd = realpathSync(path);
  if (command(cwd, ['rev-parse', '--is-bare-repository']).trim() !== 'false') {
    throw new WorkspaceError('UNSUPPORTED_REPOSITORY', 'A non-bare working repository is required');
  }
  const gitCommonDir = realpathSync(command(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const records = command(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0');
  const worktrees = records.filter((record) => record.startsWith('worktree ')).map((record) => record.slice(9));
  const primary = worktrees[0];
  if (!primary) throw new WorkspaceError('UNSUPPORTED_REPOSITORY', 'No primary checkout is registered');
  const root = realpathSync(primary);
  // Opening a linked worktree resolves the primary repository before looking for .oms.
  if (
    realpathSync(command(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) !== gitCommonDir
  ) {
    throw new WorkspaceError('IDENTITY_DECISION_REQUIRED', 'Git common directory and primary checkout disagree');
  }
  return { root, gitCommonDir, worktrees };
}

export function trackedPrivateState(root: string): boolean {
  return command(root, ['ls-files', '-z', '--', '.oms']).length !== 0;
}

export function commitHasPrivateState(root: string, oid: string): boolean {
  return command(root, ['ls-tree', '-z', oid, '--', '.oms']).length !== 0;
}

export function ignoresPrivateState(root: string): boolean {
  try {
    // check-ignore succeeds if any input is ignored; inspect each input independently.
    for (const path of ['.oms/', '.oms/.env.agent', '.oms/.keys/probe', '.oms/tasks/probe/task.json']) {
      command(root, ['check-ignore', '-q', '--no-index', path]);
    }
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) return false;
    throw error;
  }
}

export function commitExists(root: string, oid: string): boolean {
  try {
    return command(root, ['cat-file', '-t', oid]).trim() === 'commit';
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') return false;
    throw error;
  }
}

/** Full oid of the commit a revision names, or undefined when it names none. */
export function resolveCommit(root: string, revision: string): string | undefined {
  if (!revision || revision.startsWith('-')) return undefined;
  try {
    return command(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`]).trim();
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') return undefined;
    throw error;
  }
}

export function branchExists(root: string, branch: string): boolean {
  try {
    command(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) return false;
    throw error;
  }
}

export function addWorktree(root: string, path: string, branch: string, oid: string): void {
  // Repository/global filter commands must never execute on the trusted host.
  let keys: string[];
  try {
    keys = command(root, [
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process|required)$',
    ])
      .split('\0')
      .filter(Boolean);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 1) throw error;
    keys = [];
  }
  const filters = keys.flatMap((key) => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`]);
  command(root, ['worktree', 'add', '--no-checkout', '-b', branch, '--', path, oid], filters);
  command(path, ['read-tree', '--reset', '-u', oid], filters);
}

export function validateWorktree(root: string, codeRoot: string, branch: string, gitCommonDir: string): void {
  const paths = repositoryPaths(codeRoot);
  if (
    paths.root !== root ||
    paths.gitCommonDir !== gitCommonDir ||
    command(codeRoot, ['symbolic-ref', '--quiet', 'HEAD']).trim() !== `refs/heads/${branch}`
  ) {
    throw new WorkspaceError(
      'TASK_IDENTITY_MISMATCH',
      'Task checkout no longer matches its recorded repository and branch',
    );
  }
}
