import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function secretKeyLength(value: string): boolean {
  let number = 0n;
  for (const char of value) number = number * 58n + BigInt(alphabet.indexOf(char));
  let bytes = value.match(/^1*/)?.[0].length ?? 0;
  while (number > 0n) { bytes++; number >>= 8n; }
  return bytes === 64;
}
/** Shared by model-bound text and persisted logs; never returns the matched key. */
export function redactReviewText(value: string): string {
  return value.replace(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?(?:-----END \1-----|$)/g, block => '[REDACTED]' + '\n'.repeat((block.match(/\n/g) ?? []).length))
    .replace(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{64,90}(?![1-9A-HJ-NP-Za-km-z])/g,
      candidate => secretKeyLength(candidate) ? '[REDACTED]' : candidate);
}
function keyArray(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.length === 64 && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  } catch { return false; }
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}
function allowedName(name: string): boolean {
  return !['.git', '.oms', 'node_modules', 'target'].includes(name) &&
    !name.toLowerCase().startsWith('.env') && !name.toLowerCase().endsWith('.pem');
}
function safeRelative(path: string): boolean {
  return !isAbsolute(path) && !path.includes('\\') && !/^[A-Za-z]:/.test(path) &&
    !/[\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}
export interface ReviewSnapshot {
  inventory(): ReadonlyMap<string, number>;
  read(path: string): string;
  grep(query: string): Array<{ file: string; line: number; text: string }>;
  excludedFiles: number;
}

/** Capture once before model execution. No model read follows a live workspace
 * path. Entries are checked by realpath, then opened with O_NOFOLLOW. */
export async function captureSnapshot(repo: string, limits: { fileBytes?: number; totalBytes?: number; files?: number } = {}): Promise<ReviewSnapshot> {
  const fileBytes = limits.fileBytes ?? 512 * 1024;
  const totalBytes = limits.totalBytes ?? 16 * 1024 * 1024;
  const maxFiles = limits.files ?? 2000;
  if (![fileBytes, totalBytes, maxFiles].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid snapshot limits');
  const root = await realpath(repo);
  if (!(await lstat(root)).isDirectory()) throw new Error('Snapshot root must be a directory');
  const files = new Map<string, string>();
  let total = 0;
  let examined = 0;
  let excludedFiles = 0;
  async function walk(directory: string): Promise<void> {
    for await (const entry of await opendir(directory)) {
      if (++examined > maxFiles * 4) throw new Error('Snapshot entry budget exhausted');
      if (!allowedName(entry.name) || entry.isSymbolicLink()) { excludedFiles++; continue; }
      const path = join(directory, entry.name);
      const canonical = await realpath(path);
      if (!within(root, canonical) || canonical !== path) { excludedFiles++; continue; }
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) { excludedFiles++; continue; }
      const name = relative(root, path).split(sep).join('/');
      if (!safeRelative(name)) { excludedFiles++; continue; }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.size > BigInt(fileBytes)) { excludedFiles++; continue; }
        const buffer = Buffer.alloc(fileBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (!part.bytesRead) break;
          bytesRead += part.bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        if (bytesRead > fileBytes || BigInt(bytesRead) !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) { excludedFiles++; continue; }
        let source: string;
        try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); }
        catch { excludedFiles++; continue; }
        if (source.includes('\0') || keyArray(source)) { excludedFiles++; continue; }
        const redacted = redactReviewText(source);
        total += Buffer.byteLength(redacted);
        if (total > totalBytes || files.size >= maxFiles) throw new Error('Snapshot content budget exhausted');
        files.set(name, redacted);
      } finally { await handle.close(); }
    }
  }
  await walk(root);
  return Object.freeze({
    excludedFiles,
    inventory: () => new Map([...files].map(([name, text]) => [name, text.split('\n').length])),
    read(path: string): string {
      if (!safeRelative(path) || !files.has(path)) throw new Error('Path is not in the review snapshot');
      return files.get(path)!;
    },
    grep(query: string) {
      if (!query || Buffer.byteLength(query) > 4096) throw new Error('Invalid literal query');
      const hits: Array<{ file: string; line: number; text: string }> = [];
      for (const [file, source] of files) {
        for (const [index, line] of source.split('\n').entries()) {
          if (line.includes(query)) hits.push({ file, line: index + 1, text: line.slice(0, 1000) });
          if (hits.length === 100) return hits;
        }
      }
      return hits;
    },
  });
}
