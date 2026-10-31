import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { digestFileEntries, digestJson, sha256Hex, type FileDigest } from './digest.ts';
import { PathError, isInside, realDirectory, resolveFileInsideRoot, resolveInsideRoot } from './paths.ts';
import type { ContractItem, EvaluatorConfig } from './types.ts';
import { assertDirectories, directoryIdentities, readCheckedFile, sameIdentity } from './source-files.ts';
import { withSourceAccess, type SourceAccessOptions } from './source-access.ts';

/** An explicitly empty offline ledger has a fixed identity, not an invented digest. */
export const EMPTY_SNAPSHOT_DIGEST = sha256Hex('oms:empty-snapshot:v1');
export const MAX_INPUT_BYTES = 256 * 1024 * 1024;
export const MAX_INPUT_ENTRIES = 100_000;
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export function specificationDigest(item: Pick<ContractItem, 'id' | 'done'>, config: EvaluatorConfig): string {
  return digestJson({ id: item.id, done: item.done, evaluatorConfig: config });
}

export function snapshotDigest(codeRoot: string, config: EvaluatorConfig, options: SourceAccessOptions = {}): string {
  return withSourceAccess(codeRoot, codeRoot => {
    if (config.snapshotPath === undefined) return EMPTY_SNAPSHOT_DIGEST;
    const path = resolveFileInsideRoot(codeRoot, config.snapshotPath);
    const info = lstatSync(path);
    if (info.size > MAX_SNAPSHOT_BYTES) throw new RangeError('snapshot exceeds the 64 MiB proof input limit');
    return sha256Hex(readCheckedFile(path, info, MAX_SNAPSHOT_BYTES));
  }, options);
}

/** All code-root membership participates, including untracked files and manifests.
 * Only the root Git control entry is excluded; it is never copied into execution.
 * Dependencies must therefore be inside the input tree or supplied by a pinned image.
 */
function visitInputs(codeRoot: string, destination?: string): FileDigest[] {
  const root = realDirectory(codeRoot);
  const files: FileDigest[] = [];
  const rootDirectories = directoryIdentities(root);
  let bytesRead = 0;
  let entries = 0;
  function visit(relative: string): void {
    if (++entries > MAX_INPUT_ENTRIES) throw new RangeError('code input exceeds the 100000-entry proof limit');
    const absolute = join(root, relative);
    const directories = [...directoryIdentities(dirname(absolute)), ...rootDirectories];
    assertDirectories(directories);
    const stat = lstatSync(absolute);
    const target = destination === undefined ? undefined : join(destination, relative);
    if (stat.isSymbolicLink()) {
      const resolved = resolveInsideRoot(root, relative);
      if (isInside(join(root, '.git'), resolved)) throw new PathError('E_PATH_ESCAPE', 'input symlink targets excluded Git control data', relative);
      const link = readlinkSync(absolute);
      if (!sameIdentity(lstatSync(absolute), stat)) throw new PathError('E_BAD_PATH', 'input symlink changed', relative);
      assertDirectories(directories);
      if (link.startsWith('/')) throw new PathError('E_ABSOLUTE_PATH', 'absolute input symlinks cannot be relocated', relative);
      files.push({ path: relative, digest: sha256Hex(`symlink\0${link}`) });
      if (target !== undefined) { mkdirSync(dirname(target), { recursive: true }); symlinkSync(link, target); }
    } else if (stat.isDirectory()) {
      files.push({ path: `${relative}/`, digest: sha256Hex(`directory\0${stat.mode & 0o777}`) });
      const directory = { path: absolute, stat };
      assertDirectories([...directories, directory]);
      if (target !== undefined) mkdirSync(target, { recursive: true });
      const names = readdirSync(absolute).sort();
      assertDirectories([...directories, directory]);
      for (const name of names) visit(`${relative}/${name}`);
      if (target !== undefined) chmodSync(target, stat.mode & 0o777);
    } else if (stat.isFile()) {
      if (stat.size > MAX_INPUT_BYTES - bytesRead) throw new RangeError('code input exceeds the 256 MiB proof limit');
      const bytes = readCheckedFile(absolute, stat, MAX_INPUT_BYTES - bytesRead, directories);
      bytesRead += bytes.length;
      if (bytesRead > MAX_INPUT_BYTES) throw new RangeError('code input exceeds the 256 MiB proof limit');
      files.push({ path: relative, digest: createHash('sha256').update(`file\0${stat.mode & 0o777}\0`).update(bytes).digest('hex') });
      if (target !== undefined) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { mode: stat.mode & 0o777 });
        chmodSync(target, stat.mode & 0o777);
      }
    } else {
      throw new PathError('E_NOT_A_FILE', 'input is not a regular file, directory or contained symlink', relative);
    }
  }
  assertDirectories(rootDirectories);
  const names = readdirSync(root).sort();
  assertDirectories(rootDirectories);
  for (const name of names) if (name !== '.git') visit(name);
  assertDirectories(rootDirectories);
  return files;
}

export function digestCodeInputs(codeRoot: string, config: EvaluatorConfig, options: SourceAccessOptions = {}): string {
  return withSourceAccess(codeRoot, codeRoot => {
    for (const path of config.codePaths) resolveFileInsideRoot(codeRoot, path);
    return digestFileEntries(visitInputs(codeRoot));
  }, options);
}

export interface SavedInputs {
  codeRoot: string;
  codeDigest: string;
  snapshotDigest: string;
  dispose(): void;
}

export function saveCodeInputs(codeRoot: string, config: EvaluatorConfig, options: SourceAccessOptions = {}): SavedInputs {
  return withSourceAccess(codeRoot, codeRoot => saveCodeInputsHeld(codeRoot, config, options), options);
}

function saveCodeInputsHeld(codeRoot: string, config: EvaluatorConfig, options: SourceAccessOptions): SavedInputs {
  for (const path of config.codePaths) resolveFileInsideRoot(codeRoot, path);
  if (config.snapshotPath !== undefined &&
      lstatSync(resolveFileInsideRoot(codeRoot, config.snapshotPath)).size > MAX_SNAPSHOT_BYTES) {
    throw new RangeError('snapshot exceeds the 64 MiB proof input limit');
  }
  const saved = realDirectory(mkdtempSync(join(tmpdir(), 'oms-proof-')));
  try {
    const codeDigest = digestFileEntries(visitInputs(codeRoot, saved));
    const snapshot = snapshotDigest(saved, config, options);
    if (snapshot !== config.snapshotDigest) throw new Error('snapshot bytes differ from the pinned snapshot digest');
    if (digestCodeInputs(codeRoot, config, options) !== codeDigest) throw new Error('code inputs changed while being saved');
    return { codeRoot: saved, codeDigest, snapshotDigest: snapshot, dispose: () => rmSync(saved, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(saved, { recursive: true, force: true });
    throw error;
  }
}
