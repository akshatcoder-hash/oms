/**
 * The mount allowlist. This is the security control: on Colima/macOS a bind
 * mount exposes a path fully even at 0600/0700, so
 * the allowlist — not file modes — is what keeps the signer and its token
 * directory out of the sandbox.
 *
 * Rules enforced here:
 *  - the project root is mounted rw at the container root;
 *  - verifier/contract paths (readOnlyPaths) are re-mounted :ro on top of the
 *    project mount so a model cannot edit what the evaluator trusts;
 *  - heavy dirs become named volumes (macOS bind-mount performance);
 *  - forbidden paths (signer dir, token/state dir, ~/.ssh, ~/.aws,
 *    ~/.config/solana, home, /, docker.sock) can never be mounted, directly,
 *    via a parent, via a child, or via a symlink that escapes the project;
 *  - a forbidden dir that lives INSIDE the project root cannot make the
 *    project unusable, so it is shadowed with an empty tmpfs instead.
 */

import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { SandboxError } from './errors.ts';
import { isWithin, isWithinOrEqual, normalizePath, requireRealPath } from './paths.ts';
import { approveBindSources } from './bind-sources.ts';

export interface MountBinding {
  hostPath: string;
  containerPath: string;
  mode: 'ro' | 'rw';
}

export interface NamedVolumeBinding {
  name: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface MountPlan {
  projectMount: MountBinding;
  extraMounts: MountBinding[];
  readOnlyMounts: MountBinding[];
  volumes: NamedVolumeBinding[];
  /** Container paths shadowed by an empty tmpfs because a forbidden dir sits inside the project root. */
  shadowMounts: string[];
}

export interface ForbiddenPaths {
  /** Directory holding the signer socket / token files. Supplied by the engine. */
  signerDir: string;
  /** oms state/token directory (e.g. ~/.oms). */
  stateDir?: string;
  /** Defaults to os.homedir(). */
  homeDir?: string;
  /** Additional forbidden paths. */
  extra?: string[];
}

export interface BuildMountsOptions {
  projectRoot: string;
  /** Task identifier used in volume names (`oms-<task>-<dir>`). */
  taskName: string;
  /** Additional bind mounts (explicit non-keypair mounts). Read-only mounts may overlay a read-only project. */
  extra?: Array<{ hostPath: string; containerPath: string; mode?: 'ro' | 'rw' }>;
  /**
   * Read-only host directories overlaid inside the project mount (for example locked dependencies at `node_modules`), so the agent's
   * sandbox sees what the verifier sees. Always `:ro`, always strictly inside the project's container root.
   */
  readOnlyOverlays?: Array<{ hostPath: string; containerPath: string }>;
  /** Verifier/contract paths, mounted :ro on top of the project mount. */
  readOnlyPaths?: string[];
  /** Project subdirectories put on named volumes. Defaults to ['node_modules', 'target']. */
  heavyDirs?: string[];
  /** Container path of the project mount. Defaults to '/work'. */
  containerRoot?: string;
  forbidden?: ForbiddenPaths;
  /** Immutable verifier input trees use ro; ordinary agent work remains rw. */
  projectMode?: 'ro' | 'rw';
}

interface ForbiddenEntry {
  /** Real (symlink-resolved) path, when it exists. */
  real: string | null;
  /** Lexical normalized path, always available. */
  lexical: string;
  /**
   * true: candidates inside this path are also forbidden (secrets trees).
   * false: only the path itself and its ancestors are forbidden (home, /):
   * projects legitimately live below home, so "inside" must stay allowed.
   */
  wholeTree: boolean;
}

const DEFAULT_HEAVY_DIRS = ['node_modules', 'target'];
const TASK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEAVY_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function buildForbidden(forbidden: ForbiddenPaths | undefined): ForbiddenEntry[] {
  const entries: Array<{ path: string; wholeTree: boolean }> = [];
  if (forbidden?.signerDir) entries.push({ path: forbidden.signerDir, wholeTree: true });
  if (forbidden?.stateDir) entries.push({ path: forbidden.stateDir, wholeTree: true });
  for (const p of forbidden?.extra ?? []) entries.push({ path: p, wholeTree: true });
  const home = forbidden?.homeDir ?? os.homedir();
  entries.push({ path: path.join(home, '.config', 'solana'), wholeTree: true });
  entries.push({ path: path.join(home, '.ssh'), wholeTree: true });
  entries.push({ path: path.join(home, '.aws'), wholeTree: true });
  entries.push({ path: '/var/run/docker.sock', wholeTree: true });
  // home and / reject only themselves and ancestors: everything else on the
  // machine lives inside them.
  entries.push({ path: forbidden?.homeDir ?? os.homedir(), wholeTree: false });
  entries.push({ path: '/', wholeTree: false });

  const out: ForbiddenEntry[] = [];
  for (const e of entries) {
    const lexical = normalizePath(e.path);
    let real: string | null = null;
    try {
      real = requireRealPath(lexical);
    } catch {
      // e.g. docker.sock does not exist on this host; the lexical path still
      // must never be mounted.
    }
    out.push({ real, lexical, wholeTree: e.wholeTree });
  }
  return out;
}

/**
 * True when the caller claims the path is inside the project (lexical relative
 * path from the project root) but a symlink along the way resolves it outside.
 * The walk starts at the project's REAL root so macOS prefixes like
 * /var/folders -> /private/var/folders do not defeat the comparison.
 */
function escapesProject(
  lexical: string,
  projectRootLexical: string,
  projectRootReal: string,
): boolean {
  const rel = path.relative(projectRootLexical, lexical);
  if (!isWithin(lexical, projectRootLexical)) return false;
  let cur = projectRootReal;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    try {
      cur = realpathSync(cur);
    } catch {
      // Non-existent tail: keep the lexical join; nothing to resolve yet.
    }
  }
  return !isWithinOrEqual(cur, projectRootReal);
}

/**
 * Check one candidate mount source against the forbidden set. Throws
 * E_MOUNT_SYMLINK_ESCAPE / E_MOUNT_FORBIDDEN on violation. The candidate may
 * not exist; the lexical path is then checked as-is (forbidden wins over
 * E_MOUNT_MISSING so probing a forbidden path never reveals an error class a
 * stranger could not already know).
 */
function checkForbidden(
  candidateReal: string | null,
  candidateLexical: string,
  projectRootLexical: string,
  projectRootReal: string,
  forbidden: ForbiddenEntry[],
  what: string,
): void {
  // A symlink inside the project that resolves outside it is an escape.
  if (escapesProject(candidateLexical, projectRootLexical, projectRootReal)) {
    throw new SandboxError(
      'E_MOUNT_SYMLINK_ESCAPE',
      `${what} contains a symlink that resolves outside the project root: ${candidateLexical}`,
      { path: candidateLexical, resolved: candidateReal ?? candidateLexical },
    );
  }
  for (const f of forbidden) {
    for (const target of [f.real, f.lexical]) {
      if (target === null) continue;
      for (const candidate of [candidateReal, candidateLexical]) {
        if (candidate === null) continue;
        if (candidate === target) {
          throw new SandboxError('E_MOUNT_FORBIDDEN', `${what} is a forbidden path: ${target}`, {
            path: candidate,
            forbidden: target,
          });
        }
        if (f.wholeTree && isWithin(candidate, target)) {
          throw new SandboxError(
            'E_MOUNT_FORBIDDEN',
            `${what} is inside a forbidden path: ${target}`,
            { path: candidate, forbidden: target },
          );
        }
        if (isWithin(target, candidate)) {
          throw new SandboxError(
            'E_MOUNT_FORBIDDEN',
            `${what} contains a forbidden path and would expose it: ${target}`,
            { path: candidate, forbidden: target },
          );
        }
      }
    }
  }
}

/**
 * Forbidden dirs that physically sit inside the project root cannot be
 * rejected (the project mount is required), so they are collected for an
 * empty-tmpfs shadow that hides their contents from the container.
 */
function collectShadows(
  projectRootReal: string,
  projectRootLexical: string,
  containerRoot: string,
  forbidden: ForbiddenEntry[],
): string[] {
  const shadows: string[] = [];
  for (const f of forbidden) {
    for (const [target, root] of [[f.real, projectRootReal], [f.lexical, projectRootLexical]]) {
      if (target && root && isWithin(target, root)) {
        shadows.push(path.join(containerRoot, path.relative(root, target)));
      }
    }
  }
  return [...new Set(shadows)];
}

function resolveOrCaptureMissing(lexical: string): { real: string | null; missing: SandboxError | null } {
  try {
    return { real: requireRealPath(lexical), missing: null };
  } catch (e) {
    if (e instanceof SandboxError && e.code === 'E_MOUNT_MISSING') {
      return { real: null, missing: e };
    }
    throw e;
  }
}

export function buildMounts(options: BuildMountsOptions): MountPlan {
  const { projectRoot, taskName } = options;
  if (!TASK_NAME_RE.test(taskName)) {
    throw new SandboxError('E_BAD_ARGUMENT', `invalid task name: ${taskName}`, { taskName });
  }
  const containerRoot = options.containerRoot ?? '/work';
  if (!path.isAbsolute(containerRoot) || containerRoot === '/') {
    throw new SandboxError('E_BAD_ARGUMENT', `containerRoot must be an absolute non-root path`, {
      containerRoot,
    });
  }
  const projectRootReal = requireRealPath(projectRoot);
  const projectRootLexical = normalizePath(projectRoot);
  const forbidden = buildForbidden(options.forbidden);

  // Whole-tree ancestors forbid the project itself. Forbidden descendants
  // are shadowed below, except home/root, which may never be exposed at all.
  for (const f of forbidden) {
    for (const target of [f.real, f.lexical]) {
      if (target === null) continue;
      for (const candidate of [projectRootReal, projectRootLexical]) {
        if (candidate === target ||
            (f.wholeTree && isWithin(candidate, target)) ||
            (!f.wholeTree && isWithin(target, candidate))) {
          throw new SandboxError(
            'E_MOUNT_FORBIDDEN',
            `project root overlaps a forbidden path: ${target}`,
            { path: candidate, forbidden: target },
          );
        }
      }
    }
  }

  const projectMount: MountBinding = {
    hostPath: projectRootReal,
    containerPath: containerRoot,
    mode: options.projectMode ?? 'rw',
  };

  const extraMounts: MountBinding[] = [];
  for (const extra of options.extra ?? []) {
    const lexical = normalizePath(extra.hostPath);
    const { real, missing } = resolveOrCaptureMissing(lexical);
    const containerPath = normalizePath(extra.containerPath);
    if (!path.isAbsolute(extra.containerPath) || containerPath === '/') {
      throw new SandboxError('E_BAD_ARGUMENT', `extra mount containerPath must be absolute`, {
        containerPath: extra.containerPath,
      });
    }
    const mode = extra.mode ?? 'rw';
    if (isWithinOrEqual(containerPath, containerRoot) && (mode !== 'ro' || projectMount.mode !== 'ro')) {
      throw new SandboxError(
        'E_MOUNT_CONFLICT',
        `extra mount ${containerPath} conflicts with the project mount at ${containerRoot}`,
        { containerPath },
      );
    }
    checkForbidden(real, lexical, projectRootLexical, projectRootReal, forbidden, 'extra mount');
    if (missing) throw missing;
    extraMounts.push({ hostPath: mode === 'ro' ? lexical : real as string, containerPath, mode });
  }

  for (const overlay of options.readOnlyOverlays ?? []) {
    const lexical = normalizePath(overlay.hostPath);
    const { real, missing } = resolveOrCaptureMissing(lexical);
    const containerPath = normalizePath(overlay.containerPath);
    if (!path.isAbsolute(overlay.containerPath) || containerPath === containerRoot || !isWithinOrEqual(containerPath, containerRoot)) {
      throw new SandboxError('E_BAD_ARGUMENT', 'a read-only overlay must sit strictly inside the project mount', { containerPath: overlay.containerPath });
    }
    checkForbidden(real, lexical, projectRootLexical, projectRootReal, forbidden, 'overlay mount');
    if (missing) throw missing;
    extraMounts.push({ hostPath: lexical, containerPath, mode: 'ro' });
  }

  const readOnlyMounts: MountBinding[] = [];
  for (const ro of options.readOnlyPaths ?? []) {
    const lexical = normalizePath(ro);
    // A project-relative path that symlinks out of the project is an escape,
    // not merely "outside the project".
    if (escapesProject(lexical, projectRootLexical, projectRootReal)) {
      throw new SandboxError(
        'E_MOUNT_SYMLINK_ESCAPE',
        `readOnlyPath contains a symlink that resolves outside the project root: ${lexical}`,
        { path: lexical },
      );
    }
    const { real, missing } = resolveOrCaptureMissing(lexical);
    if (missing) throw missing;
    // readOnlyPaths are verifier/contract files that shadow the project mount,
    // so they must live inside it (realpath check defeats ../ and symlinks).
    if (real === null || !isWithinOrEqual(real, projectRootReal)) {
      throw new SandboxError(
        'E_MOUNT_OUTSIDE_PROJECT',
        `readOnlyPath must be an existing path inside the project root: ${lexical}`,
        { path: lexical, projectRoot: projectRootReal },
      );
    }
    // Even read-only, a path inside a forbidden tree must never be mounted.
    for (const f of forbidden) {
      for (const target of [f.real, f.lexical]) {
        if (target === null) continue;
        if (real === target || (f.wholeTree && isWithin(real, target))) {
          throw new SandboxError(
            'E_MOUNT_FORBIDDEN',
            `readOnlyPath is inside a forbidden path: ${target}`,
            { path: real, forbidden: target },
          );
        }
      }
    }
    const rel = path.relative(projectRootReal, real);
    readOnlyMounts.push({
      hostPath: real,
      containerPath: rel === '' ? containerRoot : path.join(containerRoot, rel),
      mode: 'ro',
    });
  }

  const heavyDirs = options.heavyDirs ?? DEFAULT_HEAVY_DIRS;
  const volumes: NamedVolumeBinding[] = [];
  const seenHeavy = new Set<string>();
  for (const name of heavyDirs) {
    if (!HEAVY_NAME_RE.test(name) || name === '.' || name === '..') {
      throw new SandboxError('E_BAD_ARGUMENT', `invalid heavy dir name: ${name}`, { name });
    }
    if (seenHeavy.has(name)) continue;
    seenHeavy.add(name);
    volumes.push({ name: `oms-${taskName}-${name}`, containerPath: path.join(containerRoot, name) });
  }

  const shadowMounts = collectShadows(projectRootReal, projectRootLexical, containerRoot, forbidden);
  return approveBindSources({ projectMount, extraMounts, readOnlyMounts, volumes, shadowMounts });
}
