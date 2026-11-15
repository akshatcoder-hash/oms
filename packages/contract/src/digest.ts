/**
 * Digests.
 *
 * `canonicalJson` is the byte-stable serialization used for config digests:
 * object keys sorted, no whitespace. `digestFiles` hashes a *sorted path list*
 * plus each file's content, so the same tree always gives the same digest and
 * reordering the list changes nothing. A path list, not a glob: zero-dependency
 * and explicit, which means the pin is only as complete as the list.
 */

import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readCheckedFile } from './source-files.ts';
import { withSourceAccess, type SourceAccessOptions } from './source-access.ts';
import {
  PathError,
  isPathError,
  realDirectory,
  resolveFileInsideRoot,
  toPosixRelative,
} from './paths.ts';

export type DigestCode = 'E_NOT_CANONICAL' | 'E_CIRCULAR';

export class DigestError extends Error {
  readonly code: DigestCode;

  constructor(code: DigestCode, message: string) {
    super(message);
    this.name = 'DigestError';
    this.code = code;
  }
}

export interface PinSet {
  contractDigest: string;
  verifierDigest: string;
  evaluatorConfigDigest: string;
}

export interface FileDigest {
  /** Project-relative POSIX path. */
  path: string;
  digest: string;
}

export interface DigestSet {
  /** sha256 over the sorted (path, content-digest) pairs. */
  digest: string;
  files: FileDigest[];
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new DigestError('E_NOT_CANONICAL', 'numbers must be finite to be canonical');
    }
    return JSON.stringify(value);
  }
  if (kind === 'boolean') return value === true ? 'true' : 'false';
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new DigestError('E_CIRCULAR', 'cannot canonicalize a cyclic value');
    seen.add(value);
    const parts = value.map((entry) => canonicalize(entry, seen));
    seen.delete(value);
    return `[${parts.join(',')}]`;
  }
  if (kind === 'object') {
    const object = value as Record<string, unknown>;
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new DigestError(
        'E_NOT_CANONICAL',
        'only plain objects, arrays, strings, numbers, booleans and null are canonical',
      );
    }
    if (seen.has(object)) throw new DigestError('E_CIRCULAR', 'cannot canonicalize a cyclic value');
    seen.add(object);
    const keys = Object.keys(object).sort();
    const parts = keys.map((key) => {
      const entry = object[key];
      if (entry === undefined) {
        throw new DigestError('E_NOT_CANONICAL', 'undefined is not a JSON value');
      }
      return `${JSON.stringify(key)}:${canonicalize(entry, seen)}`;
    });
    seen.delete(object);
    return `{${parts.join(',')}}`;
  }
  throw new DigestError('E_NOT_CANONICAL', `cannot canonicalize a value of type ${kind}`);
}

/** Canonical JSON: sorted keys, no whitespace, no trailing newline. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

export function digestJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * The aggregate formula: sha256 over `path\0contentDigest\n` for each entry in
 * sorted path order. Exported so a pin file can be checked for internal
 * consistency without touching the filesystem.
 */
export function digestFileEntries(files: readonly FileDigest[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const material = sorted.map((file) => `${file.path}\u0000${file.digest}\n`).join('');
  return sha256Hex(material);
}

/**
 * Hash the given project-relative files (path + content, sorted).
 * Throws `PathError` for absolute paths, `..` traversal, symlinks that leave
 * the root, directories, duplicates and missing files.
 */
export function digestFiles(root: string, relativePaths: readonly string[], options: SourceAccessOptions = {}): DigestSet {
  return withSourceAccess(root, canonicalRoot => digestFilesHeld(canonicalRoot, relativePaths), options);
}

function digestFilesHeld(root: string, relativePaths: readonly string[]): DigestSet {
  const rootReal = realDirectory(root);
  const seen = new Set<string>();
  const files: FileDigest[] = [];

  for (const input of relativePaths) {
    const normalized = toPosixRelative(input);
    if (seen.has(normalized)) {
      throw new PathError('E_DUPLICATE_PATH', 'path is listed twice', normalized);
    }
    seen.add(normalized);
    const absolute = resolveFileInsideRoot(rootReal, normalized);
    let digest: string;
    try {
      digest = sha256Hex(readCheckedFile(absolute, lstatSync(absolute), 256 * 1024 * 1024));
    } catch (error) {
      if (isPathError(error)) throw error;
      throw new PathError('E_NOT_FOUND', 'file could not be read', normalized);
    }
    files.push({ path: normalized, digest });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { digest: digestFileEntries(files), files };
}
