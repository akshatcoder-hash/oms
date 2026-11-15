import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { SandboxResult } from '@oms/sandbox';

export const MAX_TASK_FILE_BYTES = 64 * 1024;
const MAX_TASK_DIRECTORY_ENTRIES = 512;
export interface TaskFileEntry { path: string; kind: 'file' | 'directory' }
export interface TaskFileSnapshot { bytes: Buffer; revision: string }
export type TaskFileExecutor = (argv: string[], signal?: AbortSignal) => Promise<SandboxResult>;
export interface TaskFileAccess {
  list(path?: string, signal?: AbortSignal): Promise<TaskFileEntry[]>;
  read(path: string, signal?: AbortSignal): Promise<TaskFileSnapshot>;
  write(path: string, bytes: Uint8Array, expectedRevision?: string, signal?: AbortSignal): Promise<string>;
  create(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string>;
  access(path: string, signal?: AbortSignal): Promise<void>;
  makeDirectory(path: string, signal?: AbortSignal): Promise<void>;
}

const FILE_OPERATION = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
try {
const [operation, input, content, expected, taskRoot, protectedJson] = process.argv.slice(1);
const root = fs.realpathSync(taskRoot);
const target = path.resolve(root, input);
const inside = value => value === root || value.startsWith(root + path.sep);
const protectedPaths = JSON.parse(protectedJson);
if (['write', 'create', 'mkdir'].includes(operation) && protectedPaths.some(file => target === file || target.startsWith(file + path.sep) || file.startsWith(target + path.sep))) throw Error('pinned verifier files are not writable');
const privateNames = { '.git': true, '.oms': true, '.keys': true, '.env.agent': true };
if (!inside(target) || (target === root && operation !== 'mkdir' && operation !== 'list') || path.relative(root, target).split(path.sep).some(part => privateNames[part] === true)) throw Error('path is outside the admitted task files');
if (operation !== 'list') {
let ancestor = target;
while (!fs.existsSync(ancestor)) {
  const next = path.dirname(ancestor);
  if (next === ancestor) throw Error('no existing task ancestor');
  ancestor = next;
}
const canonicalAncestor = fs.realpathSync(ancestor);
if (!inside(canonicalAncestor)) throw Error('path escapes the task through a symlink');
const canonicalTarget = path.resolve(canonicalAncestor, path.relative(ancestor, target));
if (path.relative(root, canonicalTarget).split(path.sep).some(part => privateNames[part] === true)) throw Error('private/control path is unavailable');
if (['write', 'create', 'mkdir'].includes(operation) && protectedPaths.some(file => {
  const canonical = fs.existsSync(file) ? fs.realpathSync(file) : file;
  return canonicalTarget === canonical || canonicalTarget.startsWith(canonical + path.sep) || canonical.startsWith(canonicalTarget + path.sep);
})) throw Error('pinned verifier files are not writable');
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function readRegular(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 65536) throw Error('read requires a regular file no larger than 64 KiB');
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('file changed during the read');
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
if (operation === 'list') {
  // Directory descriptors pin each component; the Linux sandbox never follows a
  // symlink, including an alias swapped while a directory is being traversed.
  const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd/' : '/dev/fd/';
  let fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let directory;
  try {
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
      const next = fs.openSync(descriptorRoot + fd + '/' + part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(fd); fd = next;
    }
    directory = fs.opendirSync(descriptorRoot + fd);
    const entries = [];
    let count = 0;
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (++count > 512) throw Error('Directory exceeds the 512-entry listing limit; open a file by path');
      if (privateNames[entry.name] === true) continue;
      const stat = fs.lstatSync(descriptorRoot + fd + '/' + entry.name);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
      entries.push({ path: path.relative(root, path.join(target, entry.name)), kind: stat.isDirectory() ? 'directory' : 'file' });
    }
    entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.path.localeCompare(b.path));
    const output = JSON.stringify(entries);
    if (Buffer.byteLength(output) > 65536) throw Error('Directory listing exceeds the 64 KiB output limit; open a file by path');
    process.stdout.write(output);
  } finally {
    try { if (directory) directory.closeSync(); } finally { fs.closeSync(fd); }
  }
} else if (operation === 'read') {
  const bytes = readRegular(target);
  process.stdout.write(JSON.stringify({ bytes: bytes.toString('base64'), revision: digest(bytes) }));
} else if (operation === 'access') {
  fs.accessSync(target, fs.constants.R_OK);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('path is not a regular task file');
} else if (operation === 'mkdir') {
  fs.mkdirSync(target, { recursive: true });
} else if (operation === 'write' || operation === 'create') {
  const bytes = Buffer.from(content, 'base64');
  if (bytes.length > 65536) throw Error('write exceeds 64 KiB');
  let mode = 420;
  if (operation === 'write' && fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('write requires an ordinary task file');
    mode = stat.mode & 511;
    if (expected && digest(readRegular(target)) !== expected) throw Error('file changed after the edit read; read it again');
  } else if (expected) throw Error('file disappeared after the edit read');
  const parent = path.dirname(target);
  if (!inside(fs.realpathSync(parent))) throw Error('write parent escaped task');
  const temporary = path.join(parent, '.oms-write-' + crypto.randomBytes(12).toString('hex'));
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (expected && digest(readRegular(target)) !== expected) throw Error('file changed before save; read it again');
    // link publishes the complete temporary file only if the name is absent.
    if (operation === 'create') {
      try { fs.linkSync(temporary, target); }
      catch (error) {
        if (error.code === 'EEXIST') throw Error('File already exists; open it or choose a different new-file path');
        throw error;
      }
    } else fs.renameSync(temporary, target);
    process.stdout.write(digest(bytes));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
} else throw Error('unknown file operation');
} catch (error) {
  process.stderr.write(JSON.stringify({ message: error instanceof Error ? error.message : 'Task file operation failed' }));
  process.exitCode = 1;
}
`;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function textBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_TASK_FILE_BYTES) throw new Error('Task file exceeds 64 KiB');
  if (bytes.includes(0)) throw new Error('Binary task files are unavailable in this text editor');
  try { decoder.decode(bytes); } catch { throw new Error('Task file requires valid UTF-8'); }
}
function taskPath(path: string, root: string, allowRoot = false): string {
  const resolved = posix.resolve(root, path);
  if ((!allowRoot && resolved === root) || (resolved !== root && !resolved.startsWith(root + '/'))) {
    throw new Error('File operations are limited to the selected task under /work');
  }
  return resolved;
}

/** Both model tools and the editor execute this fixed helper inside an owned sandbox. */
export function createTaskFileAccess(execute: TaskFileExecutor, root = '/work', protectedPaths: string[] = []): TaskFileAccess {
  const call = async (operation: 'read' | 'write' | 'create' | 'mkdir' | 'access' | 'list', path: string, content: string, expected: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const result = await execute(['node', '-e', FILE_OPERATION, operation, path, content, expected, root, JSON.stringify(protectedPaths)], signal);
    if (result.cancelled) throw new Error('Task file operation was cancelled');
    if (result.timedOut) throw new Error('Task file operation timed out');
    if (result.truncated) throw new Error('Task file operation exceeded its output limit');
    if (result.exitCode !== 0) {
      const diagnostic = result.stderr.trim();
      if (diagnostic.startsWith('{"message":')) {
        let detail: unknown;
        try { detail = JSON.parse(diagnostic); }
        catch { throw new Error('Task file operation returned malformed error details', { cause: diagnostic }); }
        if (detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string') {
          throw new Error(detail.message, { cause: diagnostic });
        }
      }
      throw new Error(diagnostic || 'Task file operation failed');
    }
    return result.stdout;
  };
  return {
    async list(path = '.', signal) {
      const resolved = taskPath(path, root, true);
      const raw = await call('list', resolved, '', '', signal);
      if (Buffer.byteLength(raw) > MAX_TASK_FILE_BYTES) throw new Error('Task directory response exceeds its limit');
      let entries: unknown;
      try { entries = JSON.parse(raw); } catch { throw new Error('Task directory response is invalid'); }
      if (!Array.isArray(entries) || entries.length > MAX_TASK_DIRECTORY_ENTRIES) throw new Error('Task directory response is invalid');
      const paths = new Set<string>();
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' ||
            !['file', 'directory'].includes(entry.kind) || entry.path.startsWith('/') ||
            posix.normalize(entry.path) !== entry.path || posix.dirname(posix.resolve(root, entry.path)) !== resolved ||
            entry.path.split('/').some((part: string) => ['.git', '.oms', '.keys', '.env.agent', '..'].includes(part)) ||
            paths.has(entry.path)) throw new Error('Task directory response is invalid');
        paths.add(entry.path);
      }
      return entries as TaskFileEntry[];
    },
    async read(path, signal) {
      signal?.throwIfAborted();
      const raw = await call('read', taskPath(path, root), '', '', signal);
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new Error('Task file response is invalid'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('bytes' in value) || !('revision' in value) ||
          typeof value.bytes !== 'string' || value.bytes.length > Math.ceil(MAX_TASK_FILE_BYTES / 3) * 4 ||
          typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) {
        throw new Error('Task file response is invalid');
      }
      const bytes = Buffer.from(value.bytes, 'base64');
      if (bytes.toString('base64') !== value.bytes || createHash('sha256').update(bytes).digest('hex') !== value.revision) {
        throw new Error('Task file response is inconsistent');
      }
      textBytes(bytes);
      return { bytes, revision: value.revision };
    },
    async write(path, bytes, expectedRevision, signal) {
      signal?.throwIfAborted();
      textBytes(bytes);
      if (expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error('Task file revision is invalid');
      const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const revision = createHash('sha256').update(content).digest('hex');
      const saved = await call('write', taskPath(path, root), content.toString('base64'), expectedRevision ?? '', signal);
      if (saved !== revision) throw new Error('Saved task file revision is inconsistent');
      return revision;
    },
    async create(path, bytes, signal) {
      signal?.throwIfAborted();
      textBytes(bytes);
      const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const revision = createHash('sha256').update(content).digest('hex');
      const saved = await call('create', taskPath(path, root), content.toString('base64'), '', signal);
      if (saved !== revision) throw new Error('Created task file revision is inconsistent');
      return revision;
    },
    async access(path, signal) {
      await call('access', taskPath(path, root), '', '', signal);
    },
    async makeDirectory(path, signal) {
      const resolved = taskPath(path, root, true);
      signal?.throwIfAborted();
      // The mounted task root already exists by the executor's admission contract.
      if (resolved !== root) await call('mkdir', resolved, '', '', signal);
    },
  };
}
