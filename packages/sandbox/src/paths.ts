/**
 * Path helpers for the mount allowlist. Every decision is made on real paths
 * (symlinks resolved) or on normalized lexical paths — never on raw input.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { SandboxError } from './errors.ts';

/** Lexically normalize a path (collapses `.`, `..` and duplicate separators). */
export function normalizePath(p: string): string {
  return path.resolve(p);
}

/**
 * Resolve symlinks. A non-existent path is an error: docker would silently
 * create a directory for a missing bind source, which must never happen
 * implicitly.
 */
export function requireRealPath(p: string): string {
  const n = normalizePath(p);
  try {
    return realpathSync(n);
  } catch {
    throw new SandboxError('E_MOUNT_MISSING', `mount source does not exist: ${n}`, { path: n });
  }
}

/** True when `child` is strictly inside `dir` (both normalized/real). */
export function isWithin(child: string, dir: string): boolean {
  if (child === dir) return false;
  const rel = path.relative(dir, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** True when `child` equals `dir` or is inside it. */
export function isWithinOrEqual(child: string, dir: string): boolean {
  return child === dir || isWithin(child, dir);
}
