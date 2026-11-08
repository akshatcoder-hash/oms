import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDirectory, reviewScope } from './report/storage.ts';

export interface RetentionResult {
  deleted: string[];
  /** Exceptional non-deletions; recent reports are omitted. */
  retained: Array<{ reviewId: string; reason: string }>;
}
interface ReviewState { stateRoot: string; repo: string }
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) && id !== 'all';
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

const directory = ({ stateRoot, repo }: ReviewState) => reviewScope(stateRoot, repo, false);

// Read only bounded regular files, never symlinks, FIFOs or device files. The
// creation timestamp is host report metadata, not directory mtime (which changes
// when logs/proofs are added). Invalid metadata requires explicit purge.
async function createdAt(path: string, id: string): Promise<number> {
  const handle = await open(join(path, 'report.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const limit = 4 * 1024 * 1024;
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid report metadata');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > limit) throw new Error('Invalid report metadata');
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid report metadata');
    const record = value as Record<string, unknown>;
    const time = typeof record['createdAt'] === 'string' ? Date.parse(record['createdAt']) : NaN;
    if (record['schema'] !== 'oms.review/1' || record['reviewId'] !== id || !Number.isFinite(time) ||
        new Date(time).toISOString() !== record['createdAt']) throw new Error('Invalid report metadata');
    return time;
  } finally { await handle.close(); }
}

async function removeReviews(options: ReviewState, selector: string | undefined, cutoff?: number, now?: number): Promise<RetentionResult> {
  const result: RetentionResult = { deleted: [], retained: [] };
  const root = await directory(options);
  if (!root) return result;
  const ids = selector && selector !== 'all' ? [selector] : (await readdir(root)).sort();
  for (const id of ids) {
    if (!validId(id)) { result.retained.push({ reviewId: id, reason: 'Unsupported review ID' }); continue; }
    const path = join(root, id);
    try { await privateDirectory(path); }
    catch (error) {
      if (missing(error)) continue;
      result.retained.push({ reviewId: id, reason: 'Review is not a private directory' }); continue;
    }
    if (cutoff !== undefined) {
      let time: number;
      try { time = await createdAt(path, id); }
      catch { result.retained.push({ reviewId: id, reason: 'Missing or invalid creation metadata' }); continue; }
      if (time > now!) { result.retained.push({ reviewId: id, reason: 'Creation time is in the future' }); continue; }
      if (time > cutoff) continue;
    }
    // State is host-owned and must never be mounted into an untrusted process.
    // rm unlinks symlinks inside this directory; it does not follow their targets.
    // Recheck ancestors before deletion; this is not a same-UID race sandbox.
    if (await directory(options) !== root) throw new Error('Review state changed during retention');
    await privateDirectory(path);
    await rm(path, { recursive: true, force: true });
    result.deleted.push(id);
  }
  return result;
}

/** Run at review startup. Only this canonical checkout's reports are eligible. */
export async function expireReviews(options: ReviewState & { retentionDays?: number; now?: number }): Promise<RetentionResult> {
  const days = options.retentionDays ?? 30;
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(now - days * 86400000)) throw new Error('Invalid review retention settings');
  return removeReviews(options, undefined, now - days * 86400000, now);
}

/** Explicit --purge id|all; all means this checkout, never every repository. */
export async function purgeReviews(options: ReviewState & { reviewId: string }): Promise<RetentionResult> {
  if (options.reviewId !== 'all' && !validId(options.reviewId)) throw new Error('Invalid review ID');
  return removeReviews(options, options.reviewId);
}
