/**
 * File-read guard for model-issued read tools.
 *
 * Allowlist semantics, not denylist semantics: a read is allowed only if the
 * *resolved* path sits inside the project root AND outside every protected
 * path. Resolution happens before comparison, so symlinks inside the project
 * that point at the signer key, the socket directory or anything else outside
 * the root are denied.
 *
 * Every check is fail-closed: any error while resolving a path denies the read.
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export type GuardDenialCode =
  'E_GUARD_BAD_PATH' | 'E_GUARD_OUTSIDE_ROOT' | 'E_GUARD_DENIED_PATH' | 'E_GUARD_RESOLVE_FAILED';

export interface GuardDecision {
  allowed: boolean;
  code?: GuardDenialCode;
  /** The resolved absolute path when allowed. */
  resolved?: string;
  reason?: string;
}

export interface ReadGuard {
  checkRead(requested: string): GuardDecision;
  readonly projectRoot: string;
  readonly deniedPaths: readonly string[];
}

export interface ReadGuardOptions {
  projectRoot: string;
  /** Paths (files or directories) that must never be readable, e.g. the keypair. */
  deniedPaths?: readonly string[];
  /**
   * Extra absolute roots that are also readable, e.g. a read-only mount.
   * Defaults to just the project root.
   */
  extraRoots?: readonly string[];
}

function isInside(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return candidate.startsWith(withSep);
}

/**
 * Resolve as far as the filesystem allows: realpath the deepest existing
 * ancestor and re-append the non-existent tail. This is what makes a symlinked
 * ancestor directory (e.g. `root/evil -> /etc`) detectable even when the final
 * component does not exist yet.
 */
function resolveWithExistingAncestor(absolutePath: string): string {
  let current = absolutePath;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      const parent = resolve(current, '..');
      if (parent === current) {
        // Reached the filesystem root without finding anything that exists.
        return absolutePath;
      }
      tail.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

function realpathOfNearest(p: string): string {
  try {
    const resolved = resolveWithExistingAncestor(p);
    // If the path itself exists, prefer the true realpath.
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  } catch {
    return p;
  }
}

/** Case-fold comparison is applied additionally on case-insensitive volumes. */
function deniedVariants(p: string): string[] {
  return [p, p.toLowerCase()];
}

export function createReadGuard(options: ReadGuardOptions): ReadGuard {
  const projectRoot = realpathOfNearest(resolve(options.projectRoot));
  const roots = [projectRoot, ...(options.extraRoots ?? []).map((root) => realpathOfNearest(resolve(root)))];

  const deniedInputs = options.deniedPaths ?? [];
  const deniedEntries: string[] = [];
  for (const entry of deniedInputs) {
    const absolute = isAbsolute(entry) ? resolve(entry) : resolve(projectRoot, entry);
    const real = realpathOfNearest(absolute);
    deniedEntries.push(...deniedVariants(absolute), ...deniedVariants(real), ...deniedVariants(resolve(absolute)));
  }
  const deniedSet = new Set(deniedEntries);
  const deniedList = [...deniedSet];

  const guard: ReadGuard = {
    projectRoot,
    deniedPaths: Object.freeze(deniedList),
    checkRead(requested: string): GuardDecision {
      if (typeof requested !== 'string' || requested.trim().length === 0) {
        return { allowed: false, code: 'E_GUARD_BAD_PATH', reason: 'path must be a non-empty string' };
      }
      if (requested.includes('\u0000')) {
        return { allowed: false, code: 'E_GUARD_BAD_PATH', reason: 'path contains a NUL byte' };
      }

      // Relative requests are interpreted against the project root, then go
      // through the same resolution as absolute ones, so `../../etc/passwd`
      // lands outside and is denied.
      const absolute = isAbsolute(requested) ? resolve(requested) : resolve(projectRoot, requested);

      let resolvedPath: string;
      try {
        resolvedPath = realpathOfNearest(absolute);
      } catch {
        return { allowed: false, code: 'E_GUARD_RESOLVE_FAILED', reason: 'path could not be resolved' };
      }

      // If the final target exists, use its true realpath (catches symlinks).
      try {
        statSync(resolvedPath);
        resolvedPath = realpathSync(resolvedPath);
      } catch {
        // Does not exist yet: the ancestor-resolved path stands.
      }

      const candidates = deniedVariants(resolvedPath).concat(deniedVariants(absolute));
      for (const candidate of candidates) {
        for (const denied of deniedList) {
          // Exact match, or the candidate sits inside a protected directory.
          if (isInside(denied, candidate)) {
            return {
              allowed: false,
              code: 'E_GUARD_DENIED_PATH',
              reason: 'path is on the protected list (signer key or signer state)',
            };
          }
        }
      }

      const insideRoot = roots.some((root) => isInside(root, resolvedPath));
      if (!insideRoot) {
        return { allowed: false, code: 'E_GUARD_OUTSIDE_ROOT', reason: 'path resolves outside the project root' };
      }

      return { allowed: true, resolved: resolvedPath };
    },
  };

  return guard;
}
