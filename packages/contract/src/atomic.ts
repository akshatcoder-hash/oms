/**
 * Atomic file writes: write a temp file in the target directory, fsync it, then
 * rename over the destination. On any failure the temp file is removed, so a
 * crash or a bad destination never leaves a half-written contract or pin.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface AtomicWriteOptions {
  /** File mode for a newly created destination. Defaults to 0644. */
  mode?: number;
}

let tempCounter = 0;

export function writeFileAtomic(filePath: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const target = resolve(filePath);
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  tempCounter += 1;
  const temp = join(directory, `.${basename(target)}.tmp-${process.pid}-${tempCounter}`);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, 'wx', options.mode ?? 0o644);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, target);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Descriptor already gone; nothing to clean up.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // The rename may have succeeded before an fsync error, or the temp file
      // was never created. Either way there is nothing left to remove.
    }
    throw error;
  }
}
