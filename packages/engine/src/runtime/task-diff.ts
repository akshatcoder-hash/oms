import { execFile } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
/** Ceiling on the diff text one call returns; the caller says when it was cut. */
export const TASK_DIFF_LIMIT = 256 * 1024;

export interface TaskDiff {
  /** `git diff --stat` against the base: tracked changes, staged and unstaged together. */
  stat: string;
  /** The unified diff, cut at TASK_DIFF_LIMIT bytes. */
  patch: string;
  truncated: boolean;
  /** New files git does not track yet (ignored files excluded). */
  untracked: string[];
}

/** A path inside the task, safe to hand to git after `--`. */
export function taskDiffPath(path: string): string {
  const clean = normalize(path.trim());
  if (
    !clean ||
    /[\0\r\n]/.test(clean) ||
    isAbsolute(clean) ||
    clean === '..' ||
    clean.startsWith('../') ||
    clean.split('/').includes('.git')
  ) {
    throw new Error('Choose a path inside the task worktree');
  }
  return clean;
}

/**
 * Changes in the task worktree against its base commit. Read-only git, with external diff drivers, text conversion and
 * the fsmonitor hook off, so a repository's own configuration cannot run a program here.
 */
export async function taskDiff(codeRoot: string, baseOid: string, path?: string): Promise<TaskDiff> {
  const scope = path === undefined ? [] : ['--', taskDiffPath(path)];
  const git = async (...args: string[]) =>
    (
      await run('git', ['-C', codeRoot, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args], {
        encoding: 'utf8',
        maxBuffer: 4 * TASK_DIFF_LIMIT,
        timeout: 30_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      })
    ).stdout;
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color'];
  const [stat, patch, others] = await Promise.all([
    git('diff', ...flags, '--stat', baseOid, ...scope),
    git('diff', ...flags, baseOid, ...scope),
    git('ls-files', '--others', '--exclude-standard', ...scope),
  ]);
  const bytes = Buffer.from(patch, 'utf8');
  const truncated = bytes.length > TASK_DIFF_LIMIT;
  return {
    stat: stat.trimEnd(),
    patch: truncated ? bytes.subarray(0, TASK_DIFF_LIMIT).toString('utf8') : patch,
    truncated,
    untracked: others.split('\n').filter(Boolean),
  };
}
