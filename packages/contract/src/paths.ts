/**
 * Path containment helpers.
 *
 * Everything that is pinned or cached has to be resolved before it is trusted:
 * a verifier path may not escape the project root lexically (`..`) or through a
 * symlink, and the pin file plus the verifier cache must live *outside* the
 * root because the generator can write anywhere inside it.
 *
 * Fail-closed: every check either returns a path that is proven to be inside
 * the root or throws a `PathError`.
 */

import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';

export type PathCode =
  | 'E_BAD_PATH'
  | 'E_ABSOLUTE_PATH'
  | 'E_PATH_ESCAPE'
  | 'E_SYMLINK_ESCAPE'
  | 'E_NOT_FOUND'
  | 'E_NOT_A_FILE'
  | 'E_NOT_A_DIRECTORY'
  | 'E_BAD_ROOT'
  | 'E_DUPLICATE_PATH'
  | 'E_PATH_INSIDE_ROOT'
  | 'E_UNRESOLVABLE';

export class PathError extends Error {
  readonly code: PathCode;
  /** The offending path as given by the caller, when there is one. */
  readonly path: string | undefined;

  constructor(code: PathCode, message: string, path?: string) {
    super(message);
    this.name = 'PathError';
    this.code = code;
    this.path = path;
  }
}

export function isPathError(value: unknown): value is PathError {
  return value instanceof PathError;
}

export function isInside(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return candidate.startsWith(withSep);
}

/**
 * Resolve as far as the filesystem allows: realpath the deepest existing
 * ancestor and re-append the missing tail. This is what makes a symlinked
 * ancestor (`root/evil -> /etc`) detectable even when the final component does
 * not exist yet.
 */
export function realpathAllowingMissing(absolutePath: string): string {
  let current = absolutePath;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return absolutePath;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Real path of an existing directory, or `E_BAD_ROOT`. */
export function realDirectory(root: string): string {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new PathError('E_BAD_ROOT', 'root must be a non-empty path');
  }
  const absolute = resolve(root);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new PathError('E_BAD_ROOT', 'root does not exist', root);
  }
  let stats;
  try {
    stats = statSync(real);
  } catch {
    throw new PathError('E_BAD_ROOT', 'root is not readable', root);
  }
  if (!stats.isDirectory()) throw new PathError('E_BAD_ROOT', 'root is not a directory', root);
  return real;
}

/**
 * Normalize a caller-supplied relative path to POSIX separators and reject
 * lexical escapes. Absolute paths are rejected: every pinned path is relative
 * to the project root by definition.
 */
export function toPosixRelative(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new PathError('E_BAD_PATH', 'path must be a non-empty string');
  }
  if (input.includes('\u0000')) {
    throw new PathError('E_BAD_PATH', 'path contains a NUL byte', input);
  }
  if (isAbsolute(input)) {
    throw new PathError('E_ABSOLUTE_PATH', 'path must be relative to the project root', input);
  }
  const normalized = posix.normalize(input.split(sep).join('/'));
  if (normalized === '' || normalized === '.' || normalized === './') {
    throw new PathError('E_BAD_PATH', 'path does not name a file', input);
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new PathError('E_PATH_ESCAPE', 'path escapes the project root', input);
  }
  return normalized;
}

/**
 * Resolve a project-relative path and prove it stays inside the root. Symlinks
 * are followed; one that leaves the root is reported as `E_SYMLINK_ESCAPE`,
 * a lexical `..` escape as `E_PATH_ESCAPE`.
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  const rootReal = realDirectory(root);
  const normalized = toPosixRelative(relativePath);
  const lexical = resolve(rootReal, normalized);
  if (!isInside(rootReal, lexical)) {
    throw new PathError('E_PATH_ESCAPE', 'path escapes the project root', relativePath);
  }
  let real: string;
  try {
    real = realpathAllowingMissing(lexical);
  } catch {
    throw new PathError('E_UNRESOLVABLE', 'path could not be resolved', relativePath);
  }
  if (!isInside(rootReal, real)) {
    const code: PathCode = real === lexical ? 'E_PATH_ESCAPE' : 'E_SYMLINK_ESCAPE';
    throw new PathError(code, 'path resolves outside the project root', relativePath);
  }
  return real;
}

/** Resolve a path that must exist as a regular file (no directories). */
export function resolveFileInsideRoot(root: string, relativePath: string): string {
  const resolved = resolveInsideRoot(root, relativePath);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new PathError('E_NOT_FOUND', 'file does not exist', relativePath);
  }
  if (!stats.isFile()) {
    throw new PathError('E_NOT_A_FILE', 'path is not a regular file', relativePath);
  }
  return resolved;
}

/**
 * The pin file and the verifier cache must be invisible to the generator, so
 * they may not sit inside the project root.
 */
export function assertOutsideRoot(root: string, target: string): void {
  if (typeof target !== 'string' || target.trim().length === 0) {
    throw new PathError('E_BAD_PATH', 'path must be a non-empty string');
  }
  const rootReal = realDirectory(root);
  const lexical = resolve(target);
  let real: string;
  try {
    real = realpathAllowingMissing(lexical);
  } catch {
    real = lexical;
  }
  if (isInside(rootReal, lexical) || isInside(rootReal, real)) {
    throw new PathError('E_PATH_INSIDE_ROOT', 'this path must live outside the project root', target);
  }
}

/** Best-effort parent directory creation with owner-only permissions. */
export function ensureParentDirectory(filePath: string): string {
  const parent = dirname(resolve(filePath));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return parent;
}

/** Trusted host configuration, never values accepted from model tool arguments. */
export interface TaskRoots {
  workspaceRoot: string;
  stateRoot: string;
  codeRoot: string;
  /** Shared trusted source exclusion; never derived from model arguments. */
  sourceControlDir?: string;
}

export function resolveTaskRoots(roots: TaskRoots, pinFile: string): TaskRoots {
  const workspaceRoot = realDirectory(roots.workspaceRoot);
  const stateRoot = realDirectory(roots.stateRoot);
  const codeRoot = realDirectory(roots.codeRoot);
  if (roots.codeRoot !== resolve(roots.codeRoot) || roots.codeRoot !== codeRoot) {
    throw new PathError('E_BAD_ROOT', 'codeRoot must remain its admitted absolute canonical path', roots.codeRoot);
  }
  if (isInside(codeRoot, stateRoot) || isInside(stateRoot, codeRoot)) {
    throw new PathError('E_PATH_INSIDE_ROOT', 'stateRoot and codeRoot must be disjoint');
  }
  for (const root of [workspaceRoot, stateRoot, codeRoot]) assertOutsideRoot(root, pinFile);
  return { workspaceRoot, stateRoot, codeRoot };
}
