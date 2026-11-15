import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { MountPlan } from './mounts.ts';
import { isWithinOrEqual } from './paths.ts';
import { SandboxError } from './errors.ts';

/** A crashed holder is never guessed dead: its lease requires explicit host recovery. */
export function acquireVolumeLeases(
  leaseDir: string,
  taskName: string,
  phase: 'install' | 'run',
  mounts: MountPlan,
): () => void {
  if (typeof leaseDir !== 'string' || !path.isAbsolute(leaseDir)) {
    throw new SandboxError('E_BAD_ARGUMENT', 'leaseDir must be an absolute, private host directory');
  }
  // Check before creation too, so a bad configuration cannot write into code.
  const bindRoots = [mounts.projectMount, ...mounts.extraMounts, ...mounts.readOnlyMounts].map((m) => m.hostPath);
  if (bindRoots.some((root) => isWithinOrEqual(path.resolve(leaseDir), root))) {
    throw new SandboxError('E_BAD_ARGUMENT', 'leaseDir must not be exposed through any sandbox bind mount');
  }
  mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
  const root = realpathSync(leaseDir);
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    bindRoots.some((bind) => isWithinOrEqual(root, realpathSync(bind)))
  ) {
    throw new SandboxError('E_BAD_ARGUMENT', 'leaseDir must be host-owned, private (0700), and outside sandbox binds');
  }
  const token = randomUUID();
  const held: string[] = [];
  const release = () => {
    const failures: unknown[] = [];
    for (const file of held) {
      try {
        unlinkSync(file);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'failed to release sandbox volume leases');
    held.length = 0;
  };
  try {
    // The key is the actual volume name, not just the caller's task, so a
    // misidentified caller cannot bypass a live owner's mutation exclusion.
    for (const name of [...new Set(mounts.volumes.map((v) => v.name))].sort()) {
      const dir = path.join(root, createHash('sha256').update(name).digest('hex'));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const gate = path.join(dir, 'gate');
      try {
        mkdirSync(gate, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new SandboxError('E_RESOURCE_BUSY', `volume lease is being changed: ${name}`, { taskName, volume: name });
      }
      try {
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          const holder: unknown = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
          if (
            typeof holder !== 'object' ||
            holder === null ||
            !('phase' in holder) ||
            (holder.phase !== 'install' && holder.phase !== 'run')
          ) {
            throw new SandboxError('E_RESOURCE_BUSY', `unreadable volume lease requires host recovery: ${name}`);
          }
          if (phase === 'install' || holder.phase === 'install') {
            throw new SandboxError('E_RESOURCE_BUSY', `volume is in use: ${name}`, { taskName, volume: name });
          }
        }
        const file = path.join(dir, `${token}.json`);
        writeFileSync(file, JSON.stringify({ taskName, volume: name, phase, pid: process.pid }), {
          flag: 'wx',
          mode: 0o600,
        });
        held.push(file);
      } finally {
        rmdirSync(gate);
      }
    }
  } catch (error) {
    try {
      release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'volume lease acquisition cleanup failed');
    }
    throw error;
  }
  return release;
}
