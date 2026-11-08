import { lstatSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';
import type { MountBinding, MountPlan } from './mounts.ts';
import { SandboxError } from './errors.ts';
import { isWithinOrEqual } from './paths.ts';

interface Identity { path: string; stat: Stats; canonical: string }
interface Approval { material: string; identities: Identity[] }
const approvals = new WeakMap<MountPlan, Approval>();

function overlaps(a: string, b: string): boolean {
  return isWithinOrEqual(a, b) || isWithinOrEqual(b, a);
}
function fail(message: string): never { throw new SandboxError('E_MOUNT_FORBIDDEN', message); }
function material(plan: MountPlan): string {
  return JSON.stringify([plan.projectMount, plan.extraMounts, plan.readOnlyMounts]);
}
function sourceChain(source: MountBinding): Identity[] {
  const identities: Identity[] = [];
  const canonicalSource = realpathSync(source.hostPath);
  if (canonicalSource !== source.hostPath) {
    // Read-only system libraries commonly use root-owned /lib aliases. Pin both
    // the alias chain and its canonical target; writable mounts never do this.
    if (source.mode !== 'ro') fail(`writable bind source is not canonical: ${source.hostPath}`);
    for (let current = source.hostPath;; current = path.dirname(current)) {
      const stat = lstatSync(current);
      if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0) ||
          (current !== source.hostPath && !stat.isDirectory() && !stat.isSymbolicLink())) {
        fail(`read-only bind alias is not root-controlled: ${current}`);
      }
      identities.push({ path: current, stat, canonical: realpathSync(current) });
      if (path.dirname(current) === current) break;
    }
    return [...identities, ...sourceChain({ ...source, hostPath: canonicalSource })];
  }
  for (let current = source.hostPath;; current = path.dirname(current)) {
    const stat = lstatSync(current);
    if (realpathSync(current) !== current || stat.isSymbolicLink() ||
        (current === source.hostPath ? !stat.isFile() && !stat.isDirectory() : !stat.isDirectory())) {
      fail(`bind source or ancestor is not canonical: ${current}`);
    }
    if (current === source.hostPath && source.mode !== 'ro' && process.getuid && stat.uid !== process.getuid()) fail(`bind source is not host-owned: ${current}`);
    if (current === source.hostPath && (stat.mode & 0o022) !== 0) fail(`bind source is writable by other host users: ${current}`);
    if (current !== source.hostPath && ((stat.uid !== 0 && process.getuid && stat.uid !== process.getuid()) ||
        ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0)))) {
      fail(`bind ancestor is not protected against other host users: ${current}`);
    }
    identities.push({ path: current, stat, canonical: current });
    if (path.dirname(current) === current) return identities;
  }
}

/** Called only by the trusted mount allowlist, never with model-approved paths. */
export function approveBindSources(plan: MountPlan): MountPlan {
  const sources = [plan.projectMount, ...plan.extraMounts, ...plan.readOnlyMounts];
  for (let index = 0; index < plan.extraMounts.length; index++) {
    const extra = plan.extraMounts[index]!;
    if (overlaps(extra.hostPath, plan.projectMount.hostPath) || plan.extraMounts.slice(0, index).some(other => overlaps(extra.hostPath, other.hostPath))) {
      fail('extra bind sources must be disjoint from the project and every other writable bind');
    }
    if (extra.mode === 'rw') {
      const parent = lstatSync(path.dirname(extra.hostPath));
      if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid())) {
        fail('extra writable bind sources require a private host-owned parent outside writable sandbox sources');
      }
    }
  }
  const identities = sources.flatMap(sourceChain);
  approvals.set(plan, { material: material(plan), identities });
  return plan;
}

/** Must run under project source ownership, before any Docker operation and
 * immediately before Docker create. No managed writer can replace readonly
 * overlay ancestors while the daemon establishes binds. The command starts
 * only after all binds exist; subsequent commands must validate again.
 */
export function validateBindSources(plan: MountPlan): void {
  const approval = approvals.get(plan);
  if (!approval || approval.material !== material(plan)) fail('bind plan has no unchanged trusted source approval');
  try {
    for (const identity of approval.identities) {
      const current = lstatSync(identity.path);
      if (current.dev !== identity.stat.dev || current.ino !== identity.stat.ino || current.mode !== identity.stat.mode ||
          current.uid !== identity.stat.uid || current.gid !== identity.stat.gid || realpathSync(identity.path) !== identity.canonical) {
        fail(`approved bind source or ancestor identity changed: ${identity.path}`);
      }
    }
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    fail('approved bind source or ancestor is no longer accessible');
  }
}
