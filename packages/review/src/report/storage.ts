import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactReviewText } from '../snapshot.ts';
import { parseReviewReport, type ReviewReport } from '../types.ts';
import { renderJson, renderMarkdown } from './render.ts';

export async function privateDirectory(path: string, create = false): Promise<void> {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  ) {
    throw new Error('Review storage requires private host directories without symlinks');
  }
}

/** True when child is parent itself or inside it. */
export function isNested(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

/** The per-checkout review directory under a private state root that lies outside
 * the workspace. Without create, a missing reviews tree yields undefined. */
export async function reviewScope(stateRoot: string, repo: string, create: boolean): Promise<string | undefined> {
  if (!isAbsolute(stateRoot)) throw new Error('Review state root must be absolute');
  const canonical = await realpath(repo);
  if (isNested(canonical, stateRoot)) throw new Error('Review state must be outside the workspace');
  await privateDirectory(stateRoot);
  const reviews = join(stateRoot, 'reviews');
  if (isNested(canonical, reviews) || isNested(reviews, canonical))
    throw new Error('Review storage tree must not overlap the workspace');
  const scoped = join(reviews, createHash('sha256').update(canonical).digest('hex'));
  try {
    await privateDirectory(reviews, create);
    await privateDirectory(scoped, create);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
  return scoped;
}

function prepareReport(options: { report: ReviewReport; files: ReadonlyMap<string, number>; logs: string }) {
  // Freeze and validate all contents before the first asynchronous operation.
  const input = parseReviewReport(options.report);
  const id = input.reviewId;
  const time = Date.parse(input.createdAt);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ||
    id === 'all' ||
    redactReviewText(id) !== id ||
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== input.createdAt
  )
    throw new Error('Invalid review storage metadata');
  if (typeof options.logs !== 'string' || Buffer.byteLength(options.logs) > 1024 * 1024)
    throw new Error('Review logs exceed storage limit');
  const files = new Map(options.files);
  const redacted = JSON.parse(
    JSON.stringify(input, (_key, value: unknown) => (typeof value === 'string' ? redactReviewText(value) : value)),
  );
  const json = renderJson(redacted, files);
  if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error('Review report exceeds storage limit');
  const markdown = renderMarkdown(redacted, files);
  const logs = redactReviewText(options.logs);
  return { id, json, markdown, logs };
}

/** Persist a Phase A report in host-owned state, never in the reviewed checkout.
 * No raw snapshot, credentials or proof material is accepted by this interface.
 * The caller owns stateRoot; it must never be mounted into untrusted processes.
 * This does not isolate concurrent malicious processes running as the host UID. */
export async function saveReview(options: {
  stateRoot: string;
  repo: string;
  report: ReviewReport;
  files: ReadonlyMap<string, number>;
  logs: string;
}): Promise<{ directory: string }> {
  const { stateRoot, repo } = options;
  const { id, json, markdown, logs } = prepareReport(options);
  if (!(await lstat(await realpath(repo))).isDirectory()) throw new Error('Review workspace must be a directory');
  const scoped = (await reviewScope(stateRoot, repo, true))!;
  const directory = join(scoped, id);
  // Exclusive directory creation prevents overwrites and reserves the review ID.
  // A failed competing writer must not remove the first writer's directory.
  await mkdir(directory, { mode: 0o700 });
  try {
    await writeFile(join(directory, 'logs.txt'), logs, { flag: 'wx', mode: 0o600 });
    await writeFile(join(directory, 'report.md'), markdown, { flag: 'wx', mode: 0o600 });
    // Written last: retention sees no creation metadata until both siblings exist.
    await writeFile(join(directory, 'report.json'), json, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory };
}

/** Explicit Phase A export. Only reports leave private state; no logs, snapshots
 * or proof files are copied. The destination must be new under a canonical
 * existing parent. Same-UID concurrent filesystem tampering is not isolated. */
export async function exportReview(options: {
  out: string;
  report: unknown;
  files: ReadonlyMap<string, number>;
}): Promise<void> {
  const { out } = options;
  const report = parseReviewReport(options.report);
  // The strict report schema currently permits Phase A suspected findings only.
  // Rejects Phase B and proof-bearing input before any destination is created.
  const { json, markdown } = prepareReport({ report, files: options.files, logs: '' });
  if (!isAbsolute(out) || resolve(out) !== out || /[\x00-\x1f\x7f]/.test(out)) throw new Error('Invalid export path');
  if ((await realpath(dirname(out))) !== dirname(out)) throw new Error('Symlinked export parent');
  await mkdir(out, { mode: 0o700 });
  try {
    await writeFile(join(out, 'report.md'), markdown, { flag: 'wx', mode: 0o600 });
    await writeFile(join(out, 'report.json'), json, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(out, { recursive: true, force: true });
    throw error;
  }
}
